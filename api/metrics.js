// Tracking mensal ao vivo do Pipedrive — filtrável por funil, usuário e mês.
// GET /api/metrics?pipeline_id=7&user_id=16776298&month=2026-07
// Serverless function servida pela Vercel (mesmo padrão de api/users.js).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const META_POR_FUNIL = { 7: 160000, 2: 80000 }; // ajuste por funil
const META_PADRAO = 160000;

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
}

function contarDiasUteis(ano, mes, de, ate) {
  let c = 0;
  for (let d = de; d <= ate; d++) {
    const w = new Date(ano, mes, d).getDay();
    if (w !== 0 && w !== 6) c++;
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

// Geração do mês: entrantes (Entrada), SQL (alcançou Qualificado, ord>=4) e Reuniões (alcançou Reunião Agendada, ord>=5).
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
  return { mql, sql, reunioes, qualNome, reuniaoNome };
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
    const monthStart = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;
    const ehMesAtual = ano === now.getFullYear() && mes === now.getMonth();
    const diaAtual = ehMesAtual ? now.getDate() : new Date(ano, mes + 1, 0).getDate();

    const [pipe, user, stagesRaw, won, open, entrantes] = await Promise.all([
      pd(`${V1}/pipelines/${pipelineId}`, TK),
      userId ? pd(`${V1}/users/${userId}`, TK) : Promise.resolve(null),
      pd(`${V1}/stages?pipeline_id=${pipelineId}`, TK),
      fetchWonMonth(pipelineId, userId, monthStart, TK),
      fetchOpenDeals(pipelineId, userId, TK),
      fetchEntrantesMonth(pipelineId, userId, monthStart, TK),
    ]);
    const geracao = computeGeracao(entrantes, stagesRaw);

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

    res.status(200).json({
      mesReferencia: nomeMes(ano, mes),
      funilNome: (pipe.data && pipe.data.name) || `Funil ${pipelineId}`,
      usuarioNome: (user && user.data && user.data.name) || "Todos os vendedores",
      metaMensal,
      faturamentoAtual: won.sum,
      negociosGanhos: won.count,
      pipelineAbertoTotal,
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
