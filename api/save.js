/**
 * POST /api/save
 * Headers: Authorization: Bearer <admin password>
 * Body: { page: "index.html", html: "<!DOCTYPE html>..." }
 *
 * Commits the new HTML content to GitHub. Vercel auto-deploys on push.
 */
const { checkAuth } = require('./_auth');

const OWNER  = 'adamkolaru-ops';
const REPO   = 'letsbeachgithub';
const BRANCH = 'main';

// Only allow editing these files (safety)
const ALLOWED = new Set([
  'index.html', 'treninky.html', 'o-mne.html',
  'kontakt.html', 'merch.html', 'privacy.html',
  'akce.html', 'kempy.html',
]);

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

  const page = body?.page;
  const html = body?.html;

  if (!page || !ALLOWED.has(page)) {
    return res.status(400).json({ ok: false, error: 'Invalid page' });
  }
  if (typeof html !== 'string' || html.length < 50) {
    return res.status(400).json({ ok: false, error: 'Invalid HTML' });
  }

  const ghHeaders = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'letsbeach-admin',
  };

  try {
    // 1. Get current file SHA (required to update)
    const getUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(page)}?ref=${BRANCH}`;
    const getRes = await fetch(getUrl, { headers: ghHeaders });
    if (!getRes.ok) {
      const t = await getRes.text();
      return res.status(502).json({ ok: false, error: `GitHub GET failed: ${getRes.status} ${t.slice(0,200)}` });
    }
    const current = await getRes.json();
    const sha = current.sha;

    // 2. PUT new content
    const contentB64 = Buffer.from(html, 'utf8').toString('base64');
    const putUrl = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(page)}`;
    const putRes = await fetch(putUrl, {
      method: 'PUT',
      headers: ghHeaders,
      body: JSON.stringify({
        message: `Admin edit: ${page}`,
        content: contentB64,
        sha,
        branch: BRANCH,
      }),
    });

    if (!putRes.ok) {
      const t = await putRes.text();
      return res.status(502).json({ ok: false, error: `GitHub PUT failed: ${putRes.status} ${t.slice(0,200)}` });
    }

    const result = await putRes.json();
    return res.status(200).json({
      ok: true,
      commit: result.commit?.sha?.slice(0, 7),
      message: 'Saved. Site will rebuild in ~30s.',
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
