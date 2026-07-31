// FONTE DA VERDADE dos JSON de configuração/dataset do Playbook = coleção `store` do Firestore.
//
// Antes: todo endpoint lia e GRAVAVA os JSON via GitHub Contents API. Consequências que isso trouxe:
//   1) /api/snapshot e /api/fc-history geravam COMMITS automáticos no repo (ruído + conflito de sha
//      quando duas execuções colidiam, ainda mais com Vercel e Firebase rodando em paralelo);
//   2) um único GITHUB_TOKEN revogado derrubou o painel inteiro em 30/07/2026 (todos os endpoints
//      de configuração dependiam dele);
//   3) o teto de escrita passava pela API do GitHub, não pelo banco.
//
// Agora: leitura e escrita vão ao Firestore. O GitHub fica apenas como SEED de leitura — se o doc
// ainda não existe no store, buscamos no repo uma única vez (migração transparente, sem downtime).
//
// Mapa origem -> doc: "metas.json" -> store/metas · "data/history.json" -> store/data__history
// (o `/` não é permitido em id de documento; o mesmo esquema que o espelho de 29/07 já usava).
//
// Schema do doc: { json: stringValue, origem: stringValue, updatedAt: timestampValue }
//
// ZERO dependência npm, igual ao lib/fscache.js — reusa a autenticação dele.

const { auth } = require("./fscache");

const GH_REPO = "vendas-captei/playbook";
const docFor = (origem) => origem.replace(/^data\//, "data__").replace(/\.json$/, "");
const DOCS = () =>
  `https://firestore.googleapis.com/v1/projects/${auth.projectId()}/databases/(default)/documents/store`;

// Lê do GitHub. Só é chamado quando o doc ainda não existe no store (seed da migração).
async function seedFromGitHub(origem) {
  const tok = process.env.GITHUB_TOKEN;
  if (!tok) return null;
  const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${origem}`, {
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "PlaybookApp",
    },
    cache: "no-store",
  });
  if (!r.ok) return null;
  const j = await r.json();
  try {
    return JSON.parse(Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8") || "null");
  } catch (_) {
    return null;
  }
}

// Retorna o objeto guardado, ou `null` se não existe em nenhum dos dois lugares.
// LANÇA em falha de infraestrutura (auth, 5xx) — o endpoint deve responder 500, não dado vazio.
async function readJson(origem) {
  if (!auth.ativo()) throw new Error("store: Firestore não configurado (FIREBASE_SA_JSON ou ADC ausente)");
  const r = await fetch(`${DOCS()}/${docFor(origem)}`, {
    headers: { Authorization: `Bearer ${await auth.token()}` },
    cache: "no-store",
  });
  if (r.status === 404) {
    const seed = await seedFromGitHub(origem);          // migração: 1ª leitura vem do repo
    if (seed !== null) await writeJson(origem, seed);   // e já fica gravada no store
    return seed;
  }
  if (!r.ok) throw new Error(`store: Firestore ${r.status} ao ler ${origem}`);
  const f = (await r.json()).fields || {};
  return f.json ? JSON.parse(f.json.stringValue) : null;
}

// Grava e devolve true. LANÇA se o Firestore recusar — nunca falha em silêncio.
async function writeJson(origem, obj) {
  if (!auth.ativo()) throw new Error("store: Firestore não configurado (FIREBASE_SA_JSON ou ADC ausente)");
  const qs = "updateMask.fieldPaths=json&updateMask.fieldPaths=origem&updateMask.fieldPaths=updatedAt";
  const r = await fetch(`${DOCS()}/${docFor(origem)}?${qs}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${await auth.token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        json: { stringValue: JSON.stringify(obj) },
        origem: { stringValue: origem },
        updatedAt: { timestampValue: new Date().toISOString() },
      },
    }),
  });
  if (!r.ok) throw new Error(`store: Firestore ${r.status} ao gravar ${origem}: ${(await r.text()).slice(0, 200)}`);
  return true;
}

// Leitura com cache em memória por instância. Para quem lia o JSON com `require()` no topo do
// módulo (tpc.js, filters.js): o require só é avaliado uma vez e passaria a servir o arquivo
// CONGELADO do repo, já que as escritas agora vão para o Firestore. `fallback` é o último recurso
// se o store estiver indisponível — melhor devolver dado velho do que derrubar o painel.
const _mem = new Map();
async function readJsonCached(origem, ttlMs = 60000, fallback = null) {
  const hit = _mem.get(origem);
  if (hit && hit.exp > Date.now()) return hit.val;
  try {
    const val = await readJson(origem);
    _mem.set(origem, { val, exp: Date.now() + ttlMs });
    return val;
  } catch (e) {
    if (hit) return hit.val;
    return fallback;
  }
}

// Body de POST, à prova das duas pilhas. Mora aqui (e não num 3º arquivo) porque é usado pelos
// mesmos endpoints que gravam no store, e cada arquivo novo em lib/ precisa ser espelhado em functions/lib/.
//   - Vercel: o runtime Node já popula req.body; se não, o stream ainda está intacto e pode ser lido.
//   - Firebase: o express.json() do functions/index.js JÁ CONSUMIU o stream — ler req.on("data") ali
//     nunca dispara 'end' e a request trava até o timeout. Por isso req.body vem primeiro.
async function readBody(req) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) return req.body;
  if (typeof req.body === "string" && req.body) { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  if (req.readableEnded || req.complete) return {};
  const raw = await new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
    req.on("error", () => resolve(""));
  });
  try { return JSON.parse(raw || "{}"); } catch (_) { return {}; }
}

module.exports = { readJson, writeJson, readJsonCached, docFor, readBody };
