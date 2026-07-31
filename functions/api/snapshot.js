// Congela o cenário mensal no Firestore (coleção `store`, doc `data__history`).
// Uso: GET /api/snapshot?key=<SNAPSHOT_KEY>[&month=YYYY-MM]
//   - default month = mês ANTERIOR ao atual (roda no dia 1 via cron n8n).
//   - MQL/Venda/Faturamento vêm do /api/metrics do mês-alvo (carimbos imutáveis).
//   - SQL/OPP vêm do /api/metrics do mês CORRENTE (foto do estoque de pipeline = estado de fim de mês).
//   - Grava para todos os funis do radar (7 e 2).
// Protegido por SNAPSHOT_KEY (env). Não commita mais no repo: antes cada execução gerava um commit
// (e com Vercel + Firebase rodando em paralelo, conflito de sha). Ver lib/store.js.
const { readJson, writeJson } = require("../lib/store");
const PATH = "data/history.json";
const FC_PATH = "data/forecast-history.json";
const FILTERS_PATH = "data/filters.json";
const DAILY_PATH = "data/daily.json";
const FUNIS = [7, 2];

// Flush do registro diário ao vivo (Edge Config daily<pid>) → data/daily.json no repo.
// Arquivo histórico macro: { "<pid>": { "YYYY-MM-DD": {decomposição do dia + vendedores} } }.
// Chamado por cron/manual (GET /api/snapshot?key=…&only=daily) — nunca a cada "Atualizar",
// pra não disparar redeploy da Vercel a cada clique. O dado do dia corrente vive no Edge Config.
const { fsRead } = require("../lib/fscache");

// Cache migrado do Vercel Edge Config para o Firestore em 29/07/2026: o plano free do Edge
// Config permite 250 escritas/MÊS e estourou em 22/07, falhando em silêncio (o painel abria com
// foto velha). Firestore free tier = 20.000 escritas/DIA.
// LEITURA: Firestore primeiro, com fallback no Edge Config (a foto antiga segue legível até a
// primeira gravação nova). ESCRITA: só Firestore — as escritas do Edge Config estão mortas.
async function snapshotDaily() {
  const vivo = {};
  for (const pid of FUNIS) {
    vivo[pid] = (await fsRead(`daily${pid}`)) || {};
  }
  const arq = (await readJson(DAILY_PATH)) || { _meta: {} };
  let dias = 0;
  for (const pid of FUNIS) {
    arq[pid] = arq[pid] || {};
    for (const data in (vivo[pid] || {})) { arq[pid][data] = vivo[pid][data]; dias++; }
  }
  arq._meta = arq._meta || {}; arq._meta.atualizado_em = new Date().toISOString().slice(0, 10);
  await writeJson(DAILY_PATH, arq);
  return dias;
}

// Refresca o snapshot de filtros (funis + usuários ativos) commitado no repo.
// É o fallback de api/filters.js — mantém o painel de pé quando o token estoura no Cloudflare.
async function snapshotFilters() {
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
  await writeJson(FILTERS_PATH, payload);
  return true;
}

function baseUrl(req) {
  // Usa o host da requisição. Fallback = Firebase Hosting (a Vercel está sendo desligada).
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (host) return `https://${host}`;
  return "https://playbook-comercial-18c7a.web.app";
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
async function snapshotForecast(base, monthAlvo, monthAtual) {
  const hist = (await readJson(FC_PATH)) || { _meta: {} };
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
  await writeJson(FC_PATH, hist);
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

  // Atalho leve: só refresca o fallback dos filtros (2 chamadas). GET /api/snapshot?key=…&only=filters
  if (u.searchParams.get("only") === "filters") {
    try { const ok = await snapshotFilters(); res.status(200).json({ ok, only: "filters" }); }
    catch (e) { res.status(500).json({ error: e.message }); }
    return;
  }

  // Atalho leve: flush do registro diário (Edge Config) → data/daily.json. GET /api/snapshot?key=…&only=daily
  if (u.searchParams.get("only") === "daily") {
    try { const dias = await snapshotDaily(); res.status(200).json({ ok: true, only: "daily", dias }); }
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

    // Lê o histórico atual do store e mescla.
    const hist = (await readJson(PATH)) || {};

    for (const pid of FUNIS) {
      hist[pid] = hist[pid] || {};
      hist[pid][month] = registros[pid];
    }
    if (hist._meta) hist._meta.atualizado_em = new Date().toISOString().slice(0, 10);

    await writeJson(PATH, hist);

    // Recalcula a conversão MEDIDA (novo deal→venda) com trailing dos últimos 6 meses e grava em params.
    let convLeadVenda = null;
    try {
      const meses = Object.keys(hist["7"] || {}).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().slice(-6);
      let sV = 0, sL = 0;
      for (const k of meses) { const r = hist["7"][k]; if (r && r.leadsOrg > 0 && typeof r.venda === "number") { sV += r.venda; sL += r.leadsOrg; } }
      const rate = sL > 0 ? sV / sL : null;
      if (rate && rate >= 0.05 && rate <= 0.6) {
        convLeadVenda = Math.round(rate * 100) / 100;
        const params = (await readJson("params.json")) || {};
        params["7"] = { ...(params["7"] || {}), convLeadVenda };
        await writeJson("params.json", params);
      }
    } catch (_) { /* best-effort */ }

    // Congela também o Forecast (mesmo cron). month = mês-alvo (anterior); monthAtual = mês corrente.
    let forecastOk = false;
    try {
      const now2 = new Date();
      const monthAtual = `${now2.getUTCFullYear()}-${String(now2.getUTCMonth() + 1).padStart(2, "0")}`;
      await snapshotForecast(base, month, monthAtual);
      forecastOk = true;
    } catch (e) { /* forecast é best-effort; não derruba o snapshot do Tracking */ }

    // Refresca o fallback dos filtros (best-effort; não derruba o snapshot do Tracking).
    let filtersOk = false;
    try { filtersOk = await snapshotFilters(); } catch (_) {}

    res.status(200).json({ ok: true, month, registros, convLeadVenda, forecastOk, filtersOk });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
