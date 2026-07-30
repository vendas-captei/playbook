// Cache em Firestore (projeto Firebase "playbook-comercial") — substitui o Vercel Edge Config,
// que estourou o limite do plano free em 22/07/2026 (250 escritas/MÊS) e falhava em silêncio.
// Firestore free tier = 20.000 escritas/DIA. Ver 2026-07-29_viabilidade-migracao-vercel-firebase.md
//
// ZERO dependência npm de propósito: o repo não tem package.json. Usa só o builtin `crypto`
// (assinatura RS256 do JWT da service account) e o `fetch` global do Node 18+, já usado no repo.
// Não está em api/ para não contar no teto de 12 Serverless Functions da Vercel (estamos em 12/12).

const crypto = require("crypto");

let SA = null;
try { SA = JSON.parse(process.env.FIREBASE_SA_JSON || "null"); } catch (_) { SA = null; }

const BASE = SA ? `https://firestore.googleapis.com/v1/projects/${SA.project_id}/databases/(default)/documents/cache` : null;
const b64u = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let _tok = null, _exp = 0;
async function token() {
  const now = Math.floor(Date.now() / 1000);
  if (_tok && _exp > now + 60) return _tok;                       // reusa o token por ~1h
  const hdr = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const pl = b64u(JSON.stringify({
    iss: SA.client_email,
    scope: "https://www.googleapis.com/auth/datastore",           // escopo mínimo: só Firestore
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }));
  const sig = b64u(crypto.createSign("RSA-SHA256").update(`${hdr}.${pl}`).sign(SA.private_key));
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${hdr}.${pl}.${sig}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("firestore auth falhou");
  _tok = j.access_token; _exp = now + (j.expires_in || 3600);
  return _tok;
}

// Blob inteiro guardado como um único stringValue → mesma semântica do Edge Config.
// Retorna null em qualquer falha (mesmo contrato dos wrappers originais, que engoliam erro).
async function fsRead(key) {
  if (!SA) return null;
  try {
    const r = await fetch(`${BASE}/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${await token()}` }, cache: "no-store",
    });
    if (!r.ok) return null;                                        // 404 = chave nunca gravada
    const f = (await r.json()).fields || {};
    return f.json ? JSON.parse(f.json.stringValue) : null;
  } catch (_) { return null; }
}

async function fsWrite(key, value) {
  if (!SA) return false;
  try {
    const qs = "updateMask.fieldPaths=json&updateMask.fieldPaths=updatedAt";
    const r = await fetch(`${BASE}/${encodeURIComponent(key)}?${qs}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: {
        json: { stringValue: JSON.stringify(value) },
        updatedAt: { timestampValue: new Date().toISOString() },
      } }),
    });
    return r.ok;
  } catch (_) { return false; }
}

module.exports = { fsRead, fsWrite, ativo: () => !!SA };
