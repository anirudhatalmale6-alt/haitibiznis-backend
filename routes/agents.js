/* ═══ CERTIFIED AGENTS — the badge QR's verification page and its admin ════
 *
 * Public:
 *   GET  /api/agents/verify/:agentId   what the QR page shows
 *   GET  /api/agents/photo/:agentId    the agent's photo
 *   POST /api/agents/register          the exam / re-issue page records a
 *                                      certification - ONLY ever as PENDING
 * Console code (x-admin-pin), also listed in middleware/adminOnly.js:
 *   GET  /api/agents/admin/list
 *   POST /api/agents/admin              create one by hand
 *   PATCH /api/agents/admin/:agentId    edit details / approve / suspend
 *   POST /api/agents/admin/:agentId/photo
 *   …/admin/pilot/*                     the Ajan Pilòt field pilot (below)
 *
 * 🔑 Why PENDING: the re-issue page is unlocked by a code written in its own
 * source, so a submission proves nothing about who passed. "VERIFYE" means a
 * person at HaitiBiznis looked at it.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
/* 3 Nov (OAVCT ASSISTANCE): a pending driver whose OAVCT is not in order - no document, no date, or EXPIRED.
   Jeffery 3 Nov evening: "Automatically include drivers with expired OAVCT ... even if the Ajan didn't select
   the assistance option" - so the box ticked at registration (oavct_assist) is a record, not the condition. */
function assistOpen(d) {
  if (!d || d.status !== 'pending') return false;
  const exp = d.oavct_expiry ? new Date(d.oavct_expiry).toISOString().slice(0, 10) : '';
  return !(d.doc_types || []).includes('oavct') || !exp || exp < new Date().toISOString().slice(0, 10);
}
/* Jeffery 3 Nov: the national ID card is OPTIONAL (the licence carries the NIF) - 4 required photos */
const AJ_NEED = ['selfie', 'license', 'oavct', 'vehicle'];
const router = express.Router();
const CertifiedAgent = require('../models/CertifiedAgent');
const { requirePin } = require('../utils/consolePin');
const clientIp = require('../utils/clientIp');

const ID_RE = /^LMA-\d{4}-\d{6}$/;
const PAID_GATE_FROM = new Date('2026-11-10T00:00:00Z');   // OPTION A: badges registered from this day need a paid seat
const VALID_MONTHS = 12;              // default validity, changeable per agent
const MAX_PHOTO = 300 * 1024;         // decoded bytes; a 460px JPEG is ~50 KB

function normId(s) { return String(s || '').trim().toUpperCase(); }

function addMonths(d, n) {
  const x = new Date(d);
  x.setMonth(x.getMonth() + n);
  return x;
}

/* data:image/jpeg;base64,... -> { buf, mime } or null */
function decodePhoto(dataUrl) {
  const m = String(dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > MAX_PHOTO) return null;
  return { buf, mime: m[1] };
}

/* Simple per-address limit on the public write. */
const hits = new Map();
function tooMany(req, max, windowMs) {
  const ip = clientIp(req), now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  list.push(now); hits.set(ip, list);
  return list.length > max;
}

/* ─── PUBLIC: the verification page ─────────────────────────────────────── */
router.get('/verify/:agentId', async (req, res) => {
  try {
    const id = normId(req.params.agentId);
    if (!ID_RE.test(id)) return res.status(404).json({ found: false });
    const a = await CertifiedAgent.findOne({ agentId: id });
    if (!a) return res.status(404).json({ found: false });

    const state = a.publicState();
    const out = { found: true, state, agentId: a.agentId, name: a.name };
    /* A revoked or not-yet-approved badge shows its name (so the person
       holding it can be told apart) and nothing that would help it pass. */
    if (state === 'active' || state === 'expired' || state === 'suspended') {
      Object.assign(out, {
        certifiedAt: a.certifiedAt, expiresAt: a.expiresAt,
        city: a.city, sponsor: a.sponsor, services: a.services,
        photo: !!a.photoAt
      });
    }
    /* Contact and the referral code only while the agent may work. */
    if (state === 'active') Object.assign(out, { phone: a.phone, referralCode: a.referralCode });
    res.set('Cache-Control', 'no-store');
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
});

router.get('/photo/:agentId', async (req, res) => {
  try {
    const id = normId(req.params.agentId);
    if (!ID_RE.test(id)) return res.status(404).end();
    const a = await CertifiedAgent.findOne({ agentId: id }).select('+photo status photoMime');
    if (!a || !a.photo || a.status === 'revoked' || a.status === 'pending') return res.status(404).end();
    res.set('Content-Type', a.photoMime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(a.photo);
  } catch (e) { res.status(404).end(); }
});

/* ─── PUBLIC: the exam / re-issue page records a certification ──────────── */
router.post('/register', async (req, res) => {
  try {
    if (tooMany(req, 30, 60 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const b = req.body || {};
    const name = String(b.name || '');
    const ymd = String(b.date || '');
    /* 10 Nov 2026: an ID the SERVER issued at the exam (random, unique - not name + date): the page only adds the
       photo, and only with the same name. Its phone and name stay what the paid exam recorded. */
    if (b.agentId && ID_RE.test(normId(b.agentId))) {
      const own = await CertifiedAgent.findOne({ agentId: normId(b.agentId), examAttempt: { $ne: '' } }).select('+photo');
      if (own) {
        const nk = require('./academy').nameKey;
        if (nk(own.name) !== nk(name)) return res.status(400).json({ error: 'id_mismatch' });
        if (own.status === 'pending') {
          const ph = b.photo ? decodePhoto(b.photo) : null;
          if (ph) { own.photo = ph.buf; own.photoMime = ph.mime; own.photoAt = new Date(); }
          own.submissions += 1; own.lastSubmittedAt = new Date(); await own.save();
        }
        return res.json({ agentId: own.agentId, state: own.publicState() });
      }
    }
    const agentId = CertifiedAgent.certNumber(name, ymd);
    if (!agentId || !name.trim()) return res.status(400).json({ error: 'name_and_date_required' });
    /* The phone sends the number it printed; it must be the one the server
       computes, or the badge in someone's hand and this record would differ. */
    if (b.agentId && normId(b.agentId) !== agentId) return res.status(400).json({ error: 'id_mismatch', agentId });

    const phone = String(b.phone || '').replace(/[^\d+ ]/g, '').trim().slice(0, 40);
    const photo = b.photo ? decodePhoto(b.photo) : null;
    const source = b.source === 'reissue' ? 'reissue' : 'exam';

    let a = await CertifiedAgent.findOne({ agentId }).select('+photo');
    if (!a) {
      const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      a = new CertifiedAgent({
        agentId, name: name.trim().replace(/\s+/g, ' '), phone, source,
        certifiedAt: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)),
        status: 'pending',
        history: [{ action: 'submitted', note: source }]
      });
    } else if (a.status !== 'pending') {
      /* ⛔ An approved, suspended or revoked record is never changed from a
         public page. Its state is reported back, nothing else. */
      return res.json({ agentId, state: a.publicState() });
    } else if (phone) {
      a.phone = phone;
    }
    if (photo) { a.photo = photo.buf; a.photoMime = photo.mime; a.photoAt = new Date(); }
    a.submissions += 1;
    a.lastSubmittedAt = new Date();
    await a.save();
    res.json({ agentId, state: a.publicState() });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
});

/* ─── CONSOLE ──────────────────────────────────────────────────────────── */
/* ⛔ Also in middleware/adminOnly.js: a guard inside the thing it guards is not
   the only guard. */
/* ─── PUBLIC: an Ajan's personal driver link (1 Nov 2026) ──────────────────
   Jeffery: "make sure the Ajan code is captured reliably". The LajanMaker app
   knows its Ajan by the phone number on his badge; this turns that number into
   his personal MsouWout driver link, so a driver he signs up is credited to him
   with nothing to type. Only an ACTIVE badge with a referral code answers, and
   only with what the public badge page already shows for an active Ajan. */
function last8(p) { const d = String(p || '').replace(/\D/g, ''); return d.length >= 8 ? d.slice(-8) : ''; }
const DRIVER_FORM = 'https://msouwout.com/driver-register.html';
router.get('/driver-link', async (req, res) => {
  try {
    if (tooMany(req, 30, 10 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const k = last8(req.query.phone);
    if (!k) return res.status(400).json({ error: 'phone_required' });
    const list = await CertifiedAgent.find({ status: 'active', referralCode: { $ne: '' } });
    const a = list.find((x) => last8(x.phone) === k && x.publicState() === 'active');
    if (!a) return res.status(404).json({ found: false });
    res.set('Cache-Control', 'no-store');
    res.json({ found: true, name: a.name, agentId: a.agentId, code: a.referralCode,
               link: DRIVER_FORM + '?agent=' + encodeURIComponent(a.referralCode) });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
});

/* PUBLIC: the Ajan's own driver count (1 Nov 2026) - what his LajanMaker app
   shows next to the drivers he registered: how many reached MsouWout under his
   code, how many Jennifer VERIFIED, and the 1 000 HTG per 5 verified rule
   (tracking only - nothing here pays anybody). Counts only, no driver names:
   a phone number is not a login. */
router.get('/my-driver-stats', async (req, res) => {
  try {
    if (tooMany(req, 60, 10 * 60 * 1000)) return res.status(429).json({ error: 'too_many' });
    const k = last8(req.query.phone);
    if (!k) return res.status(400).json({ error: 'phone_required' });
    const list = await CertifiedAgent.find({ status: 'active', referralCode: { $ne: '' } });
    const a = list.find((x) => last8(x.phone) === k && x.publicState() === 'active');
    if (!a) return res.status(404).json({ found: false });
    /* 1 Nov 2026 (evening), Jeffery: "Nirdjy and Lousenia! They can't find the
       drivers they sign up!" - drivers who came through the Ajan's QR / the
       MsouWout form were counted but never LISTED in the app. The Ajan now sees
       each of them: first name + initial, status, date, photos complete or not.
       No phone, no full name, no document - a phone number is not a login. */
    const r = await msw('GET', '/internal/console/list?status=all');
    if (r.status !== 200) return res.status(503).json({ error: 'link_unavailable' });
    const code = String(a.referralCode).toUpperCase();
    const mine = (r.data.drivers || []).filter((d) => d.referral_attached && String(d.referral_code || '').toUpperCase() === code);
    const short = (n) => { const w = String(n || '').trim().split(/\s+/).filter(Boolean); return w.length ? w[0] + (w.length > 1 ? ' ' + w[w.length - 1][0].toUpperCase() + '.' : '') : '—'; };
    const verified = mine.filter((d) => d.status === 'approved').length;
    res.set('Cache-Control', 'no-store');
    res.json({ found: true, code: a.referralCode, registered: mine.length, verified,
               bonusHtg: Math.floor(verified / 5) * 1000, toNext: 5 - (verified % 5),
               drivers: mine.slice(0, 100).map((d) => ({ name: short(d.full_name), status: d.status, service: d.preferred_service || 'both',
                 at: d.created_at, photos: d.doc_count, reason: d.status === 'rejected' ? (d.rejection_reason || '') : '', fix: d.fix_docs || [],
                 /* 1 Nov 2026, Jeffery: "when a doc is missing or not updated or expired it should show it to them" */
                 missing: AJ_NEED.filter((t) => !(d.doc_types || []).includes(t)),
                 oavct: !d.oavct_expiry ? 'missing' : (new Date(d.oavct_expiry).toISOString().slice(0, 10) < new Date().toISOString().slice(0, 10) ? 'expired' : 'ok'),
                 /* 3 Nov: "🟠 ENSKRI — OAVCT POKO REGLE" while the assistance is still open */
                 oavctAssist: assistOpen(d) })) });
  } catch (e) {
    res.status(500).json({ error: 'server' });
  }
});

/* ═══ THE AJAN'S OWN LOGIN — OPTION B (3 Nov 2026) ═══════════════════════════
   Jeffery: "Jennifer provides each certified Ajan with a one-time activation code.
   The Ajan creates their own secure PIN, linked to their verified badge and phone
   number. Once authenticated, the Ajan must be able to correct documents for ALL
   drivers credited to them... Only the assigned Ajan or authorized admin can
   modify documents... Every correction is logged."
   - 3 Nov (later), OPTION C: activation codes + PINs RETIRED ("too complicated" - Jennifer). A phone
     is approved by Jennifer with one tap (see OPTION C below); PIN sessions already open stay valid.
   - the session: signed (HMAC), revoked by ajanTokenV (disconnect all) or by the phone's state
   - a correction: the driver must be credited to THIS Ajan's code AND pending;
     it goes to MsouWout as "ajan:<badge>" (who + when on the photo + history) */
const crypto = require('crypto');
const AJ_SECRET = () => process.env.AJAN_TOKEN_SECRET || process.env.INTERNAL_SERVICE_KEY || '';
const AJ_DAY = 86400000;
/* OPTION C: a phone's session carries its device id (d) and lasts 30 days; the phone renews it with its
   own key (POST /ajan/device/status) as long as Jennifer has not disconnected it. Old PIN sessions (no d)
   keep working until they expire, so nobody loses access during the change. */
function ajanToken(a, devId) {
  const t = { a: a.agentId, v: a.ajanTokenV || 0, e: Date.now() + (devId ? 30 : 60) * AJ_DAY };
  if (devId) t.d = devId;
  const p = Buffer.from(JSON.stringify(t)).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', AJ_SECRET()).update('ajan.' + p).digest('base64url');
}
async function ajanAuth(req, res, next) {
  try {
    const t = String(req.headers['x-ajan-token'] || ''), i = t.indexOf('.');
    if (i < 1 || !AJ_SECRET()) return res.status(401).json({ error: 'login_required' });
    const p = t.slice(0, i), sig = t.slice(i + 1);
    const want = crypto.createHmac('sha256', AJ_SECRET()).update('ajan.' + p).digest('base64url');
    if (want.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig))) return res.status(401).json({ error: 'login_required' });
    const j = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (!j.e || j.e < Date.now()) return res.status(401).json({ error: 'login_expired' });
    const a = await CertifiedAgent.findOne({ agentId: j.a }).select('+ajanPinHash');
    if (!a || (a.ajanTokenV || 0) !== j.v || a.status !== 'active' || a.publicState() !== 'active') return res.status(401).json({ error: 'login_required' });
    if (j.d) {
      const dev = (a.ajanDevices || []).find((x) => x.id === j.d);
      if (!dev || dev.state !== 'approved') return res.status(401).json({ error: 'device_off' });
      if (!dev.lastSeenAt || Date.now() - dev.lastSeenAt.getTime() > 3600000) {
        await CertifiedAgent.updateOne({ _id: a._id, 'ajanDevices.id': dev.id }, { $set: { 'ajanDevices.$.lastSeenAt': new Date() } });
      }
      req.ajanDevice = dev;
    } else if (!a.ajanPinHash) return res.status(401).json({ error: 'login_required' });
    req.ajan = a; next();
  } catch (e) { res.status(401).json({ error: 'login_required' }); }
}
async function badgeByPhone(phone) {
  const k = last8(phone); if (!k) return null;
  const list = await CertifiedAgent.find({ status: 'active' }).select('+ajanPinHash +ajanCodeHash');
  return list.find((x) => last8(x.phone) === k && x.publicState() === 'active') || null;
}
function ajanPublic(a) { return { agentId: a.agentId, name: a.name, code: a.referralCode || '' }; }

/* OPTION C (3 Nov, Jeffery): no more activation codes / PINs for NEW phones - a new phone asks
   Jennifer (POST /ajan/device/request). Sessions already open keep working. */
router.post('/ajan/activate', (req, res) => res.status(410).json({ error: 'use_device' }));
router.post('/ajan/login', (req, res) => res.status(410).json({ error: 'use_device' }));
router.get('/ajan/me', ajanAuth, (req, res) => res.json({ agent: ajanPublic(req.ajan) }));

/* ═══ OPTION C — ONE-TAP PHONE APPROVAL (3 Nov 2026, Jeffery "YES — OPTION C APPROVED") ═══
   1. LajanMaker makes a random key that never leaves the phone except to this server, and asks with the
      badge phone number. That only creates a REQUEST: a typed phone number opens nothing.
   2. Jennifer sees the request in ajan-admin.html with a 4-digit check code; she verifies the Ajan (he
      reads her the code shown on HIS screen) and taps ✅. Refuse / disconnect = one tap.
   3. The phone then gets a server-signed session tied to the badge AND that phone (30 days, renewed with
      the phone's key while still approved). A new phone = a new request. Suspended / revoked badge = off. */
const DEV_KEY = /^[A-Za-z0-9_-]{32,128}$/;
/* own counters (not the shared per-address one): many Haitian phones share one carrier address */
const devHits = new Map();
function devTooMany(k, max, windowMs) {
  const now = Date.now(), list = (devHits.get(k) || []).filter((t) => now - t < windowMs);
  list.push(now); devHits.set(k, list);
  if (devHits.size > 5000) for (const [x, v] of devHits) if (!v.length || now - v[v.length - 1] > windowMs) devHits.delete(x);
  return list.length > max;
}
const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
function devView(d) { return { id: d.id, check: d.check, label: d.label, state: d.state, via: d.via, requestedAt: d.requestedAt, decidedAt: d.decidedAt, decidedBy: d.decidedBy, lastSeenAt: d.lastSeenAt }; }
function hist(a, action, note) { a.history.push({ action, note: String(note).slice(0, 120) }); if (a.history.length > 50) a.history = a.history.slice(-50); }
router.post('/ajan/device/request', async (req, res) => {
  try {
    const b = req.body || {}, key = String(b.key || '');
    if (devTooMany('rq|' + clientIp(req), 60, 10 * 60000) || devTooMany('ph|' + last8(b.phone), 10, 10 * 60000)) return res.status(429).json({ error: 'too_many' });
    if (!DEV_KEY.test(key)) return res.status(400).json({ error: 'bad_key' });
    const a = await badgeByPhone(b.phone);
    if (!a) return res.status(404).json({ error: 'no_badge' });
    const kh = sha(key);
    let d = (a.ajanDevices || []).find((x) => x.keyHash === kh);
    if (!d) {
      /* at most 3 open requests per badge, at most 20 phones remembered */
      const open = a.ajanDevices.filter((x) => x.state === 'pending');
      if (open.length >= 3) open.slice(0, open.length - 2).forEach((x) => { x.state = 'refused'; x.decidedAt = new Date(); x.decidedBy = 'auto (newer request)'; });
      d = { id: crypto.randomBytes(8).toString('hex'), keyHash: kh, check: String(crypto.randomInt(1000, 10000)),
            label: String(b.label || '').replace(/[<>]/g, '').slice(0, 60), state: 'pending', via: 'request', requestedAt: new Date() };
      a.ajanDevices.push(d);
      while (a.ajanDevices.length > 20) {
        const i = a.ajanDevices.findIndex((x) => x.state !== 'approved' && x.state !== 'pending');
        if (i < 0) break; a.ajanDevices.splice(i, 1);
      }
      hist(a, 'ajan_device_request', 'phone ' + d.id + ' asks to connect (' + (d.label || '?') + ')');
      await a.save();
      d = a.ajanDevices.find((x) => x.keyHash === kh);
    }
    res.json({ deviceId: d.id, state: d.state, check: d.check, name: String(a.name || '').split(' ')[0] });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
router.post('/ajan/device/status', async (req, res) => {
  try {
    const b = req.body || {}, id = String(b.deviceId || ''), key = String(b.key || '');
    if (devTooMany('st|' + id, 120, 10 * 60000) || devTooMany('si|' + clientIp(req), 1200, 10 * 60000)) return res.status(429).json({ error: 'too_many' });
    if (!/^[0-9a-f]{16}$/.test(id) || !DEV_KEY.test(key)) return res.status(404).json({ error: 'not_found' });
    const a = await CertifiedAgent.findOne({ 'ajanDevices.id': id });
    const d = a && a.ajanDevices.find((x) => x.id === id);
    const kh = Buffer.from(sha(key)), want = Buffer.from(d ? d.keyHash : '0'.repeat(64));
    if (!d || kh.length !== want.length || !crypto.timingSafeEqual(kh, want)) return res.status(404).json({ error: 'not_found' });
    if (a.status !== 'active' || a.publicState() !== 'active') return res.json({ state: 'badge_inactive' });
    if (d.state !== 'approved') return res.json({ state: d.state, check: d.check });
    res.json({ state: 'approved', token: ajanToken(a, d.id), agent: ajanPublic(a) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
/* a phone already signed in with the old PIN becomes an approved phone (no new step, no lost access) */
router.post('/ajan/device/adopt', ajanAuth, async (req, res) => {
  try {
    if (req.ajanDevice) return res.status(400).json({ error: 'already_device' });
    const key = String((req.body || {}).key || '');
    if (!DEV_KEY.test(key)) return res.status(400).json({ error: 'bad_key' });
    const a = req.ajan, kh = sha(key);
    let d = a.ajanDevices.find((x) => x.keyHash === kh);
    if (!d) {
      a.ajanDevices.push({ id: crypto.randomBytes(8).toString('hex'), keyHash: kh, check: String(crypto.randomInt(1000, 10000)),
        label: String((req.body || {}).label || '').replace(/[<>]/g, '').slice(0, 60), state: 'approved', via: 'pin',
        requestedAt: new Date(), decidedAt: new Date(), decidedBy: 'PIN (before 3 Nov)', lastSeenAt: new Date() });
      hist(a, 'ajan_device_adopt', 'phone already signed in with the PIN kept connected');
      await a.save();
      d = a.ajanDevices.find((x) => x.keyHash === kh);
    }
    if (d.state !== 'approved') return res.status(401).json({ error: 'device_off' });
    res.json({ deviceId: d.id, token: ajanToken(a, d.id), agent: ajanPublic(a) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
/* every driver credited to this Ajan, however he registered, and exactly what is missing / to redo */

router.get('/ajan/drivers', ajanAuth, async (req, res) => {
  const code = String(req.ajan.referralCode || '').toUpperCase();
  if (!code) return res.json({ drivers: [] });
  const r = await msw('GET', '/internal/console/list?status=all');
  if (r.status !== 200) return res.status(503).json({ error: 'link_unavailable' });
  const today = new Date().toISOString().slice(0, 10), in30 = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const mine = (r.data.drivers || []).filter((d) => d.referral_attached && String(d.referral_code || '').toUpperCase() === code);
  res.set('Cache-Control', 'no-store');
  res.json({ drivers: mine.map((d) => {
    const exp = d.oavct_expiry ? new Date(d.oavct_expiry).toISOString().slice(0, 10) : '';
    return { id: d.id, name: d.full_name, phone: d.phone, status: d.status, service: d.preferred_service, vehicle: d.vehicle_type,
      at: d.created_at, docs: d.doc_types || [], missing: AJ_NEED.filter((t) => !(d.doc_types || []).includes(t)),
      fix: d.fix_docs || [], fixNote: (d.fix_docs || []).length ? (d.fix_note || '') : '', oavct: !exp ? 'missing' : (exp < today ? 'expired' : (exp <= in30 ? 'soon' : 'ok')), oavctExpiry: exp,
      reason: d.status === 'rejected' ? (d.rejection_reason || '') : '', oavctAssist: assistOpen(d) };
  }) });
});
/* 5 Nov 2026: the Ajan's approved phone claims a driver IT registered that reached MsouWout without an Ajan code
   (proof = that registration's own key, client_ref, kept on the phone). Only if nobody is credited yet. */
router.post('/ajan/drivers/:id/claim', ajanAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'not_found' });
  const code = String(req.ajan.referralCode || '').toUpperCase();
  if (!code) return res.status(409).json({ error: 'no_ajan_code' });
  const r = await msw('POST', '/internal/console/' + id + '/claim', { by: 'ajan:' + req.ajan.agentId, code, client_ref: String((req.body || {}).client_ref || '') });
  if (r.status === 200 && String(r.data.code || '').toUpperCase() !== code) return res.status(409).json({ error: 'other_ajan', code: r.data.code });
  res.status(r.status).json(r.data);
});
router.post('/ajan/drivers/:id/document', ajanAuth, async (req, res) => {
  const id = String(req.params.id || '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {}, t = String(b.doc_type || '');
  if (!['selfie', 'id', 'license', 'oavct', 'vehicle', 'insurance'].includes(t)) return res.status(400).json({ error: 'bad_type' });
  const d = await msw('GET', '/internal/console/' + id);
  if (d.status !== 200 || !d.data.driver) return res.status(404).json({ error: 'not_found' });
  const drv = d.data.driver;
  /* only HIS driver - the one his code is credited with - and only while pending */
  if (!drv.referral_attached || String(drv.referral_code || '').toUpperCase() !== String(req.ajan.referralCode || '').toUpperCase()) return res.status(403).json({ error: 'not_your_driver' });
  /* 5 Nov 2026 (OAVCT expiry): his APPROVED driver's renewed OAVCT may be sent too, when it is expired or due within
     30 days. A photo does not unblock anyone - Jennifer checks it and enters the new date (console, logged). */
  const exp = drv.oavct_expiry ? new Date(drv.oavct_expiry).toISOString().slice(0, 10) : '';
  const renewal = drv.status === 'approved' && t === 'oavct' && exp && exp <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  if (drv.status !== 'pending' && !renewal) return res.status(409).json({ error: 'not_pending' });
  const r = await msw('POST', '/internal/console/' + id + '/document', { by: 'ajan:' + req.ajan.agentId, doc_type: t, image_data: b.image_data });
  res.status(r.status).json(r.data);
});

/* ═══ MYPLOPPLOP MERCHANT VERIFICATION (4 Nov 2026) - Jennifer's console → MyPlopPlop internal routes ═══ */
async function mppInt(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_unavailable' } };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90000);
  try {
    const o = { method, headers: { 'x-internal-key': key }, signal: ctl.signal };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(KOUTYE_API + '/api/internal/merchants' + path, o);
    if (r.status === 401 || r.status === 503) return { status: 503, data: { error: 'link_unavailable' } };
    let data; try { data = await r.json(); } catch (e) { return { status: 502, data: { error: 'link_unavailable' } }; }
    return { status: r.status, data };
  } catch (e) { return { status: 503, data: { error: 'link_unavailable' } }; } finally { clearTimeout(t); }
}
const OID = /^[0-9a-fA-F]{24}$/;
/* the Ajan's approved phone sends / redoes a business photo - only for a business credited to HIS code */
router.post('/ajan/merchants/:id/document', ajanAuth, async (req, res) => {
  if (!OID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const r = await mppInt('POST', '/' + req.params.id + '/ajan-document', { agentCode: req.ajan.referralCode || '', agentId: req.ajan.agentId, type: b.type, image_data: b.image_data });
  res.status(r.status).json(r.data);
});

/* 4 Nov 2026 (Jeffery: "Proceed with activating JC-JENN7 as Jennifer's official Ajan code"): the same action,
   server to server with the shared INTERNAL_SERVICE_KEY (a GitHub workflow), for when it is done FOR her. */
router.post('/internal/adopt-code', async (req, res) => {
  const k = String(req.headers['x-internal-key'] || ''), want = String(process.env.INTERNAL_SERVICE_KEY || '');
  if (!want || k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) return res.status(401).json({ error: 'unauthorized' });
  try { const b = req.body || {}; const r = await adoptCode(b.agentId, b.code, b.by); res.status(r.status).json(r.data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.use('/admin', requirePin);
router.get('/admin/merchants', async (req, res) => { const r = await mppInt('GET', '/'); res.status(r.status).json(r.data); });
router.get('/admin/merchants/:id', async (req, res) => {
  if (!OID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = await mppInt('GET', '/' + req.params.id); res.status(r.status).json(r.data);
});
router.post('/admin/merchants/:id/:act', async (req, res) => {
  if (!OID.test(req.params.id) || !['approve', 'reject', 'fix', 'fix-done', 'reopen', 'document', 'welcome', 'review', 'edit', 'patente', 'assist'].includes(req.params.act)) return res.status(404).json({ error: 'not_found' });
  const r = await mppInt('POST', '/' + req.params.id + '/' + req.params.act, req.body || {});
  res.status(r.status).json(r.data);
});

function adminView(a) {
  return {
    agentId: a.agentId, name: a.name, phone: a.phone, city: a.city, sponsor: a.sponsor,
    referralCode: a.referralCode, services: a.services, certifiedAt: a.certifiedAt,
    expiresAt: a.expiresAt, status: a.status, state: a.publicState(), statusNote: a.statusNote,
    source: a.source, idMatched: a.idMatched !== false, photo: !!a.photoAt, approvedAt: a.approvedAt, submissions: a.submissions,
    createdAt: a.createdAt, updatedAt: a.updatedAt, history: (a.history || []).slice(-10),
    ajan: { pinSetAt: a.ajanPinSetAt || null, codePending: !!(a.ajanCodeExpires && a.ajanCodeExpires > new Date()), codeExpires: a.ajanCodeExpires || null,
            devices: (a.ajanDevices || []).filter((d) => d.state === 'pending' || d.state === 'approved').map(devView) }
  };
}

router.get('/admin/list', async (req, res) => {
  try {
    const q = {};
    if (['pending', 'active', 'suspended', 'revoked'].includes(req.query.status)) q.status = req.query.status;
    if (req.query.q) {
      const s = String(req.query.q).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60);
      q.$or = [{ name: new RegExp(s, 'i') }, { agentId: new RegExp(s, 'i') }, { phone: new RegExp(s, 'i') }];
    }
    const list = await CertifiedAgent.find(q).sort({ status: 1, updatedAt: -1 }).limit(500);
    const counts = await CertifiedAgent.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]);
    /* activation date, end date and days left of each Ajan's pilot - the same figures his app shows */
    const P = {}; (await AjanPilot.find({ agentId: { $in: list.map((a) => a.agentId) } })).forEach((p) => { P[p.agentId] = p; });
    const now = new Date();
    /* 10 Nov 2026: PEYE / PA PEYE next to each badge (a paid Academy seat for its phone) */
    const seat = {}; await Promise.all(list.map(async (a) => { seat[a.agentId] = await require('./academy').hasPaidSeat(a.phone); }));
    res.json({ agents: list.map((a) => Object.assign(adminView(a), { pilot: pilotView(P[a.agentId], now), paid: seat[a.agentId], paidRequired: !!(a.createdAt && a.createdAt >= PAID_GATE_FROM) })), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
               services: CertifiedAgent.SERVICES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Register an agent by hand - mostly the badges ALREADY PRINTED before the
   registry existed (Jeffery, 22 Oct: "No new numbers should be generated").
   With the printed number: the name must reproduce it, on the date given or on
   ANY day of that year (found automatically). If it cannot - a typo on the
   original badge - the console may still keep the printed number with
   `force`, flagged idMatched:false. Either way it is saved PENDING: an Agent
   ID alone never proves anything. */
router.post('/admin', async (req, res) => {
  try {
    const b = req.body || {};
    const name = String(b.name || '');
    if (!name.trim()) return res.status(400).json({ error: 'name_required' });
    let ymd = /^\d{4}-\d{2}-\d{2}$/.test(String(b.date || '')) ? String(b.date) : '';
    let agentId, idMatched = true;
    if (b.printedId) {
      agentId = normId(b.printedId).replace(/\s+/g, '');
      if (!ID_RE.test(agentId)) return res.status(400).json({ error: 'bad_id' });
      /* 22 Oct 2026: a phone keyboard adds a space after the last word, and
         "Alix Jacques " hashes differently from "Alix Jacques" - Jennifer was
         told the name did not match and asked for a date. Try the name as
         typed, trimmed, and with the stray space a badge may have been
         PRINTED with, before giving up. */
      const t = name.trim();
      const forms = [...new Set([name, t, t + ' ', ' ' + t])];
      if (!(ymd && forms.some((f) => CertifiedAgent.certNumber(f, ymd) === agentId))) {
        let found = null;
        for (const f of forms) { found = CertifiedAgent.findDate(f, agentId); if (found) break; }
        if (found) ymd = found;
        else if (b.force === true && ymd) idMatched = false;
        else return res.status(422).json({ error: 'no_match', agentId });
      }
    } else {
      agentId = CertifiedAgent.certNumber(name, ymd);
      if (!agentId) return res.status(400).json({ error: 'name_and_date_required' });
    }
    if (await CertifiedAgent.exists({ agentId })) return res.status(409).json({ error: 'exists', agentId });
    const m = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const a = await CertifiedAgent.create({
      agentId, name: name.trim().replace(/\s+/g, ' '), idMatched,
      phone: String(b.phone || '').trim().slice(0, 40), source: 'admin',
      certifiedAt: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), status: 'pending',
      history: [{ action: 'created', note: b.printedId ? (idMatched ? 'printed badge, number matched' : 'printed badge, number kept as printed (no match)') : 'console' }]
    });
    res.json({ agent: adminView(a), dateUsed: ymd });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch('/admin/:agentId', async (req, res) => {
  try {
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) });
    if (!a) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {};
    ['name', 'phone', 'city', 'sponsor', 'referralCode', 'statusNote'].forEach((k) => {
      if (typeof b[k] === 'string') a[k] = b[k].trim();
    });
    /* 22 Oct 2026, Jeffery: "no duplicate accounts or referral codes". One
       referral code belongs on ONE badge, and an LMA number is the badge, never
       a referral code. */
    if (typeof b.referralCode === 'string' && a.referralCode) {
      a.referralCode = a.referralCode.toUpperCase();
      if (/^LMA-?\d{4}/.test(a.referralCode)) return res.status(400).json({ error: 'code_is_badge_number' });
      const other = await CertifiedAgent.findOne({ agentId: { $ne: a.agentId },
        referralCode: new RegExp('^' + a.referralCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).select('agentId name');
      if (other) return res.status(409).json({ error: 'code_on_other_badge', agentId: other.agentId, name: other.name });
    }
    if (Array.isArray(b.services)) a.services = b.services.filter((s) => CertifiedAgent.SERVICES.includes(s));
    /* 28 Oct 2026, Jennifer: "chak m mete agent yo li anrejistre dat yo
       sètifye an ak dat pal" - every agent she enters gets the wrong
       certification date. The date saved with a PRINTED badge is the day the
       badge was made (the date its number was computed from), not the day of
       the training. She can now correct it. ⛔ The printed number never
       changes with it - it is what is on the badge. Logged old → new. */
    const oldCert = a.certifiedAt;
    let certChanged = false;
    if (b.certifiedAt !== undefined && b.certifiedAt !== '' && b.certifiedAt !== null) {
      const m = String(b.certifiedAt).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)) : null;
      if (!d || isNaN(d) || d.getUTCDate() !== +m[3]) return res.status(400).json({ error: 'bad_cert_date' });
      if (d > new Date(Date.now() + 36 * 3600 * 1000)) return res.status(400).json({ error: 'cert_date_future' });
      if (+m[1] < 2020) return res.status(400).json({ error: 'bad_cert_date' });
      const before = a.certifiedAt ? a.certifiedAt.toISOString().slice(0, 10) : '';
      if (before !== String(b.certifiedAt)) {
        a.certifiedAt = d; certChanged = true;
        a.history.push({ action: 'cert_date', note: before + ' → ' + b.certifiedAt });
      }
    }
    if (b.expiresAt !== undefined) {
      const d = b.expiresAt ? new Date(b.expiresAt) : null;
      if (d && isNaN(d)) return res.status(400).json({ error: 'bad_date' });
      a.expiresAt = d;
    }
    /* The validity that approval computed FROM the old date moves with it. One
       a person typed by hand (any other day) is left exactly as they set it. */
    if (certChanged && a.expiresAt && oldCert &&
        a.expiresAt.toISOString().slice(0, 10) === addMonths(oldCert, VALID_MONTHS).toISOString().slice(0, 10)) {
      a.expiresAt = addMonths(a.certifiedAt, VALID_MONTHS);
    }
    if (b.status && b.status !== a.status) {
      if (!['pending', 'active', 'suspended', 'revoked'].includes(b.status)) return res.status(400).json({ error: 'bad_status' });
      if (b.status === 'active') {
        /* 10 Nov 2026 (Jeffery, OPTION A): "No unpaid student should receive an official certificate or an active
           Ajan badge, even if they pass an exam." Every badge registered from today needs a paid Academy seat for
           its phone (a confirmed Tikè Lakay Formation ticket, or a payment Jennifer recorded). Badges registered
           before today came from trainings paid in person and are left as they were. */
        if (a.createdAt && a.createdAt >= PAID_GATE_FROM && !(await require('./academy').hasPaidSeat(a.phone))) {
          return res.status(409).json({ error: 'not_paid' });
        }
        if (!a.approvedAt) a.approvedAt = new Date();
        if (!a.expiresAt) a.expiresAt = addMonths(a.certifiedAt, VALID_MONTHS);
      }
      a.history.push({ action: b.status, note: String(b.statusNote || '').slice(0, 200) });
      a.status = b.status;
    } else {
      a.history.push({ action: 'edited' });
    }
    if (a.history.length > 50) a.history = a.history.slice(-50);
    await a.save();
    /* approved (or phone corrected) = the 30-day pilot, by itself */
    let pilot = null;
    try { await ensureAutoPilot(a, String(b.by || 'console').slice(0, 40)); pilot = await AjanPilot.findOne({ agentId: a.agentId }); }
    catch (e) { console.warn('[PILOT] auto on save failed for ' + a.agentId + ': ' + e.message); }
    res.json({ agent: Object.assign(adminView(a), { pilot: pilotView(pilot) }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* The console sees the photo of a PENDING agent too - that is what it checks
   before approving. Fetched with the console code, shown from a blob. */
/* Jennifer: a one-time activation code for this Ajan (shown ONCE). A new code also logs
   out every phone of his (ajanTokenV++ when it is used). */
/* OPTION C: activation codes are retired (a new phone asks Jennifer instead) */
router.post('/admin/:agentId/ajan-code', (req, res) => res.status(410).json({ error: 'use_device' }));
/* OPTION C: every phone waiting for Jennifer, across all Ajans (top of ajan-admin.html) */
router.get('/admin/ajan-devices', async (req, res) => {
  try {
    const list = await CertifiedAgent.find({ 'ajanDevices.state': 'pending' }).select('agentId name phone status ajanDevices expiresAt');
    const out = [];
    list.forEach((a) => a.ajanDevices.filter((d) => d.state === 'pending').forEach((d) =>
      out.push(Object.assign(devView(d), { agentId: a.agentId, name: a.name, phone: a.phone, badgeActive: a.status === 'active' && a.publicState() === 'active' }))));
    out.sort((x, y) => new Date(x.requestedAt) - new Date(y.requestedAt));
    res.json({ requests: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/:agentId/device/:devId/:act', async (req, res) => {
  try {
    const act = req.params.act, by = String((req.body && req.body.by) || 'console').slice(0, 40);
    if (!['approve', 'refuse', 'revoke'].includes(act)) return res.status(404).json({ error: 'not_found' });
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) });
    const d = a && a.ajanDevices.find((x) => x.id === String(req.params.devId));
    if (!d) return res.status(404).json({ error: 'not_found' });
    if (act === 'approve') {
      if (d.state !== 'pending') return res.status(409).json({ error: 'not_pending', state: d.state });
      if (a.status !== 'active' || a.publicState() !== 'active') return res.status(422).json({ error: 'not_active' });
      d.state = 'approved';
    } else if (act === 'refuse') {
      if (d.state !== 'pending') return res.status(409).json({ error: 'not_pending', state: d.state });
      d.state = 'refused';
    } else {
      if (d.state !== 'approved') return res.status(409).json({ error: 'not_approved', state: d.state });
      d.state = 'revoked';
    }
    d.decidedAt = new Date(); d.decidedBy = by;
    hist(a, 'ajan_device_' + act, 'phone ' + d.id + ' (' + (d.label || '?') + ') ' + act + ' by ' + by);
    await a.save();
    res.json({ ok: true, device: devView(d) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* 4 Nov 2026 (Jennifer: "M bezwen gen menm code JC-JENN7 lan"): the badge takes the code of the Ajan's OWN
   koutye.html sign-up instead of the one the console made - same Ajan account. Refused if any driver is
   credited to the old code here; MyPlopPlop refuses if it earned anything there or the sign-up is not hers. */
async function adoptCode(agentId, code, by) {
  const a = await CertifiedAgent.findOne({ agentId: normId(agentId) });
  if (!a) return { status: 404, data: { error: 'not_found' } };
  const to = String(code || '').trim().toUpperCase(), from = String(a.referralCode || '').toUpperCase();
  by = String(by || 'console').slice(0, 40);
  if (!to || !from || to === from) return { status: 400, data: { error: 'bad_request' } };
  if (await CertifiedAgent.exists({ referralCode: new RegExp('^' + to.replace(/[^A-Z0-9-]/g, '') + '$', 'i'), _id: { $ne: a._id } })) return { status: 409, data: { error: 'code_on_other_badge' } };
  const r = await msw('GET', '/internal/console/list?status=all');
  if (r.status !== 200) return { status: 503, data: { error: 'link_unavailable' } };
  const used = (r.data.drivers || []).filter((d) => String(d.referral_code || '').toUpperCase() === from).length;
  if (used) return { status: 409, data: { error: 'old_code_has_drivers', drivers: used } };
  const e = await engine('POST', '/ajan-code/rename', { phone: a.phone, from, to, by });
  if (e.status !== 200 || !e.data || !e.data.success) return { status: e.status === 503 ? 503 : 409, data: Object.assign({ error: 'engine_refused' }, e.data || {}) };
  a.referralCode = to;
  a.history.push({ action: 'code_adopted', note: (from + ' -> ' + to + ' (own sign-up; old code retired) by ' + by).slice(0, 120) });
  if (a.history.length > 50) a.history = a.history.slice(-50);
  await a.save();
  return { status: 200, data: { ok: true, agent: adminView(a) } };
}
router.post('/admin/:agentId/adopt-code', async (req, res) => {
  try { const r = await adoptCode(req.params.agentId, req.body && req.body.code, req.body && req.body.by); res.status(r.status).json(r.data); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/admin/:agentId/ajan-revoke', async (req, res) => {
  try {
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) });
    if (!a) return res.status(404).json({ error: 'not_found' });
    a.ajanPinHash = ''; a.ajanPinSetAt = null; a.ajanCodeHash = ''; a.ajanCodeExpires = null; a.ajanTokenV = (a.ajanTokenV || 0) + 1;
    (a.ajanDevices || []).forEach((d) => { if (d.state === 'approved' || d.state === 'pending') { d.state = 'revoked'; d.decidedAt = new Date(); d.decidedBy = String((req.body && req.body.by) || 'console').slice(0, 40); } });
    a.history.push({ action: 'ajan_revoke', note: 'PIN removed by ' + String((req.body && req.body.by) || 'console').slice(0, 40) });
    if (a.history.length > 50) a.history = a.history.slice(-50);
    await a.save();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/:agentId/photo', async (req, res) => {
  try {
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) }).select('+photo photoMime');
    if (!a || !a.photo) return res.status(404).end();
    res.set('Content-Type', a.photoMime || 'image/jpeg');
    res.set('Cache-Control', 'no-store');
    res.send(a.photo);
  } catch (e) { res.status(404).end(); }
});

router.post('/admin/:agentId/photo', async (req, res) => {
  try {
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) }).select('+photo');
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (req.body && req.body.remove) { a.photo = undefined; a.photoMime = ''; a.photoAt = null; }
    else {
      const p = decodePhoto(req.body && req.body.photo);
      if (!p) return res.status(400).json({ error: 'bad_photo' });
      a.photo = p.buf; a.photoMime = p.mime; a.photoAt = new Date();
    }
    a.history.push({ action: 'photo' });
    await a.save();
    res.json({ agent: adminView(a) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══ AJAN PILÒT — free LajanMaker days for the certified field pilot ═══════
 *
 * Jeffery, 22 Oct 2026 (approved A-G): search by phone or LMA number; show
 * activation, expiry, days left and app activity; grant 7 / 30 / custom days;
 * extend or cancel; record WHO did it; never overwrite a paid subscription;
 * prevent duplicate activations; only Ajan with a verified number, approved
 * profile, phone and a valid personal referral code; everyone else keeps the
 * normal seven days.
 *
 *   GET  /api/agents/admin/pilot/find?q=        phone, LMA number or name
 *   GET  /api/agents/admin/pilot/list           every pilot, newest first
 *   POST /api/agents/admin/pilot/:agentId        {days, by}        activate
 *   POST /api/agents/admin/pilot/:agentId/extend {days, by}
 *   POST /api/agents/admin/pilot/:agentId/cancel {by, note}
 *   POST /api/agents/admin/pilot/performance     results (via the engine)
 *   GET|POST /api/agents/admin/code              find / create a referral code
 *
 * The days ARE PosTrial.trialEndsAt, which the LajanMaker phone already obeys
 * while - and only while - its own licence is a trial. So the pilot reaches the
 * phone the next time the app opens, ends by itself, and a paid plan never
 * sees it. Nothing here can charge anybody.
 *
 * The results (drivers, businesses, sales, commissions) live with the referral
 * engine on myplopplop-api; the console page asks it directly with the codes
 * and activation dates listed here.
 * ═══════════════════════════════════════════════════════════════════════════ */
const AjanPilot = require('../models/AjanPilot');
const PosTrial = require('../models/PosTrial');
const { phoneKey } = require('../utils/ticketDelivery');

const KOUTYE_API = process.env.KOUTYE_API_URL || 'https://myplopplop-api.onrender.com';
const PILOT_MAX_DAYS = 90;
const DAY_MS = 86400000;

/* Is this a real, ACTIVE Ajan code on the referral engine? true / false, or
   null when the engine could not be reached - which the caller must treat as
   "not proven", never as yes. */
async function codeIsLive(code) {
  if (!code) return false;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(KOUTYE_API + '/api/referrals/validate/' + encodeURIComponent(code), { signal: ctl.signal });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.success && d.kind === 'koutye') return true;
    if (r.status === 404 || r.status === 409) return false;
    if (r.ok && d.kind && d.kind !== 'koutye') return false;
    return null;
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/* The referral engine's Ajan-code tools, server to server, with the key the
   two services already share for Tikè Lakay commissions. Anything short of a
   real answer is `link_unavailable`, and the console then asks the engine
   directly with ITS console code instead. */
async function engine(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_unavailable' } };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const o = { method, headers: { 'x-internal-key': key }, signal: ctl.signal };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(KOUTYE_API + '/api/internal' + path, o);
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 404 || r.status === 503) return { status: 503, data: { error: 'link_unavailable' } };
    return { status: r.status, data };
  } catch (e) {
    return { status: 503, data: { error: 'link_unavailable' } };
  } finally {
    clearTimeout(t);
  }
}

/* Is the badge's referral code real, active and HIS (same phone)?
   owner: true / false, or null when only existence could be checked. */
async function codeState(a) {
  if (!a.referralCode) return { live: false, owner: null, checked: true };
  const r = await engine('GET', '/ajan-code?phone=' + encodeURIComponent(a.phone || '') + '&code=' + encodeURIComponent(a.referralCode));
  if (r.status === 200) {
    const c = r.data.byCode;
    return { live: !!c && c.status === 'active', owner: c ? c.phoneMatch : null, checked: true,
             organization: c ? c.organization : '', ownerName: c && c.phoneMatch === false ? c.name : '' };
  }
  const live = await codeIsLive(a.referralCode);
  return { live: live === true, owner: null, checked: live !== null };
}

function eligibility(a, cs) {
  return {
    id: a.idMatched !== false,
    approved: a.status === 'active' && a.publicState() === 'active',
    phone: phoneKey(a.phone).length >= 8,
    code: !!a.referralCode && cs.live === true && cs.owner !== false,
    owner: cs.owner,
    organization: cs.organization || '',
    ownerName: cs.ownerName || '',
    codeChecked: cs.checked
  };
}

/* Console → engine: find / create an Ajan's referral code, and the pilot's
   results. Same console code as everything else on this page. */
router.get('/admin/code', async (req, res) => {
  const r = await engine('GET', '/ajan-code?phone=' + encodeURIComponent(String(req.query.phone || '')) +
    (req.query.code ? '&code=' + encodeURIComponent(String(req.query.code)) : ''));
  res.status(r.status).json(r.data);
});
router.post('/admin/code', async (req, res) => {
  const b = req.body || {};
  const r = await engine('POST', '/ajan-code', { name: b.name, phone: b.phone, customCode: b.customCode });
  res.status(r.status).json(r.data);
});
/* 4 Nov 2026 (Jennifer): a PIN cannot be read back (stored hashed), so an active badge gets a NEW one,
   shown once. The engine only does it for the account behind THIS badge's code AND phone. */
router.post('/admin/:agentId/new-pin', async (req, res) => {
  const a = await CertifiedAgent.findOne({ agentId: String(req.params.agentId || '').toUpperCase() });
  if (!a) return res.status(404).json({ error: 'not_found' });
  if (a.status !== 'active' || !a.referralCode) return res.status(409).json({ error: 'not_active' });
  const r = await engine('POST', '/ajan-code/new-pin', { phone: a.phone, code: a.referralCode, name: a.name, by: String((req.body && req.body.by) || 'console').slice(0, 60) });
  res.status(r.status).json(r.data);
});
router.post('/admin/pilot/performance', async (req, res) => {
  const r = await engine('POST', '/ajan-performance', { agents: (req.body && req.body.agents) || [] });
  res.status(r.status).json(r.data);
});

function trialView(t) {
  if (!t) return null;
  return { trialStartedAt: t.trialStartedAt, trialEndsAt: t.trialEndsAt, seenCount: t.seenCount || 0,
           lastSeen: t.lastSeen || null, pilotAgentId: t.pilotAgentId || '' };
}

function pilotView(p, now) {
  if (!p) return null;
  now = now || new Date();
  const state = p.state(now);
  return {
    agentId: p.agentId, name: p.name, phone: p.phone, referralCode: p.referralCode, state,
    startedAt: p.startedAt, endsAt: p.endsAt, cancelledAt: p.cancelledAt, prevTrialEndsAt: p.prevTrialEndsAt,
    daysLeft: state === 'active' ? Math.ceil((p.endsAt - now) / DAY_MS) : 0,
    history: (p.history || []).slice(-30)
  };
}

function byName(v) {
  const s = String(v || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return s.length >= 2 ? s : '';
}

function daysOf(v) {
  const n = Math.floor(Number(v));
  return n >= 1 && n <= PILOT_MAX_DAYS ? n : 0;
}

router.get('/admin/pilot/find', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim().slice(0, 60);
    if (!raw) return res.json({ results: [] });
    const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
    const lma = compact.match(/^LMA(\d{4})(\d{6})$/);
    const digits = raw.replace(/\D/g, '');
    let q;
    if (lma) q = { agentId: 'LMA-' + lma[1] + '-' + lma[2] };
    else if (digits.length >= 6 && digits.length === raw.replace(/[\s+().-]/g, '').length) {
      const key = phoneKey(digits);
      q = { phone: new RegExp(key.split('').join('[^0-9]*') + '[^0-9]*$') };
    } else {
      q = { name: new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') };
    }
    const list = await CertifiedAgent.find(q).sort({ updatedAt: -1 }).limit(10);
    const now = new Date();
    const results = [];
    for (const a of list) {
      const key = phoneKey(a.phone);
      const [pilot, trial, cs] = await Promise.all([
        AjanPilot.findOne({ agentId: a.agentId }),
        key.length >= 8 ? PosTrial.findOne({ phoneKey: key }).lean() : null,
        codeState(a)
      ]);
      results.push({ agent: adminView(a), eligibility: eligibility(a, cs), pilot: pilotView(pilot, now), trial: trialView(trial) });
    }
    res.json({ results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/admin/pilot/list', async (req, res) => {
  try {
    const pilots = await AjanPilot.find({}).sort({ startedAt: -1 }).limit(500);
    const ids = pilots.map((p) => p.agentId);
    const keys = pilots.map((p) => p.phoneKey);
    const [agents, trials] = await Promise.all([
      CertifiedAgent.find({ agentId: { $in: ids } }),
      PosTrial.find({ phoneKey: { $in: keys } }).lean()
    ]);
    const A = Object.fromEntries(agents.map((a) => [a.agentId, a]));
    const T = Object.fromEntries(trials.map((t) => [t.phoneKey, t]));
    const now = new Date();
    /* 22 Oct 2026: LajanMaker POS sales (models/PosSale.js) per Ajan, since
       his own pilot start. Recorded = what the phone reported and still
       stands; confirmed = the gateway said the money arrived. */
    const PosSale = require('../models/PosSale');
    const POS = {};
    for (const p of pilots) {
      const rows = await PosSale.find({ agentId: p.agentId, soldAt: { $gte: p.startedAt } });
      const s = { recorded: 0, recordedAmount: 0, confirmed: 0, confirmedAmount: 0, cancelled: 0, refunded: 0, refundedAmount: 0, share: 0, byService: {} };
      for (const r of rows) {
        if (r.state === 'cancelled') { s.cancelled++; continue; }
        if (r.state === 'refunded') { s.refunded++; s.refundedAmount += r.refunded || 0; }
        const net = r.net();
        if (net <= 0) continue;
        s.recorded++; s.recordedAmount += net; s.share += r.netShare();
        if (r.confirm && r.confirm.state === 'confirmed') { s.confirmed++; s.confirmedAmount += net; }
        const k = r.service || r.module || 'POS'; s.byService[k] = (s.byService[k] || 0) + 1;
      }
      POS[p.agentId] = s;
    }
    const unattributed = await PosSale.countDocuments({ agentId: '', state: { $ne: 'cancelled' } });
    res.json({
      maxDays: PILOT_MAX_DAYS,
      posUnattributed: unattributed,
      pilots: pilots.map((p) => {
        const a = A[p.agentId];
        return { pilot: pilotView(p, now), trial: trialView(T[p.phoneKey]), pos: POS[p.agentId],
                 agent: a ? { agentId: a.agentId, name: a.name, phone: a.phone, state: a.publicState(now),
                              referralCode: a.referralCode, sponsor: a.sponsor, city: a.city,
                              phoneChanged: phoneKey(a.phone) !== p.phoneKey } : null };
      })
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Move the phone's free-trial date. A row the phone never created is made with
   seenCount 0 / lastSeen null so the console can say "not opened yet". */
async function setTrialEnd(key, phone, name, agentId, endsAt, now) {
  const r = await PosTrial.updateOne({ phoneKey: key }, { $set: { trialEndsAt: endsAt, pilotAgentId: agentId } });
  if (r.matchedCount) return;
  try {
    await PosTrial.create({ phoneKey: key, phone: String(phone || '').slice(0, 32), label: String(name || '').slice(0, 80),
      trialStartedAt: now, trialEndsAt: endsAt, seenCount: 0, lastSeen: null, pilotAgentId: agentId });
  } catch (e) {
    /* The phone asked at the same instant and made the row first. */
    if (!e || e.code !== 11000) throw e;
    await PosTrial.updateOne({ phoneKey: key }, { $set: { trialEndsAt: endsAt, pilotAgentId: agentId } });
  }
}

/* ═══ THE PILOT STARTS BY ITSELF WHEN THE BADGE IS APPROVED (2 Nov 2026) ═══
   Jeffery: "YES, APPROVED. The 30-day free pilot should activate AUTOMATICALLY
   when Jennifer approves an Ajan's badge... The 30-day trial must start from
   the approval date, not from the first time the Ajan opened the app."
   - once per Ajan and per phone (the AjanPilot unique indexes + checks here)
   - linked to the verified badge AND its phone number
   - never shortens free days the phone already has
   - only an ACTIVE badge (suspended / revoked / expired / pending get nothing new)
   - the badge's phone corrected later = the pilot follows to the new number
     (Jeffery 2 Nov: the Ajan's app must show the SAME days as Jennifer's console)
   Runs when a badge is saved in the console, and as a sweep (boot + every 30
   min) that also catches up the Ajans approved before this existed. */
const AUTO_PILOT_DAYS = 30;
async function ensureAutoPilot(a, by, now) {
  now = now || new Date();
  if (!a || a.status !== 'active' || a.publicState(now) !== 'active') return { skipped: 'not_active' };
  /* the approval date; for a badge approved before approvedAt was recorded, the "active" entry in its history */
  const act = (a.history || []).filter((h) => h.action === 'active' && h.at).slice(-1)[0];
  const approvedOn = a.approvedAt || (act && act.at) || a.createdAt;
  const key = phoneKey(a.phone);
  if (key.length < 8) return { skipped: 'no_phone' };
  const mine = await AjanPilot.findOne({ agentId: a.agentId });
  if (mine) {
    if (mine.phoneKey === key) return { kept: true };
    /* the badge's number was corrected: the same pilot moves to the right phone */
    const other = await AjanPilot.findOne({ phoneKey: key, agentId: { $ne: a.agentId } }).select('agentId');
    if (other) return { skipped: 'phone_in_other_pilot', agentId: other.agentId };
    const fromKey = mine.phoneKey;
    mine.phoneKey = key; mine.phone = a.phone;
    mine.history.push({ at: now, by: by || 'system', action: 'phone_moved', endsAt: mine.endsAt, note: fromKey + ' → ' + key });
    await mine.save();
    if (!mine.cancelledAt && mine.endsAt > now) await setTrialEndNoShorten(key, a.phone, a.name, a.agentId, mine.endsAt, now);
    return { moved: true };
  }
  const other = await AjanPilot.findOne({ phoneKey: key }).select('agentId');
  if (other) return { skipped: 'phone_in_other_pilot', agentId: other.agentId };
  const start = new Date(approvedOn);
  const endsAt = new Date(start.getTime() + AUTO_PILOT_DAYS * DAY_MS);
  const trial = await PosTrial.findOne({ phoneKey: key }).lean();
  const prev = trial ? new Date(trial.trialEndsAt) : null;
  let p;
  try {
    p = await AjanPilot.create({ agentId: a.agentId, phoneKey: key, phone: a.phone, name: a.name, referralCode: a.referralCode || '',
      startedAt: start, endsAt, prevTrialEndsAt: prev,
      history: [{ at: now, by: by || 'system', action: 'auto', days: AUTO_PILOT_DAYS, endsAt,
                  note: 'badge approved ' + start.toISOString().slice(0, 10) + (prev && prev > endsAt ? '; phone already had a later end, kept' : '') }] });
  } catch (e) {
    if (e && e.code === 11000) return { skipped: 'exists' };
    throw e;
  }
  if (endsAt > now) await setTrialEndNoShorten(key, a.phone, a.name, a.agentId, endsAt, now);
  return { created: true, endsAt };
}
/* like setTrialEnd, but a later date already on the phone always wins */
async function setTrialEndNoShorten(key, phone, name, agentId, endsAt, now) {
  const t = await PosTrial.findOne({ phoneKey: key }).lean();
  if (t && new Date(t.trialEndsAt) >= endsAt) {
    await PosTrial.updateOne({ phoneKey: key }, { $set: { pilotAgentId: agentId } });
    return;
  }
  await setTrialEnd(key, phone, name, agentId, endsAt, now);
}
let sweeping = false;
async function pilotSweep() {
  if (sweeping) return null; sweeping = true;
  const out = { active: 0, had: 0, created: 0, moved: 0, skipped: [] };
  try {
    const list = await CertifiedAgent.find({ status: 'active' });
    out.active = list.length;
    for (const a of list) {
      try {
        const r = await ensureAutoPilot(a, 'auto-sweep');
        if (r.created) out.created++; else if (r.moved) out.moved++; else if (r.kept) out.had++;
        else if (r.skipped && r.skipped !== 'not_active') out.skipped.push(a.agentId + ':' + r.skipped);
      } catch (e) { out.skipped.push(a.agentId + ':error'); }
    }
    /* counts only (plus badge numbers of the ones skipped) - always once at boot, then only when something happens */
    if (!pilotSweep.logged || out.created || out.moved || out.skipped.length) {
      pilotSweep.logged = true;
      console.log('[PILOT] auto sweep active=' + out.active + ' had=' + out.had + ' created=' + out.created + ' moved=' + out.moved + ' skipped=' + JSON.stringify(out.skipped));
    }
    return out;
  } finally { sweeping = false; }
}
if (process.env.NODE_ENV !== 'test') {
  setTimeout(() => { pilotSweep().catch(() => {}); }, 20000);
  setInterval(() => { pilotSweep().catch(() => {}); }, 30 * 60 * 1000);
}
router.post('/admin/pilot/sweep', async (req, res) => {
  try { res.json(await pilotSweep() || { busy: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/pilot/:agentId', async (req, res) => {
  try {
    const b = req.body || {};
    const by = byName(b.by);
    const days = daysOf(b.days);
    if (!by) return res.status(400).json({ error: 'name_required' });
    if (!days) return res.status(400).json({ error: 'bad_days', max: PILOT_MAX_DAYS });
    const a = await CertifiedAgent.findOne({ agentId: normId(req.params.agentId) });
    if (!a) return res.status(404).json({ error: 'not_found' });
    const key = phoneKey(a.phone);

    if (await AjanPilot.exists({ agentId: a.agentId })) return res.status(409).json({ error: 'pilot_exists' });
    if (key.length >= 8) {
      const other = await AjanPilot.findOne({ phoneKey: key }).select('agentId name');
      if (other) return res.status(409).json({ error: 'phone_in_pilot', agentId: other.agentId, name: other.name });
    }
    if (a.referralCode) {
      const dup = await CertifiedAgent.findOne({ agentId: { $ne: a.agentId },
        referralCode: new RegExp('^' + a.referralCode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }).select('agentId name');
      if (dup) return res.status(409).json({ error: 'code_on_other_badge', agentId: dup.agentId, name: dup.name });
    }

    const el = eligibility(a, await codeState(a));
    if (!el.id || !el.approved || !el.phone || !el.code) {
      return res.status(!el.codeChecked ? 503 : 422).json({ error: 'not_eligible', eligibility: el });
    }

    const now = new Date();
    const trial = await PosTrial.findOne({ phoneKey: key }).lean();
    const prev = trial ? new Date(trial.trialEndsAt) : null;
    let endsAt = new Date(now.getTime() + days * DAY_MS);
    let note = '';
    /* Never SHORTEN what the Ajan already had. */
    if (prev && prev > endsAt) { endsAt = prev; note = 'kept the later trial end already on this phone'; }

    let p;
    try {
      p = await AjanPilot.create({
        agentId: a.agentId, phoneKey: key, phone: a.phone, name: a.name, referralCode: a.referralCode,
        startedAt: now, endsAt, prevTrialEndsAt: prev,
        history: [{ at: now, by, action: 'activate', days, endsAt, note }]
      });
    } catch (e) {
      if (e && e.code === 11000) return res.status(409).json({ error: 'pilot_exists' });
      throw e;
    }
    await setTrialEnd(key, a.phone, a.name, a.agentId, endsAt, now);
    a.history.push({ action: 'pilot', note: days + ' days by ' + by });
    if (a.history.length > 50) a.history = a.history.slice(-50);
    await a.save();
    res.json({ pilot: pilotView(p, now), trial: trialView(await PosTrial.findOne({ phoneKey: key }).lean()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/pilot/:agentId/extend', async (req, res) => {
  try {
    const b = req.body || {};
    const by = byName(b.by);
    const days = daysOf(b.days);
    if (!by) return res.status(400).json({ error: 'name_required' });
    if (!days) return res.status(400).json({ error: 'bad_days', max: PILOT_MAX_DAYS });
    const p = await AjanPilot.findOne({ agentId: normId(req.params.agentId) });
    if (!p) return res.status(404).json({ error: 'no_pilot' });
    const a = await CertifiedAgent.findOne({ agentId: p.agentId });
    /* A suspended or revoked Ajan does not get more free days. */
    if (!a || !(a.status === 'active' && a.publicState() === 'active')) return res.status(422).json({ error: 'not_approved' });
    const now = new Date();
    const wasCancelled = !!p.cancelledAt;
    const base = (!wasCancelled && p.endsAt > now) ? p.endsAt : now;
    const endsAt = new Date(base.getTime() + days * DAY_MS);
    p.endsAt = endsAt;
    p.cancelledAt = null;
    p.history.push({ at: now, by, action: 'extend', days, endsAt, note: wasCancelled ? 'reopened after cancel' : '' });
    if (p.history.length > 100) p.history = p.history.slice(-100);
    await p.save();
    await setTrialEnd(p.phoneKey, p.phone, p.name, p.agentId, endsAt, now);
    res.json({ pilot: pilotView(p, now), trial: trialView(await PosTrial.findOne({ phoneKey: p.phoneKey }).lean()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin/pilot/:agentId/cancel', async (req, res) => {
  try {
    const b = req.body || {};
    const by = byName(b.by);
    if (!by) return res.status(400).json({ error: 'name_required' });
    const p = await AjanPilot.findOne({ agentId: normId(req.params.agentId) });
    if (!p) return res.status(404).json({ error: 'no_pilot' });
    const now = new Date();
    if (p.state(now) !== 'active') return res.status(409).json({ error: 'not_active', state: p.state(now) });
    p.cancelledAt = now;
    p.endsAt = now;
    p.history.push({ at: now, by, action: 'cancel', endsAt: now, note: String(b.note || '').trim().slice(0, 200) });
    if (p.history.length > 100) p.history = p.history.slice(-100);
    await p.save();
    /* The phone's trial ends now; it goes back to asking for the normal
       subscription. A paid plan on that phone is untouched, as always. */
    await PosTrial.updateOne({ phoneKey: p.phoneKey }, { $set: { trialEndsAt: now } });
    res.json({ pilot: pilotView(p, now), trial: trialView(await PosTrial.findOne({ phoneKey: p.phoneKey }).lean()) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ═══ MSOUWOUT DRIVERS, FROM THIS CONSOLE (1 Nov 2026) ═════════════════════
   Jennifer checks the drivers' documents but could not approve them: MsouWout
   approval needed Jeffery's own login + the code on his phone. These pass her
   decision to MsouWout server to server (shared INTERNAL_SERVICE_KEY, never a
   browser), behind the same console code as the rest of this page, and always
   with the name of the person deciding. */
const MSW_API = process.env.MSOUWOUT_API_URL || 'https://msouwout-backend.onrender.com';
async function msw(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_unavailable' } };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 90000);
  try {
    const o = { method, headers: { 'x-internal-key': key }, signal: ctl.signal };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(MSW_API + '/api/drivers' + path, o);
    if (r.status === 401 || r.status === 503) return { status: 503, data: { error: 'link_unavailable' } };
    /* 3 Nov 2026 (Jennifer: "6 dokiman" on the card, "Pa gen dokiman" when opened): a body that did not
       arrive whole (slow MsouWout, 1-2 MB of photos, or the 60 s timer) used to become {} with a 200 -
       an EMPTY answer passed off as a real one. Now it is an error the console can say. */
    let data;
    try { data = await r.json(); } catch (e) { return { status: 502, data: { error: 'link_unavailable' } }; }
    return { status: r.status, data };
  } catch (e) {
    return { status: 503, data: { error: 'link_unavailable' } };
  } finally {
    clearTimeout(t);
  }
}
const UUID_RE = /^[0-9a-f-]{36}$/i;
/* Jeffery's text, 2 Nov 2026. ⛔ It must never tell a driver he can take rides now. */
function driverWelcomeText(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  return '🎉 FELISITASYON! BYENVINI NAN MSOUWOUT!\n\n'
    + 'Bonjou' + (first ? ' ' + first : '') + '! Nou kontan fè w konnen enskripsyon w kòm chofè MsouWout apwouve. ✅\n\n'
    + '📲 Telechaje aplikasyon MsouWout la, antre nimewo telefòn ou epi kreye PIN 4 chif ou.\n\n'
    + '🎓 MSOUWOUT AP ÒGANIZE YON FÒMASYON GRATIS POU OU!\n\n'
    + 'Nou pral montre w kijan pou itilize aplikasyon MsouWout ak MyPlopPlop yo pi byen, kijan pou resevwa ak jere kous ak livrezon, epi kijan pou travay an sekirite ak pwofesyonalis.\n\n'
    + '📅 N ap kontakte w pou ba w dat, lè ak kote fòmasyon an ap fèt.\n\n'
    + '🚀 Gwo lansman an ap vini byento!\n\n'
    + 'MsouWout — Chofè Verifye. Kous An Sekirite.';
}
async function sendDriverWelcome(driver, by) {
  const wa = require('../utils/whatsappSend');
  let out = { sent: false, reason: 'WhatsApp credentials not configured' };
  if (wa.configured()) {
    try {
      out = await wa.sendWhatsApp(driver.phone, { template: process.env.WHATSAPP_TEMPLATE_DRIVER_WELCOME || '', lang: process.env.WHATSAPP_TEMPLATE_LANG || 'fr',
        bodyParams: [String(driver.full_name || '').trim().split(/\s+/)[0] || 'chofè'], text: driverWelcomeText(driver.full_name) });
    } catch (e) { out = { sent: false, reason: e.message }; }
  }
  const status = out.sent ? 'sent' : 'manual_needed';
  await msw('POST', '/internal/console/' + driver.id + '/welcome', { by: by || 'system', status, channel: out.sent ? 'whatsapp_auto' : 'none',
    note: out.sent ? '' : String(out.reason || '').slice(0, 200) });
  return { status, channel: out.sent ? 'whatsapp_auto' : 'none', reason: out.sent ? '' : out.reason, text: driverWelcomeText(driver.full_name) };
}
router.get('/admin/drivers', async (req, res) => {
  const st = ['pending', 'approved', 'rejected', 'suspended', 'all'].includes(req.query.status) ? req.query.status : 'pending';
  const r = await msw('GET', '/internal/console/list?status=' + st);
  if (r.status === 200) {
    /* the recruiting Ajan by name, from this registry */
    const codes = [...new Set((r.data.drivers || []).map((d) => d.referral_code).filter(Boolean))];
    const agents = codes.length ? await CertifiedAgent.find({ referralCode: { $in: codes } }).select('name agentId referralCode') : [];
    const byCode = {}; agents.forEach((a) => { byCode[String(a.referralCode).toUpperCase()] = { name: a.name, agentId: a.agentId }; });
    (r.data.drivers || []).forEach((d) => { d.ajan = d.referral_attached ? (byCode[String(d.referral_code).toUpperCase()] || null) : null; });
  }
  res.status(r.status).json(r.data);
});
/* 5 Nov 2026: OAVCT watch for Jennifer - approved drivers held (expired) / expiring within 30 days / no date */
router.get('/admin/drivers/oavct', async (req, res) => {
  const r = await msw('GET', '/internal/console/oavct');
  res.status(r.status).json(r.data);
});
router.get('/admin/drivers/stats', async (req, res) => {
  const r = await msw('GET', '/internal/console-stats/agents');
  if (r.status !== 200) return res.status(r.status).json(r.data);
  const agents = await CertifiedAgent.find({ referralCode: { $ne: '' } }).select('name agentId referralCode status');
  const byCode = {}; agents.forEach((a) => { byCode[String(a.referralCode).toUpperCase()] = a; });
  const rows = (r.data.agents || []).map((x) => {
    const a = byCode[String(x.code).toUpperCase()];
    /* Jeffery's rule, shown for tracking only: 1 000 HTG for every 5 VERIFIED
       drivers. Nothing here pays anybody. */
    return { code: x.code, name: a ? a.name : '', agentId: a ? a.agentId : '', registered: x.registered, verified: x.verified,
             bonusHtg: Math.floor(x.verified / 5) * 1000, toNext: 5 - (x.verified % 5) };
  });
  res.json({ agents: rows, uncredited: r.data.uncredited || 0 });
});
/* 3 Nov 2026 (Jeffery): CSV of the drivers Jennifer filtered (console code required: router.use('/admin',
   requirePin)). The list is read from MsouWout HERE, never taken from the browser; every export is logged. */
const DriverExportLog = require('../models/DriverExportLog');
const DOC_HT = { selfie: 'Foto figi', id: 'Kat ID', license: 'Lisans', oavct: 'OAVCT', vehicle: 'Foto moto/machin' };
function csvCell(v) {
  let t = String(v == null ? '' : v).replace(/\r?\n/g, ' ');
  if (/^[=+\-@\t]/.test(t)) t = "'" + t;                      /* a cell is never a spreadsheet formula */
  return /[",;]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
router.post('/admin/drivers/export', async (req, res) => {
  try {
    const b = req.body || {}, by = String(b.by || '').trim().slice(0, 60);
    if (!by) return res.status(400).json({ error: 'name_required' });
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String))].filter((x) => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 1000);
    if (!ids.length) return res.status(400).json({ error: 'nothing_to_export' });
    const r = await msw('GET', '/internal/console/list?status=all');
    if (r.status !== 200) return res.status(503).json({ error: 'link_unavailable' });
    const all = r.data.drivers || [], want = new Set(ids);
    const rows = all.filter((d) => want.has(String(d.id)));
    const codes = [...new Set(rows.map((d) => d.referral_code).filter(Boolean))];
    const agents = codes.length ? await CertifiedAgent.find({ referralCode: { $in: codes } }).select('name agentId referralCode') : [];
    const byCode = {}; agents.forEach((a) => { byCode[String(a.referralCode).toUpperCase()] = a; });
    const today = new Date().toISOString().slice(0, 10);
    const head = ['Non', 'Telefòn', 'Machin', 'Ajan', 'Badj Ajan', 'Kòd Ajan', 'Estati', 'Dokiman ki manke / pou refè', 'OAVCT', 'Dat enskripsyon'];
    const lines = rows.map((d) => {
      const h = d.doc_types || [], fx = d.fix_docs || [], a = d.referral_attached ? byCode[String(d.referral_code || '').toUpperCase()] : null;
      const exp = d.oavct_expiry ? new Date(d.oavct_expiry).toISOString().slice(0, 10) : '';
      const miss = AJ_NEED.filter((t) => !h.includes(t)).map((t) => 'Manke ' + DOC_HT[t]).concat(fx.map((t) => 'Refè ' + (DOC_HT[t] || t)));
      const st = d.status === 'pending' ? (assistOpen(d) ? 'ENSKRI — OAVCT POKO REGLE' : (fx.length ? 'Pou korije' : 'An atant')) : d.status === 'approved' ? 'Apwouve' : d.status === 'rejected' ? 'Rejte' : d.status;
      return [d.full_name, d.phone, /moto/.test(d.vehicle_type || '') ? 'Moto' : 'Machin', a ? a.name : '', a ? a.agentId : '', d.referral_attached ? d.referral_code : '',
        st, miss.join(' · '), !exp ? 'pa gen dat' : exp < today ? 'ekspire ' + exp : 'valab jiska ' + exp,
        d.created_at ? new Date(d.created_at).toISOString().slice(0, 10) : ''].map(csvCell).join(',');
    });
    await DriverExportLog.create({ by, filter: String(b.filter || '').slice(0, 200), count: rows.length, driverIds: rows.map((d) => String(d.id)), ip: clientIp(req) });
    console.log('[EXPORT] ' + rows.length + ' drivers exported by ' + by + ' (' + String(b.filter || '').slice(0, 80) + ')');
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', 'attachment; filename="chofe-msouwout-' + today + '.csv"');
    res.set('Cache-Control', 'no-store');
    res.send('\ufeff' + head.map(csvCell).join(',') + '\r\n' + lines.join('\r\n') + '\r\n');
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
router.get('/admin/drivers/exports', async (req, res) => {
  const L = await DriverExportLog.find({}).sort({ at: -1 }).limit(30).select('by filter count at').lean();
  res.json({ exports: L });
});
router.get('/admin/drivers/:id/events', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = await msw('GET', '/internal/console/' + req.params.id + '/events');
  res.status(r.status).json(r.data);
});
router.get('/admin/drivers/:id', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const r = await msw('GET', '/internal/console/' + req.params.id);
  res.status(r.status).json(r.data);
});
router.post('/admin/drivers/:id/:act', async (req, res) => {
  const act = req.params.act;
  if (!UUID_RE.test(req.params.id) || !['approve', 'reject', 'agent', 'fix', 'oavct', 'document', 'welcome', 'edit', 'reopen', 'pin-reset'].includes(act)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  let code = String(b.code || '').trim();
  /* An Ajan can be named by his badge number: it becomes his referral code. */
  if (act === 'agent' && /^LMA-?\d{4}/i.test(code)) {
    const a = await CertifiedAgent.findOne({ agentId: normId(code) });
    if (!a || a.publicState() !== 'active' || !a.referralCode) return res.status(400).json({ error: 'badge_not_active' });
    code = a.referralCode;
  }
  /* Jennifer sent the welcome herself from the WhatsApp button: record it (once) */
  if (act === 'welcome') {
    const w = await msw('POST', '/internal/console/' + req.params.id + '/welcome', { by: b.by, status: 'sent', channel: 'whatsapp_manual' });
    return res.status(w.status).json(w.data);
  }
  const r = await msw('POST', '/internal/console/' + req.params.id + '/' + act, { by: b.by, reason: b.reason, code, service: b.service,
    docs: b.docs, note: b.note, expiry: b.expiry, doc_type: b.doc_type, image_data: b.image_data, fields: b.fields });
  /* 2 Nov 2026, Jeffery: after Jennifer's approval is saved, the welcome goes out by
     itself - ONCE, only on a NEW approval (not a change of services). WhatsApp is
     the only channel there is; until the Business number is connected the result
     is "to send by hand" and her console shows the ready-written button. */
  if (act === 'approve' && r.status === 200 && r.data && r.data.was !== 'approved' && r.data.driver && !r.data.driver.welcome_status) {
    r.data.welcome = await sendDriverWelcome(r.data.driver, b.by);
  }
  res.status(r.status).json(r.data);
});

/* ═══ KOLI REFUNDS (5 Nov 2026) - Jennifer's console → MyPlopPlop internal routes ═══
   Jeffery: "a reliable refund process if no driver accepts". A paid parcel nobody took (30 min), or that
   the sender cancelled before pickup, is recorded on MyPlopPlop as a refund OWED. Jennifer sees the list
   here, pays it back by MonCash/NatCash/card, and records who + the transaction reference. */
async function mppJob(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_unavailable' } };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90000);
  try {
    const o = { method, headers: { 'x-internal-key': key }, signal: ctl.signal };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(KOUTYE_API + '/api/internal' + path, o);
    if (r.status === 401 || r.status === 503) return { status: 503, data: { error: 'link_unavailable' } };
    let data; try { data = await r.json(); } catch (e) { return { status: 502, data: { error: 'link_unavailable' } }; }
    return { status: r.status, data };
  } catch (e) { return { status: 503, data: { error: 'link_unavailable' } }; } finally { clearTimeout(t); }
}
/* 5 Nov 2026 (Jennifer could not find passenger-ride refunds anywhere): MsouWout ride refunds owed, listed and
   recorded from her console - the same 💸 tab as the parcel refunds. */
async function mswRides(method, path, body) {
  const key = process.env.INTERNAL_SERVICE_KEY;
  if (!key) return { status: 503, data: { error: 'link_unavailable' } };
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 90000);
  try {
    const o = { method, headers: { 'x-internal-key': key }, signal: ctl.signal };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    const r = await fetch(MSW_API + '/api/rides' + path, o);
    if (r.status === 401 || r.status === 503) return { status: 503, data: { error: 'link_unavailable' } };
    let data; try { data = await r.json(); } catch (e) { return { status: 502, data: { error: 'link_unavailable' } }; }
    return { status: r.status, data };
  } catch (e) { return { status: 503, data: { error: 'link_unavailable' } }; } finally { clearTimeout(t); }
}
router.get('/admin/ride-refunds', async (req, res) => {
  const st = ['owed', 'refunded', 'all'].includes(req.query.status) ? req.query.status : 'owed';
  const r = await mswRides('GET', '/internal/refunds?status=' + st);
  res.status(r.status).json(r.data);
});
router.post('/admin/ride-refunds/:id/refunded', async (req, res) => {
  if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const r = await mswRides('POST', '/internal/refunds/' + req.params.id + '/refunded', { by: String(b.by || '').slice(0, 60),
    reference: String(b.reference || '').slice(0, 120), note: String(b.note || '').slice(0, 300), amount: b.amount });
  res.status(r.status).json(r.data);
});
/* 6 Nov 2026 (Koli option A, Jeffery: "Add the 15-minute alert for Jennifer"): paid parcels still without a driver,
   red after 15 minutes, with the nearest eligible drivers to call. Console code (router.use('/admin', requirePin)). */
router.get('/admin/parcels-waiting', async (req, res) => {
  const r = await mppJob('GET', '/parcels-waiting');
  res.set('Cache-Control', 'no-store');
  res.status(r.status).json(r.data);
});
router.get('/admin/parcel-refunds', async (req, res) => {
  const st = ['owed', 'refunded', 'all'].includes(req.query.status) ? req.query.status : 'owed';
  const r = await mppJob('GET', '/parcel-refunds?status=' + st);
  res.status(r.status).json(r.data);
});
router.post('/admin/parcel-refunds/:id/refunded', async (req, res) => {
  if (!OID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const r = await mppJob('POST', '/parcel-refunds/' + req.params.id + '/refunded', { by: String(b.by || '').slice(0, 80), reference: String(b.reference || '').slice(0, 120), note: String(b.note || '').slice(0, 300) });
  res.status(r.status).json(r.data);
});

module.exports = router;
module.exports.pilotSweep = pilotSweep;
module.exports.ensureAutoPilot = ensureAutoPilot;
