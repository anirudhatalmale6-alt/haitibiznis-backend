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
 *
 * 🔑 Why PENDING: the re-issue page is unlocked by a code written in its own
 * source, so a submission proves nothing about who passed. "VERIFYE" means a
 * person at HaitiBiznis looked at it.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const CertifiedAgent = require('../models/CertifiedAgent');
const { requirePin } = require('../utils/consolePin');
const clientIp = require('../utils/clientIp');

const ID_RE = /^LMA-\d{4}-\d{6}$/;
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
router.use('/admin', requirePin);

function adminView(a) {
  return {
    agentId: a.agentId, name: a.name, phone: a.phone, city: a.city, sponsor: a.sponsor,
    referralCode: a.referralCode, services: a.services, certifiedAt: a.certifiedAt,
    expiresAt: a.expiresAt, status: a.status, state: a.publicState(), statusNote: a.statusNote,
    source: a.source, photo: !!a.photoAt, approvedAt: a.approvedAt, submissions: a.submissions,
    createdAt: a.createdAt, updatedAt: a.updatedAt, history: (a.history || []).slice(-10)
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
    res.json({ agents: list.map(adminView), counts: Object.fromEntries(counts.map((c) => [c._id, c.n])),
               services: CertifiedAgent.SERVICES });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/admin', async (req, res) => {
  try {
    const b = req.body || {};
    const agentId = CertifiedAgent.certNumber(String(b.name || ''), String(b.date || ''));
    if (!agentId || !String(b.name || '').trim()) return res.status(400).json({ error: 'name_and_date_required' });
    if (await CertifiedAgent.exists({ agentId })) return res.status(409).json({ error: 'exists', agentId });
    const m = String(b.date).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const a = await CertifiedAgent.create({
      agentId, name: String(b.name).trim().replace(/\s+/g, ' '),
      phone: String(b.phone || '').trim().slice(0, 40), source: 'admin',
      certifiedAt: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), status: 'pending',
      history: [{ action: 'created', note: 'console' }]
    });
    res.json({ agent: adminView(a) });
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
    if (Array.isArray(b.services)) a.services = b.services.filter((s) => CertifiedAgent.SERVICES.includes(s));
    if (b.expiresAt !== undefined) {
      const d = b.expiresAt ? new Date(b.expiresAt) : null;
      if (d && isNaN(d)) return res.status(400).json({ error: 'bad_date' });
      a.expiresAt = d;
    }
    if (b.status && b.status !== a.status) {
      if (!['pending', 'active', 'suspended', 'revoked'].includes(b.status)) return res.status(400).json({ error: 'bad_status' });
      if (b.status === 'active') {
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
    res.json({ agent: adminView(a) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* The console sees the photo of a PENDING agent too - that is what it checks
   before approving. Fetched with the console code, shown from a blob. */
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

module.exports = router;
