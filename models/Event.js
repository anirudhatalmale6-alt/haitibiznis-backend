const mongoose = require('mongoose');

const ticketSchema = new mongoose.Schema({
  name: { type: String, required: true },
  price: { type: Number, default: 0 },
  qty: { type: Number, default: 100 },
  sold: { type: Number, default: 0 },
  saleStart: String,
  saleEnd: String,
  desc: String
}, { _id: true });

/* Who is coming to a free event.
 *
 * The Academy director's third point: a free workshop should not drag people through a
 * ticket purchase to say they will be there. Two buttons, yes or no. A "no" is
 * kept rather than thrown away - for a training course, knowing that thirty
 * people were asked and eight declined is the difference between planning for
 * eight and printing thirty handouts.
 *
 * Keyed on phone: the same person tapping Yes then No then Yes again is one
 * attendee who changed their mind, not three rows. */
const rsvpSchema = new mongoose.Schema({
  name: { type: String, default: '' },
  phone: { type: String, default: '' },
  phoneKey: { type: String, default: '' },
  response: { type: String, enum: ['yes', 'no'], required: true },
  guests: { type: Number, default: 1 },
  /* 🚨 25 Sep, Jeffery: "When an attendee RSVP +1 or 2 they should the option
     to put the name of the extra people."
     Jennifer's workshop is how this came up - 22 answers, 26 people. A number
     tells the organiser how many chairs; it does not tell the person on the
     door who is allowed through. Optional on purpose: nobody is blocked from
     saying yes because they have not asked a friend's surname yet. */
  guestNames: { type: [String], default: [] },
  checkedInAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, { _id: true });

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, default: 'lòt' },
  typeLabel: String,
  typeEmoji: String,

  /* An event type the organiser typed themselves.
   *
   * The dropdown offers twenty-nine types, all written in Kreyol, and
   * typeLabel used to be frozen from that list at the moment the event was
   * created. So an organiser working in French picked from a Kreyol list and
   * published an event whose type stayed Kreyol on a French page - which is
   * what the Academy director reported.
   *
   * Two halves to the fix and this is the second one: when the organiser
   * writes their own type it is stored here and shown EXACTLY as typed, in
   * whatever language they wrote it, and never translated. The first half is
   * that the built-in types are now translated at display time from the `type`
   * key instead of being frozen into typeLabel at creation. */
  typeCustom: { type: String, trim: true, maxlength: 40, default: '' },
  gradient: String,
  tagBg: String,
  date: { type: String, required: true },
  startTime: String,
  endTime: String,
  location: String,
  onlineLink: String,
  description: String,
  organizer: String,
  organizerPhone: String,
  organizerEmail: String,
  hostedBy: String,
  flyerUrl: String,
  inviteImage: String,
  tickets: [ticketSchema],
  paymentMethods: {
    moncash: { type: Boolean, default: false },
    natcash: { type: Boolean, default: false },
    card: { type: Boolean, default: false },
    manual: { type: Boolean, default: false }
  },
  moncashNumber: String,
  natcashNumber: String,
  // The code a helper on the door types once to be allowed to mark tickets
  // used. It is per event on purpose: the console code opens escrow, refunds
  // and driver approval, and none of that belongs in a volunteer's pocket.
  doorCode: { type: String },
  koutyeEnabled: { type: Boolean, default: false },
  creatorPct: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'published', 'cancelled'], default: 'published' },
  views: { type: Number, default: 0 },

  rsvps: [rsvpSchema],

  /* The code that lets the organiser manage their OWN event.
   *
   * The Academy director's second point was that a published event cannot be deleted. The
   * reason is not a missing button. PUT and DELETE on an event take the
   * console code - the same code that opens escrow, refunds and driver
   * approval - because an event carries the organiser's MonCash number and
   * anybody who could edit one could redirect somebody else's takings to
   * themselves. So the routes were locked, correctly, and locked to him alone.
   *
   * An organiser needs to delete their own mistake without being handed the
   * keys to the platform. This is that: generated once when the event is
   * created, returned once, never stored in the clear. His console code still
   * opens everything, so he remains able to remove anything.
   *
   * ⛔ Events created before this existed have no manage code and never will -
   * there is nobody to hand it to who can be shown to be the organiser. Those
   * stay console-code-only, which is where they already were. */
  manageSalt: { type: String, select: false },
  manageHash: { type: String, select: false },

  createdAt: { type: Date, default: Date.now }
});

const crypto = require('crypto');
const MANAGE_ROUNDS = 100000;

/* Six characters from an alphabet with no O/0 and no I/1/l in it. This gets
   read off one phone screen and typed into another by someone standing up. */
const MANAGE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

eventSchema.statics.newManageCode = function () {
  const bytes = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += MANAGE_ALPHABET[bytes[i] % MANAGE_ALPHABET.length];
  return out;
};

function normManage(raw) {
  return String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

eventSchema.methods.setManageCode = function (raw) {
  const norm = normManage(raw);
  if (norm.length < 6) {
    const e = new Error('A manage code needs at least 6 letters or numbers');
    e.status = 400;
    throw e;
  }
  this.manageSalt = crypto.randomBytes(16).toString('hex');
  this.manageHash = crypto.pbkdf2Sync(norm, this.manageSalt, MANAGE_ROUNDS, 32, 'sha256').toString('hex');
};

eventSchema.methods.checkManageCode = function (raw) {
  if (!this.manageSalt || !this.manageHash) return false;
  const norm = normManage(raw);
  if (!norm) return false;
  const got = crypto.pbkdf2Sync(norm, this.manageSalt, MANAGE_ROUNDS, 32, 'sha256').toString('hex');
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(this.manageHash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

eventSchema.index({ status: 1, date: -1 });
eventSchema.index({ type: 1 });

module.exports = mongoose.model('Event', eventSchema);
