const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  referenceId: { type: String, required: true, unique: true },
  store: {
    name: String,
    phone: String,
    whatsapp: String,
    category: String
  },
  buyer: {
    name: String,
    phone: String,
    address: String
  },
  items: [{
    name: String,
    qty: { type: Number, default: 1 },
    price: Number,
    emoji: String
  }],
  subtotal: { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  totalAmount: { type: Number, required: true },
  platformPct: { type: Number, default: 0.05 },

  paymentMethod: { type: String, enum: ['moncash', 'natcash', 'card'] },
  sipTransactionId: String,
  paymentUrl: String,
  paidAt: Date,

  status: {
    type: String,
    enum: ['pending_payment', 'paid', 'seller_confirmed', 'preparing', 'ready_for_pickup',
           'picked_up', 'on_the_way', 'delivered', 'confirmed_received',
           'funds_released', 'disputed', 'refunded', 'cancelled'],
    default: 'pending_payment'
  },

  deliveryPin: String,
  deliveryPhotoUrl: String,
  driver: {
    name: String,
    phone: String,
    vehicle: String
  },

  sellerPayout: { type: Number, default: 0 },
  driverPayout: { type: Number, default: 0 },
  platformEarnings: { type: Number, default: 0 },
  payoutStatus: { type: String, enum: ['held', 'released', 'refunded'], default: 'held' },

  disputeReason: String,
  disputeAt: Date,
  releaseAt: Date,
  autoReleaseAt: Date,

  isPerishable: { type: Boolean, default: false },

  statusHistory: [{
    status: String,
    at: { type: Date, default: Date.now },
    note: String
  }]
}, { timestamps: true });

orderSchema.pre('save', function() {
  if (this.isModified('status')) {
    this.statusHistory.push({ status: this.status, at: new Date() });
  }
});

module.exports = mongoose.model('Order', orderSchema);
