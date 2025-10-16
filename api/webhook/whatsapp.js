import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// cache opcional em memória p/ fallback
const cache = new Map(); // key: wa_id → { wa_id, name, lang, last_seen_at }

// ------------- CONTACTS -------------
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

async function upsertContact({ wa_id, name = null, lang = null, last_seen_at = null }) {
  try {
    const payload = { wa_id, name, lang, last_seen_at: last_seen_at || new Date().toISOString() };
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
    const fallback = { wa_id, name, lang, last_seen_at: last_seen_at || new Date().toISOString() };
    cache.set(wa_id, fallback);
    return fallback;
  }
}

// ------------- TEXTOS BÁSICOS -------------
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
  }
};

// ------------- HISTÓRICO (messages) -------------
async function logMessage(wa_id, role, content) {
  try {
    const { error } = await supabase.from("messages").insert({ wa_id, role, content });
    if (error) throw error;
  } catch (e) {
    console.error("DB_LOG_MESSAGE_ERR", e);
  }
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

// ------------- WHATSAPP SEND -------------
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
      return;
    }
    const ok = await resp.json().catch(() => ({}));
    console.log("WA_SEND_OK", ok);
  } catch (e) {
    console.error("WA_SEND_EXCEPTION", e);
  }
}

// ------------- DETECÇÃO DE IDIOMA -------------
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

// ------------- REPLIES -------------
function defaultReply(lang, name) {
  if (lang === "pt") return name ? `Oi, ${name}! Já estou verificando as opções para você. 😊`
                                : "Recebi sua mensagem e já estou verificando as opções para você. 😊";
  if (lang === "es") return name ? `¡Hola, ${name}! Ya estoy revisando opciones para ti. 😊`
                                : "Recibí tu mensaje y ya estoy revisando opciones para ti. 😊";
  return name ? `Hi, ${name}! I'm checking options for you now. 😊`
              : "Got your message — I’m checking options for you now. 😊";
}

// ------------- AGENTE (com histórico) -------------
async function callAgent({ message, profile }) {
  const lang = profile.lang || "en";
  const name = profile.name || "";
  const history = await getRecentMessages(profile.wa_id, 6);

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

  return defaultReply(lang, name);
}

// ------------- HANDLER -------------
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
      const entry = req.body?.entry?.[0];
      const change = entry?.changes?.[0];
      const value = change?.value;
      const messages = value?.messages;

      if (Array.isArray(messages) && messages.length) {
        const msg  = messages[0];
        const from = msg.from;                   // wa_id
        const text = msg.text?.body || "";
        const type = msg.type;

        // Carrega/Cria perfil persistente
        let profile = await getContact(from);
        if (!profile) {
          profile = { wa_id: from, name: null, lang: null, last_seen_at: null };
        }

        // 1) Idioma
        if (!profile.lang && text) {
          profile.lang = await detectLang(text); // "en" | "pt" | "es"
        }

        // 2) Nome do payload
        const maybeName = value?.contacts?.[0]?.profile?.name;
        if (!profile.name && maybeName) profile.name = maybeName;

        // 3) Inferir nome se usuário digitou
        if (!profile.name) {
          const namePattern = /^[a-zA-ZÀ-ÿ' ]{2,30}$/;
          if (/^meu nome é\s+/i.test(text) || /^mi nombre es\s+/i.test(text) || /^my name is\s+/i.test(text) || namePattern.test(text)) {
            const cleaned = text.replace(/^meu nome é\s+|^mi nombre es\s+|^my name is\s+/i, "").trim();
            profile.name = cleaned.split(" ")[0];
            await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });
            await sendWhatsAppText(from, TEXTS.ack_set_name[profile.lang || "en"](profile.name));
          } else if (type === "text") {
            await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });
            await sendWhatsAppText(from, TEXTS.ask_name[profile.lang || "en"]);
            return res.status(200).end();
          }
        }

        // 4) Persistir last_seen
        await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });

        // 5) Registrar e responder usando histórico
        await logMessage(from, "user", text);
        const reply = await callAgent({ message: text, profile });
        await sendWhatsAppText(from, reply);
        await logMessage(from, "assistant", reply);
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
