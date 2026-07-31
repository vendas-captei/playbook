// Metas mensais por funil — lê/grava no Firestore, coleção `store`, doc `metas` (ver lib/store.js).
// Antes lia/gravava metas.json no repo via GitHub API; a troca tirou o GITHUB_TOKEN do caminho
// crítico (um token revogado derrubou o painel inteiro em 30/07/2026) e acabou com os commits.
// GET  /api/metas            -> { metas: { "<pipelineId>": <valor> } }
// POST /api/metas {pipelineId, valor} -> grava e devolve { ok, metas }
const { readJson, writeJson, readBody } = require("../lib/store");
const ORIGEM = "metas.json";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      res.status(200).json({ metas: (await readJson(ORIGEM)) || {} });
      return;
    }
    if (req.method === "POST") {
      const { pipelineId, valor } = await readBody(req);
      const pid = String(Number(pipelineId));
      const v = Number(valor);
      if (pid === "NaN" || isNaN(v) || v < 0) {
        res.status(400).json({ error: "pipelineId e valor válidos são obrigatórios" });
        return;
      }
      const metas = (await readJson(ORIGEM)) || {};
      metas[pid] = v;
      await writeJson(ORIGEM, metas);
      res.status(200).json({ ok: true, metas });
      return;
    }
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
