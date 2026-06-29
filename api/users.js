const REPO_OWNER = 'vendas-captei';
const REPO_NAME  = 'playbook';
const FILE_PATH  = 'users.json';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const token = process.env.GITHUB_TOKEN;
  if (!token) { res.status(500).json({ error: 'GITHUB_TOKEN not configured' }); return; }

  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;
  const ghHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PlaybookApp',
  };

  if (req.method === 'GET') {
    const r = await fetch(apiUrl, { headers: ghHeaders });
    if (!r.ok) { res.status(500).json({ error: `GitHub ${r.status}` }); return; }
    const data = await r.json();
    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    res.status(200).json({ users: JSON.parse(text), sha: data.sha });

  } else if (req.method === 'POST') {
    const { users, sha } = req.body;
    if (!Array.isArray(users)) { res.status(400).json({ error: 'users must be array' }); return; }
    const content = Buffer.from(JSON.stringify(users, null, 2)).toString('base64');
    const r = await fetch(apiUrl, {
      method: 'PUT',
      headers: { ...ghHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'sync: update users', content, sha }),
    });
    if (!r.ok) {
      const err = await r.json();
      res.status(500).json({ error: err.message }); return;
    }
    const result = await r.json();
    res.status(200).json({ ok: true, sha: result.content.sha });
  } else {
    res.status(405).end();
  }
};
