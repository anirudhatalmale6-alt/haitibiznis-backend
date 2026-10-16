/* The address the request really came from (16 Oct 2026).
   The FIRST X-Forwarded-For entry is whatever the caller chose to send, so a
   rate limit keyed on it could be dodged by sending a new value each time.
   Render's edge adds the real one: use cf-connecting-ip, else the LAST
   X-Forwarded-For entry (appended by the proxy), else the socket. */
module.exports = function clientIp(req) {
  const h = (req && req.headers) || {};
  const cf = String(h['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  const parts = String(h['x-forwarded-for'] || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  return parts[parts.length - 1] || (req && (req.ip || (req.socket && req.socket.remoteAddress))) || 'unknown';
};
