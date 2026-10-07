/* ═══ PAID ONLINE CLASSES, TAUGHT IN GOOGLE CLASSROOM ═══════════════════════
 *
 * Jeffery, 7 Oct 2026:
 *   "HaitiBiznis = Registration + Payment + Access Control
 *    Google Classroom = Teaching + Lessons + Assignments"
 *   "Access must NEVER be granted just because the browser returns from the
 *    payment page."
 *   "DO NOT create a separate payment system for courses."
 *
 * So there is no new payment system in this file. MonCash and NatCash go to
 * the same SolutionIP endpoint the tickets use, through the same
 * utils/verifyPayment.js that decides what counts as a payment; cards go
 * through the same utils/stripe.js. The only thing written here is the
 * bookkeeping that is genuinely different: a seat, a Gmail address, and
 * whether somebody has been invited to the Classroom yet.
 *
 * 🔑 THE ONE RULE THIS FILE EXISTS TO ENFORCE. The Classroom link leaves this
 * server in exactly one circumstance: a registration whose status is
 * 'completed'. Not when the browser comes back from the payment page - the
 * browser is not a witness, it is a thing the buyer controls. The server asks
 * the gateway itself, and the gateway's answer is the only one that counts.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const Course = require('../models/Course');
const CourseRegistration = require('../models/CourseRegistration');

const { notifyAdmin } = require('../utils/notify');
const { paymentConfirmed } = require('../utils/verifyPayment');
const stripe = require('../utils/stripe');
const { phoneKey } = require('../utils/ticketDelivery');
const { requirePin } = require('../utils/consolePin');

const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const SITE = 'https://haitibiznis.com';

/* No service fee on a course. Tikè Lakay adds 7.5% because he said so in
   writing; he did not say it for classes, and inventing a charge that takes
   money off a student is not a default I get to pick. The student pays the
   price the admin typed.
   To turn it on later, this is the only line that changes - the maths below is
   already written as subtotal + fee. */
const COURSE_FEE_PCT = 0;

function genRef() {
  return 'KO-' + Date.now().toString(36).toUpperCase() +
         Math.random().toString(36).substring(2, 6).toUpperCase();
}

/* Good enough to catch the real mistakes - a phone number typed into the email
   box, a missing @, "gmail" with no dot - and not so clever that it rejects a
   valid address. The admin cannot invite somebody to Google Classroom without
   this, so a wrong one costs a student the course they paid for. */
function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());
}

function seatsLeft(course) {
  if (!course || !course.maxStudents) return null;     /* null = no limit */
  return Math.max(0, course.maxStudents - (course.seatsTaken || 0));
}

/* ═══ MARKING A REGISTRATION PAID, EXACTLY ONCE ═════════════════════════════
 *
 * Jeffery: "It must also be idempotent, so the same payment callback cannot
 * register or charge the student twice."
 *
 * This findOneAndUpdate is the whole of that guarantee. The filter includes
 * status:'pending', so if the gateway webhook, the confirmation page and the
 * background sweep all discover the same payment in the same second, the
 * database admits exactly one of them and the other two get null. Everything
 * that must happen once - the seat, the notification - hangs off the winner.
 * ═══════════════════════════════════════════════════════════════════════════ */
async function markRegPaid(reg) {
  const claimed = await CourseRegistration.findOneAndUpdate(
    { _id: reg._id, status: 'pending' },
    { $set: { status: 'completed', paidAt: new Date() } },
    { new: true }
  );
  if (!claimed) return null;

  /* Take the seat atomically. $inc rather than read-add-save: two students
     paying in the same second both used to be able to take the last one. */
  const course = await Course.findOneAndUpdate(
    { _id: claimed.course },
    { $inc: { seatsTaken: 1 } },
    { new: true }
  ).catch(() => null);

  /* A course that filled up while this student was on the payment screen.
     The money has arrived, so the registration stands - refusing it here
     would be taking payment and giving nothing. It is flagged instead, and
     shows up in red on the admin list so he can decide. */
  if (course && course.maxStudents && course.seatsTaken > course.maxStudents) {
    await CourseRegistration.updateOne({ _id: claimed._id },
      { $set: { overCapacity: true } }).catch(() => {});
    console.warn('[KOU] ' + claimed.referenceId + ' paid for a FULL course (' +
      course.seatsTaken + '/' + course.maxStudents + '). Honoured and flagged.');
  }

  /* He has to invite this person's Google account by hand in version 1, so
     being told a student has paid is not a nicety - it is the next step in the
     flow. Not awaited: a slow notification must not hold up the student's
     confirmation screen. */
  notifyAdmin('course', {
    name: claimed.studentName, phone: claimed.phone, email: claimed.email,
    course: claimed.courseTitle, amount: claimed.amount, ref: claimed.referenceId
  }).catch(() => {});

  return claimed;
}

/* ═══ ASK WHOEVER TOOK THE MONEY ════════════════════════════════════════════
 * The same shape as reconcile() in routes/payments.js, and for the same
 * reason: a student on a Haitian phone finishes paying inside the MonCash app
 * and never comes back to the browser at all. If confirmation depended on the
 * return trip, their money would be gone and their registration would say
 * pending for ever. That exact failure cost a real ticket buyer 20 HTG in
 * September.
 *
 * Fails closed in every direction. Gateway unreachable, unknown reply, Stripe
 * down - the registration is left exactly as it was and asked again later.
 * ═══════════════════════════════════════════════════════════════════════════ */
async function reconcileReg(reg) {
  if (!reg || reg.status !== 'pending') return reg;

  let confirmed = false;
  if (reg.stripeSessionId) {
    const out = await stripe.confirmCheckout(reg.stripeSessionId, reg.amount, reg.currency || 'HTG');
    if (!out.ok) {
      console.error('[KOU] could not ask Stripe about ' + reg.referenceId +
        ' - leaving it pending. ' + out.error);
      return reg;
    }
    /* ⛔ PAID AT STRIPE IS NOT ENOUGH. A session completed for a different
       figure than the one we asked for is not this course being paid for. */
    if (out.stripe_paid && !out.amount_matches) {
      console.error('[KOU] ' + reg.referenceId + ' was paid at Stripe for ' +
        out.amount_total + ' ' + out.currency + ' but we asked for ' +
        reg.amount + ' ' + (reg.currency || 'HTG') + '. NOT marking it paid.');
      return reg;
    }
    confirmed = out.paid;
    if (confirmed) {
      await CourseRegistration.updateOne({ _id: reg._id }, { $set: {
        stripePaymentIntent: out.payment_intent || null,
        paidAmount: out.amount_total, paidCurrency: out.currency } }).catch(() => {});
    }
  } else {
    confirmed = (await paymentConfirmed(reg.referenceId, 'course reconcile')).confirmed;
  }

  if (!confirmed) return reg;
  const paid = await markRegPaid(reg);
  if (paid) {
    console.log('[KOU] ' + reg.referenceId + ' was paid at the gateway but still ' +
      'said pending here. Marked paid.');
  }
  return paid || (await CourseRegistration.findById(reg._id));
}

/* What a student is told about their own registration. The Classroom details
   are attached by the ONE caller allowed to, after checking status. */
function regPayload(reg) {
  return {
    referenceId: reg.referenceId,
    status: reg.status,
    courseTitle: reg.courseTitle,
    studentName: reg.studentName,
    email: reg.email,
    amount: reg.amount,
    currency: reg.currency || 'HTG',
    paymentMethod: reg.paymentMethod,
    paidAt: reg.paidAt || null,
    classroomStatus: reg.classroomStatus,
    invitedAt: reg.invitedAt || null,
    createdAt: reg.createdAt
  };
}

/* ───────────────────────────────────────────────────────────────────────────
   ADMIN. Mounted first, because `/:id` further down would otherwise swallow
   `/admin/...` as a course id.
   Every one of these takes the console code. Course creation sets the price
   and holds the Classroom link, so it is not an open form.
   ─────────────────────────────────────────────────────────────────────────── */

/* Accept only the fields a course is made of. Spreading req.body straight into
   the model would let anyone behind the console code set seatsTaken, which is
   the capacity counter, by typo. */
function courseFieldsFrom(body) {
  const out = {};
  const str = ['title', 'description', 'instructor', 'startDate', 'endDate',
               'imageUrl', 'classroomLink', 'classroomCode', 'accessInstructions'];
  for (const k of str) if (body[k] !== undefined) out[k] = String(body[k] || '').trim();
  if (body.price !== undefined) out.price = Math.max(0, Math.round(Number(body.price) || 0));
  if (body.maxStudents !== undefined) out.maxStudents = Math.max(0, parseInt(body.maxStudents) || 0);
  if (body.isFree !== undefined) out.isFree = !!body.isFree;
  if (body.status !== undefined && ['draft', 'published', 'closed'].includes(body.status)) {
    out.status = body.status;
  }
  if (body.paymentMethods && typeof body.paymentMethods === 'object') {
    out.paymentMethods = {
      moncash: !!body.paymentMethods.moncash,
      natcash: !!body.paymentMethods.natcash,
      card: !!body.paymentMethods.card
    };
  }
  return out;
}

/* Free and Paid are a pair, and a mismatch between them is the kind of thing
   that charges somebody 0 HTG or hands out a 5,000 HTG course for nothing.
   Settled here, once, rather than hoped for in the form. */
function priceProblem(fields, existing) {
  const isFree = fields.isFree !== undefined ? fields.isFree
                 : (existing ? existing.isFree : false);
  const price = fields.price !== undefined ? fields.price
                : (existing ? existing.price : 0);
  if (isFree && price > 0) return 'A free course cannot have a price. Set the price to 0 or untick Free.';
  if (!isFree && price <= 0) return 'A paid course needs a price above 0.';
  return null;
}

router.get('/admin/list', requirePin, async (req, res) => {
  try {
    const courses = await Course.find().sort({ createdAt: -1 }).lean();
    /* One grouped count instead of a query per course. */
    const ids = courses.map(c => c._id);
    const agg = await CourseRegistration.aggregate([
      { $match: { course: { $in: ids } } },
      { $group: {
          _id: { course: '$course', status: '$status' },
          n: { $sum: 1 }, money: { $sum: '$amount' } } }
    ]);
    const by = {};
    for (const row of agg) {
      const k = String(row._id.course);
      by[k] = by[k] || { registered: 0, paid: 0, unpaid: 0, collected: 0 };
      by[k].registered += row.n;
      if (row._id.status === 'completed') { by[k].paid += row.n; by[k].collected += row.money; }
      else if (row._id.status === 'pending') by[k].unpaid += row.n;
    }
    res.json({ courses: courses.map(c => Object.assign(c,
      { counts: by[String(c._id)] || { registered: 0, paid: 0, unpaid: 0, collected: 0 } })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/admin', requirePin, async (req, res) => {
  try {
    const fields = courseFieldsFrom(req.body);
    if (!fields.title) return res.status(400).json({ error: 'A course needs a name.' });
    const bad = priceProblem(fields, null);
    if (bad) return res.status(400).json({ error: bad });
    if (fields.isFree) fields.price = 0;
    const course = await Course.create(fields);
    res.json({ success: true, id: course._id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/admin/:id', requirePin, async (req, res) => {
  try {
    const existing = await Course.findById(req.params.id).select('+classroomLink +classroomCode');
    if (!existing) return res.status(404).json({ error: 'Course not found' });
    const fields = courseFieldsFrom(req.body);
    const bad = priceProblem(fields, existing);
    if (bad) return res.status(400).json({ error: bad });
    if (fields.isFree) fields.price = 0;

    /* 🚨 Changing the price of a course people have already paid for would
       make the reconciler compare a Stripe session against a figure that was
       never charged, and every one of those registrations would stop
       confirming. The amount paid is recorded on the registration, so the
       money is not lost - but the course cannot be re-priced underneath it. */
    if (fields.price !== undefined && fields.price !== existing.price) {
      const paid = await CourseRegistration.countDocuments({
        course: existing._id, status: { $in: ['pending', 'completed'] } });
      if (paid > 0) {
        return res.status(400).json({ error: 'There are already ' + paid +
          ' registrations on this course, so the price cannot be changed. ' +
          'Close it and create the next session as a new course.' });
      }
    }

    Object.assign(existing, fields);
    await existing.save();
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Deleting a course that people paid for would delete the only record of
   their money, so it is refused. Closing it is what he actually wants - it
   comes off the public list and keeps its student list. */
router.delete('/admin/:id', requirePin, async (req, res) => {
  try {
    const n = await CourseRegistration.countDocuments({
      course: req.params.id, status: 'completed' });
    if (n > 0) {
      return res.status(400).json({ error: n + ' student(s) have paid for this course. ' +
        'It cannot be deleted. Set it to Closed instead.' });
    }
    await CourseRegistration.deleteMany({ course: req.params.id, status: { $ne: 'completed' } });
    await Course.deleteOne({ _id: req.params.id });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* The only route that hands the Classroom link to anybody who has not paid,
   and it is behind the console code because it is the edit form. */
router.get('/admin/:id/classroom', requirePin, async (req, res) => {
  try {
    const c = await Course.findById(req.params.id)
      .select('+classroomLink +classroomCode +accessInstructions').lean();
    if (!c) return res.status(404).json({ error: 'Course not found' });
    res.json({ classroomLink: c.classroomLink || '', classroomCode: c.classroomCode || '',
               accessInstructions: c.accessInstructions || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/admin/:id/students', requirePin, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).select(Course.PUBLIC_FIELDS).lean();
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const regs = await CourseRegistration.find({ course: req.params.id })
      .sort({ createdAt: -1 }).limit(1000);

    /* Ask about anything still unpaid while the list is being drawn. The admin
       opening this page is the most likely moment for a lost payment to be
       noticed, so it is a good moment to go and check. */
    const out = [];
    let paid = 0, unpaid = 0, collected = 0;
    for (const r of regs) {
      const cur = (await reconcileReg(r)) || r;
      if (cur.status === 'completed') { paid++; collected += cur.amount || 0; }
      else if (cur.status === 'pending') unpaid++;
      out.push({
        referenceId: cur.referenceId, studentName: cur.studentName,
        phone: cur.phone, email: cur.email, amount: cur.amount,
        status: cur.status, paymentMethod: cur.paymentMethod,
        paidAt: cur.paidAt || null, classroomStatus: cur.classroomStatus,
        invitedAt: cur.invitedAt || null, overCapacity: !!cur.overCapacity,
        createdAt: cur.createdAt
      });
    }
    res.json({ course, students: out,
               totals: { registered: out.length, paid, unpaid, collected } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* "Export student list". A CSV, because that is what opens on a phone and in
   Excel without anybody installing anything. */
function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  /* A leading =, +, - or @ is executed as a formula by Excel. A student called
     "=cmd|..." is unlikely; a student whose name starts with a dash is not. */
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}

router.get('/admin/:id/students.csv', requirePin, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).select('title').lean();
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const regs = await CourseRegistration.find({ course: req.params.id })
      .sort({ createdAt: 1 }).lean();
    const head = ['Non', 'Telefon', 'Email (Google)', 'Montan', 'Peman',
                  'Metòd', 'Dat peman', 'Klas Google', 'Referans'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of regs) {
      lines.push([
        r.studentName, r.phone, r.email, r.amount,
        r.status === 'completed' ? 'PEYE' : (r.status === 'pending' ? 'PA PEYE' : r.status),
        r.paymentMethod || '', r.paidAt ? new Date(r.paidAt).toISOString().slice(0, 16).replace('T', ' ') : '',
        r.classroomStatus === 'active' ? 'Nan klas la'
          : (r.classroomStatus === 'invited' ? 'Envite' : 'Poko envite'),
        r.referenceId
      ].map(csvCell).join(','));
    }
    const name = 'etidyan-' + String(course.title || 'kou').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    /* A BOM, or Excel shows Kreyòl accents as mojibake. */
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* "Mark Invited / Access Granted". */
router.post('/admin/registration/:ref/classroom', requirePin, async (req, res) => {
  try {
    const want = String(req.body.status || '').trim();
    if (!['none', 'invited', 'active'].includes(want)) {
      return res.status(400).json({ error: 'status must be none, invited or active' });
    }
    const reg = await CourseRegistration.findOne({ referenceId: req.params.ref });
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    /* ⛔ An unpaid student is not invited to anything. Marking one invited
       would show them the Classroom link, which is the one thing that must not
       happen without money. */
    if (reg.status !== 'completed' && want !== 'none') {
      return res.status(400).json({ error: 'This student has not paid yet.', status: reg.status });
    }
    const set = { classroomStatus: want };
    if (want === 'invited') { set.invitedAt = new Date(); set.invitedBy = 'admin'; }
    if (want === 'active') {
      set.accessGrantedAt = new Date();
      if (!reg.invitedAt) set.invitedAt = new Date();
    }
    await CourseRegistration.updateOne({ _id: reg._id }, { $set: set });
    res.json({ success: true, classroomStatus: want });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ───────────────────────────────────────────────────────────────────────────
   PUBLIC
   ─────────────────────────────────────────────────────────────────────────── */

router.get('/', async (req, res) => {
  try {
    const courses = await Course.find({ status: 'published' })
      .select(Course.PUBLIC_FIELDS).sort({ startDate: 1, createdAt: -1 }).limit(100).lean();
    res.json({ count: courses.length, courses: courses.map(c =>
      Object.assign(c, { seatsLeft: seatsLeft(c) })) });
  } catch (err) { res.status(500).json({ error: err.message, courses: [] }); }
});

/* ═══ REGISTER AND PAY ══════════════════════════════════════════════════════ */
router.post('/register', async (req, res) => {
  try {
    const { courseId, studentName, phone, email, paymentMethod } = req.body;
    if (!courseId || !studentName || !phone || !email) {
      return res.status(400).json({ error: 'Non, telefòn ak imèl obligatwa.' });
    }
    if (!looksLikeEmail(email)) {
      /* Said in Kreyòl and in plain terms, because this is the field people
         get wrong and the consequence - no Classroom invitation - is invisible
         to them at the moment they make the mistake. */
      return res.status(400).json({
        error: 'Imèl la pa bon. Nou bezwen yon adrès Gmail (egzanp: non@gmail.com) ' +
               'paske Google Classroom travay ak kont Google.' });
    }

    const course = await Course.findById(courseId).select(Course.PUBLIC_FIELDS);
    if (!course) return res.status(404).json({ error: 'Kou sa a pa egziste.' });
    if (course.status !== 'published') {
      return res.status(400).json({ error: 'Enskripsyon fèmen pou kou sa a.' });
    }

    const left = seatsLeft(course);
    if (left === 0) return res.status(400).json({ error: 'Kou sa a konplè.' });

    const key = phoneKey(phone);

    /* Already paid for this course. Hand back the registration they already
       have rather than creating a second one and charging them again - this is
       somebody tapping the button twice, or coming back next week having
       forgotten. */
    const already = await CourseRegistration.findOne({
      course: course._id, phoneKey: key, status: 'completed' });
    if (already) {
      return res.json({ success: true, alreadyRegistered: true,
        referenceId: already.referenceId, status: 'completed' });
    }

    const subtotal = Math.round(Number(course.price) || 0);
    const fee = Math.round(subtotal * COURSE_FEE_PCT);
    const total = subtotal + fee;

    /* ─── FREE COURSE ─────────────────────────────────────────────────────
       Born completed. There is no payment to confirm, so it never passes
       through reconcileReg - which means the seat and the notification have to
       be taken here, through the same markRegPaid, or a free class would be
       the one case where nobody is told a student signed up. */
    if (course.isFree || total <= 0) {
      const ref = genRef();
      const reg = await CourseRegistration.create({
        course: course._id, courseTitle: course.title,
        studentName: String(studentName).trim(), phone: String(phone).trim(),
        phoneKey: key, email: String(email).trim().toLowerCase(),
        referenceId: ref, amount: 0, currency: course.currency || 'HTG',
        paymentMethod: 'free', status: 'pending'
      });
      await markRegPaid(reg);
      return res.json({ success: true, free: true, referenceId: ref, status: 'completed' });
    }

    const method = String(paymentMethod || '').toLowerCase();
    if (!['moncash', 'natcash', 'card'].includes(method)) {
      return res.status(400).json({ error: 'Chwazi yon metòd peman.' });
    }
    if (course.paymentMethods && course.paymentMethods[method] === false) {
      return res.status(400).json({ error: 'Metòd peman sa a pa disponib pou kou sa a.' });
    }

    const ref = genRef();
    const reg = await CourseRegistration.create({
      course: course._id, courseTitle: course.title,
      studentName: String(studentName).trim(), phone: String(phone).trim(),
      phoneKey: key, email: String(email).trim().toLowerCase(),
      referenceId: ref, amount: total, currency: course.currency || 'HTG',
      paymentMethod: method, status: 'pending'
    });

    const returnUrl = SITE + '/kou-konfime.html?ref=' + ref;

    /* ─── CARD → STRIPE ──────────────────────────────────────────────────
       The same service the tickets use. Nothing new, and in particular no
       second idea about what "paid" means. */
    if (method === 'card') {
      if (!stripe.configured()) {
        await CourseRegistration.deleteOne({ _id: reg._id }).catch(() => {});
        return res.status(503).json({ error: 'Kat kredi pa disponib pou kounye a.' });
      }
      const sess = await stripe.createCheckout({
        amount: total, currency: course.currency || 'HTG',
        label: course.title, reference: ref,
        successUrl: returnUrl,
        cancelUrl: SITE + '/kou.html',
        email: reg.email,
        metadata: { course: String(course._id), kind: 'course' }
      });
      if (!sess.ok) {
        console.error('[KOU] Stripe checkout failed for ' + ref + ': ' + sess.error);
        await CourseRegistration.deleteOne({ _id: reg._id }).catch(() => {});
        return res.status(502).json({ error: 'Nou pa ka louvri paj peman an. Eseye ankò.' });
      }
      reg.stripeSessionId = sess.id;
      reg.paymentUrl = sess.url;
      await reg.save();
      return res.json({ success: true, referenceId: ref, paymentUrl: sess.url,
                        amount: total, provider: 'stripe' });
    }

    /* ─── WALLET → SOLUTIONIP ────────────────────────────────────────────── */
    let sipData = null;
    try {
      const sipRes = await fetch(SIP_URL + '/api/paiement-marchand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: SIP_CLIENT, refference_id: ref, montant: total,
          payment_method: method, return_url: returnUrl
        })
      });
      sipData = await sipRes.json();
    } catch (e) {
      console.error('[KOU] gateway unreachable for ' + ref + ': ' + e.message);
    }

    if (sipData && sipData.status && sipData.url) {
      reg.sipTransactionId = sipData.transaction_id || '';
      reg.paymentUrl = sipData.url;
      await reg.save();
      return res.json({ success: true, referenceId: ref, paymentUrl: sipData.url,
                        amount: total, provider: method });
    }

    reg.status = 'failed';
    await reg.save();
    res.status(502).json({ error: 'Peman an pa ka kòmanse. Eseye ankò.' });
  } catch (err) {
    console.error('[KOU] register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* ═══ THE CONFIRMATION SCREEN ═══════════════════════════════════════════════
 * Where "✅ PEMAN KONFIME / KOU OU A PARE" comes from, and the ONE place the
 * Classroom link is handed out. The check below is the whole access control in
 * this module:
 *
 *     if (reg.status === 'completed')   -> attach the Classroom details
 *     otherwise                         -> do not
 *
 * reconcileReg() runs first, so a student who never came back from MonCash
 * gets confirmed by the act of opening this page. But the confirmation comes
 * from the gateway, not from the fact that the page was opened.
 * ═══════════════════════════════════════════════════════════════════════════ */
router.get('/registration/:ref', async (req, res) => {
  try {
    let reg = await CourseRegistration.findOne({ referenceId: req.params.ref });
    if (!reg) return res.status(404).json({ error: 'Enskripsyon pa twouve' });
    reg = (await reconcileReg(reg)) || reg;

    const out = regPayload(reg);
    const course = await Course.findById(reg.course).select(Course.PUBLIC_FIELDS).lean();
    out.course = course || null;

    if (reg.status === 'completed') {
      /* Loaded only now, and only because this registration is paid. */
      const secret = await Course.findById(reg.course)
        .select('+classroomLink +classroomCode +accessInstructions').lean();
      out.classroom = {
        link: (secret && secret.classroomLink) || '',
        code: (secret && secret.classroomCode) || '',
        instructions: (secret && secret.accessInstructions) || ''
      };
    }
    res.json(out);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══ KOU MWEN YO ═══════════════════════════════════════════════════════════
 * Found by phone number, exactly like my-tickets, and with the same honest
 * caveat: this is not authentication. Anybody who types a number that
 * registered sees what that number registered for. The alternative is an
 * account system for students who mostly have no email they can receive at,
 * and the thing being revealed is a Classroom invitation that still has to be
 * accepted inside somebody's own Gmail.
 *
 * Only EMPTY lookups count against the rate limit - thirty students on one
 * training-centre wifi all looking up their own course come from one address,
 * and rate limiting them would be a control that protects nothing and creates
 * a queue. Somebody walking the list is guessing, and a guess returns nothing.
 * ═══════════════════════════════════════════════════════════════════════════ */
const lookupMisses = new Map();
const LOOKUP_MAX = 12;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

function missCount(ip) {
  const now = Date.now();
  const hits = (lookupMisses.get(ip) || []).filter(t => now - t < LOOKUP_WINDOW_MS);
  lookupMisses.set(ip, hits);
  return hits.length;
}
function recordMiss(ip) {
  const now = Date.now();
  const hits = (lookupMisses.get(ip) || []).filter(t => now - t < LOOKUP_WINDOW_MS);
  hits.push(now);
  lookupMisses.set(ip, hits);
  if (lookupMisses.size > 5000) {
    for (const [k, v] of lookupMisses) {
      if (!v.length || now - v[v.length - 1] > LOOKUP_WINDOW_MS) lookupMisses.delete(k);
    }
  }
}

router.get('/my-courses', async (req, res) => {
  try {
    const key = phoneKey(req.query.phone);
    if (!key || key.length < 8) {
      return res.status(400).json({ error: 'Mete nimewo telefòn ou an konplè.', courses: [] });
    }
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    if (missCount(ip) >= LOOKUP_MAX) {
      return res.status(429).json({ error: 'Twòp rechèch. Eseye ankò nan kèk minit.', courses: [] });
    }

    const raw = String(req.query.phone || '').trim();
    const found = await CourseRegistration.find({
      $or: [{ phoneKey: key }, { phone: raw }, { phone: key }]
    }).sort({ createdAt: -1 }).limit(40);

    const out = [];
    for (const r of found) {
      const cur = (await reconcileReg(r)) || r;
      const row = regPayload(cur);
      const course = await Course.findById(cur.course).select(Course.PUBLIC_FIELDS).lean();
      row.course = course || null;
      if (cur.status === 'completed') {
        const secret = await Course.findById(cur.course)
          .select('+classroomLink +classroomCode +accessInstructions').lean();
        row.classroom = {
          link: (secret && secret.classroomLink) || '',
          code: (secret && secret.classroomCode) || '',
          instructions: (secret && secret.accessInstructions) || ''
        };
      }
      out.push(row);
    }
    if (!out.length) recordMiss(ip);
    res.json({ count: out.length, courses: out });
  } catch (err) { res.status(500).json({ error: err.message, courses: [] }); }
});

/* The gateway's nudge. Like the ticket webhook, the body is not believed: it
   only says which reference to go and ask about. Anybody can POST here; all
   they can achieve is making the server check with the gateway, which is what
   it does on a timer anyway. */
router.post('/webhook', async (req, res) => {
  try {
    const ref = req.body.reference_id || req.body.refference_id || req.body.orderId;
    if (!ref) return res.status(400).json({ error: 'Missing reference' });
    const reg = await CourseRegistration.findOne({ referenceId: ref });
    if (!reg) return res.status(404).json({ error: 'Registration not found' });
    if (reg.status === 'completed') return res.json({ received: true, alreadyPaid: true });
    const after = await reconcileReg(reg);
    res.json({ received: true, paid: !!(after && after.status === 'completed') });
  } catch (err) {
    console.error('[KOU] webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/* LAST, because `/:id` matches anything. */
router.get('/:id', async (req, res) => {
  try {
    const c = await Course.findById(req.params.id).select(Course.PUBLIC_FIELDS).lean();
    if (!c) return res.status(404).json({ error: 'Kou sa a pa egziste.' });
    if (c.status !== 'published') return res.status(404).json({ error: 'Kou sa a pa disponib.' });
    res.json(Object.assign(c, { seatsLeft: seatsLeft(c) }));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
/* Exported for the background payment sweep, so there is one definition of
   "this registration is paid" and one atomic claim behind it. */
module.exports.reconcileReg = reconcileReg;
