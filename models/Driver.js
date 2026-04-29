const mongoose = require('mongoose');

const driverSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  email: String,
  vehicleType: { type: String, enum: ['car', 'moto'], required: true },
  vehicleMake: String,
  vehicleModel: String,
  vehicleColor: String,
  vehicleYear: Number,
  licensePlate: { type: String, required: true },
  photoUrl: String,
  licensePhotoUrl: String,
  status: { type: String, enum: ['offline', 'available', 'busy'], default: 'offline' },
  verified: { type: Boolean, default: false },
  rating: { type: Number, default: 5.0 },
  totalRides: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  location: {
    lat: Number,
    lng: Number,
    updatedAt: Date
  },
  zone: String,
  pin: String,
  createdAt: { type: Date, default: Date.now }
});

driverSchema.index({ status: 1, vehicleType: 1 });
driverSchema.index({ phone: 1 });

module.exports = mongoose.model('Driver', driverSchema);
