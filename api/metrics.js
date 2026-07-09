// Tracking mensal ao vivo do Pipedrive — filtrável por funil, usuário e mês.
// GET /api/metrics?pipeline_id=7&user_id=16776298&month=2026-07
// Serverless function servida pela Vercel (mesmo padrão de api/users.js).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const META_POR_FUNIL = { 7: 160000, 2: 80000 }; // ajuste por funil
const META_PADRAO = 160000;

// ── Campos custom e opções para a definição de negócio de MQL/SQL/OPP (Captação Ativa, funil 7) ──
// Verificado via API em 2026-07-09. Ver memória project_pipedrive_estrutura / reference_cidade_lead_e_base.
const F_PRODUTO = "4a67c7a7684177402784cf8773a45dd8e1670b59"; // set: 6843 CA, 6844 Indica+, 6860 IA, 7173 NI
const F_CIDADE  = "ad134d73ddf7e8c36e15b4a7c6348cc595170d70"; // enum: 7207 dentro base, 7208 fora base
const F_CRECI   = "806f3f6384d7d9b503e4e25a9375818d187a18bc"; // enum: 6734 Sim, 6735 Não
const F_CLIENTE = "75afcc85302974a298be36d95bb743ce7e9b2fc7"; // enum: 7096 Sim, 7097 Não
const F_IMOB    = "dca89917133f0345cb886860d6343f65d37cd2f4"; // enum: 6786 Imobiliária, 6787 Corretor autônomo
const PROD_CA = "6843", PROD_INDICA = "6844";
const APRESENTACOES = ["apresentacao_captei", "apresentacao_indica"]; // activityType key_strings

function setHas(raw, id) {
  // campo "set" do Pipedrive vem como string "6843" ou "6843,6860"
  return raw != null && String(raw).split(",").map((s) => s.trim()).includes(id);
}

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
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

function deriveMetrics({ ano, mes, diaAtual, faturamentoAtual, negociosGanhos, metaMensal }) {
  const ultimoDia = new Date(ano, mes + 1, 0).getDate();
  const diasUteisTotais = contarDiasUteis(ano, mes, 1, ultimoDia);
  const diasUteisDecorridos = Math.max(1, contarDiasUteis(ano, mes, 1, Math.min(diaAtual, ultimoDia)));
  const diasUteisRestantes = Math.max(0, diasUteisTotais - diasUteisDecorridos);
  const ticketMedio = negociosGanhos > 0 ? faturamentoAtual / negociosGanhos : 0;
  const runRate = (faturamentoAtual / diasUteisDecorridos) * diasUteisTotais;
  const gapMeta = metaMensal - faturamentoAtual;
  const fechamentoDiarioNecessario = diasUteisRestantes > 0 ? gapMeta / diasUteisRestantes : Math.max(0, gapMeta);
  return { diasUteisTotais, diasUteisDecorridos, diasUteisRestantes, ticketMedio, runRate, gapMeta, fechamentoDiarioNecessario };
}

function nomeMes(ano, mes) {
  const s = new Date(ano, mes, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
}

async function fetchWonMonth(pipelineId, userId, monthStart, TK) {
  let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=won_time&status=won&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  const deals = (r.data && r.data[0] && r.data[0].deals) || [];
  const sum = deals.reduce((acc, d) => acc + (Number(d.value) || 0), 0);
  return { count: deals.length, sum };
}

async function fetchEntrantesMonth(pipelineId, userId, monthStart, TK) {
  let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=add_time&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  return (r.data && r.data[0] && r.data[0].deals) || [];
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

// ── Geração por DEFINIÇÃO DE NEGÓCIO — Captação Ativa (funil 7). Definido com Natan 2026-07-09. ──
// MQL: produto de interesse ∈ {Captação Ativa, Indica+}, criado no mês, EM QUALQUER FUNIL.
// SQL: MQL E ( [dentro da base + Tem CRECI Sim + não é cliente] OU [fora da base + Imobiliária + não é cliente] ).
//   "não é cliente" = campo "É cliente Captei?" != Sim (null ou Não passam).
function computeGeracaoCA(entrantesCrossFunil) {
  let mql = 0, sql = 0;
  for (const d of entrantesCrossFunil) {
    const isCA = setHas(d[F_PRODUTO], PROD_CA) || setHas(d[F_PRODUTO], PROD_INDICA);
    if (!isCA) continue;
    mql++;
    const naoCliente = String(d[F_CLIENTE]) !== "7096";
    const dentro = String(d[F_CIDADE]) === "7207";
    const fora   = String(d[F_CIDADE]) === "7208";
    const temCreci = String(d[F_CRECI]) === "6734";
    const imob = String(d[F_IMOB]) === "6786";
    const sqlDentro = dentro && temCreci && naoCliente;
    const sqlFora   = fora && imob && naoCliente;
    if (sqlDentro || sqlFora) sql++;
  }
  return { modo: "ca", mql, sql };
}

// Entrantes do mês SEM filtro de funil (cross-funil), com os campos custom p/ MQL/SQL de negócio.
async function fetchEntrantesCrossFunil(userId, monthStart, TK) {
  let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=add_time`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  return (r.data && r.data[0] && r.data[0].deals) || [];
}

// deal_ids com atividade de apresentação (Captei/Indica+) no mês — status a fazer OU concluído (não deletadas).
// user_id=0 => todos os vendedores (v1 /activities sem user_id retorna só o dono do token).
// O recorte por vendedor é feito depois pelo DONO DO DEAL (não pelo dono da atividade).
async function fetchDealIdsApresentacao(monthStart, monthEnd, TK) {
  const ids = new Set();
  for (const type of APRESENTACOES) {
    let start = 0, guard = 0;
    do {
      const url = `${V1}/activities?type=${type}&user_id=0&start_date=${monthStart}&end_date=${monthEnd}&start=${start}&limit=500`;
      const r = await pd(url, TK);
      for (const a of r.data || []) {
        if (a.deal_id && a.active_flag !== false) ids.add(a.deal_id);
      }
      const pg = (r.additional_data && r.additional_data.pagination) || {};
      start = pg.more_items_in_collection ? pg.next_start : -1;
    } while (start >= 0 && ++guard < 20);
  }
  return ids;
}

// OPP (funil 7) = deals COM apresentação no mês que pertencem ao funil 7 (e ao vendedor, se filtrado).
// Resolve o pipeline/dono só dos ~dezenas de deals com apresentação (barato) em vez de varrer o funil inteiro.
async function computeOppFunil7(pipelineId, userId, monthStart, monthEnd, TK) {
  const ids = [...(await fetchDealIdsApresentacao(monthStart, monthEnd, TK))];
  let opp = 0;
  const CONC = 12;
  for (let i = 0; i < ids.length; i += CONC) {
    const chunk = ids.slice(i, i + CONC);
    const deals = await Promise.all(
      chunk.map((id) => pd(`${V2}/deals/${id}`, TK).then((r) => r.data || {}).catch(() => ({})))
    );
    for (const d of deals) {
      if (d.pipeline_id !== pipelineId) continue;
      if (userId && d.owner_id !== userId) continue;
      opp++;
    }
  }
  return opp;
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
    const pipelineId = Number(u.searchParams.get("pipeline_id")) || 7;
    const userId = u.searchParams.get("user_id") ? Number(u.searchParams.get("user_id")) : null;
    const month = u.searchParams.get("month");

    const now = new Date();
    let ano = now.getFullYear(), mes = now.getMonth();
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      const parts = month.split("-").map(Number);
      ano = parts[0]; mes = parts[1] - 1;
    }
    const ultimoDiaMes = new Date(ano, mes + 1, 0).getDate();
    const monthStart = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const monthEnd = `${ano}-${String(mes + 1).padStart(2, "0")}-${String(ultimoDiaMes).padStart(2, "0")}`;
    const ehMesAtual = ano === now.getFullYear() && mes === now.getMonth();
    const diaAtual = ehMesAtual ? now.getDate() : ultimoDiaMes;

    const [pipe, user, stagesRaw, won, open] = await Promise.all([
      pd(`${V1}/pipelines/${pipelineId}`, TK),
      userId ? pd(`${V1}/users/${userId}`, TK) : Promise.resolve(null),
      pd(`${V1}/stages?pipeline_id=${pipelineId}`, TK),
      fetchWonMonth(pipelineId, userId, monthStart, TK),
      fetchOpenDeals(pipelineId, userId, TK),
    ]);

    // Funil 7 (Captação Ativa) usa definição de NEGÓCIO (MQL/SQL cross-funil, OPP por apresentação, Venda=Ganho).
    // Demais funis mantêm a definição por ETAPA até terem coordenadas próprias.
    let geracao;
    if (pipelineId === 7) {
      const [entrantesCF, opp] = await Promise.all([
        fetchEntrantesCrossFunil(userId, monthStart, TK),
        computeOppFunil7(pipelineId, userId, monthStart, monthEnd, TK),
      ]);
      const base = computeGeracaoCA(entrantesCF);
      geracao = { ...base, opp, venda: won.count };
    } else {
      const entrantes = await fetchEntrantesMonth(pipelineId, userId, monthStart, TK);
      geracao = computeGeracao(entrantes, stagesRaw);
    }

    const metaParam = u.searchParams.get("meta");
    const metaMensal =
      metaParam && !isNaN(Number(metaParam)) && Number(metaParam) > 0
        ? Number(metaParam)
        : META_POR_FUNIL[pipelineId] || META_PADRAO;
    const d = deriveMetrics({ ano, mes, diaAtual, faturamentoAtual: won.sum, negociosGanhos: won.count, metaMensal });

    const stages = (stagesRaw.data || []).sort((a, b) => a.order_nr - b.order_nr);
    const porStage = new Map();
    for (const o of open) porStage.set(o.stageId, (porStage.get(o.stageId) || 0) + 1);
    const funil = stages.map((s) => ({ etapa: s.name, quantidade: porStage.get(s.id) || 0 }));
    funil.push({ etapa: "Ganho (mês)", quantidade: won.count });

    const pipelineAbertoTotal = open.reduce((acc, o) => acc + o.value, 0);
    const abertoCount = open.length; // nº de leads em aberto (p/ teto saudável de 55)

    res.status(200).json({
      mesReferencia: nomeMes(ano, mes),
      funilNome: (pipe.data && pipe.data.name) || `Funil ${pipelineId}`,
      usuarioNome: (user && user.data && user.data.name) || "Todos os vendedores",
      metaMensal,
      faturamentoAtual: won.sum,
      negociosGanhos: won.count,
      pipelineAbertoTotal,
      abertoCount,
      funil,
      geracao,
      forecastSemanal: buildForecast(open),
      ...d,
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
