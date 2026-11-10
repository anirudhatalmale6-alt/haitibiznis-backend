/* ═══ LAJANMAKER ACADEMY SETTINGS (10 Nov 2026) ═══════════════════════════════
   - the trainer's exam code: it used to sit in the exam page's source
     (KOD_FOMATE), readable by anyone. Now only a salted hash lives here and the
     server checks it; Jennifer sets / changes it from her dashboard.
   - which Tikè Lakay training events are the paid Academy training (an organizer
     could create his own "fòmasyon" event, so the list is chosen, not guessed). */
const mongoose = require('mongoose');

const academySettingSchema = new mongoose.Schema({
  key: { type: String, default: 'academy', unique: true },
  codeSalt: { type: String, select: false },
  codeHash: { type: String, select: false },
  codeSetAt: Date,
  codeSetBy: { type: String, default: '' },
  eventIds: { type: [String], default: undefined },
  updatedBy: { type: String, default: '' }
}, { timestamps: true });

module.exports = mongoose.model('AcademySetting', academySettingSchema);
