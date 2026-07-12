// Histórico congelado do Forecast (data/forecast-history.json). Leitura pública p/ a aba Forecast.
// GET /api/fc-history[?pipeline_id=7] -> série de meses { forecastInicial, fechamento } por funil.
const REPO = "vendas-captei/playbook", PATH = "data/forecast-history.json";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  try {
    let hist = {};
    if (tok) {
      const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
        headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store",
      });
      if (r.ok) { const j = await r.json(); hist = JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "{}"); }
      else if (r.status !== 404) throw new Error(`GitHub ${r.status}`);
    }
    const u = new URL(req.url, "http://localhost");
    const pid = u.searchParams.get("pipeline_id");
    if (pid) { res.status(200).json({ pipelineId: pid, meses: hist[pid] || {}, _meta: hist._meta || {} }); return; }
    res.status(200).json(hist);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
