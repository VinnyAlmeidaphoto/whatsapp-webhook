export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vinny_verify_1";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge); // devolve SOMENTE o challenge
    }
    return res.sendStatus(403);
  }

  if (req.method === "POST") {
    try {
      // Aqui chegam os eventos/mensagens do WhatsApp
      // Ex.: console.log(JSON.stringify(req.body, null, 2));
      return res.sendStatus(200);
    } catch (e) {
      return res.sendStatus(500);
    }
  }

  return res.setHeader("Allow", "GET, POST").status(405).end("Method Not Allowed");
}
