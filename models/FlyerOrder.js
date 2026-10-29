const mongoose = require('mongoose');

/* An organiser buying AI flyer designs for one of their events.
 *
 * Jeffery, 29 Oct 2026: "Organizers should be able to enter their event
 * details, upload photos/logos, and have AI generate 3 professional flyer
 * designs, automatically including the event QR code, ready to download and
 * share... 250 HTG for 3 designs, using our existing OpenAI integration and
 * payment system."
 *
 * Kept apart from Transaction on purpose. A Transaction is a TICKET: it is
 * counted against seats, swept, delivered and admitted at the door. A flyer
 * order is none of those, and putting it in the same collection would let one
 * show up in places that only ever expect tickets.
 *
 * ⛔ The AI only ever draws the BACKGROUND. The title, date, place, logos and
 * the QR code are put on top by the page itself, because an AI-drawn QR code
 * does not scan, AI-drawn logos come out distorted and AI-drawn words come out
 * misspelled. Nothing here stores a QR code - the promotional QR is the public
 * event link and is never an admission ticket.
 */
const imageSchema = new mongoose.Schema({
  data: Buffer,
  mime: { type: String, default: 'image/jpeg' },
  style: String,
  model: String,
  quality: String,
  outputTokens: Number,
  costUsd: Number
}, { _id: false });

const flyerOrderSchema = new mongoose.Schema({
  referenceId: { type: String, required: true, unique: true },
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  eventTitle: String,
  amount: { type: Number, required: true },
  currency: { type: String, default: 'HTG' },
  paymentMethod: { type: String, enum: ['moncash', 'natcash', 'card'] },
  phone: String,
  phoneKey: { type: String, index: true },
  /* What the organiser asked the look to be ("blue and gold, elegant").
     Optional, short, and only ever used as a hint to the image model. */
  look: { type: String, maxlength: 200, default: '' },

  /* pending    - checkout opened, not paid
     paid       - the provider confirmed the money; designs not made yet
     generating - one worker has claimed it and is calling the AI
     ready      - designs stored
     failed     - the AI could not make any design (paid, so it can be retried) */
  status: { type: String, enum: ['pending', 'paid', 'generating', 'ready', 'failed'], default: 'pending', index: true },
  sipTransactionId: String,
  stripeSessionId: { type: String, index: true },
  stripePaymentIntent: String,
  paymentUrl: String,
  paidAt: Date,
  paidAmount: Number,
  paidCurrency: String,
  lastCheckAt: Date,

  genAttempts: { type: Number, default: 0 },
  genStartedAt: Date,
  genError: String,
  readyAt: Date,
  images: { type: [imageSchema], default: [] },
  /* What the designs cost on the OpenAI account, so the revenue from flyers
     can be read next to what it cost to make them. */
  aiCostUsd: { type: Number, default: 0 }
}, { timestamps: true });

module.exports = mongoose.model('FlyerOrder', flyerOrderSchema);
