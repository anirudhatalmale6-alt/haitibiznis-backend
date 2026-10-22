/* ═══ A SALE MADE IN THE LAJANMAKER POS, AS THE SERVER KNOWS IT ═══════════════
 *
 * Jeffery, 22 Oct 2026: "I want LajanMaker POS sales synchronized with the
 * server. Every sale should be attributed to the correct Ajan… Duplicate
 * sales are prevented… Cancelled or refunded transactions are correctly
 * reflected… distinguishes recorded sales from confirmed paid sales… No
 * commissions are generated twice."
 *
 * The phone stays the place a sale is MADE; this is the copy that counts.
 *
 * 🔑 ONE ROW PER (deviceId, saleId). Sale numbers restart at HB-1001 on every
 *    phone, so the number alone is not unique - the pair is (unique index).
 *    Sending the same sale again updates this row; it can never add a second.
 * 🔑 RECORDED vs CONFIRMED: what the phone reports is "recorded". "Confirmed"
 *    is set ONLY by the server, after the payment gateway itself says the
 *    MonCash/NatCash payment arrived for at least the amount (verifyPayment).
 *    Cash and "marked paid by hand" can never become confirmed.
 * 🔑 CANCELLED ≠ REFUNDED. Cancelled: the sale did not stand (nothing kept).
 *    Refunded: it stood, then money went back (all or part) - the refund
 *    itself is done by hand, outside; this only RECORDS it. Both need the
 *    console code, a reason and the administrator's name, and are logged.
 * ⛔ No commission is created anywhere from this. posShare is the Ajan's share
 *    the phone already computed, shown for evaluation only; payouts untouched.
 * ⛔ No customer name or phone is stored: the pilot needs counts and amounts.
 * ═══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const posSaleSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  saleId: { type: String, required: true },

  /* Who made it: the number typed in the app (last 8 digits), and the
     approved badge that number belonged to when the sale arrived. */
  phoneKey: { type: String, default: '', index: true },
  agentId: { type: String, default: '', index: true },       // '' = not attributed
  referralCode: { type: String, default: '' },
  staff: { type: String, default: '' },

  type: { type: String, default: 'sale' },                    // sale | reg | ticket | delivery …
  module: { type: String, default: '' },
  service: { type: String, default: '' },
  amount: { type: Number, default: 0 },
  currency: { type: String, default: 'HTG' },
  payment: { type: String, default: '' },                     // cash | moncash | natcash | …
  payStatus: { type: String, default: '' },                   // what the PHONE says: paid | manual | cash
  payRef: { type: String, default: '' },
  payClient: { type: String, default: '' },
  posShare: { type: Number, default: 0 },
  posPct: { type: Number, default: 0 },
  status: { type: String, default: '' },                      // wait | prog | ready | done (work status)
  soldAt: { type: Date, required: true },

  /* Set by the SERVER only. */
  confirm: {
    state: { type: String, enum: ['none', 'pending', 'confirmed', 'not_paid'], default: 'none' },
    checkedAt: Date,
    tries: { type: Number, default: 0 },
    amount: Number
  },

  state: { type: String, enum: ['active', 'cancelled', 'refunded'], default: 'active', index: true },
  cancelled: { at: Date, by: String, reason: String },
  refunds: [{ _id: false, at: Date, by: String, reason: String, amount: Number }],
  refunded: { type: Number, default: 0 },

  rev: { type: Number, default: 1 },                          // the phone's edit counter
  firstSeen: { type: Date, default: Date.now },
  history: [{ _id: false, at: { type: Date, default: Date.now }, by: String, action: String, note: String }]
}, { timestamps: true });

posSaleSchema.index({ deviceId: 1, saleId: 1 }, { unique: true });
posSaleSchema.index({ agentId: 1, soldAt: 1 });

/* What still counts after cancellations and refunds. */
posSaleSchema.methods.net = function () {
  if (this.state === 'cancelled') return 0;
  return Math.max(0, (this.amount || 0) - (this.refunded || 0));
};
posSaleSchema.methods.netShare = function () {
  const a = this.amount || 0;
  return a > 0 ? Math.round((this.posShare || 0) * this.net() / a) : 0;
};

module.exports = mongoose.model('PosSale', posSaleSchema);
