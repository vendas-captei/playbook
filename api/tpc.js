// TPC — Tempo de Primeiro Contato (minutos entre a ENTRADA do deal no funil e a 1ª atividade de contato real).
// GET /api/tpc?pipeline_id=7&month=2026-07&user_id=opcional
// Regras: ignora gatilhos de sistema (a IA sendo acionada não é contato). Meta de performance: 5 min.
// Custo: 1 chamada de atividades por deal, com pool de concorrência + cap (evita timeout do serverless).
const V1 = "https://api.pipedrive.com/v1";
const V2 = "https://api.pipedrive.com/api/v2";

// Tipos que NÃO contam como primeiro contato (automação/registro de sistema).
const TIPOS_SISTEMA = new Set(["gatilho_copiloto"]);
const CAP = 180;          // teto de deals amostrados por request
const CONCURRENCY = 10;   // requisições simultâneas de atividades
const META_MIN = 5;       // meta de TPC em minutos

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
  // aceita "2026-07-01 09:31:17" (v1) e "2026-07-01T09:38:31Z" (v2) — ambos UTC
  const iso = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const t = Date.parse(iso);
  return isNaN(t) ? null : t;
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
  return (acts[0] - addTime) / 60000; // minutos
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

    // Entrantes do mês (add_time), via timeline (mesma fonte do metrics.js)
    let url = `${V1}/deals/timeline?start_date=${monthStart}&interval=month&amount=1&field_key=add_time&pipeline_id=${pipelineId}`;
    if (userId) url += `&user_id=${userId}`;
    const tl = await pd(url, TK);
    let deals = (tl.data && tl.data[0] && tl.data[0].deals) || [];
    const totalEntrantes = deals.length;

    // Amostra: mais recentes primeiro, cap para caber no tempo do serverless
    deals = deals
      .filter((d) => d.add_time)
      .sort((a, b) => (parseData(b.add_time) || 0) - (parseData(a.add_time) || 0))
      .slice(0, CAP);

    const mins = (await poolMap(deals, (d) => primeiroContatoMin(d, TK), CONCURRENCY)).filter((m) => m != null && m >= 0);

    const comContato = mins.length;
    const med = mediana(mins);
    const dentroMeta = mins.filter((m) => m <= META_MIN).length;
    const pctDentro = comContato ? (dentroMeta / comContato) * 100 : 0;

    res.status(200).json({
      metaMin: META_MIN,
      totalEntrantes,
      amostra: deals.length,
      capAtingido: totalEntrantes > CAP,
      comContato,
      medianaMin: Math.round(med * 10) / 10,
      pctDentroMeta: Math.round(pctDentro),
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
