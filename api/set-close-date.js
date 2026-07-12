// Grava a data prevista de fechamento no card (campo expected_close_date do Pipedrive).
// POST /api/set-close-date { deal_id, date: "YYYY-MM-DD" }
const V1 = "https://api.pipedrive.com/v1";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).end(); return; }
  const TK = process.env.PIPEDRIVE_API_TOKEN;
  if (!TK) { res.status(500).json({ error: "PIPEDRIVE_API_TOKEN ausente na Vercel" }); return; }
  try {
    let body = ""; await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
    const b = JSON.parse(body || "{}");
    const dealId = Number(b.deal_id);
    const date = String(b.date || "");
    if (!dealId || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { res.status(400).json({ error: "deal_id e date (YYYY-MM-DD) obrigatórios" }); return; }
    const r = await fetch(`${V1}/deals/${dealId}?api_token=${TK}`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expected_close_date: date }),
    });
    const j = await r.json();
    if (!r.ok || !j.success) { res.status(500).json({ error: `Pipedrive ${r.status}: ${JSON.stringify(j).slice(0, 200)}` }); return; }
    res.status(200).json({ ok: true, dealId, expected_close_date: (j.data && j.data.expected_close_date) || date });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
