// Tracking mensal ao vivo do Pipedrive — filtrável por funil, usuário e mês.
// GET /api/metrics?pipeline_id=7&user_id=16776298&month=2026-07
// Serverless function servida pela Vercel (mesmo padrão de api/users.js).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const META_POR_FUNIL = { 7: 160000, 2: 80000 }; // ajuste por funil
const META_PADRAO = 160000;

// ── Cache sob demanda (Vercel Edge Config) ──────────────────────────────────
// Política (2026-07-15, Natan): o Pipedrive só é consultado quando um usuário
// LOGADO clica "Atualizar" no painel. O dashboard e o Modo TV (deploy separado)
// leem esta foto congelada — ZERO chamada ao Pipedrive em background. Escrita
// via API Vercel (só server-side); leitura via endpoint HTTPS com read token.
const EC_ID = process.env.EDGE_CONFIG_ID;
const EC_READ = process.env.EDGE_CONFIG_READ_TOKEN;
const { fsRead, fsWrite } = require("../lib/fscache");

// Cache migrado do Vercel Edge Config para o Firestore em 29/07/2026: o plano free do Edge
// Config permite 250 escritas/MÊS e estourou em 22/07, falhando em silêncio (o painel abria com
// foto velha). Firestore free tier = 20.000 escritas/DIA.
// LEITURA: Firestore primeiro, com fallback no Edge Config (a foto antiga segue legível até a
// primeira gravação nova). ESCRITA: só Firestore — as escritas do Edge Config estão mortas.
async function ecLegacyRead(key) {
  if (!EC_ID || !EC_READ) return null;
  try {
    const r = await fetch(`https://edge-config.vercel.com/${EC_ID}/item/${key}?token=${EC_READ}`, { cache: "no-store" });
    return r.ok ? await r.json() : null;
  } catch (_) { return null; }
}

async function cacheRead(pid) {
  const v = await fsRead(`live${pid}`);
  return v !== null ? v : await ecLegacyRead(`live${pid}`);
}
async function cacheWrite(pid, value) {
  return await fsWrite(`live${pid}`, value);
}
// Registro diário (decomposição do dia), chave daily<pid> = { "YYYY-MM-DD": {...} }.
// Upsert por data → acumula o mês ao vivo, sem redeploy. O snapshot.js flusha p/ data/daily.json (repo).
async function dailyReadMap(pid) {
  const v = await fsRead(`daily${pid}`);
  return v || (await ecLegacyRead(`daily${pid}`)) || {};
}
async function dailyUpsert(pid, rec, mapaPre) {
  try {
    const mapa = mapaPre || (await dailyReadMap(pid));
    // write-once: a meta do dia FIXA (valor do início do dia) grava UMA vez e nunca sobrescreve.
    const prev = mapa[rec.data];
    if (prev && prev.metaDiaInicio != null && rec.metaDiaInicio == null) rec.metaDiaInicio = prev.metaDiaInicio;
    mapa[rec.data] = rec;
    return await fsWrite(`daily${pid}`, mapa);
  } catch (_) { return false; }
}

// ── Campos custom e opções para a definição de negócio de MQL/SQL/OPP (Captação Ativa, funil 7) ──
// Verificado via API em 2026-07-09. Ver memória project_pipedrive_estrutura / reference_cidade_lead_e_base.
const F_PRODUTO = "4a67c7a7684177402784cf8773a45dd8e1670b59"; // set: 6843 CA, 6844 Indica+, 6860 IA, 7173 NI
const F_CIDADE  = "ad134d73ddf7e8c36e15b4a7c6348cc595170d70"; // enum: 7207 dentro base, 7208 fora base
const F_CRECI   = "806f3f6384d7d9b503e4e25a9375818d187a18bc"; // enum: 6734 Sim, 6735 Não
const F_CLIENTE = "75afcc85302974a298be36d95bb743ce7e9b2fc7"; // enum: 7096 Sim, 7097 Não
const F_IMOB    = "dca89917133f0345cb886860d6343f65d37cd2f4"; // enum: 6786 Imobiliária, 6787 Corretor autônomo
const PROD_CA = "6843", PROD_INDICA = "6844";
// Rótulos do campo Produto p/ a comemoração de vendas (celebrate.js).
const PRODUTO_LABEL = { "6843": "Captação Ativa", "6844": "Indica+", "6860": "IA Copiloto", "7173": "Não informado" };
// Filtro salvo no Pipedrive (criado 2026-07-10, id 80142): Produto ∈ {CA, Indica+} E status=open.
// Enxuga a varredura de deals abertos cross-funil (509 deals / 2 págs) vs varrer os ~15k abertos (31 págs).
const FILTRO_CA_ABERTO = 80142;

// Histórico consolidado congelado (meses fechados). Fonte da verdade p/ o passado:
// o dashboard lê daqui em vez de recalcular ao vivo — imune a drift de campos e ao 500
// de timeline em meses com importação em massa. Ver data/history.json.
let HISTORY = {};
try { HISTORY = require("../data/history.json"); } catch (_) { HISTORY = {}; }

function setHas(raw, id) {
  // campo "set" do Pipedrive vem como string "6843" ou "6843,6860"
  return raw != null && String(raw).split(",").map((s) => s.trim()).includes(id);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET no Pipedrive com retry/backoff em 429/5xx (Cloudflare devolve 429 "Too many requests"
// como texto puro quando o token compartilhado estoura a cota de borda). Ver api/filters.js.
async function pd(url, TK, tries = 3) {
  const sep = url.includes("?") ? "&" : "?";
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" });
    if (r.ok) return r.json();
    last = `Pipedrive ${r.status} em ${url.split("?")[0]}`;
    if (r.status === 429 || r.status >= 500) { await sleep((i + 1) * 700); continue; }
    throw new Error(last);
  }
  throw new Error(`${last} (rate limit persistente)`);
}

// Feriados nacionais BR (fixos + móveis) — dias úteis = seg-sex que NÃO são feriado.
// Manter atualizado ano a ano. Fonte: calendário nacional (Lei 14.759/2023 incluiu 20/11).
const FERIADOS = new Set([
  // 2025
  "2025-01-01","2025-03-03","2025-03-04","2025-04-18","2025-04-21","2025-05-01",
  "2025-06-19","2025-09-07","2025-10-12","2025-11-02","2025-11-15","2025-11-20","2025-12-25",
  // 2026
  "2026-01-01","2026-02-16","2026-02-17","2026-04-03","2026-04-21","2026-05-01",
  "2026-06-04","2026-09-07","2026-10-12","2026-11-02","2026-11-15","2026-11-20","2026-12-25",
]);

function contarDiasUteis(ano, mes, de, ate) {
  let c = 0;
  for (let d = de; d <= ate; d++) {
    const w = new Date(ano, mes, d).getDay();
    if (w === 0 || w === 6) continue;
    const key = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (FERIADOS.has(key)) continue;
    c++;
  }
  return c;
}

// ── Helpers de intervalo (string YYYY-MM-DD, TZ-safe via UTC) ────────────────
const _parseD = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const _isoD = (d) => d.toISOString().slice(0, 10);
const addDaysStr = (s, n) => { const d = _parseD(s); d.setUTCDate(d.getUTCDate() + n); return _isoD(d); };
const dowShort = (s) => ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][_parseD(s).getUTCDay()];
function ehUtilStr(s) { const w = _parseD(s).getUTCDay(); return w !== 0 && w !== 6 && !FERIADOS.has(s); }
function diasUteisRange(from, to) { let c = 0, x = from; while (x <= to) { if (ehUtilStr(x)) c++; x = addDaysStr(x, 1); } return c; }
function diasUteisMesStr(ano, mes) {
  const last = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  return diasUteisRange(`${ano}-${String(mes + 1).padStart(2, "0")}-01`, `${ano}-${String(mes + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`);
}
// Meta do período = meta mensal RATEADA por dias úteis (1 mês = meta cheia; N meses = soma proporcional).
function metaRateadaPeriodo(from, to, metaMensal) {
  let total = 0, y = _parseD(from).getUTCFullYear(), m = _parseD(from).getUTCMonth();
  const yEnd = _parseD(to).getUTCFullYear(), mEnd = _parseD(to).getUTCMonth();
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    const mFrom = `${y}-${String(m + 1).padStart(2, "0")}-01`;
    const mTo = `${y}-${String(m + 1).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    const clipFrom = mFrom < from ? from : mFrom, clipTo = mTo > to ? to : mTo;
    const duMes = diasUteisMesStr(y, m);
    total += metaMensal * (duMes > 0 ? diasUteisRange(clipFrom, clipTo) / duMes : 0);
    m++; if (m > 11) { m = 0; y++; }
  }
  return total;
}

// Modelo NOVO de ritmo — período-aware e SEM off-by-one:
//  • diasUteisRestantes CONTA o dia de hoje (você ainda pode vender hoje);
//  • necessário/dia = (meta − realizado ATÉ ONTEM) ÷ dias úteis restantes INCL. hoje.
// Recebe wonSumByDay = { "YYYY-MM-DD": receita } sobre [from,to] e monta a série cumulativa.
function deriveMetrics({ from, to, hoje, metaPeriodo, wonSum, wonCount, wonSumByDay, wonCountByDay }) {
  const diasUteisTotais = diasUteisRange(from, to);
  const base = diasUteisTotais > 0 ? metaPeriodo / diasUteisTotais : 0;
  const contemHoje = hoje >= from && hoje <= to;
  const ontem = addDaysStr(hoje, -1);
  const diasUteisDecorridos = contemHoje
    ? Math.max(0, diasUteisRange(from, hoje > to ? to : hoje))          // inclui hoje
    : diasUteisTotais;                                                   // período fechado → tudo decorrido
  const diasUteisAteOntem = (from <= ontem) ? diasUteisRange(from, ontem > to ? to : ontem) : 0;
  const diasUteisRestantes = Math.max(0, diasUteisTotais - diasUteisAteOntem); // INCL. hoje

  const ticketMedio = wonCount > 0 ? wonSum / wonCount : 0;
  const runRate = diasUteisDecorridos > 0 ? (wonSum / diasUteisDecorridos) * diasUteisTotais : 0;
  const gapMeta = metaPeriodo - wonSum;

  // Série dia-a-dia: alvo fixo (base), realizado, acumulados, saldo que rola, e necessário recalculado.
  const tracking = [];
  let realAcum = 0, i = 0, x = from;
  while (x <= to) {
    if (ehUtilStr(x)) {
      i++;
      const r = wonSumByDay[x] || 0;
      realAcum += r;
      const alvoAcum = base * i;
      const restDoDia = Math.max(1, diasUteisTotais - (i - 1));               // dias úteis a partir deste (incl.)
      const necessarioRecalc = Math.max(0, (metaPeriodo - (realAcum - r))) / restDoDia; // sobre saldo do início do dia
      tracking.push({
        data: x, dow: dowShort(x), idx: i,
        alvo: base, realizado: r, count: wonCountByDay[x] || 0,
        realAcum, alvoAcum, saldoAcum: realAcum - alvoAcum,
        necessarioRecalc, ehHoje: x === hoje,
      });
    }
    x = addDaysStr(x, 1);
  }

  const realizadoAteOntem = tracking.filter((t) => t.data < hoje).reduce((a, t) => a + t.realizado, 0);
  const fechamentoDiarioNecessario = contemHoje
    ? (diasUteisRestantes > 0 ? Math.max(0, metaPeriodo - realizadoAteOntem) / diasUteisRestantes : Math.max(0, gapMeta))
    : (diasUteisRestantes > 0 ? Math.max(0, gapMeta) / diasUteisRestantes : Math.max(0, gapMeta));
  const metaDiariaFixa = base;
  return {
    diasUteisTotais, diasUteisDecorridos, diasUteisRestantes, diasUteisAteOntem,
    ticketMedio, runRate, gapMeta, fechamentoDiarioNecessario, metaDiariaFixa,
    realizadoAteOntem, contemHoje, tracking, baseDia: base,
  };
}

function nomeMes(ano, mes) {
  const s = new Date(ano, mes, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Vendas ganhas HOJE (America/Sao_Paulo), qualquer funil — alimenta celebrate.js (fogos globais).
async function fetchWinsToday(TK) {
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const r = await pd(`${V1}/deals/timeline?start_date=${hojeSP}&interval=day&amount=1&field_key=won_time&status=won`, TK);
  const deals = (r.data && r.data[0] && r.data[0].deals) || [];
  const wins = deals.map((d) => {
    let produto = null;
    const raw = d[F_PRODUTO];
    for (const k in PRODUTO_LABEL) if (setHas(raw, k)) { produto = PRODUTO_LABEL[k]; break; }
    return {
      id: d.id,
      produto,
      valor: Number(d.value) || 0,
      vendedor: d.owner_name || (d.user_id && d.user_id.name) || "—",
      cliente: d.org_name || d.person_name || "",
    };
  });
  return { data: hojeSP, total: wins.length, wins, atualizadoEm: new Date().toISOString() };
}

// Vendas ganhas HOJE no funil (e vendedor, se filtrado) — alimenta a "meta do dia"
// do card Fechamento/dia, que é abatida pelo progresso real do dia.
async function fetchWonToday(pipelineId, userId, TK) {
  const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  let url = `${V1}/deals/timeline?start_date=${hojeSP}&interval=day&amount=1&field_key=won_time&status=won&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  const deals = (r.data && r.data[0] && r.data[0].deals) || [];
  const sum = deals.reduce((acc, d) => acc + (Number(d.value) || 0), 0);
  // Decomposição por vendedor (nome + valor + nº de vendas), maior receita primeiro.
  const byV = new Map();
  for (const d of deals) {
    const nome = d.owner_name || (d.user_id && d.user_id.name) || "—";
    const cur = byV.get(nome) || { vendedor: nome, valor: 0, count: 0 };
    cur.valor += Number(d.value) || 0; cur.count += 1;
    byV.set(nome, cur);
  }
  const porVendedor = [...byV.values()].sort((a, b) => b.valor - a.valor);
  return { count: deals.length, sum, porVendedor };
}

// Receita ganha POR DIA no intervalo [from,to] — base da série de tracking diário.
// Retorna mapas data→receita e data→nº de vendas, + totais do período.
async function fetchWonByDay(pipelineId, userId, from, to, TK) {
  const amount = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  let url = `${V1}/deals/timeline?start_date=${from}&interval=day&amount=${amount}&field_key=won_time&status=won&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  const sumByDay = {}, countByDay = {};
  let sum = 0, count = 0;
  for (const p of (r.data || [])) {
    const ds = p.period_start.slice(0, 10);
    const deals = p.deals || [];
    const s = deals.reduce((a, x) => a + (Number(x.value) || 0), 0);
    sumByDay[ds] = s; countByDay[ds] = deals.length;
    sum += s; count += deals.length;
  }
  return { sumByDay, countByDay, sum, count };
}

async function fetchWonMonth(pipelineId, userId, monthStart, TK) {
  let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=won_time&status=won&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  const deals = (r.data && r.data[0] && r.data[0].deals) || [];
  const sum = deals.reduce((acc, d) => acc + (Number(d.value) || 0), 0);
  return { count: deals.length, sum };
}

// Entrantes de UM mês por add_time — via PAGINAÇÃO de /v1/deals (status all_not_deleted).
// ⚠️ NÃO usar /deals/timeline?field_key=add_time: ele SUBCONTA (só reflete deals ainda abertos →
// jul/26 deu 270 no funil 7 vs 485 reais; bate com o relatório nativo do Luiz de 395+exclusões).
// Descoberto 2026-07-23 com Natan. Paginado por add_time DESC, para ao cruzar o início do mês.
async function fetchEntrantesMes(pipelineId, userId, monthStart, TK) {
  const [y, m] = monthStart.split("-").map(Number);
  const nextStart = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  const out = [];
  let start = 0, guard = 0;
  while (guard++ < 60) {
    let url = `${V1}/deals?status=all_not_deleted&sort=add_time%20DESC&start=${start}&limit=500`;
    if (userId) url += `&user_id=${userId}`;
    const r = await pd(url, TK);
    const data = r.data || [];
    if (!data.length) break;
    let stop = false;
    for (const d of data) {
      const at = (d.add_time || "").slice(0, 10);
      if (!at) continue;
      if (at < monthStart) { stop = true; continue; }
      if (at >= nextStart) continue;                       // mais novo que o mês → ignora, segue
      if (pipelineId && d.pipeline_id !== pipelineId) continue;
      out.push(d);
    }
    const pg = (r.additional_data && r.additional_data.pagination) || {};
    if (stop || !pg.more_items_in_collection) break;
    start = pg.next_start;
  }
  return out;
}

async function fetchEntrantesMonth(pipelineId, userId, monthStart, TK) {
  return fetchEntrantesMes(pipelineId, userId, monthStart, TK);
}

// ── Geração por ETAPA (funis que ainda não têm definição de negócio, ex.: funil 2 por ora) ──
// entrantes (Entrada), SQL (alcançou Qualificado, ord>=4) e Reuniões (alcançou Reunião Agendada, ord>=5).
function computeGeracao(entrantes, stagesRaw) {
  const stages = stagesRaw.data || [];
  const orderByStage = new Map(stages.map((s) => [s.id, s.order_nr]));
  let qualOrder = 4, reuniaoOrder = 5, qualNome = "Qualificado", reuniaoNome = "Reunião Agendada";
  for (const s of stages) {
    const n = (s.name || "").toLowerCase();
    if (/qualif/.test(n)) { qualOrder = s.order_nr; qualNome = s.name; }
    if (/reuni/.test(n) && /agend/.test(n)) { reuniaoOrder = s.order_nr; reuniaoNome = s.name; }
  }
  let mql = entrantes.length, sql = 0, reunioes = 0;
  for (const d of entrantes) {
    const won = d.status === "won";
    const ord = won ? 999 : (orderByStage.get(d.stage_id) || 0);
    if (ord >= qualOrder) sql++;
    if (ord >= reuniaoOrder) reunioes++;
  }
  return { modo: "etapa", mql, sql, reunioes, qualNome, reuniaoNome };
}

// ── Geração por DEFINIÇÃO DE NEGÓCIO — Captação Ativa (funil 7). Definido com Natan; revisado 2026-07-10. ──
// MQL: produto ∈ {CA, Indica+}, CRIADO NO MÊS, em qualquer funil (métrica de fluxo).
// SQL: produto ∈ {CA, Indica+}, ABERTO, criado a qualquer momento, cross-funil, atendendo o critério:
//      ( [dentro da base + Tem CRECI Sim + não é cliente] OU [fora da base + Imobiliária + não é cliente] ).
//      "não é cliente" = "É cliente Captei?" != Sim (null ou Não passam).
// OPP: ABERTO no funil 7, etapa Proposta Enviada EM DIANTE (ordem >= ordem da Proposta Enviada).
// Venda: won no mês (funil 7) — inalterado.
// SQL/OPP/Venda: a data de criação do lead NÃO importa (estoque); só MQL é coorte do mês.
function contaMQL(entrantesCrossFunil) {
  let mql = 0;
  for (const d of entrantesCrossFunil)
    if (setHas(d[F_PRODUTO], PROD_CA) || setHas(d[F_PRODUTO], PROD_INDICA)) mql++;
  return mql;
}

function atendeCriterioSQL(d) {
  if (!(setHas(d[F_PRODUTO], PROD_CA) || setHas(d[F_PRODUTO], PROD_INDICA))) return false;
  const naoCliente = String(d[F_CLIENTE]) !== "7096";
  const dentro = String(d[F_CIDADE]) === "7207";
  const fora   = String(d[F_CIDADE]) === "7208";
  const temCreci = String(d[F_CRECI]) === "6734";
  const imob = String(d[F_IMOB]) === "6786";
  return (dentro && temCreci && naoCliente) || (fora && imob && naoCliente);
}

function contaSQL(dealsAbertosCA) {
  let sql = 0;
  for (const d of dealsAbertosCA) if (atendeCriterioSQL(d)) sql++;
  return sql;
}

// OPP: deals abertos do funil 7 na etapa Proposta Enviada em diante. Reaproveita `open` já buscado (0 chamadas extra).
function contaOPP(open, stagesRaw) {
  const stages = stagesRaw.data || [];
  const orderByStage = new Map(stages.map((s) => [s.id, s.order_nr]));
  let propostaOrder = 7;
  for (const s of stages) if (/proposta/i.test(s.name || "")) propostaOrder = s.order_nr;
  let opp = 0;
  for (const o of open) if ((orderByStage.get(o.stageId) || 0) >= propostaOrder) opp++;
  return opp;
}

// Entrantes do mês SEM filtro de funil (cross-funil), com os campos custom p/ o MQL de negócio.
async function fetchEntrantesCrossFunil(userId, monthStart, TK) {
  return fetchEntrantesMes(null, userId, monthStart, TK);
}

// Deals de um filtro salvo do Pipedrive (v1), paginado. Traz os campos custom no topo do objeto.
async function fetchDealsFiltro(filterId, userId, TK) {
  const out = [];
  let start = 0, guard = 0;
  do {
    let url = `${V1}/deals?filter_id=${filterId}&start=${start}&limit=500`;
    if (userId) url += `&user_id=${userId}`;
    const r = await pd(url, TK);
    for (const d of r.data || []) out.push(d);
    const pg = (r.additional_data && r.additional_data.pagination) || {};
    start = pg.more_items_in_collection ? pg.next_start : -1;
  } while (start >= 0 && ++guard < 20);
  return out;
}

async function fetchOpenDeals(pipelineId, userId, TK) {
  const out = [];
  let cursor = null, guard = 0;
  do {
    let url = `${V2}/deals?status=open&pipeline_id=${pipelineId}&limit=500`;
    if (userId) url += `&owner_id=${userId}`;
    if (cursor) url += `&cursor=${cursor}`;
    const r = await pd(url, TK);
    for (const d of r.data || []) {
      if (userId && d.owner_id !== userId) continue;
      out.push({ stageId: d.stage_id, value: Number(d.value) || 0, close: d.expected_close_date || null });
    }
    cursor = (r.additional_data && r.additional_data.next_cursor) || null;
  } while (cursor && ++guard < 10);
  return out;
}

function segundaFeira(d) {
  const x = new Date(d);
  const dow = (x.getDay() + 6) % 7;
  x.setDate(x.getDate() - dow);
  x.setHours(0, 0, 0, 0);
  return x;
}

function buildForecast(deals) {
  const hojeSeg = segundaFeira(new Date());
  const buckets = new Map();
  for (const d of deals) {
    if (!d.close) continue;
    const dt = new Date(`${d.close}T12:00:00`);
    if (isNaN(dt.getTime())) continue;
    const wk = segundaFeira(dt).getTime();
    if (wk < hojeSeg.getTime()) continue;
    buckets.set(wk, (buckets.get(wk) || 0) + d.value);
  }
  const f = (x) => `${String(x.getDate()).padStart(2, "0")}/${String(x.getMonth() + 1).padStart(2, "0")}`;
  return Array.from(buckets.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 6)
    .map(([wk, v]) => {
      const ini = new Date(wk), fim = new Date(wk + 4 * 864e5);
      return { semana: `${f(ini)}–${f(fim)}`, valor: Math.round(v) };
    });
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const TK = process.env.PIPEDRIVE_API_TOKEN;
  if (!TK) {
    res.status(500).json({ error: "PIPEDRIVE_API_TOKEN não configurado na Vercel" });
    return;
  }
  try {
    const u = new URL(req.url, "http://localhost");

    // Comemoração de vendas (fogos globais no Playbook): GET /api/metrics?action=wins
    if (u.searchParams.get("action") === "wins") {
      res.status(200).json(await fetchWinsToday(TK));
      return;
    }

    // Leitura do cache sob demanda: GET /api/metrics?action=cache&pipeline_id=7
    // Devolve a última foto congelada no Edge Config — ZERO chamada ao Pipedrive.
    // Usado pelo boot do dashboard e pelo Modo TV. Só existe p/ mês corrente, funis 7/2.
    if (u.searchParams.get("action") === "cache") {
      const pid = Number(u.searchParams.get("pipeline_id")) || 7;
      const cached = await cacheRead(pid);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json(cached || { cacheVazio: true, pipelineId: pid });
      return;
    }

    const pipelineId = Number(u.searchParams.get("pipeline_id")) || 7;
    const userId = u.searchParams.get("user_id") ? Number(u.searchParams.get("user_id")) : null;
    const month = u.searchParams.get("month");

    // ── Período (filtro estilo Pipedrive) ────────────────────────────────────
    // Fonte da verdade = ?from=YYYY-MM-DD&to=YYYY-MM-DD. Compat: ?month=YYYY-MM → mês inteiro;
    // sem nada → mês corrente (America/Sao_Paulo). O "hoje" é sempre TZ SP.
    const hojeSP = new Date().toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const dMy = /^\d{4}-\d{2}-\d{2}$/;
    const boundsMes = (y, m) => [`${y}-${String(m + 1).padStart(2, "0")}-01`, `${y}-${String(m + 1).padStart(2, "0")}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, "0")}`];
    let from, to;
    const pFrom = u.searchParams.get("from"), pTo = u.searchParams.get("to");
    if (dMy.test(pFrom || "") && dMy.test(pTo || "")) { from = pFrom; to = pTo; }
    else if (month && /^\d{4}-\d{2}$/.test(month)) { const [y, m] = month.split("-").map(Number); [from, to] = boundsMes(y, m - 1); }
    else { const [y, m] = hojeSP.split("-").map(Number); [from, to] = boundsMes(y, m - 1); }
    if (from > to) { const t = from; from = to; to = t; }
    const periodoLabel = u.searchParams.get("label") || null;

    // Mês-âncora p/ os blocos estruturais (geração/estoque/histórico): mês que contém HOJE
    // se o período o abrange; senão o mês final do período (meses fechados → histórico).
    const contemHoje = hojeSP >= from && hojeSP <= to;
    const anchor = contemHoje ? hojeSP : to;
    const ano = Number(anchor.slice(0, 4)), mes = Number(anchor.slice(5, 7)) - 1;
    const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
    const [monthStart, monthEnd] = boundsMes(ano, mes);
    const curY = Number(hojeSP.slice(0, 4)), curM = Number(hojeSP.slice(5, 7)) - 1;
    const ehMesAtual = ano === curY && mes === curM;
    const diaAtual = ehMesAtual ? Number(hojeSP.slice(8, 10)) : ultimoDiaMes;
    // Período = exatamente 1 mês inteiro? (default "Este mês") → mantém caminho de cache/daily.
    const periodoEhMesInteiro = from === monthStart && to === monthEnd;

    // ── Roteamento mês fechado vs mês corrente ──────────────────────────────────
    // SQL/OPP são uma FOTO DO ESTOQUE ATUAL do pipeline — não têm como ser reconstruídos
    // para o passado (o Pipedrive não guarda estado histórico). Por isso, meses fechados
    // são servidos do histórico CONGELADO (data/history.json, alimentado mensalmente pelo
    // snapshot). Mês corrente continua ao vivo. Recorte por vendedor recalcula ao vivo
    // (ainda não congelamos por vendedor) — nesse caso SQL/OPP vêm n/d p/ meses fechados.
    const monthKey = monthStart.slice(0, 7);
    const mesFechado = !ehMesAtual;
    const histRec = (HISTORY[pipelineId] && HISTORY[pipelineId][monthKey]) || null;
    const useHistory = mesFechado && histRec && !userId;

    const [pipe, user, stagesRaw] = await Promise.all([
      pd(`${V1}/pipelines/${pipelineId}`, TK),
      userId ? pd(`${V1}/users/${userId}`, TK) : Promise.resolve(null),
      pd(`${V1}/stages?pipeline_id=${pipelineId}`, TK),
    ]);

    let won, open = [], geracao, historico = false, fonteHist = null;
    let novosDeals = null; // novos deals do mês (base de "leads gerados" p/ o funil reverso)

    if (useHistory) {
      // Mês fechado, agregado → tudo congelado (0 varreduras de deals).
      historico = true;
      fonteHist = histRec.fonte || "historico";
      novosDeals = histRec.leadsOrg ?? null;
      won = { count: histRec.venda || 0, sum: histRec.faturamento || 0 };
      geracao = pipelineId === 7
        ? { modo: "ca", mql: histRec.mql ?? null, sql: histRec.sql ?? null, opp: histRec.opp ?? null, venda: histRec.venda || 0, historico: true, fonte: fonteHist }
        : { modo: "etapa", mql: histRec.mql ?? null, sql: histRec.sql ?? null, reunioes: histRec.reunioes ?? null, historico: true, fonte: fonteHist };
    } else {
      [won, open] = await Promise.all([
        fetchWonMonth(pipelineId, userId, monthStart, TK),
        fetchOpenDeals(pipelineId, userId, TK),
      ]);
      if (pipelineId === 7 && mesFechado) {
        // Mês fechado sem congelamento (ou recorte por vendedor): MQL/Venda confiáveis (carimbos
        // imutáveis); SQL/OPP n/d. Timeline pode dar 500 em mês de importação → cai p/ histórico/null.
        let mql = null;
        try { const ecf = await fetchEntrantesCrossFunil(userId, monthStart, TK); mql = contaMQL(ecf); novosDeals = ecf.length; }
        catch (_) { mql = histRec ? histRec.mql : null; novosDeals = histRec ? (histRec.leadsOrg ?? null) : null; }
        historico = true;
        fonteHist = histRec ? histRec.fonte : "reconstruido-ao-vivo";
        geracao = { modo: "ca", mql, sql: histRec ? histRec.sql : null, opp: histRec ? histRec.opp : null, venda: won.count, historico: true, fonte: fonteHist };
      } else if (pipelineId === 7) {
        // Mês corrente (Captação Ativa) — definição de negócio ao vivo.
        const [entrantesCF, dealsAbertosCA] = await Promise.all([
          fetchEntrantesCrossFunil(userId, monthStart, TK),
          fetchDealsFiltro(FILTRO_CA_ABERTO, userId, TK),
        ]);
        novosDeals = entrantesCF.length;
        geracao = { modo: "ca", mql: contaMQL(entrantesCF), sql: contaSQL(dealsAbertosCA), opp: contaOPP(open, stagesRaw), venda: won.count };
      } else {
        const entrantes = await fetchEntrantesMonth(pipelineId, userId, monthStart, TK);
        geracao = computeGeracao(entrantes, stagesRaw);
        geracao.opp = contaOPP(open, stagesRaw); // Oportunidades (Proposta enviada+) p/ o card KPI (ex.: funil 2)
      }
    }

    const metaParam = u.searchParams.get("meta");
    const metaMensal =
      metaParam && !isNaN(Number(metaParam)) && Number(metaParam) > 0
        ? Number(metaParam)
        : META_POR_FUNIL[pipelineId] || META_PADRAO;
    const metaPeriodo = metaRateadaPeriodo(from, to, metaMensal);

    // Série de receita ganha POR DIA no período (base do tracking). Timeline pode dar 500 em
    // mês de importação em massa → degrada p/ o lump do mês-âncora, sem quebra dia-a-dia.
    let wonRange;
    try { wonRange = await fetchWonByDay(pipelineId, userId, from, to, TK); }
    catch (_) { wonRange = { sumByDay: {}, countByDay: {}, sum: won.sum, count: won.count }; }

    // ── Escalonamento por patamar (pedido Natan 24/07) ───────────────────────────────
    // Quando o realizado bate a meta, o ALVO sobe pro próximo patamar da Calculadora de
    // Comissão (100% → 110% Acel I → 120% Acel II) e trava em 120%. Como metaPeriodoEf
    // alimenta deriveMetrics + a meta do dia, o escalonamento reflete no painel INTEIRO
    // (Gap, Trilha, Ritmo Diário, Tracking Diário, Necessidade) — e vale tanto no recorte
    // individual (meta via ?meta=) quanto na meta agregada do funil/time.
    let patamarMult = 1.0;
    if (wonRange.sum >= metaPeriodo)         patamarMult = 1.1;  // bateu 100% → alvo 110%
    if (wonRange.sum >= metaPeriodo * 1.1)   patamarMult = 1.2;  // bateu 110% → alvo 120% (teto)
    const metaMensalBase  = metaMensal;
    const metaPeriodoBase = metaPeriodo;
    const metaMensalEf    = metaMensal  * patamarMult;
    const metaPeriodoEf   = metaPeriodo * patamarMult;
    const patamarPct      = Math.round(patamarMult * 100);

    const d = deriveMetrics({
      from, to, hoje: hojeSP, metaPeriodo: metaPeriodoEf,
      wonSum: wonRange.sum, wonCount: wonRange.count,
      wonSumByDay: wonRange.sumByDay, wonCountByDay: wonRange.countByDay,
    });

    // Vendas de HOJE (só faz sentido no mês corrente) — abatem a meta do dia no card.
    let vendasHoje = 0, vendasHojeCount = 0, vendasHojePorVendedor = [];
    if (ehMesAtual) {
      try { const wt = await fetchWonToday(pipelineId, userId, TK); vendasHoje = wt.sum; vendasHojeCount = wt.count; vendasHojePorVendedor = wt.porVendedor; }
      catch (_) { /* mantém 0 se a chamada falhar */ }
    }

    // Meta do dia FIXA ("valor do início do dia"): gap do COMEÇO do dia (meta − realizado até
    // ontem = faturamento − vendas de hoje) ÷ dias úteis restantes. Invariante durante o dia; no
    // card (bloco 3) é abatida SÓ pelas vendas de hoje. Distinta do "Necessário por dia útil"
    // (bloco 2 = gap ao vivo ÷ dias restantes), que se move com o mês.
    // Meta do dia FIXA ("início do dia") — agora SEM off-by-one: dias restantes INCLUEM hoje,
    // numerador = meta do período − realizado até ONTEM (da série). Congelada write-once no dia.
    const metaDiaInicioCalc = d.contemHoje
      ? (d.diasUteisRestantes > 0
          ? Math.max(0, metaPeriodoEf - d.realizadoAteOntem) / d.diasUteisRestantes
          : Math.max(0, metaPeriodoEf - d.realizadoAteOntem))
      : null;

    const stages = (stagesRaw.data || []).sort((a, b) => a.order_nr - b.order_nr);
    const porStage = new Map();
    for (const o of open) porStage.set(o.stageId, (porStage.get(o.stageId) || 0) + 1);
    const funil = stages.map((s) => ({ etapa: s.name, quantidade: porStage.get(s.id) || 0 }));
    funil.push({ etapa: "Ganho (mês)", quantidade: won.count });

    // Estoque de pipeline é "agora" — para meses fechados vem congelado (ou n/d se não capturado).
    const pipelineAbertoTotal = useHistory ? (histRec.pipelineAbertoTotal ?? null) : open.reduce((acc, o) => acc + o.value, 0);
    const abertoCount = useHistory ? (histRec.abertoCount ?? null) : open.length; // nº de leads em aberto (p/ teto saudável de 55)

    const payload = {
      mesReferencia: nomeMes(ano, mes),
      funilNome: (pipe.data && pipe.data.name) || `Funil ${pipelineId}`,
      usuarioNome: (user && user.data && user.data.name) || "Todos os vendedores",
      metaMensal: metaMensalEf,
      metaPeriodo: metaPeriodoEf,
      metaBase: metaMensalBase,       // meta-base "oficial" (100%) — editável e mostrada como referência
      metaPeriodoBase: metaPeriodoBase,
      patamarPct,                      // 100 | 110 | 120 — patamar atual do alvo
      patamarAtivo: patamarMult > 1,   // true quando o alvo já escalou (bateu ≥100%)
      periodo: { from, to, label: periodoLabel, ehMesInteiro: periodoEhMesInteiro, contemHoje: d.contemHoje },
      faturamentoAtual: wonRange.sum,
      negociosGanhos: wonRange.count,
      pipelineAbertoTotal,
      abertoCount,
      funil,
      geracao,
      novosDeals,
      vendasHoje,
      vendasHojeCount,
      vendasHojePorVendedor,
      metaDiaInicio: metaDiaInicioCalc,
      forecastSemanal: buildForecast(open),
      historico,
      fonte: fonteHist,
      ...d,
      atualizadoEm: new Date().toISOString(),
    };

    // Grava no cache sob demanda SÓ quando é a foto cacheável (mês corrente, sem
    // recorte por vendedor, funil 7/2) E o cliente pediu refresh explícito — ou seja,
    // o clique no botão "Atualizar". Nunca grava em views filtradas nem em leituras
    // incidentais. É o único momento em que o cache do dashboard/TV é renovado.
    const cacheavel = ehMesAtual && periodoEhMesInteiro && !userId && (pipelineId === 7 || pipelineId === 2);
    if (cacheavel && u.searchParams.get("refreshCache") === "1") {
      // Meta do dia = metaDiaInicioCalc, que JÁ é estável intra-dia (numerador = realizado ATÉ ONTEM,
      // que não muda durante o dia). NÃO reusar mais o valor congelado do registro diário: o daily7
      // de hoje foi gravado pelo código ANTIGO (metaDiaInicio bugado = 9.060) e não pode ser regravado
      // enquanto a cota de escrita do Edge Config não resetar — reusá-lo servia o valor errado no refresh.
      const mapaDaily = await dailyReadMap(pipelineId);
      const metaDiaInicioFinal = metaDiaInicioCalc;
      payload.metaDiaInicio = metaDiaInicioFinal;
      payload._cache = { updatedAt: payload.atualizadoEm, updatedBy: u.searchParams.get("by") || null };
      await cacheWrite(pipelineId, payload);
      // Registra a foto diária (decomposição do dia) no Edge Config p/ controle macro no detalhe.
      await dailyUpsert(pipelineId, {
        data: hojeSP, funil: pipelineId,
        metaMensal: metaMensalEf, metaBase: metaMensalBase, patamarPct,
        faturamentoAtual: won.sum, gapMeta: d.gapMeta,
        baseDia: d.metaDiariaFixa, necessarioHoje: d.fechamentoDiarioNecessario,
        metaDiaInicio: metaDiaInicioFinal,
        vendidoHoje: vendasHoje, vendasCount: vendasHojeCount, porVendedor: vendasHojePorVendedor,
        diasUteisDecorridos: d.diasUteisDecorridos, diasUteisRestantes: d.diasUteisRestantes,
        atualizadoEm: payload.atualizadoEm,
      }, mapaDaily);
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};

