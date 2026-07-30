// Probabilidades por etapa do Forecast — lê/grava fcparams.json no repo (padrão de api/params.js).
// GET  /api/fcparams -> { params: { "<pid>": { "<stageId>": prob% } } } (defaults mesclados)
// POST /api/fcparams { pipelineId, probs: { "<stageId>": prob% } } -> merge por etapa e grava
const OWNER = "vendas-captei", REPO = "playbook", FILE = "fcparams.json";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

// Defaults iguais aos de api/forecast.js (curva típica B2B, editável pela Gestão).
const DEFAULTS = {
  "7": { 37: 5, 38: 8, 39: 12, 40: 20, 41: 35, 144: 10, 42: 50, 43: 65, 79: 85, 80: 95 },
  "2": { 6: 5, 149: 8, 7: 12, 8: 20, 9: 35, 10: 10, 100: 50, 101: 65, 102: 85, 150: 95 },
};

async function readFile(tok) {
  const r = await fetch(GH, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store" });
  if (r.status === 404) return { params: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status} ao ler fcparams.json`);
  const j = await r.json();
  const text = Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { params: JSON.parse(text || "{}"), sha: j.sha };
}

// Mescla defaults + salvos por funil (por etapa), sem perder etapas não editadas.
function merge(saved) {
  const out = {};
  for (const pid of new Set([...Object.keys(DEFAULTS), ...Object.keys(saved || {})])) {
    out[pid] = { ...(DEFAULTS[pid] || {}), ...((saved || {})[pid] || {}) };
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) { res.status(500).json({ error: "GITHUB_TOKEN não configurado na Vercel" }); return; }
  try {
    if (req.method === "GET") {
      const { params } = await readFile(tok);
      res.status(200).json({ params: merge(params) });
      return;
    }
    if (req.method === "POST") {
      let body = ""; await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
      const b = JSON.parse(body || "{}");
      const pid = String(Number(b.pipelineId));
      if (pid === "NaN") { res.status(400).json({ error: "pipelineId obrigatório" }); return; }
      if (!b.probs || typeof b.probs !== "object") { res.status(400).json({ error: "probs obrigatório" }); return; }
      const { params, sha } = await readFile(tok);
      const cur = { ...(DEFAULTS[pid] || {}), ...(params[pid] || {}) };
      for (const [sid, val] of Object.entries(b.probs)) {
        const n = Number(val);
        if (!isNaN(n) && n >= 0 && n <= 100) cur[sid] = Math.round(n);
      }
      params[pid] = cur;
      const content = Buffer.from(JSON.stringify(params, null, 2)).toString("base64");
      const pr = await fetch(GH, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "PlaybookApp" }, body: JSON.stringify({ message: `chore: probabilidades forecast funil ${pid}`, content, ...(sha ? { sha } : {}) }) });
      if (!pr.ok) { res.status(500).json({ error: `GitHub PUT ${pr.status}`, detail: await pr.text() }); return; }
      res.status(200).json({ ok: true, params: merge(params) });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
