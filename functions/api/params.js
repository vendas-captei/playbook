// Parâmetros do funil reverso (Receita Previsível) por funil — lê/grava params.json no repo.
// Mesmo padrão de api/metas.js (usa a env GITHUB_TOKEN já existente no projeto).
// GET  /api/params -> { params: { "<pid>": { taxaReuniaoVenda, taxaLeadReuniao, ticketRef } } }
// POST /api/params { pipelineId, taxaReuniaoVenda?, taxaLeadReuniao?, ticketRef? } -> merge e grava
const OWNER = "vendas-captei", REPO = "playbook", FILE = "params.json";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

// Defaults (premissas iniciais, editáveis pela Gestão). Fonte: medição jan–jun/2026.
const DEFAULTS = {
  "7": { taxaReuniaoVenda: 0.85, taxaLeadReuniao: 0.30, ticketRef: 2950, convLeadVenda: 0.21 },
  "2": { taxaReuniaoVenda: 0.85, taxaLeadReuniao: 0.30, ticketRef: 2950, convLeadVenda: 0.21 },
};

async function readFile(tok) {
  const r = await fetch(GH, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store" });
  if (r.status === 404) return { params: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status} ao ler params.json`);
  const j = await r.json();
  const text = Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { params: JSON.parse(text || "{}"), sha: j.sha };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) { res.status(500).json({ error: "GITHUB_TOKEN não configurado na Vercel" }); return; }
  try {
    if (req.method === "GET") {
      const { params } = await readFile(tok);
      res.status(200).json({ params: { ...DEFAULTS, ...params } });
      return;
    }
    if (req.method === "POST") {
      let body = ""; await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
      const b = JSON.parse(body || "{}");
      const pid = String(Number(b.pipelineId));
      if (pid === "NaN") { res.status(400).json({ error: "pipelineId obrigatório" }); return; }
      const { params, sha } = await readFile(tok);
      const cur = { ...(DEFAULTS[pid] || DEFAULTS["7"]), ...(params[pid] || {}) };
      const rate = (x) => (typeof x === "number" && x > 0 && x <= 1 ? x : null);
      if (rate(b.taxaReuniaoVenda) != null) cur.taxaReuniaoVenda = b.taxaReuniaoVenda;
      if (rate(b.taxaLeadReuniao) != null) cur.taxaLeadReuniao = b.taxaLeadReuniao;
      if (rate(b.convLeadVenda) != null) cur.convLeadVenda = b.convLeadVenda;
      if (typeof b.ticketRef === "number" && b.ticketRef > 0) cur.ticketRef = Math.round(b.ticketRef);
      params[pid] = cur;
      const content = Buffer.from(JSON.stringify(params, null, 2)).toString("base64");
      const pr = await fetch(GH, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "PlaybookApp" }, body: JSON.stringify({ message: `chore: params funil ${pid}`, content, ...(sha ? { sha } : {}) }) });
      if (!pr.ok) { res.status(500).json({ error: `GitHub PUT ${pr.status}`, detail: await pr.text() }); return; }
      res.status(200).json({ ok: true, params: { ...DEFAULTS, ...params } });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
