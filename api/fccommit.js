// Forecast Call — commit qualitativo do vendedor/gestor (metodologia: múltiplos métodos, quali + quanti).
// Firestore `store`/`fccommit` (antes: fccommit.json no repo). Chave: funil > mês > escopo ("geral" ou userId).
// GET  /api/fccommit?pipeline_id=7&month=2026-07&user_id= -> { valor, atualizadoEm, por }
// POST /api/fccommit { pipelineId, month, userId?, valor, por } -> grava
const { readJson, writeJson, readBody } = require("../lib/store");
const ORIGEM = "fccommit.json";
// Cadências (editores No-Code compartilhados) — cada "kind" mapeia um doc do store. Mesmo endpoint p/ ficar no limite de 12 funções.
const CAD_FILES = { "cadencias": "data/cadencias.json", "cadencias-copiloto": "data/cadencias-copiloto.json" };
const CAD_LABELS = { "cadencias": "Captação Ativa", "cadencias-copiloto": "Copiloto" };

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    // ── Cadências (No-Code editável e compartilhado) — GET por kind ──
    const cadKind = req.method === "GET" ? new URL(req.url, "http://localhost").searchParams.get("kind") : null;
    if (cadKind && CAD_FILES[cadKind]) {
      const data = await readJson(CAD_FILES[cadKind]);
      res.status(200).json(data || { tracks: [] });
      return;
    }
    if (req.method === "POST") {
      const pb = await readBody(req);
      // ── Cadências — POST por kind ──
      if (pb.kind && CAD_FILES[pb.kind]) {
        if (!pb.data || !Array.isArray(pb.data.tracks)) { res.status(400).json({ error: "data.tracks (array) obrigatório" }); return; }
        const payload = { updatedAt: new Date().toISOString(), updatedBy: pb.por || "", tracks: pb.data.tracks };
        await writeJson(CAD_FILES[pb.kind], payload);
        res.status(200).json({ ok: true, updatedAt: payload.updatedAt, escopo: CAD_LABELS[pb.kind] || pb.kind });
        return;
      }
      // não-cadências: segue para o fluxo de forecast call com o corpo já lido
      req._prebody = pb;
    }
    if (req.method === "GET") {
      const u = new URL(req.url, "http://localhost");
      const pid = String(Number(u.searchParams.get("pipeline_id")) || 7);
      const month = u.searchParams.get("month") || "";
      const escopo = u.searchParams.get("user_id") || "geral";
      const data = (await readJson(ORIGEM)) || {};
      const rec = (((data[pid] || {})[month] || {})[escopo]) || null;
      res.status(200).json(rec || { valor: null });
      return;
    }
    if (req.method === "POST") {
      const b = req._prebody || {};
      const pid = String(Number(b.pipelineId));
      const month = String(b.month || "");
      const escopo = b.userId ? String(b.userId) : "geral";
      if (pid === "NaN" || !/^\d{4}-\d{2}$/.test(month)) { res.status(400).json({ error: "pipelineId e month obrigatórios" }); return; }
      const valor = Number(b.valor);
      if (isNaN(valor) || valor < 0) { res.status(400).json({ error: "valor inválido" }); return; }
      const data = (await readJson(ORIGEM)) || {};
      data[pid] = data[pid] || {}; data[pid][month] = data[pid][month] || {};
      data[pid][month][escopo] = { valor: Math.round(valor), por: b.por || "", atualizadoEm: new Date().toISOString() };
      await writeJson(ORIGEM, data);
      res.status(200).json({ ok: true, valor: data[pid][month][escopo].valor });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
