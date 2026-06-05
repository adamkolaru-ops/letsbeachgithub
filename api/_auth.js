/**
 * Shared auth helper – verifies the admin password from the
 * Authorization header against the ADMIN_PASSWORD env var.
 */
function checkAuth(req) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const header = req.headers['authorization'] || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  return token === expected;
}

module.exports = { checkAuth };
