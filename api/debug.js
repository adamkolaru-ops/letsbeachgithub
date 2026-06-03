/**
 * /api/debug – temporary debug endpoint
 * Shows raw Reenio API response to diagnose issues
 * DELETE THIS FILE after debugging
 */
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const endMonthStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const body = new URLSearchParams({ date: dateStr, endDate: endMonthStr });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    const resp = await fetch('https://lets-beach.reenio.com/en/api/Term/List', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (compatible)',
      },
      body: body.toString(),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const text = await resp.text();
    res.status(200).json({
      ok: resp.status,
      body: text.slice(0, 1000),
      region: process.env.VERCEL_REGION || 'unknown',
    });
  } catch (err) {
    res.status(200).json({ error: err.message, type: err.name });
  }
};
