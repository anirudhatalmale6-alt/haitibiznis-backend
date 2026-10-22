/* ═══ THE CERTIFIED-AJAN FIELD PILOT — free LajanMaker days for chosen Ajan ═══
 *
 * Jeffery, 22 Oct 2026: "We want to give these 15 agents 30 days FREE access
 * to LajanMaker, starting from the date we activate them… this is a special
 * Certified Agent field pilot. It should not change the normal 7-day trial for
 * regular users… Jennifer/us [should] be able to do this ourselves."
 *
 * The free time itself is PosTrial.trialEndsAt - the date every LajanMaker
 * phone already obeys while its licence is still a trial (pos/index.html
 * trialSync). This record is the paperwork around it: who got it, when it
 * started and ends, and every change with the name of whoever made it.
 *
 * ⛔ ONE pilot per Ajan and per phone (unique indexes): a second "Bay 30 jou"
 *    is refused - more days are an EXTENSION, which is logged as one.
 * ⛔ A paid LajanMaker plan is never touched: the phone only follows the
 *    server's date while its own plan is 'trial'. Nothing here can charge.
 * ═══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const ajanPilotSchema = new mongoose.Schema({
  agentId: { type: String, required: true, unique: true, uppercase: true, trim: true },
  phoneKey: { type: String, required: true, unique: true },
  phone: { type: String, default: '' },
  name: { type: String, default: '' },
  referralCode: { type: String, default: '' },

  startedAt: { type: Date, required: true },
  endsAt: { type: Date, required: true },
  cancelledAt: { type: Date, default: null },

  /* What PosTrial said before the pilot touched it (null = the phone had never
     asked). Kept so nobody has to guess what the Ajan had before. */
  prevTrialEndsAt: { type: Date, default: null },

  history: [{
    _id: false,
    at: { type: Date, default: Date.now },
    by: String,            // the name typed in the console - the code is shared
    action: String,        // activate | extend | cancel
    days: Number,
    endsAt: Date,
    note: String
  }]
}, { timestamps: true });

ajanPilotSchema.methods.state = function (now) {
  now = now || new Date();
  if (this.cancelledAt) return 'cancelled';
  return this.endsAt > now ? 'active' : 'ended';
};

module.exports = mongoose.model('AjanPilot', ajanPilotSchema);
