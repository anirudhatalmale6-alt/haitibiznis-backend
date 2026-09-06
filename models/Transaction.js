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
  koutyeCode: { type: String }
}, { timestamps: true });

module.exports = mongoose.model('Transaction', transactionSchema);
