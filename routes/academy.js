/* ═══ LAJANMAKER ACADEMY: CERTIFICATION EXAM RECORDS (9 Nov 2026) ═══════════════
   POST /api/academy/exam/start    { name, phone, lang }  -> { attemptId, startedAt, minutes } | 409 wait
   POST /api/academy/exam/finish   { attemptId, ok, n, pct, passed, cert, timedOut }
   POST /api/academy/exam/offline  { clientRef, name, phone, startedAt, finishedAt, ok, n, pct, passed, cert }
   GET  /api/academy/admin/exams[.csv]   (console code) - Jennifer's dashboard

   Rules (the same the page shows): 20 minutes, 80% to pass, 24 hours before a
   retake - now for the student's phone NUMBER on any device. An attempt started
   and never finished counts once 20 minutes (+ grace) have gone by; a student
   whose connection dropped can come back to the SAME attempt (same clock) until
   then. */
const express = require('express');
const router = express.Router();
const ExamAttempt = require('../models/ExamAttempt');
const { requirePin } = require('../utils/consolePin');

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
    const now = new Date();
    /* same student, connection dropped: back to the SAME attempt, same clock */
    const open = await ExamAttempt.findOne({ phoneDigits: digits, status: 'started', startedAt: { $gte: new Date(now.getTime() - limitMs()) } }).sort({ startedAt: -1 });
    if (open) return res.json({ attemptId: open._id, startedAt: open.startedAt, minutes: MINUTES, resumed: true, now });
    const blk = await blocking(digits, now);
    if (blk) return res.status(409).json({ error: 'wait', hours: blk.hours, retryAt: blk.retryAt });
    const a = await ExamAttempt.create({ name, phone: String(b.phone || '').slice(0, 40), phoneDigits: digits, lang: String(b.lang || 'ht').slice(0, 5),
      startedAt: now, ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    res.json({ attemptId: a._id, startedAt: a.startedAt, minutes: MINUTES, now });
  } catch (e) { console.error('[EXAM] start', e.message); res.status(500).json({ error: 'server' }); }
});

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
    if (a.status === 'finished') return res.json({ ok: true, already: true, passed: a.passed });
    const now = new Date(), secs = Math.round((now - a.startedAt) / 1000);
    const s = scoreOf(b);
    const late = secs * 1000 > limitMs();
    const r = await ExamAttempt.findOneAndUpdate({ _id: a._id, status: 'started' }, { $set: {
      status: 'finished', finishedAt: now, seconds: Math.min(secs, MINUTES * 60 + GRACE_SEC), timedOut: !!b.timedOut || late,
      ok: s.ok, n: s.n, pct: s.pct, passed: late ? false : s.passed, cert: s.passed && !late ? String(b.cert || '').slice(0, 40) : '' } }, { new: true });
    if (!r) return res.json({ ok: true, already: true });
    res.json({ ok: true, passed: r.passed, late });
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
      ok: s.ok, n: s.n, pct: s.pct, passed: late ? false : s.passed, cert: s.passed && !late ? String(b.cert || '').slice(0, 40) : '',
      lang: String(b.lang || 'ht').slice(0, 5), ip: ip(req), ua: String(req.headers['user-agent'] || '').slice(0, 200) });
    res.json({ ok: true });
  } catch (e) { console.error('[EXAM] offline', e.message); res.status(500).json({ error: 'server' }); }
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
    const lines = ['Dat,Non,Telefon,Nòt,Pousantaj,Rezilta,Sètifika,Tan (minit),Estati,Mòd'].concat(rows.map((r) => [
      new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 16), r.name, r.phone, r.ok != null ? r.ok + '/' + r.n : '', r.pct != null ? r.pct + '%' : '',
      r.passed === true ? 'PASE' : r.passed === false ? 'PA PASE' : '', r.cert || '', r.seconds != null ? (r.seconds / 60).toFixed(1) : '', r.status, r.mode].map(esc).join(',')));
    res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="rezilta-egzamen-lajanmaker.csv"');
    res.send('﻿' + lines.join('\n'));
  } catch (e) { res.status(500).send('error'); }
});

module.exports = router;
