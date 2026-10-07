/* ═══ ONE STUDENT, ONE COURSE, ONE PAYMENT ══════════════════════════════════
 *
 * Deliberately a near-twin of models/Transaction.js. The ticket flow learned
 * several things the hard way and every one of them applies here:
 *
 *   - phoneKey, because the same person's number gets typed four different
 *     ways over a few months and a lookup on the raw string finds none of them.
 *   - the stripe* fields, because the presence of stripeSessionId is what tells
 *     the reconciler which provider to ask.
 *   - paidAmount, because "paid" and "paid the right amount" are not the same
 *     claim.
 *
 * What is NEW here is the Classroom side: a paid registration is not yet a
 * student who can get in. Somebody has to invite their Google account. So the
 * two states are tracked separately and the student is told the truth about
 * which one they are in.
 * ═══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const registrationSchema = new mongoose.Schema({
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true, index: true },
  /* A copy of the title as it was when they registered. Renaming a course
     must not make last month's student list unreadable, and a deleted course
     must not turn a paid registration into an orphan with no name on it. */
  courseTitle: { type: String, default: '' },

  studentName: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, default: '' },
  /* Last eight digits - how a student finds their own courses again. */
  phoneKey: { type: String, index: true },
  /* 🔑 THE FIELD THE WHOLE MODULE TURNS ON.
     Jeffery: "Email address - important because Google Classroom uses Google
     accounts." Without this the admin has paid money in his account and no way
     to invite the person who sent it. Required, and the route checks it looks
     like an email before taking any money. */
  email: { type: String, required: true, trim: true, lowercase: true },

  referenceId: { type: String, required: true, unique: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'HTG' },
  paymentMethod: { type: String, enum: ['moncash', 'natcash', 'card', 'free'] },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },

  /* SolutionIP (wallets) */
  sipTransactionId: { type: String },
  /* Stripe (cards). Its presence is the provider switch. */
  stripeSessionId: { type: String, index: true },
  stripePaymentIntent: { type: String },
  paidAmount: { type: Number },
  paidCurrency: { type: String },

  paymentUrl: { type: String },
  paidAt: { type: Date },

  /* ─── CLASSROOM ACCESS ───────────────────────────────────────────────────
     none     paid, waiting for somebody to invite their Google account
     invited  the invitation has been sent; it is sitting in their Gmail
     active   they have accepted and are in the class

     Three states rather than a yes/no because "I invited you" and "you are in"
     are different facts, and a student staring at a screen that says they have
     access when the invitation is still unopened in their inbox will phone
     somebody. */
  classroomStatus: { type: String, enum: ['none', 'invited', 'active'], default: 'none' },
  invitedAt: { type: Date },
  invitedBy: { type: String, default: '' },
  accessGrantedAt: { type: Date },

  /* Set when a payment arrives for a course that is already full. The money
     is real and arrived, so the registration is honoured and flagged rather
     than refused - refusing it would take the money and give nothing. */
  overCapacity: { type: Boolean, default: false },

  adminNote: { type: String, default: '', maxlength: 500 }
}, { timestamps: true });

/* The admin student list, and the capacity count. */
registrationSchema.index({ course: 1, status: 1 });

module.exports = mongoose.model('CourseRegistration', registrationSchema);
