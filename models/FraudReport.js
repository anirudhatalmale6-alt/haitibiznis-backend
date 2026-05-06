const mongoose = require('mongoose');

const fraudReportSchema = new mongoose.Schema({
  reportedProfile: { type: mongoose.Schema.Types.ObjectId, ref: 'VerifiedProfile', required: true },
  reporterPhone: { type: String, required: true },
  reporterName: { type: String },
  category: {
    type: String,
    enum: ['fake_identity', 'scam', 'unsafe_behavior', 'harassment', 'fake_documents', 'impersonation', 'other'],
    required: true
  },
  description: { type: String, required: true, maxlength: 1000 },
  evidenceUrls: [{ type: String }],
  platform: { type: String, enum: ['msouwout', 'myplopplop', 'prolakay', 'utility_hub', 'delivery', 'haitibiznis_center'] },
  transactionId: { type: String },
  status: { type: String, enum: ['open', 'investigating', 'resolved', 'dismissed'], default: 'open' },
  adminNote: { type: String },
  resolvedAt: { type: Date },
  resolvedBy: { type: String }
}, { timestamps: true });

fraudReportSchema.index({ reportedProfile: 1, status: 1 });
fraudReportSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('FraudReport', fraudReportSchema);
