const mongoose = require('mongoose');

const chatSessionSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  flow: { type: String, enum: ['ride', 'driver', 'koutye', 'refund', null], default: null },
  step: { type: Number, default: 0 },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  name: String,
  koutyeCode: String,
  referredBy: String,
  lastActivity: { type: Date, default: Date.now }
});

chatSessionSchema.index({ phone: 1 });
chatSessionSchema.index({ lastActivity: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('ChatSession', chatSessionSchema);
