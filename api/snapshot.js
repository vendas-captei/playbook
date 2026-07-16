// Congela o cenário mensal no data/history.json (commit via API do GitHub).
// Uso: GET /api/snapshot?key=<SNAPSHOT_KEY>[&month=YYYY-MM]
//   - default month = mês ANTERIOR ao atual (roda no dia 1 via cron n8n).
//   - MQL/Venda/Faturamento vêm do /api/metrics do mês-alvo (carimbos imutáveis).
//   - SQL/OPP vêm do /api/metrics do mês CORRENTE (foto do estoque de pipeline = estado de fim de mês).
//   - Grava para todos os funis do radar (7 e 2).
// Protegido por SNAPSHOT_KEY (env). Requer GITHUB_TOKEN (env, já existe no projeto).
const REPO = "vendas-captei/playbook";
const PATH = "data/history.json";
const FC_PATH = "data/forecast-history.json";
const FILTERS_PATH = "data/filters.json";
const DAILY_PATH = "data/daily.json";
const FUNIS = [7, 2];

// Flush do registro diário ao vivo (Edge Config daily<pid>) → data/daily.json no repo.
// Arquivo histórico macro: { "<pid>": { "YYYY-MM-DD": {decomposição do dia + vendedores} } }.
// Chamado por cron/manual (GET /api/snapshot?key=…&only=daily) — nunca a cada "Atualizar",
// pra não disparar redeploy da Vercel a cada clique. O dado do dia corrente vive no Edge Config.
async function snapshotDaily(ghHeaders) {
  const EC_ID = process.env.EDGE_CONFIG_ID, EC_READ = process.env.EDGE_CONFIG_READ_TOKEN;
  if (!EC_ID || !EC_READ) throw new Error("Edge Config não configurado");
  const vivo = {};
  for (const pid of FUNIS) {
    try {
      const r = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/daily${pid}?token=${EC_READ}`, { cache: "no-store" });
      vivo[pid] = r.ok ? ((await r.json()) || {}) : {};
    } catch (_) { vivo[pid] = {}; }
  }
  const getR = await fetch(`https://api.github.com/repos/${REPO}/contents/${DAILY_PATH}`, { headers: ghHeaders });
  let arq = { _meta: {} }, sha;
  if (getR.ok) { const j = await getR.json(); sha = j.sha; try { arq = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); } catch (_) { arq = { _meta: {} }; } }
  else if (getR.status !== 404) throw new Error(`GitHub GET daily ${getR.status}`);
  let dias = 0;
  for (const pid of FUNIS) {
    arq[pid] = arq[pid] || {};
    for (const data in (vivo[pid] || {})) { arq[pid][data] = vivo[pid][data]; dias++; }
  }
  arq._meta = arq._meta || {}; arq._meta.atualizado_em = new Date().toISOString().slice(0, 10);
  const novo = Buffer.from(JSON.stringify(arq, null, 2) + "\n", "utf8").toString("base64");
  const putR = await fetch(`https://api.github.com/repos/${REPO}/contents/${DAILY_PATH}`, {
    method: "PUT", headers: ghHeaders,
    body: JSON.stringify({ message: `snapshot diário: ${dias} registro(s) dia×funil`, content: novo, ...(sha ? { sha } : {}) }),
  });
  if (!putR.ok) throw new Error(`GitHub PUT daily ${putR.status}`);
  return dias;
}

// Refresca o snapshot de filtros (funis + usuários ativos) commitado no repo.
// É o fallback de api/filters.js — mantém o painel de pé quando o token estoura no Cloudflare.
async function snapshotFilters(ghHeaders) {
  const PD = process.env.PIPEDRIVE_API_TOKEN;
  if (!PD) return false;
  const V1 = "https://api.pipedrive.com/v1";
  const [pr, ur] = await Promise.all([
    fetch(`${V1}/pipelines?api_token=${PD}`, { cache: "no-store" }),
    fetch(`${V1}/users?api_token=${PD}`, { cache: "no-store" }),
  ]);
  if (!pr.ok || !ur.ok) throw new Error(`filters upstream ${pr.status}/${ur.status}`);
  const pipes = await pr.json(), users = await ur.json();
  const funis = (pipes.data || [])
    .filter((p) => p.active && !/^OLD|Testes/i.test(p.name))
    .map((p) => ({ id: p.id, nome: p.name }));
  const usuarios = (users.data || [])
    .filter((u) => u.active_flag)
    .map((u) => ({ id: u.id, nome: u.name, email: (u.email || "").toLowerCase() }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
  if (!funis.length) throw new Error("0 funis — abortando (não sobrescreve snapshot bom)");
  const payload = { funis, usuarios, _meta: { atualizado_em: new Date().toISOString().slice(0, 10), fonte: "snapshot-cron" } };
  const getR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILTERS_PATH}`, { headers: ghHeaders });
  let sha;
  if (getR.ok) sha = (await getR.json()).sha;
  else if (getR.status !== 404) throw new Error(`GitHub GET filters ${getR.status}`);
  const novo = Buffer.from(JSON.stringify(payload, null, 2) + "\n", "utf8").toString("base64");
  const putR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FILTERS_PATH}`, {
    method: "PUT", headers: ghHeaders,
    body: JSON.stringify({ message: `snapshot filtros: ${funis.length} funis, ${usuarios.length} usuários`, content: novo, ...(sha ? { sha } : {}) }),
  });
  if (!putR.ok) throw new Error(`GitHub PUT filters ${putR.status}`);
  return true;
}

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

async function getTpc(base, pid, month) {
  const r = await fetch(`${base}/api/tpc?pipeline_id=${pid}&month=${month}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`tpc ${r.status}`);
  return r.json();
}

async function getForecast(base, pid, month) {
  const r = await fetch(`${base}/api/forecast?pipeline_id=${pid}&month=${month}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`forecast ${r.status} (pid=${pid}, month=${month})`);
  return r.json();
}

// Congela o Forecast no data/forecast-history.json. Mesmo cron do Tracking.
// - forecastInicial: foto do forecast do mês CORRENTE (o que prevemos) — só pode ser capturada ao vivo.
// - fechamento: indicadores do mês-alvo (anterior) — win/lost são carimbos imutáveis, recuperáveis.
async function snapshotForecast(base, ghHeaders, monthAlvo, monthAtual) {
  const getR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FC_PATH}`, { headers: ghHeaders });
  let hist = { _meta: {} }, sha;
  if (getR.ok) { const j = await getR.json(); sha = j.sha; hist = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); }
  else if (getR.status !== 404) throw new Error(`GitHub GET fc ${getR.status}`);
  const hoje = new Date().toISOString().slice(0, 10);

  for (const pid of FUNIS) {
    hist[pid] = hist[pid] || {};
    // (1) Forecast do mês corrente = o que prevemos agora.
    try {
      const fc = await getForecast(base, pid, monthAtual);
      hist[pid][monthAtual] = hist[pid][monthAtual] || {};
      hist[pid][monthAtual].forecastInicial = {
        cenarios: fc.cenarios, ponderado: fc.ponderado, totalAberto: fc.totalAberto,
        dealsAbertos: fc.dealsAbertos, metaMensal: fc.metaMensal, semanas: fc.semanas,
        semData: fc.semData, snapshotEm: hoje,
      };
    } catch (_) { /* best-effort */ }
    // (2) Fechamento do mês-alvo (anterior) = realizado + indicadores finais.
    try {
      const fa = await getForecast(base, pid, monthAlvo);
      const i = fa.indicadores || {};
      hist[pid][monthAlvo] = hist[pid][monthAlvo] || {};
      hist[pid][monthAlvo].fechamento = {
        realizado: fa.realizado, negociosGanhos: fa.negociosGanhos, winRate: i.winRate,
        cicloMedianoDias: i.cicloMedianoDias, perdidosOpp: i.perdidosOpp, perdidosTotal: i.perdidosTotal,
        metaMensal: fa.metaMensal, snapshotEm: hoje,
      };
    } catch (_) { /* best-effort */ }
  }
  hist._meta = hist._meta || {}; hist._meta.atualizado_em = hoje;
  const novo = Buffer.from(JSON.stringify(hist, null, 2) + "\n", "utf8").toString("base64");
  const putR = await fetch(`https://api.github.com/repos/${REPO}/contents/${FC_PATH}`, {
    method: "PUT", headers: ghHeaders,
    body: JSON.stringify({ message: `snapshot forecast: ${monthAtual} (prev) + ${monthAlvo} (fech)`, content: novo, ...(sha ? { sha } : {}) }),
  });
  if (!putR.ok) throw new Error(`GitHub PUT fc ${putR.status}: ${await putR.text()}`);
  return hist;
}

// Leads orgânicos do mês = novos deals cross-funil (topo de funil, proxy de MQL).
// >400 ou erro (500 em mês de importação em massa) → null (não usar; recupera-se no backfill manual).
async function leadsOrganicos(month) {
  const PD = process.env.PIPEDRIVE_API_TOKEN;
  if (!PD) return null;
  const r = await fetch(`https://api.pipedrive.com/v1/deals/timeline?start_date=${month}-01&interval=month&amount=1&field_key=add_time&api_token=${PD}`, { cache: "no-store" });
  if (!r.ok) return null;
  const j = await r.json();
  const n = ((j.data && j.data[0] && j.data[0].deals) || []).length;
  return n > 400 ? null : n;
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
  const ghHeaders0 = { Authorization: `Bearer ${GH}`, Accept: "application/vnd.github+json", "User-Agent": "captei-playbook" };

  // Atalho leve: só refresca o fallback dos filtros (2 chamadas). GET /api/snapshot?key=…&only=filters
  if (u.searchParams.get("only") === "filters") {
    try { const ok = await snapshotFilters(ghHeaders0); res.status(200).json({ ok, only: "filters" }); }
    catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // Atalho leve: flush do registro diário (Edge Config) → data/daily.json. GET /api/snapshot?key=…&only=daily
  if (u.searchParams.get("only") === "daily") {
    try { const dias = await snapshotDaily(ghHeaders0); res.status(200).json({ ok: true, only: "daily", dias }); }
    catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

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

      // Série diária de TPC do mês-alvo (só funil 7 — onde 1º contato importa e o volume é limitado).
      if (pid === 7) {
        try {
          const tpc = await getTpc(base, pid, month);
          if (tpc && tpc.serie) {
            delete tpc.atualizadoEm; delete tpc.historico;
            tpc.fonte = `snapshot-vivo-${new Date().toISOString().slice(0, 10)}`;
            registros[pid].tpc = tpc;
          }
        } catch (_) { /* TPC é best-effort; não derruba o snapshot */ }
        try { const lo = await leadsOrganicos(month); if (lo != null) registros[pid].leadsOrg = lo; } catch (_) {}
      }
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

    // Recalcula a conversão MEDIDA (novo deal→venda) com trailing dos últimos 6 meses e grava em params.json.
    let convLeadVenda = null;
    try {
      const meses = Object.keys(hist["7"] || {}).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().slice(-6);
      let sV = 0, sL = 0;
      for (const k of meses) { const r = hist["7"][k]; if (r && r.leadsOrg > 0 && typeof r.venda === "number") { sV += r.venda; sL += r.leadsOrg; } }
      const rate = sL > 0 ? sV / sL : null;
      if (rate && rate >= 0.05 && rate <= 0.6) {
        convLeadVenda = Math.round(rate * 100) / 100;
        const pGet = await fetch(`https://api.github.com/repos/${REPO}/contents/params.json`, { headers: ghHeaders });
        if (pGet.ok) {
          const pj = await pGet.json();
          const params = JSON.parse(Buffer.from(pj.content, "base64").toString("utf8"));
          params["7"] = { ...(params["7"] || {}), convLeadVenda };
          const pc = Buffer.from(JSON.stringify(params, null, 2) + "\n", "utf8").toString("base64");
          await fetch(`https://api.github.com/repos/${REPO}/contents/params.json`, { method: "PUT", headers: ghHeaders, body: JSON.stringify({ message: `snapshot: convLeadVenda=${Math.round(rate * 100)}%`, content: pc, sha: pj.sha }) });
        }
      }
    } catch (_) { /* best-effort */ }

    // Congela também o Forecast (mesmo cron). month = mês-alvo (anterior); monthAtual = mês corrente.
    let forecastOk = false;
    try {
      const now2 = new Date();
      const monthAtual = `${now2.getUTCFullYear()}-${String(now2.getUTCMonth() + 1).padStart(2, "0")}`;
      await snapshotForecast(base, ghHeaders, month, monthAtual);
      forecastOk = true;
    } catch (e) { /* forecast é best-effort; não derruba o snapshot do Tracking */ }

    // Refresca o fallback dos filtros (best-effort; não derruba o snapshot do Tracking).
    let filtersOk = false;
    try { filtersOk = await snapshotFilters(ghHeaders); } catch (_) {}

    res.status(200).json({ ok: true, month, registros, convLeadVenda, forecastOk, filtersOk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
