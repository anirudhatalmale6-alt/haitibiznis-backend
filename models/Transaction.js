const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event', required: true },
  ticketName: { type: String, required: true },
  ticketPrice: { type: Number, required: true },
  qty: { type: Number, default: 1 },
  totalAmount: { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  referenceId: { type: String, required: true, unique: true },
  sipTransactionId: { type: String },
  // 'free' belongs here: buy-ticket writes it for a zero-price ticket, and
  // without it mongoose refused the save, so a free RSVP answered 500 and no
  // free ticket could ever be issued at all.
  paymentMethod: { type: String, enum: ['moncash', 'natcash', 'card', 'all', 'free'] },
  status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'], default: 'pending' },
  buyerName: { type: String },
  buyerPhone: { type: String },
  buyerEmail: { type: String },
  paymentUrl: { type: String },
  paidAt: { type: Date },
  // Checking a ticket and using it are different acts. Without these three the
  // door could only ever say "this is paid", so one photograph of one valid
  // ticket walked as many people in as it was shown to. usedAt is written once
  // and never overwritten; useCount counts every accepted scan, so a second
  // scan is visible instead of silent.
  usedAt: { type: Date },
  usedBy: { type: String },
  useCount: { type: Number, default: 0 },
  koutyeCode: { type: String },

  // Whether the buyer was actually SENT their ticket, and if not, why.
  //
  // A ticket bought on 10 September was paid for and never delivered, and
  // nothing anywhere recorded that fact - the transaction looked identical to
  // one that had arrived safely. "Sent" has to be a thing the system knows,
  // otherwise the only way to discover a silent failure is a buyer
  // complaining, which is how this one was found.
  //
  // deliveredAt is set once, on the first successful send. deliveryError keeps
  // the last reason a send did not happen, including the honest one where no
  // WhatsApp credentials are configured at all.
  deliveredAt: { type: Date },
  deliveryChannel: { type: String },
  deliveryError: { type: String },
  deliveryAttempts: { type: Number, default: 0 },

  // The last eight digits of buyerPhone, which is how a buyer finds their own
  // ticket again. Stored separately because one person's number gets typed as
  // "31234567", "+509 3123 4567" and "509-3123-4567" over the months, and a
  // lookup comparing the raw strings finds none of them.
  phoneKey: { type: String, index: true }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
