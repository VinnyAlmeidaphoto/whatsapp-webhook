import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// ---------- util: horário de atendimento ----------
const BUS_TZ    = process.env.BUSINESS_TZ    || "America/Sao_Paulo";
const BUS_START = Number(process.env.BUSINESS_START ?? 9);   // 0-23
const BUS_END   = Number(process.env.BUSINESS_END   ?? 18);  // 0-23
function isOpenNow() {
  try {
    const hourStr = new Date().toLocaleString("en-US", { timeZone: BUS_TZ, hour: "2-digit", hour12: false });
    const h = parseInt(hourStr, 10);
    return h >= BUS_START && h <= BUS_END;
  } catch {
    const h = new Date().getHours();
    return h >= BUS_START && h <= BUS_END;
  }
}

// ---------- cache leve ----------
const cache = new Map(); // key: wa_id → { wa_id, name, lang, last_seen_at, human? }

// ---------- CONTACTS ----------
async function getContact(wa_id) {
  try {
    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("wa_id", wa_id)
      .maybeSingle();
    if (error) throw error;
    if (data) {
      cache.set(wa_id, data);
      return data;
    }
  } catch (e) {
    console.error("DB_GET_CONTACT_ERR", e);
    if (cache.has(wa_id)) return cache.get(wa_id);
  }
  return null;
}

async function upsertContact({ wa_id, name = null, lang = null, last_seen_at = null, human = null }) {
  try {
    const payload = { wa_id, name, lang, last_seen_at: last_seen_at || new Date().toISOString() };
    if (human !== null) payload.human = human;

    const { data, error } = await supabase
      .from("contacts")
      .upsert(payload, { onConflict: "wa_id" })
      .select()
      .single();
    if (error) throw error;
    cache.set(wa_id, data);
    return data;
  } catch (e) {
    console.error("DB_UPSERT_CONTACT_ERR", e);
    const fallback = { wa_id, name, lang, human: human ?? false, last_seen_at: last_seen_at || new Date().toISOString() };
    cache.set(wa_id, fallback);
    return fallback;
  }
}

// ---------- TEXTOS ----------
const TEXTS = {
  ask_name: {
    pt: "Oi! Como posso te chamar? 😊 (responda com seu primeiro nome)",
    en: "Hi! How should I call you? 😊 (please reply with your first name)",
    es: "¡Hola! ¿Cómo puedo llamarte? 😊 (responde con tu primer nombre)"
  },
  ack_set_name: {
    pt: (n) => `Obrigado, ${n}!`,
    en: (n) => `Thanks, ${n}!`,
    es: (n) => `¡Gracias, ${n}!`
  },
  out_of_hours: {
    pt: "Atendemos de 9h às 18h (GMT-3). Já já te respondemos. ⏰",
    es: "Atendemos de 9h a 18h (GMT-3). Te respondemos pronto. ⏰",
    en: "We’re available 9am–6pm (GMT-3). We’ll get back soon. ⏰"
  },
  human_on: {
    pt: "Certo! Vou te passar para um atendente humano. 🙋‍♂️",
    es: "¡De acuerdo! Te paso con un humano. 🙋‍♂️",
    en: "Okay! I’ll hand you to a human agent. 🙋‍♂️"
  }
};

// ---------- MESSAGES (histórico) ----------
async function logMessage({ wa_id, role, content, msg_id = null }) {
  try {
    const { error } = await supabase.from("messages").insert({ wa_id, role, content, msg_id });
    if (error) throw error;
  } catch (e) {
    // 23505 = unique violation (dedup)
    if (e?.code === "23505") {
      console.warn("DUP_EVENT_SKIP", msg_id);
      return "dup";
    }
    console.error("DB_LOG_MESSAGE_ERR", e);
  }
  return "ok";
}

async function getRecentMessages(wa_id, limit = 6) {
  try {
    const { data, error } = await supabase
      .from("messages")
      .select("role, content")
      .eq("wa_id", wa_id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data || []).slice().reverse(); // cronológica
  } catch (e) {
    console.error("DB_GET_MESSAGES_ERR", e);
    return [];
  }
}

// ---------- WhatsApp SEND ----------
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = { messaging_product: "whatsapp", to, type: "text", text: { body } };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.error("WA_SEND_ERROR", resp.status, err);
    }
  } catch (e) {
    console.error("WA_SEND_EXCEPTION", e);
  }
}

async function sendTemplate(to, templateName, langCode = "pt_BR") {
  const url = `https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to, type: "template",
    template: { name: templateName, language: { code: langCode } }
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const err = await resp.text().catch(() => "");
      console.error("WA_SEND_TEMPLATE_ERROR", resp.status, err);
    }
  } catch (e) {
    console.error("WA_SEND_TEMPLATE_EXCEPTION", e);
  }
}

// ---------- Idioma ----------
async function detectLang(text) {
  const t = (text || "").trim().toLowerCase();
  if (/[¿¡]/.test(t) || /\b(hola|disponibilidad|gracias|buen[oa]s|precio)\b/.test(t)) return "es";
  if (/\b(hi|hello|thanks|availability|price|book|schedule)\b/.test(t)) return "en";
  if (/\b(oi|olá|obrigad[oa]|disponibilidade|agenda|preço)\b/.test(t) || /[áâãéêíóôõúç]/.test(t)) return "pt";

  if (process.env.OPENAI_API_KEY) {
    try {
      const body = {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: "Return ONLY one code: en, pt, or es." },
          { role: "user", content: `Text: ${text}` }
        ]
      };
      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      const code = (data?.output_text || "").trim().toLowerCase();
      if (["en","pt","es"].includes(code)) return code;
    } catch (_) {}
  }
  return "en";
}

// ---------- Replies ----------
function defaultReply(lang, name) {
  if (lang === "pt") return name ? `Oi, ${name}! Já estou verificando as opções para você. 😊`
                                : "Recebi sua mensagem e já estou verificando as opções para você. 😊";
  if (lang === "es") return name ? `¡Hola, ${name}! Ya estoy revisando opciones para ti. 😊`
                                : "Recibí tu mensaje y ya estoy revisando opciones para ti. 😊";
  return name ? `Hi, ${name}! I'm checking options for you now. 😊`
              : "Got your message — I’m checking options for you now. 😊";
}

// ---------- Agente (com histórico) ----------
async function callAgent({ message, profile }) {
  const lang = profile.lang || "en";
  const name = profile.name || "";
  const history = await getRecentMessages(profile.wa_id, 6);

  // Agent Builder
  if (process.env.AGENT_ID && process.env.OPENAI_API_KEY) {
    try {
      const resp = await fetch(`https://api.openai.com/v1/agents/${process.env.AGENT_ID}/responses`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: message,
          instructions: `Responda SEMPRE em ${lang}. Cumprimente pelo nome se souber e use o contexto recente.`,
          metadata: { customer_name: name, customer_lang: lang },
          messages: history.map(m => ({ role: m.role, content: m.content }))
        })
      });
      const data = await resp.json();
      return data?.output_text || defaultReply(lang, name);
    } catch (_) { return defaultReply(lang, name); }
  }

  // Responses API
  if (process.env.OPENAI_API_KEY) {
    try {
      const sys = `Você é um agente de suporte. Responda SEMPRE em ${lang}.
Cumprimente ${name ? `“${name}”` : "o cliente pelo nome se souber"} de forma natural e breve. Use o histórico abaixo.`;
      const input = [{ role: "system", content: sys }];
      history.forEach(m => input.push({ role: m.role, content: m.content }));
      input.push({ role: "user", content: message });

      const body = { model: process.env.OPENAI_MODEL || "gpt-4o-mini", input };
      const resp = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      const data = await resp.json();
      return data?.output_text || defaultReply(lang, name);
    } catch (_) { return defaultReply(lang, name); }
  }

  // Sem OpenAI
  return defaultReply(lang, name);
}

// ======= Horário de atendimento =======
const BUSINESS_TZ     = process.env.BUSINESS_TZ || 'America/New_York';
const BUSINESS_START  = Number(process.env.BUSINESS_START ?? 9);   // 0–23
const BUSINESS_END    = Number(process.env.BUSINESS_END   ?? 18);  // 0–23

function hourInTZ(tz) {
  // retorna a hora 0–23 no fuso indicado
  return Number(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: 'numeric'
  }).format(new Date()));
}

function isOutsideBusinessHours() {
  const h = hourInTZ(BUSINESS_TZ);
  // log de diagnóstico
  console.log('SCHEDULE', { tz: BUSINESS_TZ, start: BUSINESS_START, end: BUSINESS_END, nowHour: h });
  return (h < BUSINESS_START) || (h >= BUSINESS_END);
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vinny_verify_1";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).end(challenge);
    }
    return res.status(403).end();
  }

  if (req.method === "POST") {
    try {
      const entry   = req.body?.entry?.[0];
      const change  = entry?.changes?.[0];
      const value   = change?.value;
      const messages = value?.messages;

      if (Array.isArray(messages) && messages.length) {
        const msg   = messages[0];
        const from  = msg.from;                 // wa_id
        const text  = msg.text?.body || "";
        const type  = msg.type;
        const msgId = msg.id;                   // p/ deduplicação

        // dedup (insere já como 'user')
        const dedup = await logMessage({ wa_id: from, role: "user", content: text, msg_id: msgId });
        if (dedup === "dup") return res.status(200).end();

        // perfil
        let profile = await getContact(from);
        if (!profile) profile = { wa_id: from, name: null, lang: null, last_seen_at: null, human: false };

        // idioma
        if (!profile.lang && text) {
          profile.lang = await detectLang(text);
        }

        // nome vindo do payload de contacts
        const maybeName = value?.contacts?.[0]?.profile?.name;
        if (!profile.name && maybeName) profile.name = maybeName;

        // --- Fora do horário? manda aviso e encerra ---
if (isOutsideBusinessHours()) {
  const ooo =
    (profile.lang === 'pt') ? 'Nosso horário é 9h–18h (BRT). Assim que estivermos online, te respondemos. 😊' :
    (profile.lang === 'es') ? 'Nuestro horario es 9h–18h (BRT). Te respondemos cuando estemos en línea. 😊' :
                              'Our hours are 9am–6pm (BRT). We’ll get back to you when we’re online. 😊';

  await sendWhatsAppText(from, ooo);
  await logMessage(from, 'assistant', ooo);
  return res.status(200).end();   // MUITO importante para não cair no agente
}

        // handoff: pedido do cliente ("humano", "atendente", "human")
        if (/^(humano|atendente|human)$/i.test(text)) {
          profile.human = true;
          await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, human: true });
          await sendWhatsAppText(from,
            profile.lang === "es" ? TEXTS.human_on.es :
            profile.lang === "pt" ? TEXTS.human_on.pt :
                                    TEXTS.human_on.en
          );
          await logMessage({ wa_id: from, role: "assistant", content:
            profile.lang === "es" ? TEXTS.human_on.es :
            profile.lang === "pt" ? TEXTS.human_on.pt :
                                    TEXTS.human_on.en
          });
          return res.status(200).end();
        }

        // se já estiver em modo humano, não chamar LLM
        if (profile.human) {
          await upsertContact({ wa_id: from, last_seen_at: new Date().toISOString() });
          return res.status(200).end();
        }

        // inferir nome pela frase livre
        if (!profile.name) {
          const namePattern = /^[a-zA-ZÀ-ÿ' ]{2,30}$/;
          if (/^meu nome é\s+/i.test(text) || /^mi nombre es\s+/i.test(text) || /^my name is\s+/i.test(text) || namePattern.test(text)) {
            const cleaned = text.replace(/^meu nome é\s+|^mi nombre es\s+|^my name is\s+/i, "").trim();
            profile.name = cleaned.split(" ")[0];
            await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });
            await sendWhatsAppText(from, TEXTS.ack_set_name[profile.lang || "en"](profile.name));
            await logMessage({ wa_id: from, role: "assistant", content: TEXTS.ack_set_name[profile.lang || "en"](profile.name) });
            return res.status(200).end();
          } else if (type === "text") {
            await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });
            await sendWhatsAppText(from, TEXTS.ask_name[profile.lang || "en"]);
            await logMessage({ wa_id: from, role: "assistant", content: TEXTS.ask_name[profile.lang || "en"] });
            return res.status(200).end();
          }
        }

        // fora do horário → resposta automática
        if (!isOpenNow()) {
          const out = profile.lang === "es" ? TEXTS.out_of_hours.es :
                      profile.lang === "pt" ? TEXTS.out_of_hours.pt :
                                              TEXTS.out_of_hours.en;
          await sendWhatsAppText(from, out);
          await logMessage({ wa_id: from, role: "assistant", content: out });
          await upsertContact({ wa_id: from, last_seen_at: new Date().toISOString() });
          return res.status(200).end();
        }

        // persistir last_seen
        await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });

        // resposta com histórico
        const reply = await callAgent({ message: text, profile });
        await sendWhatsAppText(from, reply);
        await logMessage({ wa_id: from, role: "assistant", content: reply });
      }

      return res.status(200).end();
    } catch (e) {
      console.error("WEBHOOK_ERROR", e);
      return res.status(200).end(); // evita re-tentativas
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
}
