// TPC — Tempo de Primeiro Contato (minutos entre a ENTRADA do deal no funil e a 1ª atividade de contato real).
// GET /api/tpc?pipeline_id=7&month=2026-07&user_id=opcional
// Regras: ignora gatilhos de sistema (a IA sendo acionada não é contato). Meta de performance: 5 min.
// Além do agregado do mês, devolve a SÉRIE DIÁRIA (mediana de TPC por dia de entrada) p/ o sparkline.
// Meses fechados (visão equipe) são servidos do histórico CONGELADO (data/history.json) — 0 varreduras.
// Custo: 1 chamada de atividades por deal, com pool de concorrência + cap (evita timeout do serverless).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";

let HISTORY = {};
try { HISTORY = require("../data/history.json"); } catch (_) { HISTORY = {}; }

// Tipos que NÃO contam como primeiro contato (automação/registro de sistema).
const TIPOS_SISTEMA = new Set(["gatilho_copiloto"]);
const CAP = 220;          // teto de deals amostrados por request
const CONCURRENCY = 10;   // requisições simultâneas de atividades
const META_MIN = 5;       // meta de TPC em minutos
const BRT = -3 * 3600000;

function pd(url, TK) {
  const sep = url.includes("?") ? "&" : "?";
  return fetch(`${url}${sep}api_token=${TK}`, { cache: "no-store" }).then(async (r) => {
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1200)); return pd(url, TK); }
    if (!r.ok) throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
    return r.json();
  });
}

function parseData(s) {
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
}

// Dia do mês (1..31) da entrada, em BRT.
function diaBR(s) {
  const t = parseData(s);
  return t == null ? null : new Date(t + BRT).getUTCDate();
}

// Minutos ÚTEIS entre dois instantes (UTC): desconsidera sábado e domingo (corte BRT).
function minutosUteis(iniMs, fimMs) {
  if (fimMs <= iniMs) return 0;
  let total = 0, cur = iniMs;
  while (cur < fimMs) {
    const dBr = new Date(cur + BRT);
    const dow = dBr.getUTCDay();
    const proxMeiaNoiteBr = Date.UTC(dBr.getUTCFullYear(), dBr.getUTCMonth(), dBr.getUTCDate() + 1) - BRT;
    const segFim = Math.min(proxMeiaNoiteBr, fimMs);
    if (dow !== 0 && dow !== 6) total += segFim - cur;
    cur = segFim;
  }
  return total / 60000;
}

async function primeiroContatoMin(deal, TK) {
  const addTime = parseData(deal.add_time);
  if (addTime == null) return null;
  const r = await pd(`${V2}/activities?deal_id=${deal.id}&limit=100`, TK);
  const acts = (r.data || [])
    .filter((a) => !TIPOS_SISTEMA.has(a.type))
    .map((a) => parseData(a.add_time))
    .filter((t) => t != null && t >= addTime)
    .sort((a, b) => a - b);
  if (!acts.length) return null;
  return minutosUteis(addTime, acts[0]);
}

async function poolMap(items, fn, size) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx]); } catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
  return out;
}

function mediana(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const r1 = (x) => Math.round(x * 10) / 10;

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
    const monthKey = monthStart.slice(0, 7);
    const lastDay = new Date(ano, mes + 1, 0).getDate();
    const dias = Array.from({ length: lastDay }, (_, i) => i + 1);
    const ehMesAtual = ano === now.getFullYear() && mes === now.getMonth();

    // Mês fechado + visão equipe → série congelada do histórico (instantâneo).
    const hrec = (HISTORY[pipelineId] && HISTORY[pipelineId][monthKey]) || null;
    if (!ehMesAtual && !userId && hrec && hrec.tpc) {
      res.status(200).json({ ...hrec.tpc, historico: true, atualizadoEm: new Date().toISOString() });
      return;
    }

    // Entrantes do mês (add_time) do funil. Se a janela-mês der 500 (importação em massa),
    // cai p/ buckets diários somados.
    let deals = [];
    async function timelineMes() {
      let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=add_time&pipeline_id=${pipelineId}`;
      if (userId) url += `&user_id=${userId}`;
      const tl = await pd(url, TK);
      return (tl.data && tl.data[0] && tl.data[0].deals) || [];
    }
    async function timelineDias() {
      const acc = {};
      for (let d = 1; d <= lastDay; d++) {
        let url = `${V1}/deals/timeline?start_date=${ano}-${String(mes + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}&interval=day&amount=1&field_key=add_time&pipeline_id=${pipelineId}`;
        if (userId) url += `&user_id=${userId}`;
        try { const tl = await pd(url, TK); for (const x of ((tl.data && tl.data[0] && tl.data[0].deals) || [])) acc[x.id] = x; } catch (_) {}
      }
      return Object.values(acc);
    }
    try { deals = await timelineMes(); } catch (e) { if (String(e.message).includes("500")) deals = await timelineDias(); else throw e; }

    const totalEntrantes = deals.length;
    deals = deals
      .filter((d) => d.add_time)
      .sort((a, b) => (parseData(b.add_time) || 0) - (parseData(a.add_time) || 0))
      .slice(0, CAP);

    const raw = await poolMap(deals, async (d) => ({ m: await primeiroContatoMin(d, TK), dia: diaBR(d.add_time) }), CONCURRENCY);
    const rows = raw.filter((x) => x && x.m != null && x.m >= 0 && x.dia != null);

    const mins = rows.map((x) => x.m);
    const comContato = mins.length;
    const med = mediana(mins);
    const dentroMeta = mins.filter((m) => m <= META_MIN).length;
    const pctDentro = comContato ? (dentroMeta / comContato) * 100 : 0;

    // Série diária: mediana de TPC por dia de entrada.
    const porDia = new Map();
    for (const x of rows) { if (!porDia.has(x.dia)) porDia.set(x.dia, []); porDia.get(x.dia).push(x.m); }
    const serie = dias.map((d) => (porDia.has(d) ? r1(mediana(porDia.get(d))) : null));
    const counts = dias.map((d) => (porDia.has(d) ? porDia.get(d).length : 0));

    res.status(200).json({
      metaMin: META_MIN,
      totalEntrantes,
      amostra: deals.length,
      capAtingido: totalEntrantes > CAP,
      comContato,
      medianaMin: r1(med),
      pctDentroMeta: Math.round(pctDentro),
      dias, serie, counts,
      historico: false,
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
