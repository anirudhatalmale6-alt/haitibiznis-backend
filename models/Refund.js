const mongoose = require('mongoose');

const refundSchema = new mongoose.Schema({
  ride: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', required: true },
  riderPhone: { type: String, required: true },
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  reason: {
    type: String,
    enum: ['breakdown', 'driver_cancelled', 'no_driver', 'overcharged', 'wrong_route', 'safety', 'other'],
    required: true
  },
  reasonText: String,
  rideAmount: { type: Number, required: true },
  refundAmount: { type: Number, default: 0 },
  refundType: { type: String, enum: ['full', 'partial'], default: 'full' },
  percentCompleted: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['pending', 'approved', 'denied', 'processed'],
    default: 'pending'
  },
  adminNote: String,
  processedAt: Date,
  refundMethod: { type: String, enum: ['wallet', 'moncash', 'natcash'], default: 'wallet' },
  createdAt: { type: Date, default: Date.now }
});

refundSchema.index({ status: 1, createdAt: -1 });
refundSchema.index({ riderPhone: 1 });
refundSchema.index({ ride: 1 });

module.exports = mongoose.model('Refund', refundSchema);
