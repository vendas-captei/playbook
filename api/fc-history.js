// Histórico congelado do Forecast (data/forecast-history.json). Leitura pública p/ a aba Forecast.
// GET /api/fc-history[?pipeline_id=7] -> série de meses { forecastInicial, fechamento } por funil.
// GET /api/fc-history?dataset=accuracy -> Acurácia de Previsão (data/forecast-accuracy.json):
//   Previsto (expected_close_date, as-of via changelog) x Realizado (won) por dia/vendedor/funil.
//   Merge automático com o overlay ao vivo do Edge Config (chave accLive), se existir.
// GET /api/fc-history?dataset=accuracy&refresh=1 -> ATUALIZA do Pipedrive (incremental, cabe em 10s):
//   realizado (ganhos) ao vivo + previsto de hoje/futuro (abertos c/ ECD); passado vem do JSON base.
//   Grava overlay compacto no Edge Config e devolve o resultado mesclado. ÚNICA porta ao Pipedrive aqui.
// GET /api/fc-history?dataset=forecast-log -> Log da Calculadora de Data de Fechamento IA.
const REPO = "vendas-captei/playbook";
const PATHS = { history: "data/forecast-history.json", accuracy: "data/forecast-accuracy.json", "forecast-log": "data/forecast-log.json" };
const V2 = "https://api.pipedrive.com/api/v2";
const WINDOW = "2026-05-01";        // início da janela (igual ao script de backfill)
const PIPES = [7, 2];               // Captação Ativa (7) + IA Copiloto (2)

// Overlay ao vivo da acurácia (mesmo padrão do metrics.js), no cache Firestore.
const { fsRead, fsWrite } = require("../lib/fscache");

// Cache migrado do Vercel Edge Config para o Firestore em 29/07/2026: o plano free do Edge
// Config permite 250 escritas/MÊS e estourou em 22/07, falhando em silêncio (o painel abria com
// foto velha). Firestore free tier = 20.000 escritas/DIA.
// LEITURA: Firestore primeiro, com fallback no Edge Config (a foto antiga segue legível até a
// primeira gravação nova). ESCRITA: só Firestore — as escritas do Edge Config estão mortas.

// Datasets do Forecast agora vivem no Firestore (coleção `store`) — antes eram arquivos no repo,
// e este endpoint COMMITAVA a cada rebuild diário do cron. Ver lib/store.js.
// A assinatura mantém `tok` só para não mexer nas dezenas de chamadas; ele não é mais usado.
const { readJson, writeJson } = require("../lib/store");
async function loadJson(path, tok) {
  return (await readJson(path)) || {};
}

async function ecRead(key) {
  return await fsRead(key);
}
async function ecWrite(key, value) {
  return await fsWrite(key, value);
}

// Persiste o dataset no store (reflete na hora no loadJson). Nome mantido por compatibilidade com
// as chamadas existentes; não commita mais nada no GitHub. `msg` e `tok` ficam sem uso.
async function ghPut(path, obj, tok, msg) {
  try {
    return await writeJson(path, obj);
  } catch (_) { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// GET no Pipedrive com backoff em 429/5xx (Cloudflare de borda devolve 429 sob rajada).
async function pdGet(url, tok, tries = 4) {
  const sep = url.includes("?") ? "&" : "?";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(`${url}${sep}api_token=${tok}`, { headers: { "User-Agent": "PlaybookApp" }, cache: "no-store" });
    if (r.ok) return r.json();
    if ((r.status === 429 || r.status >= 500) && i < tries - 1) { await sleep(400 * (i + 1)); continue; }
    throw new Error(`Pipedrive ${r.status} em ${url.split("?")[0]}`);
  }
}
async function listDeals(qs, tok, maxPages = 40) {
  const out = []; let cursor = null, pages = 0;
  do {
    const u = `${V2}/deals?${qs}&limit=500` + (cursor ? `&cursor=${cursor}` : "");
    const j = await pdGet(u, tok);
    out.push(...(j.data || []));
    cursor = (j.additional_data || {}).next_cursor; pages++;
  } while (cursor && pages < maxPages);
  return { deals: out, truncated: !!cursor };
}

function addCell(buckets, owner, day, value) {
  const o = (buckets[owner] = buckets[owner] || {});
  const c = (o[day] = o[day] || { value: 0, count: 0 });
  c.value += (+value || 0); c.count += 1;
}
// Rollup mensal a partir da série diária: meses[owner][YYYY-MM] = {previsto,real}{value,count}.
function monthly(seriesPid) {
  const out = {};
  for (const [owner, kinds] of Object.entries(seriesPid)) {
    const m = {};
    for (const kind of ["previsto", "real"]) {
      for (const [day, cell] of Object.entries(kinds[kind] || {})) {
        const mo = day.slice(0, 7);
        const rec = (m[mo] = m[mo] || { previsto: { value: 0, count: 0 }, real: { value: 0, count: 0 } });
        rec[kind].value += cell.value; rec[kind].count += cell.count;
      }
    }
    out[owner] = m;
  }
  return out;
}

// today em America/Sao_Paulo (UTC-3, sem horário de verão) — alinha com o dia de negócio.
function hojeBR() { return new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10); }
function ymdMinus(ymd, n) { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); }

// Aplica o overlay ao vivo sobre o JSON base.
// PREVISTO write-once: dias JÁ CONGELADOS (<= previstoFrozenThrough) vêm SEMPRE do base e nunca mudam;
//   só os dias ainda não congelados (> frozenThrough = hoje ainda vivo + futuro) vêm do live (forecast).
//   O cron avança o congelamento p/ "hoje" no início do dia, fixando o valor daquele dia p/ sempre.
// REALIZADO: sempre autoritativo do live (é fato de venda, não congela).
function applyOverlay(base, ov) {
  if (!ov || !ov.pipes) return base;
  const out = JSON.parse(JSON.stringify(base || {}));
  out.series = out.series || {}; out.meses = out.meses || {};
  const today = ov.today || hojeBR();
  const frozen = (out._meta && out._meta.previstoFrozenThrough) || ymdMinus(today, 1);
  for (const P of Object.keys(ov.pipes)) {
    const sp = (out.series[P] = out.series[P] || {});
    const { real = {}, prevFut = {} } = ov.pipes[P];
    const owners = new Set([...Object.keys(sp), ...Object.keys(real), ...Object.keys(prevFut)]);
    for (const ow of owners) {
      const node = (sp[ow] = sp[ow] || { previsto: {}, real: {} });
      node.real = real[ow] || {};                       // realizado: live é autoritativo na janela
      const np = {};
      for (const [d, c] of Object.entries(node.previsto || {})) if (d <= frozen) np[d] = c;  // congelado (write-once)
      for (const [d, c] of Object.entries(prevFut[ow] || {})) if (d > frozen) np[d] = c;      // ainda vivo/forecast
      node.previsto = np;
    }
    out.meses[P] = monthly(sp);
  }
  out._meta = Object.assign({}, out._meta, { refreshed_em: ov.refreshed_em, refresh_mode: "incremental (realizado live + previsto forecast; congelado até " + frozen + ")", refresh_truncated: !!ov.truncated });
  return out;
}

// Monta o overlay ao vivo do Pipedrive (incremental, barato: ganhos + abertos c/ ECD).
// As 4 varreduras (won/open × F7/F2) rodam em PARALELO p/ caber folgado nos 10s da Vercel Hobby.
async function buildOverlay(pdtok) {
  const today = hojeBR();
  const results = await Promise.all(PIPES.map(async (pid) => {
    const [w, o] = await Promise.all([
      listDeals(`status=won&pipeline_id=${pid}`, pdtok),      // ganhos (janela)
      listDeals(`status=open&pipeline_id=${pid}`, pdtok, 12), // abertos: filtra os c/ ECD >= hoje
    ]);
    const real = {}, prevFut = {};
    for (const d of w.deals) {
      const wt = (d.won_time || "").slice(0, 10);
      if (!wt || wt < WINDOW) continue;
      addCell(real, "all", wt, d.value); addCell(real, String(d.owner_id), wt, d.value);
    }
    for (const d of o.deals) {
      const ecd = (d.expected_close_date || "").slice(0, 10);
      if (!ecd || ecd < today) continue;
      addCell(prevFut, "all", ecd, d.value); addCell(prevFut, String(d.owner_id), ecd, d.value);
    }
    return { P: String(pid), real, prevFut, truncated: o.truncated };
  }));
  const pipes = {}; let truncatedAny = false;
  for (const r of results) { pipes[r.P] = { real: r.real, prevFut: r.prevFut }; truncatedAny = truncatedAny || r.truncated; }
  return { refreshed_em: new Date().toISOString(), today, window: WINDOW, pipes, truncated: truncatedAny };
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const tok = process.env.GITHUB_TOKEN;
  try {
    const u = new URL(req.url, "http://localhost");
    const dataset = u.searchParams.get("dataset");
    if (dataset === "accuracy") {
      const base = await loadJson(PATHS.accuracy, tok);
      if (u.searchParams.get("refresh") === "1") {
        // ÚNICA porta ao Pipedrive: atualiza ao vivo, persiste overlay no Edge Config, devolve mesclado.
        const pdtok = process.env.PIPEDRIVE_API_TOKEN;
        if (!pdtok) { res.status(500).json({ error: "PIPEDRIVE_API_TOKEN não configurado" }); return; }
        const ov = await buildOverlay(pdtok);
        const persisted = await ecWrite("accLive", ov);            // best-effort (Edge Config Hobby = 250/mês)
        const merged = applyOverlay(base, ov);
        merged._meta = Object.assign({}, merged._meta, { refresh_persisted: persisted });
        // Persistência DURÁVEL (rebuild diário do base): grava o mesclado no store.
        // Autorizado para: Cloud Scheduler (req.internal, vindo do cronFcHistory em functions/index.js),
        // chamada com key=SNAPSHOT_KEY, ou o Vercel Cron legado (header x-vercel-cron) enquanto existir.
        const wantPersist = u.searchParams.get("persist") === "1";
        const authed = req.internal || req.headers["x-vercel-cron"] ||
          (process.env.SNAPSHOT_KEY && u.searchParams.get("key") === process.env.SNAPSHOT_KEY);
        if (wantPersist && authed) {
          const commitObj = JSON.parse(JSON.stringify(merged));
          // Avança o congelamento p/ HOJE: fixa o previsto de hoje (capturado no início do dia) p/ sempre.
          commitObj._meta = Object.assign({}, commitObj._meta, { gerado_em: new Date().toISOString(), refresh_via: "cron-incremental", previstoFrozenThrough: hojeBR() });
          delete commitObj._meta.refreshed_em; delete commitObj._meta.refresh_mode; delete commitObj._meta.refresh_persisted;
          merged._meta.committed = await ghPut(PATHS.accuracy, commitObj, tok, "chore(accuracy): rebuild diario incremental (cron)");
        }
        res.status(200).json(merged);
        return;
      }
      // Leitura normal: base (repo) + overlay ao vivo (Edge Config), SEM tocar no Pipedrive.
      res.status(200).json(applyOverlay(base, await ecRead("accLive")));
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
