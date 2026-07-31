// Probabilidades por etapa do Forecast — Firestore `store`/`fcparams` (antes: fcparams.json no repo).
// GET  /api/fcparams -> { params: { "<pid>": { "<stageId>": prob% } } } (defaults mesclados)
// POST /api/fcparams { pipelineId, probs: { "<stageId>": prob% } } -> merge por etapa e grava
const { readJson, writeJson, readBody } = require("../lib/store");
const ORIGEM = "fcparams.json";

// Defaults iguais aos de api/forecast.js (curva típica B2B, editável pela Gestão).
const DEFAULTS = {
  "7": { 37: 5, 38: 8, 39: 12, 40: 20, 41: 35, 144: 10, 42: 50, 43: 65, 79: 85, 80: 95 },
  "2": { 6: 5, 149: 8, 7: 12, 8: 20, 9: 35, 10: 10, 100: 50, 101: 65, 102: 85, 150: 95 },
};

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
  try {
    if (req.method === "GET") {
      res.status(200).json({ params: merge((await readJson(ORIGEM)) || {}) });
      return;
    }
    if (req.method === "POST") {
      const b = await readBody(req);
      const pid = String(Number(b.pipelineId));
      if (pid === "NaN") { res.status(400).json({ error: "pipelineId obrigatório" }); return; }
      if (!b.probs || typeof b.probs !== "object") { res.status(400).json({ error: "probs obrigatório" }); return; }
      const params = (await readJson(ORIGEM)) || {};
      const cur = { ...(DEFAULTS[pid] || {}), ...(params[pid] || {}) };
      for (const [sid, val] of Object.entries(b.probs)) {
        const n = Number(val);
        if (!isNaN(n) && n >= 0 && n <= 100) cur[sid] = Math.round(n);
      }
      params[pid] = cur;
      await writeJson(ORIGEM, params);
      res.status(200).json({ ok: true, params: merge(params) });
      return;
    }
    res.status(405).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
};
