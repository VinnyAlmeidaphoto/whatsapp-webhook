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

      // só responde se veio mensagem de usuário
      if (Array.isArray(messages) && messages.length > 0 && messages[0].type === "text") {
        const from = messages[0].from; // wa_id (E.164 sem +)
        await fetch(`https://graph.facebook.com/v20.0/${process.env.PHONE_NUMBER_ID}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.WHATSAPP_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: from,
            type: "text",
            text: { body: "Olá! Recebi sua mensagem ✅" }
          })
        });
      }

      return res.status(200).end();
    } catch (e) {
      console.error("WEBHOOK_ERROR", e);
      return res.status(200).end(); // ainda devolve 200 para evitar re-tentativas
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
}
