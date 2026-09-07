/* One row per phone that has ever opened the LajanMaker POS.
 *
 * Why this exists, in his words: "I deleted Jennifer and Dukens but they still
 * have access this is nuts."
 *
 * He was right and it could not have worked. Until now the POS kept everything
 * on the phone itself - the staff list, the licence, the team code - so
 * deleting a row on HIS phone could not possibly reach THEIRS. And a team code
 * verifies itself by arithmetic, with no server, so once one was sent there was
 * nothing anywhere that could take it back.
 *
 * This table is the missing half. The phone still holds its own data, but it
 * has to ask here who it is, and the answer from here wins. Blocking a phone
 * takes effect the next time it opens the app - which is every time, because
 * the POS is a web page: if it can load at all, it has reached the internet.
 *
 * What the phone REPORTS (plan, exp, label) is only what the phone believes,
 * kept for the list so he can recognise who is who. What WE decide is `grant`
 * and `status`, and only those two are trusted.
 */
const mongoose = require('mongoose');

const posDeviceSchema = new mongoose.Schema({
  deviceId: { type: String, required: true, unique: true, index: true },

  /* --- what we decide. The only fields the app is allowed to obey. --- */
  status: { type: String, enum: ['active', 'blocked'], default: 'active', index: true },
  /* none     - normal, the phone's own subscription rules apply
   * team     - one of his own people; never asked to subscribe
   * lifetime - a paid Founder, or his own phone; never asked to subscribe   */
  grant: { type: String, enum: ['none', 'team', 'lifetime'], default: 'none' },
  note: { type: String, default: '' },          // "Jennifer - old agent phone"

  /* --- what the phone says about itself. Never trusted, only displayed. --- */
  label: { type: String, default: '' },         // business or owner name
  staff: { type: [String], default: [] },       // names on that phone
  plan: { type: String, default: '' },
  exp: { type: String, default: '' },
  ver: { type: String, default: '' },
  ua: { type: String, default: '' },

  firstSeen: { type: Date, default: Date.now },
  lastSeen: { type: Date, default: Date.now, index: true },
  seenCount: { type: Number, default: 0 },
  blockedAt: Date
}, { timestamps: true });

module.exports = mongoose.model('PosDevice', posDeviceSchema);
