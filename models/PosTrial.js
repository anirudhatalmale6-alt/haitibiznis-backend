/* One row per agent's TELEPHONE NUMBER. Nothing else lives here.
 *
 * Jeffery, 4 Oct 2026: "I do not want someone clearing their app data and
 * receiving another 7-day trial... each agent/phone/account gets the free trial
 * only once... Reinstalling the app or clearing data must NOT restart another
 * trial."
 *
 * The licence itself still lives on the phone. This table answers exactly one
 * question - "has this number had its free week, and when does it end?" - and
 * the phone obeys the answer. That is the whole design: a phone can forget
 * everything it knows, and this still remembers.
 *
 * ⛔ THE GLOBAL RESET IS THIS TABLE BEING EMPTY. He asked for every existing
 * agent to get a fresh 7 days. Because no row exists for anybody yet, the first
 * time each agent opens the app the server finds nothing and gives them a clean
 * week. No deletion, no mass update, nothing touched - and therefore nothing
 * that can lose an account, a referral, a commission or a sale.
 *
 * ⛔ WHAT THIS DOES NOT HOLD: no earnings, no referrals, no commissions, no
 * certificates, no agent id. Those are somewhere else entirely and this cannot
 * reach them.
 */
const mongoose = require('mongoose');

const posTrialSchema = new mongoose.Schema({
  /* Last 8 digits. MUST match haitibiznis-backend/utils/ticketDelivery.js
     phoneKey() and the referral engine's, or the same agent is two people. */
  phoneKey: { type: String, required: true, unique: true, index: true },

  /* Kept only so a human can recognise the row. phoneKey is what matches. */
  phone: { type: String, default: '' },
  label: { type: String, default: '' },

  trialStartedAt: { type: Date, default: Date.now },
  trialEndsAt: { type: Date, required: true },

  /* How many times this number has asked. Useful for spotting somebody
     reinstalling repeatedly to look for a new trial. */
  seenCount: { type: Number, default: 1 },
  lastSeen: { type: Date, default: Date.now }
}, { timestamps: true });

module.exports = mongoose.model('PosTrial', posTrialSchema);
