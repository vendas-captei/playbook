// Lista funis + usuários ativos do Pipedrive para os filtros do dashboard.
// Gêmeo de api/users.js — serverless function servida pela Vercel.
const V1 = "https://api.pipedrive.com/v1";

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const TK = process.env.PIPEDRIVE_API_TOKEN;
  if (!TK) {
    res.status(500).json({ error: "PIPEDRIVE_API_TOKEN não configurado na Vercel" });
    return;
  }
  try {
    const [pipes, users] = await Promise.all([
      fetch(`${V1}/pipelines?api_token=${TK}`).then((r) => r.json()),
      fetch(`${V1}/users?api_token=${TK}`).then((r) => r.json()),
    ]);
    const funis = (pipes.data || [])
      .filter((p) => p.active && !/^OLD|Testes/i.test(p.name))
      .map((p) => ({ id: p.id, nome: p.name }));
    const usuarios = (users.data || [])
      .filter((u) => u.active_flag)
      .map((u) => ({ id: u.id, nome: u.name }))
      .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));
    res.status(200).json({ funis, usuarios });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
