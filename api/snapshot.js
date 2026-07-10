// Congela o cenário mensal no data/history.json (commit via API do GitHub).
// Uso: GET /api/snapshot?key=<SNAPSHOT_KEY>[&month=YYYY-MM]
//   - default month = mês ANTERIOR ao atual (roda no dia 1 via cron n8n).
//   - MQL/Venda/Faturamento vêm do /api/metrics do mês-alvo (carimbos imutáveis).
//   - SQL/OPP vêm do /api/metrics do mês CORRENTE (foto do estoque de pipeline = estado de fim de mês).
//   - Grava para todos os funis do radar (7 e 2).
// Protegido por SNAPSHOT_KEY (env). Requer GITHUB_TOKEN (env, já existe no projeto).
const REPO = "vendas-captei/playbook";
const PATH = "data/history.json";
const FUNIS = [7, 2];

function baseUrl(req) {
  // Usa o host da requisição (domínio de produção — sem deployment protection).
  // VERCEL_URL (URL do deploy) é protegida e devolve HTML de login → não serve p/ fetch interno.
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `https://${host}`;
  return "https://playbook-comercial-captei.vercel.app";
}

async function getMetrics(base, pid, month) {
  const u = `${base}/api/metrics?pipeline_id=${pid}` + (month ? `&month=${month}` : "");
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`metrics ${r.status} (pid=${pid}, month=${month || "atual"})`);
  return r.json();
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const u = new URL(req.url, "http://localhost");
  if (!process.env.SNAPSHOT_KEY || u.searchParams.get("key") !== process.env.SNAPSHOT_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const GH = process.env.GITHUB_TOKEN;
  if (!GH) { res.status(500).json({ error: "GITHUB_TOKEN ausente" }); return; }

  try {
    // Mês-alvo: parâmetro ou mês anterior (UTC).
    let month = u.searchParams.get("month");
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      const now = new Date();
      const y = now.getUTCFullYear(), m = now.getUTCMonth(); // 0-11
      const py = m === 0 ? y - 1 : y, pm = m === 0 ? 12 : m;  // mês anterior
      month = `${py}-${String(pm).padStart(2, "0")}`;
    }
    const base = baseUrl(req);

    // Coleta por funil: mês-alvo (mql/venda/fat) + mês corrente (sql/opp/estoque).
    const registros = {};
    for (const pid of FUNIS) {
      const [alvo, atual] = await Promise.all([getMetrics(base, pid, month), getMetrics(base, pid, null)]);
      const g = alvo.geracao || {};
      const gh = atual.geracao || {};
      registros[pid] = {
        mql: g.mql ?? null,
        sql: gh.sql ?? null,          // estoque atual = foto de fim de mês
        opp: gh.opp ?? null,
        reunioes: g.reunioes ?? null, // funis por etapa (ex.: 2)
        venda: alvo.negociosGanhos ?? g.venda ?? 0,
        faturamento: Math.round(alvo.faturamentoAtual || 0),
        pipelineAbertoTotal: atual.pipelineAbertoTotal ?? null,
        abertoCount: atual.abertoCount ?? null,
        fonte: `snapshot-vivo-${new Date().toISOString().slice(0, 10)}`,
      };
    }

    // Lê history.json atual (sha) e mescla.
    const ghHeaders = { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json", "User-Agent": "captei-playbook" };
    const getR = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, { headers: ghHeaders });
    let hist = {}, sha = undefined;
    if (getR.ok) {
      const j = await getR.json();
      sha = j.sha;
      hist = JSON.parse(Buffer.from(j.content, "base64").toString("utf8"));
    } else if (getR.status !== 404) {
      throw new Error(`GitHub GET ${getR.status}`);
    }

    for (const pid of FUNIS) {
      hist[pid] = hist[pid] || {};
      hist[pid][month] = registros[pid];
    }
    if (hist._meta) hist._meta.atualizado_em = new Date().toISOString().slice(0, 10);

    const novo = Buffer.from(JSON.stringify(hist, null, 2) + "\n", "utf8").toString("base64");
    const putR = await fetch(`https://api.github.com/repos/${REPO}/contents/${PATH}`, {
      method: "PUT",
      headers: ghHeaders,
      body: JSON.stringify({ message: `snapshot: congela ${month} (funis ${FUNIS.join(",")})`, content: novo, sha }),
    });
    if (!putR.ok) throw new Error(`GitHub PUT ${putR.status}: ${await putR.text()}`);

    res.status(200).json({ ok: true, month, registros });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
