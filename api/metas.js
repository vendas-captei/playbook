// Metas mensais por funil — lê/grava metas.json no repo via GitHub API.
// Mesmo padrão de api/users.js (usa a env GITHUB_TOKEN já existente no projeto).
// GET  /api/metas            -> { metas: { "<pipelineId>": <valor> } }
// POST /api/metas {pipelineId, valor} -> grava e devolve { ok, metas }
const OWNER = "vendas-captei";
const REPO = "playbook";
const FILE = "metas.json";
const GH = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${FILE}`;

async function readFile(tok) {
  const r = await fetch(GH, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "PlaybookApp",
    },
    cache: "no-store",
  });
  if (r.status === 404) return { metas: {}, sha: null };
  if (!r.ok) throw new Error(`GitHub ${r.status} ao ler metas.json`);
  const j = await r.json();
  const text = Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8");
  return { metas: JSON.parse(text || "{}"), sha: j.sha };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) {
    res.status(500).json({ error: "GITHUB_TOKEN não configurado na Vercel" });
    return;
  }
  try {
    if (req.method === "GET") {
      const { metas } = await readFile(tok);
      res.status(200).json({ metas });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      await new Promise((resolve) => {
        req.on("data", (c) => (body += c));
        req.on("end", resolve);
      });
      const { pipelineId, valor } = JSON.parse(body || "{}");
      const pid = String(Number(pipelineId));
      const v = Number(valor);
      if (pid === "NaN" || isNaN(v) || v < 0) {
        res.status(400).json({ error: "pipelineId e valor válidos são obrigatórios" });
        return;
      }
      const { metas, sha } = await readFile(tok);
      metas[pid] = v;
      const content = Buffer.from(JSON.stringify(metas, null, 2)).toString("base64");
      const payload = {
        message: `chore: meta funil ${pid} = ${v}`,
        content,
        ...(sha ? { sha } : {}),
      };
      const pr = await fetch(GH, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${tok}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "PlaybookApp",
        },
        body: JSON.stringify(payload),
      });
      if (!pr.ok) {
        const t = await pr.text();
        res.status(500).json({ error: `GitHub PUT ${pr.status}`, detail: t });
        return;
      }
      res.status(200).json({ ok: true, metas });
      return;
    }
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
