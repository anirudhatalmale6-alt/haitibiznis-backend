const mongoose = require('mongoose');

const ratingSchema = new mongoose.Schema({
  profile: { type: mongoose.Schema.Types.ObjectId, ref: 'VerifiedProfile', required: true },
  raterPhone: { type: String, required: true },
  raterName: { type: String },
  score: { type: Number, required: true, min: 1, max: 5 },
  comment: { type: String, maxlength: 500 },
  platform: {
    type: String,
    enum: ['msouwout', 'myplopplop', 'prolakay', 'utility_hub', 'delivery', 'haitibiznis_center'],
    required: true
  },
  transactionType: { type: String, enum: ['ride', 'order', 'service', 'delivery', 'general'] },
  transactionId: { type: String },
  response: { type: String, maxlength: 300 }
}, { timestamps: true });

ratingSchema.index({ profile: 1, createdAt: -1 });
ratingSchema.index({ raterPhone: 1 });
ratingSchema.index({ platform: 1 });

module.exports = mongoose.model('Rating', ratingSchema);
