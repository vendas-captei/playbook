// Lista funis + usuários ativos do Pipedrive para os filtros do dashboard.
// Gêmeo de api/users.js — serverless function servida pela Vercel.
//
// Resiliência (2026-07-15, Natan): o Pipedrive/Cloudflare devolve 429 "Too many requests"
// como TEXTO PURO quando o token compartilhado estoura a cota de borda. O `.json()` direto
// quebrava o dashboard ("Unexpected token 'T'"). Agora:
//   1) cache de borda do Vercel (s-maxage) colapsa N loads em 1 chamada upstream;
//   2) retry/backoff no 429/5xx;
//   3) fallback para o snapshot commitado em data/filters.json → o painel NUNCA quebra.
// O snapshot é refrescado pelo cron (api/snapshot.js). Ver data/filters.json.
const V1 = "https://api.pipedrive.com/v1";

// Snapshot commitado (fonte de fallback). Ver data/filters.json.
let CACHE = null;
try { CACHE = require("../data/filters.json"); } catch (_) { CACHE = null; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// GET no Pipedrive resiliente: retry em 429/5xx, erro claro (nunca .json() em texto de erro).
async function pdJson(url, tries = 3) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) return r.json();
    last = `Pipedrive ${r.status}`;
    if (r.status === 429 || r.status >= 500) { await sleep((i + 1) * 700); continue; }
    throw new Error(last);
  }
  throw new Error(`${last} (rate limit persistente)`);
}

module.exports = async function handler(req, res) {
  const TK = process.env.PIPEDRIVE_API_TOKEN;

  // Boot do dashboard: ?src=cache serve o snapshot commitado direto — ZERO Pipedrive.
  // Política sob demanda (2026-07-15): só o botão "Atualizar" pode tocar o Pipedrive.
  if (/[?&]src=cache(&|$)/.test(req.url || "") && CACHE && Array.isArray(CACHE.funis) && CACHE.funis.length) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      funis: CACHE.funis,
      usuarios: CACHE.usuarios || [],
      stale: true,
      fromCache: true,
      atualizadoEm: (CACHE._meta && CACHE._meta.atualizado_em) || null,
    });
    return;
  }

  try {
    if (!TK) throw new Error("PIPEDRIVE_API_TOKEN não configurado na Vercel");
    const [pipes, users] = await Promise.all([
      pdJson(`${V1}/pipelines?api_token=${TK}`),
      pdJson(`${V1}/users?api_token=${TK}`),
    ]);
    const funis = (pipes.data || [])
      .filter((p) => p.active && !/^OLD|Testes/i.test(p.name))
      .map((p) => ({ id: p.id, nome: p.name }));
    const usuarios = (users.data || [])
      .filter((u) => u.active_flag)
      .map((u) => ({ id: u.id, nome: u.name, email: (u.email || "").toLowerCase() }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    // Cache de borda: 5min fresco + 1 dia servindo stale enquanto revalida em background.
    // Colapsa dezenas de aberturas do painel numa única chamada ao Pipedrive.
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=86400");
    res.status(200).json({ funis, usuarios, stale: false });
  } catch (e) {
    // Fallback: serve o snapshot commitado — o dashboard não depende da API estar de pé.
    if (CACHE && Array.isArray(CACHE.funis) && CACHE.funis.length) {
      res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=86400");
      res.status(200).json({
        funis: CACHE.funis,
        usuarios: CACHE.usuarios || [],
        stale: true,
        motivo: e.message,
        atualizadoEm: (CACHE._meta && CACHE._meta.atualizado_em) || null,
      });
      return;
    }
    res.status(500).json({ error: e.message });
  }
};
