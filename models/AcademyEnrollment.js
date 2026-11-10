/* ═══ LAJANMAKER ACADEMY: ONE PAID SEAT, BOUND TO ONE STUDENT (10 Nov 2026) ═════
   Jeffery (OPTION A): "Before allowing an official exam, verify that the student's
   phone number matches a confirmed paid Formation LajanMaker ticket." and "Prevent
   students from using another person's payment or phone number to obtain
   certification. Jennifer should be able to resolve legitimate registration errors."

   A paid Tikè Lakay ticket of qty N is N seats. A seat is bound to ONE student
   (one phone = one person, name fixed at the first official exam) the first time
   that student starts the exam with the BUYER's phone number. The other seats of
   a group ticket, a ticket bought with somebody else's phone, or a payment made
   outside Tikè Lakay are bound by Jennifer from her dashboard (logged, with her
   name). Released seats stay in the history and free the seat again. */
const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema({
  phoneKey: { type: String, required: true, index: true, maxlength: 8 },     // last 8 digits (utils/ticketDelivery phoneKey)
  phone: { type: String, default: '', maxlength: 40 },
  name: { type: String, default: '', trim: true, maxlength: 120 },          // fixed at the first official exam
  nameKey: { type: String, default: '', maxlength: 120 },
  status: { type: String, enum: ['active', 'released'], default: 'active', index: true },
  /* 'ticket' = a confirmed paid Tikè Lakay ticket; 'manual' = Jennifer recorded a payment made another way */
  source: { type: String, enum: ['ticket', 'manual'], required: true },
  ticketRef: { type: String, default: '', index: true },
  eventId: { type: String, default: '' },
  eventTitle: { type: String, default: '' },
  buyerName: { type: String, default: '' },
  buyerPhone: { type: String, default: '' },
  ticketQty: { type: Number, default: 1 },
  paidAmount: { type: Number, default: 0 },
  note: { type: String, default: '', maxlength: 300 },
  by: { type: String, default: '', maxlength: 60 },                          // 'auto' or who in the console
  releasedAt: Date,
  history: [{ _id: false, at: { type: Date, default: Date.now }, action: String, note: String, by: String }]
}, { timestamps: true });

/* one ACTIVE seat per phone */
enrollmentSchema.index({ phoneKey: 1 }, { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_seat_per_phone' });

module.exports = mongoose.model('AcademyEnrollment', enrollmentSchema);
