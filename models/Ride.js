const mongoose = require('mongoose');

const rideSchema = new mongoose.Schema({
  riderName: { type: String, required: true },
  riderPhone: { type: String, required: true },
  vehicleType: { type: String, enum: ['car', 'moto'], required: true },
  pickupAddress: { type: String, required: true },
  pickupLat: Number,
  pickupLng: Number,
  dropoffAddress: { type: String, required: true },
  dropoffLat: Number,
  dropoffLng: Number,
  scheduledDate: { type: String, required: true },
  scheduledTime: { type: String, required: true },
  event: { type: mongoose.Schema.Types.ObjectId, ref: 'Event' },
  ticketRef: String,
  driver: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'driver_enroute', 'arrived', 'in_progress', 'completed', 'cancelled'],
    default: 'pending'
  },
  fare: { type: Number, default: 0 },
  estimatedFare: { type: Number, default: 0 },
  distance: Number,
  notes: String,
  riderRating: Number,
  driverRating: Number,
  cancelledBy: String,
  cancelReason: String,
  acceptedAt: Date,
  startedAt: Date,
  completedAt: Date,
  createdAt: { type: Date, default: Date.now }
});

rideSchema.index({ status: 1, scheduledDate: 1 });
rideSchema.index({ driver: 1, status: 1 });
rideSchema.index({ riderPhone: 1 });
rideSchema.index({ event: 1 });

module.exports = mongoose.model('Ride', rideSchema);
