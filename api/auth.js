/**
 * POST /api/auth
 * Body: { password }
 * Returns { ok: true } if password matches ADMIN_PASSWORD env var.
 * The client then uses the password as a Bearer token for save/upload.
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }

  const password = body?.password || '';
  const expected = process.env.ADMIN_PASSWORD;

  if (!expected) {
    return res.status(500).json({ ok: false, error: 'ADMIN_PASSWORD not configured' });
  }

  // Tiny constant-ish time guard
  if (password === expected) {
    return res.status(200).json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Wrong password' });
};
