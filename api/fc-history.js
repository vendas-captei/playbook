// Histórico congelado do Forecast (data/forecast-history.json). Leitura pública p/ a aba Forecast.
// GET /api/fc-history[?pipeline_id=7] -> série de meses { forecastInicial, fechamento } por funil.
// GET /api/fc-history?dataset=accuracy -> Acurácia de Previsão (data/forecast-accuracy.json):
//   Previsto (expected_close_date, as-of via changelog) x Realizado (won) por dia/vendedor/funil.
// GET /api/fc-history?dataset=forecast-log -> Log da Calculadora de Data de Fechamento IA
//   (data/forecast-log.json): previsão da IA x realizado (ganho/perdido) por registro. Ver api/forecast-date.js.
const REPO = "vendas-captei/playbook";
const PATHS = { history: "data/forecast-history.json", accuracy: "data/forecast-accuracy.json", "forecast-log": "data/forecast-log.json" };

async function loadJson(path, tok) {
  if (!tok) return {};
  const r = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store",
  });
  if (r.ok) { const j = await r.json(); return JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "{}"); }
  if (r.status === 404) return {};
  throw new Error(`GitHub ${r.status}`);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  try {
    const u = new URL(req.url, "http://localhost");
    const dataset = u.searchParams.get("dataset");
    if (dataset === "accuracy") {
      res.status(200).json(await loadJson(PATHS.accuracy, tok));
      return;
    }
    if (dataset === "forecast-log" || dataset === "fdlog") {
      res.status(200).json(await loadJson(PATHS["forecast-log"], tok));
      return;
    }
    const hist = await loadJson(PATHS.history, tok);
    const pid = u.searchParams.get("pipeline_id");
    if (pid) { res.status(200).json({ pipelineId: pid, meses: hist[pid] || {}, _meta: hist._meta || {} }); return; }
    res.status(200).json(hist);
  } catch (e) { res.status(500).json({ error: e.message }); }
};
