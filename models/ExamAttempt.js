/* ═══ LAJANMAKER ACADEMY: ONE CERTIFICATION EXAM ATTEMPT (9 Nov 2026) ═══════════
   Jeffery: finish the Offline Academy "including the exam system and Jennifer's
   dashboard". The 24-hour retake rule used to live in the browser of the phone
   that sat the exam (localStorage), so another phone or a cleared browser got
   round it. Now every attempt is recorded here, keyed on the STUDENT's phone
   number (digits), and the rule is checked here.
   The paper and the scoring stay in the page (the question bank is a public
   workshop file); what this adds is the record: who, when, how long, the score,
   passed or not, and the certificate number. */
const mongoose = require('mongoose');

const examAttemptSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, default: '', maxlength: 40 },
  phoneDigits: { type: String, required: true, index: true, maxlength: 20 },
  status: { type: String, enum: ['started', 'finished', 'abandoned'], default: 'started', index: true },
  startedAt: { type: Date, default: Date.now, index: true },
  finishedAt: Date,
  seconds: Number,                 // time taken (finished)
  timedOut: { type: Boolean, default: false },
  ok: Number, n: Number, pct: Number,
  passed: { type: Boolean, default: null },
  cert: { type: String, default: '' },
  lang: { type: String, default: 'ht', maxlength: 5 },
  /* 'online' = started on the server; 'offline' = the venue had no internet, the
     phone kept the result and sent it later (the 24 h rule could not be checked
     at the start for that one - it is flagged so Jennifer can see it). */
  mode: { type: String, enum: ['online', 'offline'], default: 'online' },
  clientRef: { type: String, default: '', maxlength: 40, index: true },   // offline results: sent twice = recorded once
  ip: { type: String, default: '', maxlength: 64 },
  ua: { type: String, default: '', maxlength: 200 }
}, { timestamps: true });

module.exports = mongoose.model('ExamAttempt', examAttemptSchema);
