const mongoose = require('mongoose');

const sosAlertSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  name: { type: String },
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'VerifiedProfile' },
  lat: { type: Number },
  lng: { type: Number },
  platform: { type: String, enum: ['msouwout', 'myplopplop', 'prolakay', 'delivery'] },
  rideId: { type: String },
  orderId: { type: String },
  message: { type: String },
  emergencyContacts: [{ name: String, phone: String }],
  status: { type: String, enum: ['active', 'responded', 'resolved', 'false_alarm'], default: 'active' },
  respondedAt: { type: Date },
  resolvedAt: { type: Date },
  adminNote: { type: String }
}, { timestamps: true });

sosAlertSchema.index({ status: 1, createdAt: -1 });
sosAlertSchema.index({ phone: 1 });

module.exports = mongoose.model('SOSAlert', sosAlertSchema);
