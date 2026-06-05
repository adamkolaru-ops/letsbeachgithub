/**
 * POST /api/upload
 * Headers: Authorization: Bearer <admin password>
 * Body: { path: "videos/new.mp4" | "photo.jpg", contentBase64: "..." }
 *
 * Commits a binary file (image/video) to GitHub. Returns the path to use as src.
 */
const { checkAuth } = require('./_auth');

const OWNER  = 'adamkolaru-ops';
const REPO   = 'letsbeachgithub';
const BRANCH = 'main';

const MAX_BYTES = 25 * 1024 * 1024; // 25 MB safety cap
const ALLOWED_EXT = /\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/i;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  if (!checkAuth(req)) return res.status(401).json({ ok: false, error: 'Unauthorized' });

  const token = process.env.GITHUB_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'GITHUB_TOKEN not set' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  let path = (body?.path || '').replace(/^\/+/, '').trim();
  const contentBase64 = body?.contentBase64;

  // sanitise path: no traversal, allowed extensions only
  if (!path || path.includes('..') || !ALLOWED_EXT.test(path)) {
    return res.status(400).json({ ok: false, error: 'Invalid path/extension' });
  }
  if (!contentBase64 || typeof contentBase64 !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing content' });
  }

  const approxBytes = Math.floor(contentBase64.length * 0.75);
  if (approxBytes > MAX_BYTES) {
    return res.status(413).json({ ok: false, error: 'File too large (max 25MB)' });
  }

  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'letsbeach-admin',
  };

  try {
    // Check if file exists (to get sha for overwrite)
    let sha = undefined;
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}?ref=${BRANCH}`;
    const getRes = await fetch(getUrl, { headers: ghHeaders });
    if (getRes.ok) {
      const cur = await getRes.json();
      sha = cur.sha;
    }

    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(path)}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Admin upload: ${path}`,
        content: contentBase64,
        ...(sha ? { sha } : {}),
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const t = await putRes.text();
      return res.status(502).json({ ok: false, error: `GitHub upload failed: ${putRes.status} ${t.slice(0,200)}` });
    }

    return res.status(200).json({ ok: true, path });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
