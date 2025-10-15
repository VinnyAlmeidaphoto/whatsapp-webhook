import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

// cache opcional em memória p/ fallback
const cache = new Map(); // key: wa_id → { wa_id, name, lang, last_seen_at }

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
    // fallback: cache
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
    // fallback: cache
    const fallback = { wa_id, name, lang, last_seen_at: last_seen_at || new Date().toISOString() };
    cache.set(wa_id, fallback);
    return fallback;
  }
}

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

// -------- util: envio de texto via WhatsApp Cloud API
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

// -------- detecção de idioma com fallback local
async function detectLang(text) {
  const t = (text || "").trim().toLowerCase();

  // Heurística local rápida
  if (/[¿¡]/.test(t) || /\b(hola|disponibilidad|gracias|buen[oa]s|precio)\b/.test(t)) return "es";
  if (/\b(hi|hello|thanks|availability|price|book|schedule)\b/.test(t)) return "en";
  if (/\b(oi|olá|obrigad[oa]|disponibilidade|agenda|preço)\b/.test(t) || /[áâãéêíóôõúç]/.test(t)) return "pt";

  // Só chama OpenAI se houver chave
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
    } catch (_) { /* fallback abaixo */ }
  }
  return "en"; // default seguro
}

// -------- respostas padrão por idioma (fallback)
function defaultReply(lang, name) {
  if (lang === "pt") return name ? `Oi, ${name}! Já estou verificando as opções para você. 😊`
                                : "Recebi sua mensagem e já estou verificando as opções para você. 😊";
  if (lang === "es") return name ? `¡Hola, ${name}! Ya estoy revisando opciones para ti. 😊`
                                : "Recibí tu mensaje y ya estoy revisando opciones para ti. 😊";
  return name ? `Hi, ${name}! I'm checking options for you now. 😊`
              : "Got your message — I’m checking options for you now. 😊";
}

// -------- chamada ao agente / modelo com fallback
async function callAgent({ message, profile, historySnippet }) {
  const lang = profile.lang || "en";
  const name = profile.name || "";

  // 1) Agent Builder (se você tiver AGENT_ID)
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
          instructions: `Responda sempre em ${lang}. Se tiver nome do cliente, cumprimente pelo nome.`,
          metadata: { customer_name: name, customer_lang: lang, history_snippet: historySnippet || "" }
        })
      });
      const data = await resp.json();
      return data?.output_text || defaultReply(lang, name);
    } catch (_) { return defaultReply(lang, name); }
  }

  // 2) Responses API direta (modelo)
  if (process.env.OPENAI_API_KEY) {
    try {
      const sys = `Você é um agente de suporte. Responda sempre em ${lang}. Cumprimente pelo nome se souber.`;
      const body = {
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        input: [
          { role: "system", content: sys },
          { role: "user", content: `customer_name: ${name}` },
          { role: "user", content: `message: ${message}` }
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
      return data?.output_text || defaultReply(lang, name);
    } catch (_) { return defaultReply(lang, name); }
  }

  // 3) Sem OpenAI: sempre responde algo útil
  return defaultReply(lang, name);
}

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
        const msg = messages[0];
        const from = msg.from;               // wa_id
        const text = msg.text?.body || "";
        const type = msg.type;

// Carrega/Cria perfil persistente
let profile = await getContact(from);
if (!profile) {
  profile = { wa_id: from, name: null, lang: null, last_seen_at: null };
}

// 1) Detecta e fixa o idioma se ainda não existir
if (!profile.lang && text) {
  profile.lang = await detectLang(text); // "en" | "pt" | "es"
}

// 2) Tenta obter nome do payload (às vezes vem no contacts)
const maybeName = value?.contacts?.[0]?.profile?.name;
if (!profile.name && maybeName) profile.name = maybeName;

// 3) Se ainda não temos nome, tente inferir quando o usuário responder com um nome simples
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

// Atualiza last_seen e garante persistência
await upsertContact({ wa_id: from, name: profile.name, lang: profile.lang, last_seen_at: new Date().toISOString() });

// 4) Chama o agente com o idioma fixado (ou usa fallback)
const historySnippet = `Última msg: ${text}`;
const reply = await callAgent({ message: text, profile, historySnippet });

// 5) Responde ao cliente
await sendWhatsAppText(from, reply);
      }
      return res.status(200).end();
    } catch (e) {
      console.error("WEBHOOK_ERROR", e);
      // ainda devolve 200 pra evitar re-tentativas
      return res.status(200).end();
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
}
