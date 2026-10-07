/* ═══ AN ONLINE CLASS SOLD HERE AND TAUGHT IN GOOGLE CLASSROOM ══════════════
 *
 * Jeffery, 7 Oct 2026: "I do NOT want us to build our own LMS or recreate
 * Google Classroom. Google Classroom will remain where instructors post
 * lessons, documents, assignments, videos, etc. Our system only needs to
 * manage course registration + payment + access."
 *
 * So this model holds what is needed to SELL a seat and nothing about
 * teaching: no lessons, no assignments, no grades, no attendance.
 * ═══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const courseSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 140 },
  description: { type: String, default: '', maxlength: 4000 },
  instructor: { type: String, default: '', trim: true, maxlength: 120 },

  /* Dates as strings, the same way Event stores them. A course that runs
     "15 Oct to 30 Nov" is a human arrangement, not a timestamp, and every
     other date on this platform is already a 'YYYY-MM-DD' string. Mixing the
     two is how a date ends up a day out for everybody west of Greenwich. */
  startDate: { type: String, default: '' },
  endDate: { type: String, default: '' },

  imageUrl: { type: String, default: '' },

  price: { type: Number, default: 0, min: 0 },
  currency: { type: String, default: 'HTG' },
  /* Stored rather than inferred from price === 0.
     "Free" is a decision the admin makes, and a paid course whose price field
     is empty by mistake must read as broken, not as free. The route enforces
     the pair: free means price 0, paid means price above 0. */
  isFree: { type: Boolean, default: false },

  /* ⛔⛔ THE TWO FIELDS THAT MUST NEVER REACH AN UNPAID BROWSER.
   *
   * Jeffery: "IMPORTANT: Do not expose the Classroom invitation/link publicly
   * before payment."
   *
   * select:false is the guard, and it is here rather than in the routes on
   * purpose. Every find() in this codebase - the public list, the public
   * detail page, a lookup I write in six months, one somebody else writes -
   * leaves these two out unless it asks for them BY NAME. A rule I have to
   * remember to apply in each route is a rule that gets forgotten once; a
   * field that is simply not there cannot be leaked by forgetting anything.
   *
   * There are exactly two places that ask for them: the admin course editor
   * (behind the console code) and the registration lookup, and that one checks
   * status === 'completed' first. */
  classroomLink: { type: String, default: '', select: false },
  classroomCode: { type: String, default: '', select: false },
  /* What the student has to be told once they are in - "accept the invitation
     in your Gmail", a meeting time, whatever he wants to say. Also withheld
     until paid, for the same reason. */
  accessInstructions: { type: String, default: '', maxlength: 2000, select: false },

  /* 0 means no limit. Counted in seatsTaken below. */
  maxStudents: { type: Number, default: 0, min: 0 },
  /* Incremented atomically when a registration is claimed as paid, never by
     read-modify-write. Two students paying in the same second both used to be
     able to take the last seat. */
  seatsTaken: { type: Number, default: 0 },

  /* Which of the existing payment methods this course accepts. Defaults to all
     three because the usual answer is "all of them" and an admin creating a
     course should not have to think about it. */
  paymentMethods: {
    moncash: { type: Boolean, default: true },
    natcash: { type: Boolean, default: true },
    card: { type: Boolean, default: true }
  },

  status: { type: String, enum: ['draft', 'published', 'closed'], default: 'draft' }
}, { timestamps: true });

/* The public list is "published courses, newest start first". */
courseSchema.index({ status: 1, startDate: -1 });

/* What a course looks like to somebody who has not paid. Used by the public
   routes. The classroom fields are not even loaded, so there is nothing here
   to accidentally spread into a response. */
courseSchema.statics.PUBLIC_FIELDS =
  'title description instructor startDate endDate imageUrl price currency ' +
  'isFree maxStudents seatsTaken paymentMethods status createdAt';

module.exports = mongoose.model('Course', courseSchema);
