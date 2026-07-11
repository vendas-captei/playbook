// Forecast de Vendas ao vivo do Pipedrive — pipeline ponderado por etapa + 3 cenários.
// GET /api/forecast?pipeline_id=7&user_id=16776298&month=2026-07
// Metodologia (Playbook › SalesOps › Forecast): valor do deal × probabilidade da etapa = ponderado;
// soma = forecast realista. Cenários: pessimista (só etapas finais), realista (ponderado), otimista (tudo).
// Probabilidades por etapa NÃO existem no Pipedrive (todas vêm 100%) → premissas editáveis (fcparams.json).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";
const META_POR_FUNIL = { 7: 160000, 2: 80000 };
const META_PADRAO = 160000;

// Probabilidades default por etapa (%), por funil, chaveadas por stageId. Editáveis via /api/fcparams.
// Curva típica B2B; "Proposta Enviada = 40–50%" como no exemplo do Playbook. Serão calibradas com histórico.
const PROB_DEFAULT = {
  "7": { 37: 5, 38: 8, 39: 12, 40: 20, 41: 35, 144: 10, 42: 50, 43: 65, 79: 85, 80: 95 },
  "2": { 6: 5, 149: 8, 7: 12, 8: 20, 9: 35, 10: 10, 100: 50, 101: 65, 102: 85, 150: 95 },
};

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
}

async function fetchOpenDeals(pipelineId, userId, TK) {
  const out = [];
  let cursor = null, guard = 0;
  do {
    let url = `${V2}/deals?status=open&pipeline_id=${pipelineId}&limit=500`;
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

async function fetchWonMonth(pipelineId, userId, monthStart, TK) {
  let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=won_time&status=won&pipeline_id=${pipelineId}`;
  if (userId) url += `&user_id=${userId}`;
  const r = await pd(url, TK);
  const deals = (r.data && r.data[0] && r.data[0].deals) || [];
  return { count: deals.length, sum: deals.reduce((a, d) => a + (Number(d.value) || 0), 0) };
}

// Carrega probabilidades salvas (fcparams.json no repo) e mescla sobre os defaults. Sem token/arquivo → só defaults.
async function loadProbs(pipelineId) {
  const base = { ...(PROB_DEFAULT[pipelineId] || {}) };
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) return base;
  try {
    const GH = `https://api.github.com/repos/vendas-captei/playbook/contents/fcparams.json`;
    const r = await fetch(GH, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/vnd.github+json", "User-Agent": "PlaybookApp" }, cache: "no-store" });
    if (!r.ok) return base;
    const j = await r.json();
    const saved = JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "{}");
    return { ...base, ...(saved[pipelineId] || {}) };
  } catch (_) { return base; }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const TK = process.env.PIPEDRIVE_API_TOKEN;
  if (!TK) { res.status(500).json({ error: "PIPEDRIVE_API_TOKEN não configurado na Vercel" }); return; }
  try {
    const u = new URL(req.url, "http://localhost");
    const pipelineId = Number(u.searchParams.get("pipeline_id")) || 7;
    const userId = u.searchParams.get("user_id") ? Number(u.searchParams.get("user_id")) : null;
    const month = u.searchParams.get("month");

    const now = new Date();
    let ano = now.getFullYear(), mes = now.getMonth();
    if (month && /^\d{4}-\d{2}$/.test(month)) { const p = month.split("-").map(Number); ano = p[0]; mes = p[1] - 1; }
    const monthStart = `${ano}-${String(mes + 1).padStart(2, "0")}-01`;

    const [pipe, user, stagesRaw, open, won, probs] = await Promise.all([
      pd(`${V1}/pipelines/${pipelineId}`, TK),
      userId ? pd(`${V1}/users/${userId}`, TK) : Promise.resolve(null),
      pd(`${V1}/stages?pipeline_id=${pipelineId}`, TK),
      fetchOpenDeals(pipelineId, userId, TK),
      fetchWonMonth(pipelineId, userId, monthStart, TK),
      loadProbs(String(pipelineId)),
    ]);

    const stages = (stagesRaw.data || []).sort((a, b) => a.order_nr - b.order_nr);
    const orderById = new Map(stages.map((s) => [s.id, s.order_nr]));
    // "Etapas finais" p/ o cenário pessimista = Proposta Enviada em diante.
    let propostaOrder = 7;
    for (const s of stages) if (/proposta/i.test(s.name || "")) propostaOrder = s.order_nr;

    // Agrega o pipeline aberto por etapa: nº de deals, valor total, prob e valor ponderado.
    const agg = new Map(); // stageId -> {count, valor}
    for (const o of open) {
      const a = agg.get(o.stageId) || { count: 0, valor: 0 };
      a.count++; a.valor += o.value; agg.set(o.stageId, a);
    }
    const porEtapa = stages.map((s) => {
      const a = agg.get(s.id) || { count: 0, valor: 0 };
      const prob = probs[s.id] != null ? Number(probs[s.id]) : 0;
      return { stageId: s.id, etapa: s.name, ordem: s.order_nr, quantidade: a.count, valor: Math.round(a.valor), prob, ponderado: Math.round(a.valor * prob / 100), final: s.order_nr >= propostaOrder };
    });

    const totalAberto = porEtapa.reduce((x, e) => x + e.valor, 0);
    const ponderado = porEtapa.reduce((x, e) => x + e.ponderado, 0);
    // Pessimista: apenas etapas finais (Proposta em diante), no valor ponderado (commit de alta confiança).
    const ponderadoFinais = porEtapa.filter((e) => e.final).reduce((x, e) => x + e.ponderado, 0);

    const realizado = won.sum; // já ganho no mês (entra em todos os cenários como piso)
    const cenarios = {
      pessimista: Math.round(realizado + ponderadoFinais),
      realista: Math.round(realizado + ponderado),
      otimista: Math.round(realizado + totalAberto),
    };

    const metaParam = u.searchParams.get("meta");
    const metaMensal = metaParam && Number(metaParam) > 0 ? Number(metaParam) : (META_POR_FUNIL[pipelineId] || META_PADRAO);

    res.status(200).json({
      funilNome: (pipe.data && pipe.data.name) || `Funil ${pipelineId}`,
      usuarioNome: (user && user.data && user.data.name) || "Todos os vendedores",
      mesReferencia: new Date(ano, mes, 1).toLocaleDateString("pt-BR", { month: "long", year: "numeric" }).replace(/^./, (c) => c.toUpperCase()),
      metaMensal,
      realizado, negociosGanhos: won.count,
      totalAberto: Math.round(totalAberto), ponderado: Math.round(ponderado),
      dealsAbertos: open.length,
      cenarios,
      gapRealista: Math.round(metaMensal - cenarios.realista),
      porEtapa,
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
};
