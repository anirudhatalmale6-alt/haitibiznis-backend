/* ═══ INSTRUCTOR SESSIONS ═════════════════════════════════════════════════
 *
 * An instructor should not have to type a password on every request, and the
 * password must not be stored in the browser to avoid it. So the login hands
 * back a signed token.
 *
 * 🔑 THE SIGNING KEY IS DERIVED, NOT CONFIGURED. There is no new environment
 * variable: a random server secret is created once and kept in AdminSetting,
 * and the key each token is signed with is that secret combined with THAT
 * INSTRUCTOR'S OWN PASSWORD HASH. Two consequences worth having:
 *
 *   - changing or resetting a password invalidates every token that account
 *     already issued, with no session table to clean up;
 *   - a token lifted from one browser cannot be replayed against a different
 *     account, because the key is per-account.
 *
 * ⛔ No jsonwebtoken dependency. This is an HMAC over two numbers; pulling in
 * a library to do that would be adding a supply chain for nothing.
 * ═══════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const AdminSetting = require('../models/AdminSetting');
const Instructor = require('../models/Instructor');

const TTL_MS = 12 * 60 * 60 * 1000;          /* a working day, then sign in again */
const KEY = 'instructor-session';

let cache = { at: 0, secret: '' };

/* The server secret. Created on first use and then reused. Cached for a
   minute so a burst of requests is not a burst of queries. */
async function serverSecret() {
  if (cache.secret && Date.now() - cache.at < 60000) return cache.secret;
  let doc = await AdminSetting.findOne({ key: KEY }).select('+pinSalt');
  if (!doc || !doc.pinSalt) {
    const made = crypto.randomBytes(32).toString('hex');
    /* upsert, so two workers starting at the same second cannot each write a
       different secret and invalidate each other's tokens. */
    doc = await AdminSetting.findOneAndUpdate(
      { key: KEY },
      { $setOnInsert: { key: KEY, pinSalt: made }, $set: { updatedAt: new Date() } },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    ).select('+pinSalt');
  }
  cache = { at: Date.now(), secret: doc.pinSalt };
  return cache.secret;
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  const t = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(t + '==='.slice((t.length + 3) % 4), 'base64').toString('utf8');
}

function keyFor(secret, loginHash) {
  return crypto.createHash('sha256')
    .update(secret + ':' + String(loginHash || '')).digest();
}

function sign(key, body) {
  return b64url(crypto.createHmac('sha256', key).update(body).digest());
}

/* The token is `payload.signature`, where payload is base64url JSON. Nothing
   secret is inside it - the id and an expiry - it is the signature that
   matters. */
async function mintToken(instructor) {
  const secret = await serverSecret();
  const payload = JSON.stringify({
    i: String(instructor._id),
    e: Date.now() + TTL_MS
  });
  const body = b64url(payload);
  return body + '.' + sign(keyFor(secret, instructor.loginHash), body);
}

function sameSig(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/* Returns the Instructor document, or null. Never throws on a malformed
   token - a token from a previous version of the site is a sign-in prompt,
   not a 500. */
async function instructorFromToken(raw) {
  const t = String(raw || '');
  const dot = t.indexOf('.');
  if (dot < 1) return null;
  const body = t.slice(0, dot), sig = t.slice(dot + 1);
  let payload;
  try { payload = JSON.parse(unb64url(body)); } catch (e) { return null; }
  if (!payload || !payload.i || !payload.e) return null;
  if (Date.now() > Number(payload.e)) return null;
  if (!/^[a-f0-9]{24}$/i.test(String(payload.i))) return null;

  /* The hash has to be loaded by name - it is select:false - because it is
     half the signing key. */
  const me = await Instructor.findById(payload.i).select('+loginHash +loginSalt');
  if (!me || !me.active || !me.loginHash) return null;

  const secret = await serverSecret();
  if (!sameSig(sign(keyFor(secret, me.loginHash), body), sig)) return null;
  return me;
}

/* Attaches req.instructor. 401, not 403: the right response to "who are you?"
   is a sign-in screen. */
async function requireInstructor(req, res, next) {
  try {
    const hdr = String(req.headers.authorization || '');
    const bearer = hdr.toLowerCase().startsWith('bearer ') ? hdr.slice(7).trim() : '';
    const token = bearer || req.headers['x-instructor-token'] || req.query.token;
    const me = await instructorFromToken(token);
    if (!me) return res.status(401).json({ error: 'Sesyon an fini. Konekte ankò.', signedOut: true });
    req.instructor = me;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/* Used by the tests and by a password change, which must not leave the old
   token working. Clearing the cache is enough for a rotated server secret;
   a changed password invalidates on its own because the hash is in the key. */
function _resetCache() { cache = { at: 0, secret: '' }; }

module.exports = { mintToken, instructorFromToken, requireInstructor, TTL_MS, _resetCache };
