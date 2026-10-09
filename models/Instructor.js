/* ═══ AN INSTRUCTOR WHO CAN SIGN IN ═══════════════════════════════════════
 *
 * Jeffery, 8 Oct 2026: "INSTRUCTOR MODULE lets proceed with the instructor
 * certification module… their own simple secure login, see only their courses
 * and students, access student Gmails, mark invited, view schedules and
 * enrolment. Instructors must NOT be able to change prices, access financial
 * settings, or see other instructors' students."
 *
 * So this is a login and nothing else. It carries no permissions field and no
 * role: an Instructor document IS the permission, and what it can reach is
 * decided by `Course.instructorId` matching its own _id. There is no "admin"
 * flag that could be set by accident.
 *
 * ⛔ No new dependency. The password is hashed the same way the event manage
 * code already is in this codebase - PBKDF2-SHA256 over a random per-record
 * salt, compared in constant time. Adding bcrypt for one model would mean a
 * native build on Render for no security gain over 150k rounds.
 * ═══════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const mongoose = require('mongoose');

const ROUNDS = 150000;
const MIN_LEN = 8;

/* The one-time password an admin hands over. Deliberately not generated from
   a dictionary: it is read off a screen once and then changed. I and O and 0
   and 1 are left out because this gets dictated over a phone in Haiti. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const instructorSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 120 },

  /* The login. Lower-cased and unique so "Jean@Gmail.com" and "jean@gmail.com"
     cannot become two accounts that each see half the courses. */
  email: {
    type: String, required: true, trim: true, lowercase: true,
    unique: true, index: true, maxlength: 160
  },
  phone: { type: String, default: '', trim: true, maxlength: 40 },

  /* ⛔⛔ select:false, like the Classroom link on Course. Every find() in this
     codebase leaves the credential out unless it asks for it BY NAME, so a
     route written in six months cannot leak a password hash by forgetting to
     project it away. Exactly one place asks: the login. */
  loginSalt: { type: String, select: false },
  loginHash: { type: String, select: false },

  /* Set when an admin creates or resets the account. The instructor's own
     screens nag until they have chosen their own password. */
  mustChangePassword: { type: Boolean, default: true },

  /* An instructor who has left keeps their courses and their history, but
     cannot sign in. Deleting the record would orphan every course they taught
     and every student list attached to it. */
  active: { type: Boolean, default: true },

  lastLoginAt: { type: Date },
  createdBy: { type: String, default: 'admin' }
}, { timestamps: true });

/* What an instructor record looks like anywhere outside the login. Note what
   is absent: both credential fields, and there is no financial field on this
   model at all. */
instructorSchema.statics.PUBLIC_FIELDS =
  'name email phone active mustChangePassword lastLoginAt createdAt';

instructorSchema.statics.newPassword = function (len) {
  const n = len || 10;
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
};

instructorSchema.statics.MIN_LEN = MIN_LEN;

/* ⚠️ A password is NOT normalised the way a PIN is. The console code strips
   punctuation and upper-cases because it is six characters typed on a phone;
   doing that to a password would silently throw away most of its strength and
   make "Pa$$word1" and "password1" the same secret. Only the outer whitespace
   a phone keyboard adds is removed. */
function norm(raw) {
  return String(raw === undefined || raw === null ? '' : raw).trim();
}

instructorSchema.methods.setPassword = function (raw) {
  const p = norm(raw);
  if (p.length < MIN_LEN) {
    const e = new Error('A password needs at least ' + MIN_LEN + ' characters');
    e.status = 400;
    throw e;
  }
  this.loginSalt = crypto.randomBytes(16).toString('hex');
  this.loginHash = crypto.pbkdf2Sync(p, this.loginSalt, ROUNDS, 32, 'sha256').toString('hex');
  return this;
};

instructorSchema.methods.checkPassword = function (raw) {
  if (!this.loginSalt || !this.loginHash) return false;
  const p = norm(raw);
  if (!p) return false;
  const got = crypto.pbkdf2Sync(p, this.loginSalt, ROUNDS, 32, 'sha256').toString('hex');
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(this.loginHash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = mongoose.model('Instructor', instructorSchema);
