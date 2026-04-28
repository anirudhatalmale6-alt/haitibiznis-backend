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

const eventSchema = new mongoose.Schema({
  title: { type: String, required: true },
  type: { type: String, default: 'lòt' },
  typeLabel: String,
  typeEmoji: String,
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
  koutyeEnabled: { type: Boolean, default: false },
  creatorPct: { type: Number, default: 0 },
  status: { type: String, enum: ['draft', 'published', 'cancelled'], default: 'published' },
  views: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

eventSchema.index({ status: 1, date: -1 });
eventSchema.index({ type: 1 });

module.exports = mongoose.model('Event', eventSchema);
