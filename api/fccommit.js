// Forecast Call — commit qualitativo do vendedor/gestor (metodologia: múltiplos métodos, quali + quanti).
// Grava fccommit.json no repo (padrão de api/metas.js). Chave: funil > mês > escopo ("geral" ou userId).
// GET  /api/fccommit?pipeline_id=7&month=2026-07&user_id= -> { valor, atualizadoEm, por }
// POST /api/fccommit { pipelineId, month, userId?, valor, por } -> grava
const OWNER = "vendas-captei", REPO = "playbook", FILE = "fccommit.json";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

async function readFile(tok) {
  const r = await fetch(GH, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store" });
  if (r.status === 404) return { data: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status} ao ler fccommit.json`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "{}"), sha: j.sha };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) { res.status(500).json({ error: "GITHUB_TOKEN não configurado na Vercel" }); return; }
  try {
    if (req.method === "GET") {
      const u = new URL(req.url, "http://localhost");
      const pid = String(Number(u.searchParams.get("pipeline_id")) || 7);
      const month = u.searchParams.get("month") || "";
      const escopo = u.searchParams.get("user_id") || "geral";
      const { data } = await readFile(tok);
      const rec = (((data[pid] || {})[month] || {})[escopo]) || null;
      res.status(200).json(rec || { valor: null });
      return;
    }
    if (req.method === "POST") {
      let body = ""; await new Promise((r) => { req.on("data", (c) => (body += c)); req.on("end", r); });
      const b = JSON.parse(body || "{}");
      const pid = String(Number(b.pipelineId));
      const month = String(b.month || "");
      const escopo = b.userId ? String(b.userId) : "geral";
      if (pid === "NaN" || !/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: "pipelineId e month obrigatórios" }); return; }
      const valor = Number(b.valor);
      if (isNaN(valor) || valor < 0) { res.status(400).json({ error: "valor inválido" }); return; }
      const { data, sha } = await readFile(tok);
      data[pid] = data[pid] || {}; data[pid][month] = data[pid][month] || {};
      data[pid][month][escopo] = { valor: Math.round(valor), por: b.por || "", atualizadoEm: new Date().toISOString() };
      const content = Buffer.from(JSON.stringify(data, null, 2)).toString("base64");
      const pr = await fetch(GH, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "PlaybookApp" }, body: JSON.stringify({ message: `chore: forecast call funil ${pid} ${month}`, content, ...(sha ? { sha } : {}) }) });
      if (!pr.ok) { res.status(500).json({ error: `GitHub PUT ${pr.status}`, detail: await pr.text() }); return; }
      res.status(200).json({ ok: true, valor: data[pid][month][escopo].valor });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
