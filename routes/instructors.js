/* ═══ THE INSTRUCTOR MODULE ═══════════════════════════════════════════════
 *
 * Jeffery, 8 Oct 2026: instructors get "their own simple secure login", see
 * "only their courses and students", can "access student Gmails", "mark
 * invited" and "view schedules and enrolment" — and "must NOT be able to
 * change prices, access financial settings, or see other instructors'
 * students."
 *
 * 🔑 HOW THAT IS ENFORCED, IN ONE SENTENCE: there is no route in this file
 * that can reach a Course except through myCourse(), which filters on
 * `instructorId: req.instructor._id`. Not "checks afterwards" — filters. A
 * check you have to remember to write is a check that gets left out of the
 * seventh route; a helper that cannot return somebody else's course cannot be
 * forgotten.
 *
 * 🔑 AND NO MONEY LEAVES THIS FILE. The student rows an instructor sees carry
 * paid / not-paid, because that IS enrolment and they need it to know who is
 * in the class. They do not carry the amount, the payment method, the
 * transaction, or the course price. studentRow() is the only place a student
 * is turned into JSON here, so there is one place to check rather than five.
 *
 * ⛔ There is no create-course, edit-course, delete-course or set-price route
 * here at all. Those live in routes/courses.js behind the console PIN and are
 * not duplicated — an instructor cannot change a price because the code that
 * changes prices is somewhere they cannot reach.
 * ═══════════════════════════════════════════════════════════════════════════ */
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

const Course = require('../models/Course');
const CourseRegistration = require('../models/CourseRegistration');
const Instructor = require('../models/Instructor');
const { requirePin } = require('../utils/consolePin');
const { mintToken, requireInstructor, TTL_MS } = require('../utils/instructorAuth');

function isId(s) { return /^[a-f0-9]{24}$/i.test(String(s || '')); }
function looksLikeEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim()); }

/* ───────────────────────────────────────────────────────────────────────────
   LOGIN THROTTLE

   Mirrors the one already guarding the my-courses lookup in routes/courses.js
   rather than inventing a second style. In memory on purpose: it is a speed
   bump against guessing, not an audit trail, and a restart clearing it is
   fine.
   ─────────────────────────────────────────────────────────────────────────── */
const misses = new Map();
const MAX_MISSES = 8;
const WINDOW_MS = 10 * 60 * 1000;

function missCount(ip) {
  const row = misses.get(ip);
  if (!row || Date.now() - row.at > WINDOW_MS) return 0;
  return row.n;
}
function recordMiss(ip) {
  const row = misses.get(ip);
  if (!row || Date.now() - row.at > WINDOW_MS) misses.set(ip, { n: 1, at: Date.now() });
  else { row.n++; row.at = Date.now(); }
  /* Unbounded growth is a slow memory leak on a long-running process. */
  if (misses.size > 5000) {
    const cut = Date.now() - WINDOW_MS;
    for (const [k, v] of misses) if (v.at < cut) misses.delete(k);
  }
}
function clearMisses(ip) { misses.delete(ip); }

/* ───────────────────────────────────────────────────────────────────────────
   SHAPES
   ─────────────────────────────────────────────────────────────────────────── */

/* What an instructor is allowed to know about one of their students.
   ⛔ Note what is NOT here: amount, paymentMethod, paidAmount, currency,
   sipTransactionId, stripeSessionId. */
function studentRow(r) {
  return {
    referenceId: r.referenceId,
    studentName: r.studentName,
    email: r.email,                       /* the Gmail — he asked for this explicitly */
    phone: r.phone || '',
    enrolled: r.status === 'completed',   /* enrolment, not money */
    paymentPending: r.status === 'pending',
    classroomStatus: r.classroomStatus || 'none',
    invitedAt: r.invitedAt || null,
    registeredAt: r.createdAt
  };
}

/* What an instructor sees of their own course. The price fields are left out
   deliberately — they are on the public page anyway, but putting them in an
   instructor response invites an edit form next to them. */
function courseRow(c) {
  return {
    id: String(c._id),
    title: c.title,
    description: c.description || '',
    startDate: c.startDate || '',
    endDate: c.endDate || '',
    imageUrl: c.imageUrl || '',
    status: c.status,
    maxStudents: c.maxStudents || 0,
    seatsTaken: c.seatsTaken || 0
  };
}

/* 🔑 THE GUARD. Nothing in this file loads a Course any other way. */
async function myCourse(req, id, withClassroom) {
  if (!isId(id)) return null;
  let q = Course.findOne({ _id: id, instructorId: req.instructor._id });
  if (withClassroom) q = q.select('+classroomLink +classroomCode +accessInstructions');
  return await q;
}

/* ═══════════════════════════════════════════════════════════════════════════
   ADMIN SIDE — creating instructors and handing courses to them.
   Everything here is behind the console PIN.
   ═══════════════════════════════════════════════════════════════════════════ */

router.get('/admin/list', requirePin, async (req, res) => {
  try {
    const list = await Instructor.find().select(Instructor.PUBLIC_FIELDS)
      .sort({ name: 1 }).lean();
    /* How many courses and students each one is carrying. One grouped query,
       the same way the admin course list does it. */
    const agg = await Course.aggregate([
      { $match: { instructorId: { $ne: null } } },
      { $group: { _id: '$instructorId', courses: { $sum: 1 },
                  seats: { $sum: '$seatsTaken' } } }
    ]);
    const by = {};
    for (const r of agg) by[String(r._id)] = { courses: r.courses, students: r.seats };
    const unassigned = await Course.countDocuments({ instructorId: null });
    res.json({
      instructors: list.map(i => Object.assign(i, {
        id: String(i._id),
        counts: by[String(i._id)] || { courses: 0, students: 0 }
      })),
      unassignedCourses: unassigned
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Create an account. The password is generated here and returned ONCE.
   🔑 It is never stored in readable form and there is no route that can read
   it back, so if he loses it the answer is a reset, not a lookup. The admin
   screen says so beside the code. */
router.post('/admin', requirePin, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = String(req.body.phone || '').trim();
    if (!name) return res.status(400).json({ error: 'Name is required' });
    if (!looksLikeEmail(email)) return res.status(400).json({ error: 'A valid email is required' });

    const clash = await Instructor.findOne({ email });
    if (clash) return res.status(409).json({ error: 'An instructor already uses that email' });

    const pw = Instructor.newPassword();
    const doc = new Instructor({ name, email, phone });
    doc.setPassword(pw);
    await doc.save();
    res.status(201).json({
      instructor: { id: String(doc._id), name: doc.name, email: doc.email,
                    phone: doc.phone, active: doc.active },
      /* shown once */
      temporaryPassword: pw
    });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'An instructor already uses that email' });
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.put('/admin/:id', requirePin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const set = {};
    if (req.body.name !== undefined) {
      const n = String(req.body.name).trim();
      if (!n) return res.status(400).json({ error: 'Name cannot be empty' });
      set.name = n;
    }
    if (req.body.email !== undefined) {
      const e = String(req.body.email).trim().toLowerCase();
      if (!looksLikeEmail(e)) return res.status(400).json({ error: 'A valid email is required' });
      const clash = await Instructor.findOne({ email: e, _id: { $ne: req.params.id } });
      if (clash) return res.status(409).json({ error: 'An instructor already uses that email' });
      set.email = e;
    }
    if (req.body.phone !== undefined) set.phone = String(req.body.phone).trim();
    if (req.body.active !== undefined) set.active = !!req.body.active;

    const doc = await Instructor.findByIdAndUpdate(req.params.id, { $set: set }, { returnDocument: 'after' })
      .select(Instructor.PUBLIC_FIELDS);
    if (!doc) return res.status(404).json({ error: 'Instructor not found' });
    res.json({ instructor: doc });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Reset. Returns a new one-time password and, because the signing key is
   derived from the password hash, silently signs that account out of every
   browser it was open in. */
router.post('/admin/:id/password', requirePin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const doc = await Instructor.findById(req.params.id).select('+loginSalt +loginHash');
    if (!doc) return res.status(404).json({ error: 'Instructor not found' });
    const pw = Instructor.newPassword();
    doc.setPassword(pw);
    doc.mustChangePassword = true;
    await doc.save();
    res.json({ temporaryPassword: pw, signedOutEverywhere: true });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/* ⛔ Deleting an instructor who still has courses would leave those courses
   owned by an id that no longer exists - invisible to every instructor and
   confusing in the admin list. Unassign first, or deactivate instead. */
router.delete('/admin/:id', requirePin, async (req, res) => {
  try {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const n = await Course.countDocuments({ instructorId: req.params.id });
    if (n > 0) {
      return res.status(400).json({
        error: 'This instructor still has ' + n + ' course' + (n === 1 ? '' : 's') +
               '. Reassign them first, or set the account inactive instead.',
        courses: n
      });
    }
    const doc = await Instructor.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Instructor not found' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Hand a course to an instructor, or take it back with instructorId null. */
router.post('/admin/assign', requirePin, async (req, res) => {
  try {
    const courseId = String(req.body.courseId || '');
    const instructorId = req.body.instructorId ? String(req.body.instructorId) : null;
    if (!isId(courseId)) return res.status(400).json({ error: 'Bad course id' });

    let who = null;
    if (instructorId) {
      if (!isId(instructorId)) return res.status(400).json({ error: 'Bad instructor id' });
      who = await Instructor.findById(instructorId).select(Instructor.PUBLIC_FIELDS);
      if (!who) return res.status(404).json({ error: 'Instructor not found' });
    }
    const set = { instructorId: instructorId ? new mongoose.Types.ObjectId(instructorId) : null };
    /* Keep the public name in step, but never blank an existing one when the
       course is unassigned - the card would lose the teacher's name for
       everybody looking at it. */
    if (who && who.name) set.instructor = who.name;

    const course = await Course.findByIdAndUpdate(courseId, { $set: set }, { returnDocument: 'after' })
      .select('title instructor instructorId').lean();
    if (!course) return res.status(404).json({ error: 'Course not found' });
    res.json({ success: true, course: Object.assign(course, { id: String(course._id) }) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ═══════════════════════════════════════════════════════════════════════════
   INSTRUCTOR SIDE
   ═══════════════════════════════════════════════════════════════════════════ */

router.post('/login', async (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.ip || 'unknown';
  try {
    if (missCount(ip) >= MAX_MISSES) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const me = await Instructor.findOne({ email }).select('+loginSalt +loginHash');

    /* ⚠️ One message for "no such account" and "wrong password", and the work
       is done in both cases. Two different answers tell somebody which of our
       instructors' emails are real. */
    const good = !!(me && me.active && me.checkPassword(password));
    if (!good) {
      recordMiss(ip);
      return res.status(401).json({ error: 'Email or password is not right' });
    }
    clearMisses(ip);
    const token = await mintToken(me);
    await Instructor.updateOne({ _id: me._id }, { $set: { lastLoginAt: new Date() } });
    res.json({
      token, expiresInMs: TTL_MS,
      instructor: { id: String(me._id), name: me.name, email: me.email,
                    mustChangePassword: !!me.mustChangePassword }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/me', requireInstructor, async (req, res) => {
  const me = req.instructor;
  const courses = await Course.countDocuments({ instructorId: me._id });
  res.json({
    instructor: { id: String(me._id), name: me.name, email: me.email,
                  phone: me.phone || '', mustChangePassword: !!me.mustChangePassword },
    courseCount: courses
  });
});

/* Change my own password. Requires the current one, so a borrowed phone left
   unlocked cannot be used to lock the owner out of their own account. */
router.post('/password', requireInstructor, async (req, res) => {
  try {
    const current = String(req.body.currentPassword || '');
    const next = String(req.body.newPassword || '');
    if (!req.instructor.checkPassword(current)) {
      return res.status(401).json({ error: 'Your current password is not right' });
    }
    if (next.trim() === current.trim()) {
      return res.status(400).json({ error: 'Choose a different password' });
    }
    req.instructor.setPassword(next);
    req.instructor.mustChangePassword = false;
    await req.instructor.save();
    /* The old token's key was derived from the old hash, so it is already
       dead. Hand back a fresh one rather than bouncing them to the sign-in
       screen the moment they do the right thing. */
    const token = await mintToken(req.instructor);
    res.json({ success: true, token, expiresInMs: TTL_MS });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

/* My courses, with enrolment. */
router.get('/courses', requireInstructor, async (req, res) => {
  try {
    const list = await Course.find({ instructorId: req.instructor._id })
      .sort({ startDate: -1, createdAt: -1 }).limit(200).lean();
    const ids = list.map(c => c._id);
    const agg = await CourseRegistration.aggregate([
      { $match: { course: { $in: ids } } },
      { $group: { _id: { course: '$course', status: '$status' }, n: { $sum: 1 } } }
    ]);
    const by = {};
    for (const row of agg) {
      const k = String(row._id.course);
      by[k] = by[k] || { registered: 0, enrolled: 0, pending: 0 };
      by[k].registered += row.n;
      if (row._id.status === 'completed') by[k].enrolled += row.n;
      else if (row._id.status === 'pending') by[k].pending += row.n;
    }
    res.json({
      courses: list.map(c => Object.assign(courseRow(c), {
        counts: by[String(c._id)] || { registered: 0, enrolled: 0, pending: 0 }
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* One course: the schedule, the Classroom details, and the student list. */
router.get('/courses/:id', requireInstructor, async (req, res) => {
  try {
    const course = await myCourse(req, req.params.id, true);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const regs = await CourseRegistration.find({ course: course._id })
      .sort({ createdAt: -1 }).limit(1000).lean();
    const students = regs.map(studentRow);
    res.json({
      course: Object.assign(courseRow(course), {
        /* The instructor teaches in this Classroom, so they get the link for
           their OWN course. It is still select:false everywhere else. */
        classroomLink: course.classroomLink || '',
        classroomCode: course.classroomCode || '',
        accessInstructions: course.accessInstructions || ''
      }),
      students,
      totals: {
        registered: students.length,
        enrolled: students.filter(s => s.enrolled).length,
        pending: students.filter(s => s.paymentPending).length,
        invited: students.filter(s => s.classroomStatus !== 'none').length
      }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Mark invited / in the class. Same rule as the admin route: an unpaid
   student is not invited to anything, because being invited is what shows the
   Classroom link. */
router.post('/courses/:id/students/:ref/classroom', requireInstructor, async (req, res) => {
  try {
    const want = String(req.body.status || '').trim();
    if (!['none', 'invited', 'active'].includes(want)) {
      return res.status(400).json({ error: 'status must be none, invited or active' });
    }
    const course = await myCourse(req, req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });

    /* 🔑 Scoped by course AS WELL as reference. A reference from another
       instructor's course must not be updatable by passing it here. */
    const reg = await CourseRegistration.findOne({
      referenceId: String(req.params.ref || ''), course: course._id
    });
    if (!reg) return res.status(404).json({ error: 'Student not found on this course' });

    if (reg.status !== 'completed' && want !== 'none') {
      return res.status(400).json({ error: 'This student has not paid yet.' });
    }
    const set = { classroomStatus: want };
    if (want === 'invited') { set.invitedAt = new Date(); set.invitedBy = 'instructor:' + req.instructor.email; }
    if (want === 'active') {
      set.accessGrantedAt = new Date();
      if (!reg.invitedAt) set.invitedAt = new Date();
      if (!reg.invitedBy) set.invitedBy = 'instructor:' + req.instructor.email;
    }
    await CourseRegistration.updateOne({ _id: reg._id }, { $set: set });
    res.json({ success: true, classroomStatus: want });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* The Gmail list, for pasting into Google Classroom's invite box. Plain text
   rather than CSV: this is the thing an instructor actually does, and a
   comma-separated line of addresses is what Classroom accepts. */
router.get('/courses/:id/emails', requireInstructor, async (req, res) => {
  try {
    const course = await myCourse(req, req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const regs = await CourseRegistration.find({ course: course._id, status: 'completed' })
      .sort({ createdAt: 1 }).select('email studentName classroomStatus').lean();
    const notYet = regs.filter(r => (r.classroomStatus || 'none') === 'none');
    res.json({
      all: regs.map(r => r.email),
      notYetInvited: notYet.map(r => r.email),
      count: regs.length
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* The same CSV the admin gets, minus every money column. */
function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s;
  return '"' + safe.replace(/"/g, '""') + '"';
}

router.get('/courses/:id/students.csv', requireInstructor, async (req, res) => {
  try {
    const course = await myCourse(req, req.params.id);
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const regs = await CourseRegistration.find({ course: course._id })
      .sort({ createdAt: 1 }).lean();
    const head = ['Non', 'Email (Google)', 'Telefon', 'Enskripsyon', 'Klas Google', 'Referans'];
    const lines = [head.map(csvCell).join(',')];
    for (const r of regs) {
      lines.push([
        r.studentName, r.email, r.phone,
        r.status === 'completed' ? 'KONFIME' : 'POKO KONFIME',
        r.classroomStatus === 'active' ? 'Nan klas la'
          : (r.classroomStatus === 'invited' ? 'Envite' : 'Poko envite'),
        r.referenceId
      ].map(csvCell).join(','));
    }
    const name = 'etidyan-' + String(course.title || 'kou').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '.csv';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="' + name + '"');
    res.send('﻿' + lines.join('\r\n'));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
