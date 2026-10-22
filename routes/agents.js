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
    source: a.source, idMatched: a.idMatched !== false, photo: !!a.photoAt, approvedAt: a.approvedAt, submissions: a.submissions,
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
      if (!(ymd && CertifiedAgent.certNumber(name, ymd) === agentId)) {
        const found = CertifiedAgent.findDate(name, agentId);
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
    res.json({
      maxDays: PILOT_MAX_DAYS,
      pilots: pilots.map((p) => {
        const a = A[p.agentId];
        return { pilot: pilotView(p, now), trial: trialView(T[p.phoneKey]),
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

module.exports = router;
