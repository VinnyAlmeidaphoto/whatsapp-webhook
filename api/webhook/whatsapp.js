export default async function handler(req, res) {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "vinny_verify_1";

  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).end(challenge); // ✅ nada de sendStatus
    }
    return res.status(403).end();
  }

  if (req.method === "POST") {
    try {
      // console.log("INCOMING", JSON.stringify(req.body));
      return res.status(200).end(); // ✅ responde OK
    } catch (e) {
      console.error("WEBHOOK_ERROR", e);
      return res.status(500).end();
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).end("Method Not Allowed");
}
