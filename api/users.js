const https = require('https');

const REPO_OWNER = 'vendas-captei';
const REPO_NAME  = 'playbook';
const FILE_PATH  = 'users.json';

function ghRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    res.status(500).json({ error: 'GITHUB_TOKEN not set in environment variables' });
    return;
  }

  const baseHeaders = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PlaybookApp',
  };
  const path = `/repos/${REPO_OWNER}/${REPO_NAME}/contents/${FILE_PATH}`;

  if (req.method === 'GET') {
    try {
      const r = await ghRequest({
        hostname: 'api.github.com', path, method: 'GET', headers: baseHeaders,
      });
      if (r.status !== 200) {
        res.status(500).json({ error: `GitHub returned ${r.status}`, detail: r.body });
        return;
      }
      const text = Buffer.from(r.body.content.replace(/\n/g, ''), 'base64').toString('utf8');
      res.status(200).json({ users: JSON.parse(text), sha: r.body.sha });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }

  } else if (req.method === 'POST') {
    try {
      let body = '';
      await new Promise(resolve => { req.on('data', c => body += c); req.on('end', resolve); });
      const { users, sha } = JSON.parse(body);
      if (!Array.isArray(users)) { res.status(400).json({ error: 'users must be array' }); return; }

      const content = Buffer.from(JSON.stringify(users, null, 2)).toString('base64');
      const payload = { message: 'sync: update users', content, sha };

      const r = await ghRequest({
        hostname: 'api.github.com', path, method: 'PUT',
        headers: { ...baseHeaders, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(JSON.stringify(payload)) },
      }, payload);

      if (r.status !== 200 && r.status !== 201) {
        res.status(500).json({ error: `GitHub returned ${r.status}`, detail: r.body });
        return;
      }
      res.status(200).json({ ok: true, sha: r.body.content.sha });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  } else {
    res.status(405).end();
  }
};
