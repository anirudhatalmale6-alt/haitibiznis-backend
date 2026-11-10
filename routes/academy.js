/* ═══ LAJANMAKER ACADEMY: CERTIFICATION EXAM RECORDS (9 Nov 2026) ═══════════════
   POST /api/academy/exam/start    { name, phone, lang }  -> { attemptId, startedAt, minutes } | 409 wait
   POST /api/academy/exam/finish   { attemptId, ok, n, pct, passed, cert, timedOut }
   POST /api/academy/exam/offline  { clientRef, name, phone, startedAt, finishedAt, ok, n, pct, passed, cert }
   GET  /api/academy/admin/exams[.csv]   (console code) - Jennifer's dashboard

   10 Nov 2026 (Jeffery, OPTION A - "protect the 1,000 HTG paid training and certification"):
   POST /api/academy/eligibility       { phone, name }       -> { state: paid | payable | pending | none | name_mismatch }
   POST /api/academy/exam/certificate  { phone, name }       -> the certificate of a PAID student who passed (lost / reloaded page)
   GET  /api/academy/enroll                                   -> the training to enrol in (the "Enskri" button)
   console code: GET /admin/academy, POST /admin/academy/settings, POST /admin/enrollments,
                 PATCH /admin/enrollments/:id, POST /admin/enrollments/:id/release
   - the trainer code is no longer in the page: a salted hash here, set by Jennifer
   - the official exam starts only for a phone with a confirmed paid Formation ticket
     (or a seat Jennifer bound by hand); the seat is then bound to that ONE student
   - the certificate number comes from the server, and only for a paid student
   - the free lessons and Practice Mode do not touch any of this

   Rules (the same the page shows): 20 minutes, 80% to pass, 24 hours before a
   retake - now for the student's phone NUMBER on any device. An attempt started
   and never finished counts once 20 minutes (+ grace) have gone by; a student
   whose connection dropped can come back to the SAME attempt (same clock) until
   then. */
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const ExamAttempt = require('../models/ExamAttempt');
const AcademyEnrollment = require('../models/AcademyEnrollment');
const AcademySetting = require('../models/AcademySetting');
const Transaction = require('../models/Transaction');
const Event = require('../models/Event');
const CertifiedAgent = require('../models/CertifiedAgent');
const { requirePin } = require('../utils/consolePin');
const { phoneKey } = require('../utils/ticketDelivery');

const MINUTES = 20;
const GRACE_SEC = 120;               // a slow phone / network at the very end
const RETRY_HOURS = 24;
const N_QUESTIONS = 15, PASS_PCT = 80;

function digitsOf(p) { return String(p || '').replace(/\D/g, '').replace(/^509(?=\d{8}$)/, '').slice(-15); }
function ip(req) { return String((req.headers['x-forwarded-for'] || '').split(',')[0] || req.ip || '').trim().slice(0, 64); }
/* a training room shares ONE connection: generous per address, it only stops floods */
const hits = new Map();
function tooMany(req, max, windowMs) {
  const k = ip(req), now = Date.now();
  const l = (hits.get(k) || []).filter((t) => now - t < windowMs); l.push(now); hits.set(k, l);
  return l.length > max;
}
function limitMs() { return (MINUTES * 60 + GRACE_SEC) * 1000; }

/* ═══ 10 Nov 2026: PAID TRAINING = THE ONLY WAY TO AN OFFICIAL EXAM ═══════════ */
/* the Formation LajanMaker event already on Tikè Lakay (Jeffery's 1,000 HTG "Réservez votre place") */
const DEFAULT_EVENTS = String(process.env.ACADEMY_EVENT_IDS || '6ae9db044ca71ee242c136d4').split(',').map((x) => x.trim()).filter(Boolean);
const TL_EVENT = 'https://tikelakay.com/event.html?id=';
const TRAINING_TYPE = /^f[oò]masyon$/i;
/* "Marie-Joseph  PIERRE" = "pierre marie joseph": case, accents, punctuation and word order do not matter */
function nameKey(n) {
  return String(n || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(Boolean).sort().join(' ').slice(0, 120);
}
function haitiYmd(d) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }
  catch (e) { return new Date(d.getTime() - 5 * 3600000).toISOString().slice(0, 10); }
}
function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
async function settings() {
  return (await AcademySetting.findOne({ key: 'academy' }).select('+codeSalt +codeHash')) || null;
}
async function academyEventIds(st) {
  st = st === undefined ? await settings() : st;
  return (st && Array.isArray(st.eventIds) && st.eventIds.length) ? st.eventIds : DEFAULT_EVENTS;
}
function hashCode(code, salt) { return crypto.scryptSync(String(code).trim().toUpperCase(), salt, 32).toString('hex'); }
/* 'ok' | 'bad' | 'unset' - the code lives only here (hash), or in the server's own environment */
async function checkTrainerCode(code, st) {
  const c = String(code || '').trim().toUpperCase();
  if (st && st.codeHash && st.codeSalt) {
    if (!c) return 'bad';
    const a = Buffer.from(hashCode(c, st.codeSalt), 'hex'), b = Buffer.from(st.codeHash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? 'ok' : 'bad';
  }
  const env = String(process.env.ACADEMY_TRAINER_CODE || '').trim().toUpperCase();
  if (env) return c && c === env ? 'ok' : 'bad';
  return 'unset';
}
/* wrong trainer codes: 20 an hour per address (a room shares one connection; guessing needs thousands) */
const bad = new Map();
function tooManyBad(req, add) {
  const k = ip(req), now = Date.now();
  const l = (bad.get(k) || []).filter((t) => now - t < 3600 * 1000);
  if (add) l.push(now); bad.set(k, l);
  return l.length >= 20;
}
/* the trainer's answer key page (akademi/kle.html) opens with the same exam code, checked here */
router.post('/trainer-check', async (req, res) => {
  try {
    if (tooManyBad(req, false)) return res.status(429).json({ error: 'too_many_codes' });
    const c = await checkTrainerCode((req.body || {}).code, await settings());
    if (c !== 'ok') { tooManyBad(req, true); return res.status(403).json({ error: c === 'unset' ? 'exam_closed' : 'bad_code' }); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
function digitsRe(key) { return new RegExp(key.split('').join('\\D*') + '\\D*$'); }
/* the confirmed paid tickets of this phone for the Academy training (oldest first) */
async function paidTickets(key, evIds) {
  return Transaction.find({ event: { $in: evIds }, status: 'completed', ticketPrice: { $gt: 0 },
    $or: [{ phoneKey: key }, { buyerPhone: digitsRe(key) }] }).sort({ paidAt: 1, createdAt: 1 }).lean();
}
/* the seat of this phone, if it is still paid (a seat whose ticket was REFUNDED no longer counts) */
async function activeSeat(key) {
  const enr = await AcademyEnrollment.findOne({ phoneKey: key, status: 'active' }).lean();
  if (!enr) return null;
  if (enr.source === 'ticket' && !(await Transaction.exists({ referenceId: enr.ticketRef, status: 'completed' }))) return Object.assign(enr, { refunded: true });
  return enr;
}
async function seatsUsed(ref) { return AcademyEnrollment.countDocuments({ ticketRef: ref, status: 'active' }); }
/* where does this phone stand? (nothing is written here) */
async function standing(key, name) {
  const enr = await activeSeat(key);
  if (enr && enr.refunded) return { state: 'none', refunded: true };
  if (enr) {
    if (name && enr.nameKey && enr.nameKey !== nameKey(name)) return { state: 'name_mismatch', enr };
    return { state: 'paid', enr };
  }
  const evIds = await academyEventIds();
  for (const t of await paidTickets(key, evIds)) {
    if ((await seatsUsed(t.referenceId)) < (t.qty || 1)) return { state: 'payable', txn: t };
  }
  const pend = await Transaction.findOne({ event: { $in: evIds }, status: 'pending', ticketPrice: { $gt: 0 },
    $or: [{ phoneKey: key }, { buyerPhone: digitsRe(key) }], createdAt: { $gte: new Date(Date.now() - 2 * 86400000) } }).lean();
  return { state: pend ? 'pending' : 'none' };
}
async function bindSeat(key, phone, name, txn, by, note) {
  /* the old seat of this phone was refunded: it is closed (kept in the history) before the new one */
  const old = await activeSeat(key);
  if (old && old.refunded) await AcademyEnrollment.updateOne({ _id: old._id, status: 'active' }, { $set: { status: 'released', releasedAt: new Date() }, $push: { history: { action: 'released', note: 'ticket refunded', by: 'auto' } } });
  const ev = txn ? await Event.findById(txn.event).select('title').lean() : null;
  try {
    return await AcademyEnrollment.create({ phoneKey: key, phone: clip(phone, 40), name: clip(name, 120), nameKey: nameKey(name),
      source: txn ? 'ticket' : 'manual', ticketRef: txn ? txn.referenceId : '', eventId: txn ? String(txn.event) : '', eventTitle: ev ? ev.title : '',
      buyerName: txn ? clip(txn.buyerName, 120) : '', buyerPhone: txn ? clip(txn.buyerPhone, 40) : '', ticketQty: txn ? (txn.qty || 1) : 1,
      paidAmount: txn ? (txn.paidAmount || txn.totalAmount || 0) : 0, note: clip(note, 300), by: clip(by, 60) || 'auto',
      history: [{ action: txn ? 'seat' : 'manual', note: txn ? txn.referenceId + (note ? ' · ' + clip(note, 200) : '') : clip(note, 200), by: clip(by, 60) || 'auto' }] });
  } catch (e) {
    if (e && e.code === 11000) return AcademyEnrollment.findOne({ phoneKey: key, status: 'active' });   // two taps at once: one seat
    throw e;
  }
}
async function enrollTarget() {
  const ids = await academyEventIds();
  const evs = await Event.find({ _id: { $in: ids.filter((x) => /^[0-9a-f]{24}$/i.test(x)) }, status: { $ne: 'cancelled' } })
    .select('title date startTime location tickets currency').lean();
  if (!evs.length) return null;
  const today = haitiYmd(new Date());
  const up = evs.filter((e) => String(e.date || '') >= today).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const e = up[0] || evs.sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
  const t = (e.tickets || []).filter((x) => x.price > 0).sort((a, b) => a.price - b.price)[0];
  return { eventId: String(e._id), title: String(e.title || '').trim(), date: e.date, startTime: e.startTime || '', location: e.location || '',
    price: t ? t.price : null, currency: e.currency || 'HTG', url: TL_EVENT + e._id };
}
router.get('/enroll', async (req, res) => {
  try {
    const t = await enrollTarget();
    res.set('Cache-Control', 'no-store');
    res.json(t || { url: TL_EVENT + DEFAULT_EVENTS[0] });
  } catch (e) { res.json({ url: TL_EVENT + DEFAULT_EVENTS[0] }); }
});
async function enrollUrl() { try { const t = await enrollTarget(); return t ? t.url : TL_EVENT + DEFAULT_EVENTS[0]; } catch (e) { return TL_EVENT + DEFAULT_EVENTS[0]; } }

/* the start screen asks as soon as the phone number is typed: paid or not (no name of anybody else is ever returned) */
router.post('/eligibility', async (req, res) => {
  try {
    if (tooMany(req, 300, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
    const key = phoneKey((req.body || {}).phone);
    if (key.length < 8) return res.status(400).json({ error: 'phone_required' });
    const s = await standing(key, (req.body || {}).name);
    res.set('Cache-Control', 'no-store');
    res.json({ state: s.state, enroll: s.state === 'paid' || s.state === 'payable' ? undefined : await enrollUrl() });
  } catch (e) { console.error('[EXAM] eligibility', e.message); res.status(500).json({ error: 'server' }); }
});

/* the attempt that blocks a retake: finished (or abandoned) within 24 h */
async function blocking(digits, now) {
  const since = new Date(now.getTime() - RETRY_HOURS * 3600 * 1000);
  const last = await ExamAttempt.findOne({ phoneDigits: digits, startedAt: { $gte: since },
    $or: [{ status: { $in: ['finished', 'abandoned'] } }, { status: 'started', startedAt: { $lt: new Date(now.getTime() - limitMs()) } }] })
    .sort({ startedAt: -1 }).lean();
  if (!last) return null;
  const from = last.finishedAt || new Date(last.startedAt.getTime() + limitMs());
  const retryAt = new Date(new Date(last.startedAt).getTime() + RETRY_HOURS * 3600 * 1000);
  return { last, retryAt, hours: Math.max(1, Math.ceil((retryAt - now) / 3600000)), from };
}

router.post('/exam/start', async (req, res) => {
  try {
    if (tooMany(req, 300, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
    const b = req.body || {};
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
    const digits = digitsOf(b.phone);
    if (name.length < 3) return res.status(400).json({ error: 'name_required' });
    if (digits.length < 8) return res.status(400).json({ error: 'phone_required' });
    /* 10 Nov 2026: the trainer's code, checked HERE (it is no longer in the page) */
    const st = await settings();
    if (tooManyBad(req, false)) return res.status(429).json({ error: 'too_many_codes' });
    const code = await checkTrainerCode(b.code, st);
    if (code === 'unset') return res.status(403).json({ error: 'exam_closed' });
    if (code !== 'ok') { tooManyBad(req, true); return res.status(403).json({ error: 'bad_code' }); }
    /* 10 Nov 2026: a confirmed paid Formation ticket for THIS phone, bound to THIS student */
    const key = phoneKey(b.phone);
    const s = await standing(key, name);
    if (s.state === 'name_mismatch') return res.status(409).json({ error: 'name_mismatch' });
    if (s.state === 'pending') return res.status(402).json({ error: 'payment_pending', enroll: await enrollUrl() });
    if (s.state === 'none') return res.status(402).json({ error: 'not_paid', enroll: await enrollUrl() });
    const now = new Date();
    /* same student, connection dropped: back to the SAME attempt, same clock */
    const open = await ExamAttempt.findOne({ phoneDigits: digits, status: 'started', startedAt: { $gte: new Date(now.getTime() - limitMs()) } }).sort({ startedAt: -1 });
    if (open && open.paid) return res.json({ attemptId: open._id, startedAt: open.startedAt, minutes: MINUTES, resumed: true, now });
    const blk = await blocking(digits, now);
    if (blk) return res.status(409).json({ error: 'wait', hours: blk.hours, retryAt: blk.retryAt });
    let enr = s.enr;
    if (s.state === 'payable') {
      enr = await bindSeat(key, b.phone, name, s.txn, 'auto');
      if (!enr || (enr.nameKey && enr.nameKey !== nameKey(name))) return res.status(409).json({ error: 'name_mismatch' });
    }
    if (enr && !enr.name) { await AcademyEnrollment.updateOne({ _id: enr._id }, { $set: { name, nameKey: nameKey(name) }, $push: { history: { action: 'name', note: name, by: 'exam' } } }); }
    const a = await ExamAttempt.create({ name, phone: String(b.phone || '').slice(0, 40), phoneDigits: digits, lang: String(b.lang || 'ht').slice(0, 5),
      paid: true, enrollmentId: enr ? String(enr._id) : '',
      startedAt: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    res.json({ attemptId: a._id, startedAt: a.startedAt, minutes: MINUTES, now });
  } catch (e) { console.error('[EXAM] start', e.message); res.status(500).json({ error: 'server' }); }
});

function certOut(a) { return a && a.passed && a.paid && a.cert ? { cert: a.cert, ymd: a.ymd, name: a.name, certified: true } : { certified: false }; }
/* A finish sent twice at the same moment (the page + its retry queue): the second one waits for the first to have
   written the certificate, so both answers carry the SAME number. */
async function settled(id) {
  let x = await ExamAttempt.findById(id).lean();
  for (let i = 0; i < 15 && x && x.passed && x.paid && !x.cert; i++) { await new Promise((r) => setTimeout(r, 200)); x = await ExamAttempt.findById(id).lean(); }
  return x;
}
/* The unique, permanent ID: LMA-<year>-<6 random digits>, the format every badge, QR and verification page already
   reads. Taken only if no badge (old or new) and no exam has it; the badge record (unique key) is created in the
   same step, PENDING until Jennifer approves. */
async function issueCert(r) {
  const year = String(r.ymd).slice(0, 4), m = String(r.ymd).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const key = phoneKey(r.phone);
  for (let i = 0; i < 25; i++) {
    const id = 'LMA-' + year + '-' + String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (await ExamAttempt.exists({ cert: id })) continue;
    try {
      await CertifiedAgent.create({ agentId: id, name: r.name, phone: key.length === 8 ? '+509 ' + key.slice(0, 4) + ' ' + key.slice(4) : clip(r.phone, 40),
        source: 'exam', examAttempt: String(r._id), certifiedAt: new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)), status: 'pending', submissions: 1,
        lastSubmittedAt: new Date(), history: [{ action: 'submitted', note: 'exam (paid seat) · unique ID' }] });
    } catch (e) { if (e && e.code === 11000) continue; throw e; }
    const w = await ExamAttempt.findOneAndUpdate({ _id: r._id, cert: '' }, { $set: { cert: id } }, { new: true });
    if (w) return id;
    await CertifiedAgent.deleteOne({ agentId: id, examAttempt: String(r._id), status: 'pending' });   // lost a race: keep the first number
    return (await ExamAttempt.findById(r._id).lean()).cert;
  }
  throw new Error('no_free_id');
}

function scoreOf(b) {
  const n = Math.min(50, Math.max(1, parseInt(b.n, 10) || N_QUESTIONS));
  const ok = Math.min(n, Math.max(0, parseInt(b.ok, 10) || 0));
  const pct = Math.round(ok / n * 100);
  return { ok, n, pct, passed: pct >= PASS_PCT };    // recomputed: never trust a "passed" sent alone
}

router.post('/exam/finish', async (req, res) => {
  try {
    if (tooMany(req, 300, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
    const b = req.body || {};
    if (!/^[0-9a-f]{24}$/i.test(String(b.attemptId || ''))) return res.status(404).json({ error: 'not_found' });
    const a = await ExamAttempt.findById(b.attemptId);
    if (!a) return res.status(404).json({ error: 'not_found' });
    if (a.status === 'finished') return res.json(Object.assign({ ok: true, already: true, passed: a.passed }, certOut(await settled(a._id))));
    const now = new Date(), secs = Math.round((now - a.startedAt) / 1000);
    const s = scoreOf(b);
    const late = secs * 1000 > limitMs();
    /* 10 Nov 2026: the certificate is issued HERE, only for a paid student who passed (nothing is taken from the phone).
       Jeffery: "Every student must receive a unique, permanent certificate ID, regardless of their name or exam date."
       -> a RANDOM number, checked against every badge and every exam, written once on the attempt, never recomputed. */
    const passed = late ? false : s.passed, ymd = haitiYmd(now);
    const r = await ExamAttempt.findOneAndUpdate({ _id: a._id, status: 'started' }, { $set: {
      status: 'finished', finishedAt: now, seconds: Math.min(secs, MINUTES * 60 + GRACE_SEC), timedOut: !!b.timedOut || late,
      ok: s.ok, n: s.n, pct: s.pct, passed, cert: '', ymd } }, { new: true });
    if (!r) return res.json(Object.assign({ ok: true, already: true }, certOut(await settled(a._id))));
    if (passed && r.paid) { r.cert = await issueCert(r); }
    res.json(Object.assign({ ok: true, passed: r.passed, late }, certOut(r)));
  } catch (e) { console.error('[EXAM] finish', e.message); res.status(500).json({ error: 'server' }); }
});

/* the venue had no internet: the phone sends the result when it can (once) */
router.post('/exam/offline', async (req, res) => {
  try {
    if (tooMany(req, 300, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
    const b = req.body || {};
    const ref = String(b.clientRef || '').replace(/[^\w-]/g, '').slice(0, 40);
    const name = String(b.name || '').trim().replace(/\s+/g, ' ').slice(0, 120), digits = digitsOf(b.phone);
    if (!ref || name.length < 3 || digits.length < 8) return res.status(400).json({ error: 'bad_request' });
    const had = await ExamAttempt.findOne({ clientRef: ref }).lean();
    if (had) return res.json({ ok: true, already: true });
    const st = new Date(b.startedAt), fi = new Date(b.finishedAt), now = new Date();
    const okDates = !isNaN(st) && !isNaN(fi) && fi >= st && fi <= new Date(now.getTime() + 300000) && now - st < 14 * 86400000;
    const s = scoreOf(b), secs = okDates ? Math.round((fi - st) / 1000) : null;
    const late = secs != null && secs * 1000 > limitMs();
    await ExamAttempt.create({ name, phone: String(b.phone || '').slice(0, 40), phoneDigits: digits, status: 'finished', mode: 'offline', clientRef: ref,
      startedAt: okDates ? st : now, finishedAt: okDates ? fi : now, seconds: secs, timedOut: !!b.timedOut || late,
      /* 10 Nov 2026: a result that never went through the server's start (no code check, no payment check) is
         recorded for Jennifer to see, but it never carries a certificate */
      ok: s.ok, n: s.n, pct: s.pct, passed: late ? false : s.passed, cert: '', paid: false,
      lang: String(b.lang || 'ht').slice(0, 5), ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    res.json({ ok: true });
  } catch (e) { console.error('[EXAM] offline', e.message); res.status(500).json({ error: 'server' }); }
});

/* the page was closed / reloaded / the phone lost signal at the end: a PAID student who passed gets the certificate back */
router.post('/exam/certificate', async (req, res) => {
  try {
    if (tooMany(req, 120, 3600 * 1000)) return res.status(429).json({ error: 'too_many' });
    const b = req.body || {};
    const digits = digitsOf(b.phone), nk = nameKey(b.name);
    if (digits.length < 8 || !nk) return res.status(400).json({ error: 'bad_request' });
    const rows = await ExamAttempt.find({ phoneDigits: digits, status: 'finished', passed: true, paid: true, cert: { $ne: '' } }).sort({ finishedAt: -1 }).limit(10).lean();
    const a = rows.find((x) => nameKey(x.name) === nk);
    if (!a) return res.status(404).json({ error: 'not_found' });
    res.set('Cache-Control', 'no-store');
    res.json(certOut(a));
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

/* ─── Jennifer's dashboard (console code) ─── */
async function listFor(req) {
  const q = String(req.query.q || '').trim().slice(0, 60);
  const f = {};
  if (q) { const d = q.replace(/\D/g, ''); f.$or = [{ name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }]; if (d.length >= 3) f.$or.push({ phoneDigits: new RegExp(d) }); }
  if (req.query.result === 'pass') f.passed = true;
  if (req.query.result === 'fail') f.passed = false;
  const now = Date.now();
  /* a started attempt older than the time limit is shown as abandoned */
  const rows = await ExamAttempt.find(f).sort({ startedAt: -1 }).limit(1000).select('-ua').lean();
  rows.forEach((r) => { if (r.status === 'started' && now - new Date(r.startedAt) > limitMs()) r.status = 'abandoned'; });
  /* 10 Nov 2026: PAID / NOT PAID (a seat for this phone today) and where the badge stands */
  const keys = [...new Set(rows.map((r) => phoneKey(r.phone)).filter((k) => k.length === 8))];
  const E = {}; for (const k of keys) { const e = await activeSeat(k); if (e && !e.refunded) E[k] = e; }
  const A = {}; (await CertifiedAgent.find({ agentId: { $in: rows.map((r) => r.cert).filter(Boolean) } }).select('agentId status expiresAt').lean()).forEach((x) => { A[x.agentId] = x; });
  rows.forEach((r) => {
    const e = E[phoneKey(r.phone)];
    r.paidNow = !!e; r.seat = e ? { source: e.source, ticketRef: e.ticketRef, name: e.name, by: e.by, note: e.note } : null;
    const g = r.cert ? A[r.cert] : null;
    r.badge = g ? ((g.status === 'active' && g.expiresAt && new Date(g.expiresAt) < new Date()) ? 'expired' : g.status) : (r.cert ? 'none' : '');
  });
  return rows;
}
router.get('/admin/exams', requirePin, async (req, res) => {
  try {
    const rows = await listFor(req);
    const stats = { total: rows.length, passed: rows.filter((r) => r.passed === true).length, failed: rows.filter((r) => r.passed === false).length,
      abandoned: rows.filter((r) => r.status === 'abandoned').length, offline: rows.filter((r) => r.mode === 'offline').length };
    res.set('Cache-Control', 'no-store'); res.json({ stats, rows });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
router.get('/admin/exams.csv', requirePin, async (req, res) => {
  try {
    const rows = await listFor(req);
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const BADGE = { pending: 'AN ATANT', active: 'AKTIF', suspended: 'SISPANN', revoked: 'ANILE', expired: 'EKSPIRE', none: 'PA ANREJISTRE' };
    const lines = ['Dat,Non,Telefon,Peman,Nòt,Pousantaj,Rezilta,Sètifika,Badj,Tan (minit),Estati,Mòd'].concat(rows.map((r) => [
      new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 16), r.name, r.phone, r.paidNow ? 'PEYE' : 'PA PEYE', r.ok != null ? r.ok + '/' + r.n : '', r.pct != null ? r.pct + '%' : '',
      r.passed === true ? 'PASE' : r.passed === false ? 'PA PASE' : '', r.cert || '', BADGE[r.badge] || '', r.seconds != null ? (r.seconds / 60).toFixed(1) : '', r.status, r.mode].map(esc).join(',')));
    res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="rezilta-egzamen-lajanmaker.csv"');
    res.send('﻿' + lines.join('\n'));
  } catch (e) { res.status(500).send('error'); }
});

/* ─── 10 Nov 2026: payments / seats / trainer code (console code) ─── */
function enrView(e) {
  return { id: String(e._id), phone: e.phone, phoneKey: e.phoneKey, name: e.name, status: e.status, source: e.source, ticketRef: e.ticketRef,
    eventTitle: e.eventTitle, buyerName: e.buyerName, buyerPhone: e.buyerPhone, ticketQty: e.ticketQty, paidAmount: e.paidAmount, note: e.note, by: e.by,
    createdAt: e.createdAt, releasedAt: e.releasedAt || null, history: (e.history || []).slice(-8), refunded: !!e.refunded,
    /* the buyer's name shares no word with the student's: worth a look (a gift or somebody else's payment) */
    nameDiffers: !!(e.source === 'ticket' && e.buyerName && e.name && !nameKey(e.buyerName).split(' ').some((w) => w.length > 2 && nameKey(e.name).split(' ').includes(w))) };
}
router.get('/admin/academy', requirePin, async (req, res) => {
  try {
    const st = await settings(), ids = await academyEventIds(st);
    const since = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
    const evs = await Event.find({ $or: [{ _id: { $in: ids.filter((x) => /^[0-9a-f]{24}$/i.test(x)) } }, { type: { $in: ['fòmasyon', 'fomasyon', 'Fòmasyon'] }, date: { $gte: since } }] })
      .select('title date startTime organizer type tickets status').sort({ date: -1 }).limit(100).lean();
    const txns = await Transaction.find({ event: { $in: ids }, status: { $in: ['completed', 'refunded'] }, ticketPrice: { $gt: 0 } }).sort({ paidAt: -1 }).limit(1000).lean();
    const used = {}; (await AcademyEnrollment.aggregate([{ $match: { status: 'active', ticketRef: { $ne: '' } } }, { $group: { _id: '$ticketRef', n: { $sum: 1 } } }])).forEach((x) => { used[x._id] = x.n; });
    const enr = await AcademyEnrollment.find({}).sort({ status: 1, updatedAt: -1 }).limit(1000).lean();
    const refunded = new Set(txns.filter((t) => t.status === 'refunded').map((t) => t.referenceId));
    enr.forEach((e) => { if (e.source === 'ticket' && refunded.has(e.ticketRef)) e.refunded = true; });
    res.set('Cache-Control', 'no-store');
    res.json({
      settings: { codeSet: !!(st && st.codeHash) || !!process.env.ACADEMY_TRAINER_CODE, codeSetAt: st && st.codeSetAt, codeSetBy: st && st.codeSetBy, eventIds: ids },
      events: evs.map((e) => ({ id: String(e._id), title: e.title, date: e.date, startTime: e.startTime, organizer: e.organizer, status: e.status,
        selected: ids.includes(String(e._id)), training: TRAINING_TYPE.test(String(e.type || '')),
        tickets: (e.tickets || []).map((t) => ({ name: t.name, price: t.price, sold: t.sold || 0 })) })),
      tickets: txns.map((t) => ({ ref: t.referenceId, status: t.status, buyerName: t.buyerName || '', buyerPhone: t.buyerPhone || '', qty: t.qty || 1,
        seatsUsed: used[t.referenceId] || 0, amount: t.paidAmount || t.totalAmount, paidAt: t.paidAt, event: String(t.event) })),
      enrollments: enr.map(enrView)
    });
  } catch (e) { console.error('[ACAD] admin', e.message); res.status(500).json({ error: 'server' }); }
});
router.post('/admin/academy/settings', requirePin, async (req, res) => {
  try {
    const b = req.body || {}, by = clip(b.by, 60);
    if (!by) return res.status(400).json({ error: 'name_required' });
    let st = await settings(); if (!st) st = new AcademySetting({ key: 'academy' });
    if (b.code !== undefined) {
      const c = String(b.code || '').trim().toUpperCase();
      if (!/^[A-Z0-9-]{4,20}$/.test(c)) return res.status(400).json({ error: 'bad_code_format' });
      if (c === 'LMA2026') return res.status(400).json({ error: 'code_was_public' });     // it sat in the page's source for weeks
      st.codeSalt = crypto.randomBytes(16).toString('hex'); st.codeHash = hashCode(c, st.codeSalt); st.codeSetAt = new Date(); st.codeSetBy = by;
    }
    if (Array.isArray(b.eventIds)) {
      const ids = [...new Set(b.eventIds.map(String).filter((x) => /^[0-9a-f]{24}$/i.test(x)))].slice(0, 50);
      if (!ids.length) return res.status(400).json({ error: 'one_event_required' });
      const n = await Event.countDocuments({ _id: { $in: ids } });
      if (n !== ids.length) return res.status(400).json({ error: 'event_not_found' });
      st.eventIds = ids;
    }
    st.updatedBy = by; await st.save();
    res.json({ ok: true, codeSet: !!st.codeHash, codeSetAt: st.codeSetAt, eventIds: await academyEventIds(st) });
  } catch (e) { console.error('[ACAD] settings', e.message); res.status(500).json({ error: 'server' }); }
});
/* Jennifer binds a seat: a seat of a paid ticket (group ticket, bought with another phone) or a payment made another way */
router.post('/admin/enrollments', requirePin, async (req, res) => {
  try {
    const b = req.body || {}, by = clip(b.by, 60), key = phoneKey(b.phone), name = clip(b.name, 120).replace(/\s+/g, ' ');
    if (!by) return res.status(400).json({ error: 'name_required' });
    if (key.length < 8) return res.status(400).json({ error: 'phone_required' });
    if (name.length < 3) return res.status(400).json({ error: 'student_name_required' });
    const had = await activeSeat(key);
    if (had && !had.refunded) return res.status(409).json({ error: 'already_enrolled', enrollment: enrView(had) });
    let txn = null;
    if (b.ticketRef) {
      txn = await Transaction.findOne({ referenceId: clip(b.ticketRef, 60).toUpperCase() }).lean() || await Transaction.findOne({ referenceId: clip(b.ticketRef, 60) }).lean();
      if (!txn) return res.status(404).json({ error: 'ticket_not_found' });
      if (txn.status !== 'completed' || !(txn.ticketPrice > 0)) return res.status(400).json({ error: 'ticket_not_paid' });
      if (!(await academyEventIds()).includes(String(txn.event))) return res.status(400).json({ error: 'ticket_not_training' });
      if ((await seatsUsed(txn.referenceId)) >= (txn.qty || 1)) return res.status(409).json({ error: 'no_seat_left' });
    } else if (clip(b.note, 300).length < 5) return res.status(400).json({ error: 'note_required' });   // how and when it was paid
    const e = await bindSeat(key, b.phone, name, txn, by, b.note);
    if (String(e.nameKey) !== nameKey(name)) return res.status(409).json({ error: 'already_enrolled', enrollment: enrView(e) });
    res.json({ enrollment: enrView(e) });
  } catch (e) { console.error('[ACAD] enrol', e.message); res.status(500).json({ error: 'server' }); }
});
router.patch('/admin/enrollments/:id', requirePin, async (req, res) => {
  try {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {}, by = clip(b.by, 60);
    if (!by) return res.status(400).json({ error: 'name_required' });
    const e = await AcademyEnrollment.findById(req.params.id);
    if (!e || e.status !== 'active') return res.status(404).json({ error: 'not_found' });
    if (typeof b.name === 'string') {
      const n = clip(b.name, 120).replace(/\s+/g, ' ');
      if (n.length < 3) return res.status(400).json({ error: 'student_name_required' });
      e.history.push({ action: 'name', note: (e.name || '—') + ' → ' + n, by }); e.name = n; e.nameKey = nameKey(n);
    }
    if (typeof b.phone === 'string') {
      const k = phoneKey(b.phone);
      if (k.length < 8) return res.status(400).json({ error: 'phone_required' });
      if (k !== e.phoneKey && await AcademyEnrollment.exists({ phoneKey: k, status: 'active' })) return res.status(409).json({ error: 'phone_has_seat' });
      e.history.push({ action: 'phone', note: (e.phone || e.phoneKey) + ' → ' + clip(b.phone, 40), by }); e.phoneKey = k; e.phone = clip(b.phone, 40);
    }
    if (e.history.length > 50) e.history = e.history.slice(-50);
    await e.save();
    res.json({ enrollment: enrView(e) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
router.post('/admin/enrollments/:id/release', requirePin, async (req, res) => {
  try {
    if (!/^[0-9a-f]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const b = req.body || {}, by = clip(b.by, 60), note = clip(b.note, 200);
    if (!by) return res.status(400).json({ error: 'name_required' });
    if (note.length < 3) return res.status(400).json({ error: 'note_required' });
    const e = await AcademyEnrollment.findOneAndUpdate({ _id: req.params.id, status: 'active' },
      { $set: { status: 'released', releasedAt: new Date() }, $push: { history: { action: 'released', note, by } } }, { new: true });
    if (!e) return res.status(404).json({ error: 'not_found' });
    res.json({ enrollment: enrView(e) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

/* the re-issue page (akademi/emet.html, console code): a student's certificate(s) by phone */
router.get('/admin/certificates', requirePin, async (req, res) => {
  try {
    const digits = digitsOf(req.query.phone);
    if (digits.length < 8) return res.status(400).json({ error: 'phone_required' });
    const rows = await ExamAttempt.find({ phoneDigits: digits, passed: true, paid: true, cert: { $ne: '' } }).sort({ finishedAt: -1 }).limit(10).lean();
    res.set('Cache-Control', 'no-store');
    res.json({ certificates: rows.map((a) => ({ cert: a.cert, name: a.name, ymd: a.ymd, phone: a.phone, pct: a.pct })) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});
router.get('/admin/ping', requirePin, (req, res) => res.json({ ok: true }));

/* for routes/agents.js: may this badge be approved? (a paid seat for the agent's phone) */
async function hasPaidSeat(phone) {
  const key = phoneKey(phone);
  if (key.length !== 8) return false;
  const e = await activeSeat(key);
  return !!(e && !e.refunded);
}

module.exports = router;
module.exports.hasPaidSeat = hasPaidSeat;
module.exports.nameKey = nameKey;
