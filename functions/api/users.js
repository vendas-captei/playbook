// Usuários do Playbook (login + perfil) — Firestore `store`/`users` (antes: users.json no repo).
// GET  /api/users            -> { users: [...], sha: null }
// POST /api/users { users }  -> grava e devolve { ok, sha: null }
// O `sha` era o do GitHub Contents API; segue no retorno como null só por compatibilidade — o front
// reenvia o que recebeu no GET, mas nunca o usa (conferido em index.html). Ver lib/store.js.
const { readJson, writeJson, readBody } = require("../lib/store");
const ORIGEM = "users.json";

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") { res.status(200).end(); return; }

  try {
    if (req.method === "GET") {
      res.status(200).json({ users: (await readJson(ORIGEM)) || [], sha: null });
      return;
    }
    if (req.method === "POST") {
      const { users } = await readBody(req);
      if (!Array.isArray(users)) { res.status(400).json({ error: "users must be array" }); return; }
      await writeJson(ORIGEM, users);
      res.status(200).json({ ok: true, sha: null });
      return;
    }
    res.status(405).end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
