// Parâmetros do funil reverso (Receita Previsível) por funil — Firestore `store`/`params`.
// Antes: params.json no repo via GitHub API. Ver lib/store.js.
// GET  /api/params -> { params: { "<pid>": { taxaReuniaoVenda, taxaLeadReuniao, ticketRef } } }
// POST /api/params { pipelineId, taxaReuniaoVenda?, taxaLeadReuniao?, ticketRef? } -> merge e grava
const { readJson, writeJson, readBody } = require("../lib/store");
const ORIGEM = "params.json";

// Defaults (premissas iniciais, editáveis pela Gestão). Fonte: medição jan–jun/2026.
const DEFAULTS = {
  "7": { taxaReuniaoVenda: 0.85, taxaLeadReuniao: 0.30, ticketRef: 2950, convLeadVenda: 0.21 },
  "2": { taxaReuniaoVenda: 0.85, taxaLeadReuniao: 0.30, ticketRef: 2950, convLeadVenda: 0.21 },
};

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      const params = (await readJson(ORIGEM)) || {};
      res.status(200).json({ params: { ...DEFAULTS, ...params } });
      return;
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      const pid = String(Number(b.pipelineId));
      if (pid === "NaN") { res.status(400).json({ error: "pipelineId obrigatório" }); return; }
      const params = (await readJson(ORIGEM)) || {};
      const cur = { ...(DEFAULTS[pid] || DEFAULTS["7"]), ...(params[pid] || {}) };
      const rate = (x) => (typeof x === "number" && x > 0 && x <= 1 ? x : null);
      if (rate(b.taxaReuniaoVenda) != null) cur.taxaReuniaoVenda = b.taxaReuniaoVenda;
      if (rate(b.taxaLeadReuniao) != null) cur.taxaLeadReuniao = b.taxaLeadReuniao;
      if (rate(b.convLeadVenda) != null) cur.convLeadVenda = b.convLeadVenda;
      if (typeof b.ticketRef === "number" && b.ticketRef > 0) cur.ticketRef = Math.round(b.ticketRef);
      params[pid] = cur;
      await writeJson(ORIGEM, params);
      res.status(200).json({ ok: true, params: { ...DEFAULTS, ...params } });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
