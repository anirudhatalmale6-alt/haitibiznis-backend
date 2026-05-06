const mongoose = require('mongoose');

const verifiedProfileSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  email: { type: String },
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  displayName: { type: String },
  profileType: {
    type: String,
    enum: ['driver', 'business', 'professional', 'delivery_agent', 'vendor', 'service_provider'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'verified', 'premium_verified', 'syndicate_verified', 'suspended'],
    default: 'pending'
  },
  photoUrl: { type: String },
  selfieUrl: { type: String },
  governmentIdUrl: { type: String },
  governmentIdType: { type: String, enum: ['cin', 'passport', 'nif', 'other'] },
  phoneVerified: { type: Boolean, default: false },
  phoneOtp: { type: String },
  phoneOtpExpires: { type: Date },
  businessName: { type: String },
  businessCategory: { type: String },
  businessAddress: { type: String },
  businessDocUrl: { type: String },
  driverLicenseUrl: { type: String },
  vehicleDocs: [{
    type: { type: String },
    url: { type: String },
    label: { type: String }
  }],
  syndicateName: { type: String },
  syndicateId: { type: String },
  syndicateVerified: { type: Boolean, default: false },
  professionalTitle: { type: String },
  professionalCategory: { type: String },
  certifications: [{ name: String, url: String, date: Date }],
  trainingsCompleted: [{ name: String, completedAt: Date, badge: String }],
  qrCode: { type: String, unique: true, index: true },
  rating: { type: Number, default: 0 },
  totalRatings: { type: Number, default: 0 },
  totalTrips: { type: Number, default: 0 },
  totalOrders: { type: Number, default: 0 },
  totalServices: { type: Number, default: 0 },
  trustScore: { type: Number, default: 0, min: 0, max: 100 },
  platforms: [{
    type: String,
    enum: ['msouwout', 'myplopplop', 'prolakay', 'utility_hub', 'delivery', 'haitibiznis_center']
  }],
  linkedDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'Driver' },
  suspendedAt: { type: Date },
  suspendReason: { type: String },
  verifiedAt: { type: Date },
  verifiedBy: { type: String },
  rejectedAt: { type: Date },
  rejectedReason: { type: String },
  statusHistory: [{
    status: String,
    at: { type: Date, default: Date.now },
    by: String,
    note: String
  }]
}, { timestamps: true });

verifiedProfileSchema.index({ status: 1, profileType: 1 });
verifiedProfileSchema.index({ qrCode: 1 });
verifiedProfileSchema.index({ 'platforms': 1 });
verifiedProfileSchema.index({ rating: -1 });

verifiedProfileSchema.methods.computeTrustScore = function() {
  let score = 0;
  if (this.phoneVerified) score += 10;
  if (this.photoUrl) score += 5;
  if (this.selfieUrl) score += 10;
  if (this.governmentIdUrl) score += 20;
  if (this.status === 'verified') score += 15;
  if (this.status === 'premium_verified') score += 25;
  if (this.status === 'syndicate_verified') score += 25;
  if (this.syndicateVerified) score += 5;
  if (this.rating >= 4.5) score += 10;
  else if (this.rating >= 4.0) score += 5;
  const activity = this.totalTrips + this.totalOrders + this.totalServices;
  if (activity >= 100) score += 10;
  else if (activity >= 50) score += 7;
  else if (activity >= 10) score += 3;
  if (this.trainingsCompleted.length > 0) score += 5;
  if (this.certifications.length > 0) score += 5;
  this.trustScore = Math.min(score, 100);
  return this.trustScore;
};

module.exports = mongoose.model('VerifiedProfile', verifiedProfileSchema);
