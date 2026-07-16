// Forecast Call — commit qualitativo do vendedor/gestor (metodologia: múltiplos métodos, quali + quanti).
// Grava fccommit.json no repo (padrão de api/metas.js). Chave: funil > mês > escopo ("geral" ou userId).
// GET  /api/fccommit?pipeline_id=7&month=2026-07&user_id= -> { valor, atualizadoEm, por }
// POST /api/fccommit { pipelineId, month, userId?, valor, por } -> grava
const OWNER = "vendas-captei", REPO = "playbook", FILE = "fccommit.json";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;
// Cadências (editor No-Code compartilhado) vivem em data/cadencias.json — mesmo endpoint p/ ficar no limite de 12 funções.
const CAD_PATH = "data/cadencias.json";
const CAD_GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${CAD_PATH}`;

async function ghReadRaw(url, tok, label) {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store" });
  if (r.status === 404) return { data: null, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status} ao ler ${label}`);
  const j = await r.json();
  return { data: JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "null"), sha: j.sha };
}

async function readFile(tok) {
  const { data, sha } = await ghReadRaw(GH, tok, "fccommit.json");
  return { data: data || {}, sha };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) { res.status(500).json({ error: "GITHUB_TOKEN não configurado na Vercel" }); return; }
  try {
    // ── Cadências (No-Code editável e compartilhado) ──
    const isCadGet = req.method === "GET" && new URL(req.url, "http://localhost").searchParams.get("kind") === "cadencias";
    if (isCadGet) {
      const { data } = await ghReadRaw(CAD_GH, tok, "cadencias.json");
      res.status(200).json(data || { tracks: [] });
      return;
    }
    if (req.method === "POST") {
      let peek = ""; await new Promise((r) => { req.on("data", (c) => (peek += c)); req.on("end", r); });
      const pb = JSON.parse(peek || "{}");
      if (pb.kind === "cadencias") {
        if (!pb.data || !Array.isArray(pb.data.tracks)) { res.status(400).json({ error: "data.tracks (array) obrigatório" }); return; }
        const { sha } = await ghReadRaw(CAD_GH, tok, "cadencias.json");
        const payload = { updatedAt: new Date().toISOString(), updatedBy: pb.por || "", tracks: pb.data.tracks };
        const content = Buffer.from(JSON.stringify(payload, null, 2)).toString("base64");
        const pr = await fetch(CAD_GH, { method: "PUT", headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "PlaybookApp" }, body: JSON.stringify({ message: `chore: editar cadências (Captação Ativa)${pb.por ? " — " + pb.por : ""}`, content, ...(sha ? { sha } : {}) }) });
        if (!pr.ok) { res.status(500).json({ error: `GitHub PUT ${pr.status}`, detail: await pr.text() }); return; }
        res.status(200).json({ ok: true, updatedAt: payload.updatedAt });
        return;
      }
      // não-cadências: repassa o corpo já lido para o fluxo antigo
      req._prebody = peek;
    }
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
      const b = JSON.parse(req._prebody || "{}");
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
