/* ═══ A CERTIFIED LAJANMAKER AGENT — THE ONE RECORD BEHIND THE BADGE QR ═══
 *
 * Jeffery, 21 Oct 2026: "For the Certified LajanMaker Agent badge QR code, I
 * want the QR to open an official HaitiBiznis/LajanMaker verification page…
 * If the agent is no longer active or the badge is expired, the page should
 * clearly show ⚠️ AJAN SA A PA AKTIF / BADGE EKSPIRE."
 *
 * Until now an Agent ID existed only on the phone that drew the badge: an
 * FNV-1a hash of name|date (akademi/index.html certNumber). Nothing on a
 * server knew it, so a QR could prove nothing - and the re-issue page's code
 * sits in its own source, so anyone could print a badge for any name.
 *
 * So a badge is only "VERIFYE" once a person at HaitiBiznis approves it here.
 * The exam and the re-issue page can only ever create a PENDING record.
 *
 * ⛔ No national ID, date of birth or home address - he said so, and a public
 * page is no place for them. The phone IS shown: it is the agent's work
 * contact ("Contact info of the agent is important… for follow up").
 * ═══════════════════════════════════════════════════════════════════════════ */
const mongoose = require('mongoose');

const SERVICES = ['MsouWout', 'MyPlopPlop', 'Tikè Lakay', 'LajanMaker Academy', 'Digital Services', '48HoursReady'];

const agentSchema = new mongoose.Schema({
  /* The number printed on the certificate, card and badge. It never changes. */
  agentId: { type: String, required: true, unique: true, index: true, uppercase: true, trim: true,
             match: /^LMA-\d{4}-\d{6}$/ },
  name: { type: String, required: true, trim: true, maxlength: 120 },
  phone: { type: String, default: '', trim: true, maxlength: 40 },
  city: { type: String, default: '', trim: true, maxlength: 80 },
  sponsor: { type: String, default: '', trim: true, maxlength: 80 },
  /* The agent's own Koutye code (MyPlopPlop referral engine). Every sign-up
     button on the verification page carries it, so the credit is automatic. */
  referralCode: { type: String, default: '', trim: true, maxlength: 40 },
  services: { type: [String], default: SERVICES.slice() },

  certifiedAt: { type: Date, required: true },
  expiresAt: { type: Date, default: null },

  /* pending   - came from the exam or the re-issue page, nobody has looked yet
     active    - approved; the page says VERIFYE (until expiresAt)
     suspended - temporarily not allowed to represent HaitiBiznis
     revoked   - never again */
  status: { type: String, enum: ['pending', 'active', 'suspended', 'revoked'], default: 'pending', index: true },
  statusNote: { type: String, default: '', maxlength: 300 },
  source: { type: String, enum: ['exam', 'reissue', 'admin'], default: 'exam' },

  photo: { type: Buffer, select: false },
  photoMime: { type: String, default: '' },
  photoAt: { type: Date, default: null },

  approvedAt: { type: Date, default: null },
  submissions: { type: Number, default: 0 },
  lastSubmittedAt: { type: Date, default: null },

  history: [{ _id: false, at: { type: Date, default: Date.now }, action: String, note: String }]
}, { timestamps: true });

/* What the public page is allowed to say, decided in ONE place. */
agentSchema.methods.publicState = function (now) {
  now = now || new Date();
  if (this.status === 'active') {
    return (this.expiresAt && this.expiresAt < now) ? 'expired' : 'active';
  }
  return this.status;  // pending | suspended | revoked
};

agentSchema.statics.SERVICES = SERVICES;

/* Same number the exam prints: FNV-1a over "name lower-cased, spaces folded|
   Date.toDateString()". The date is built from Y-M-D as a LOCAL date, exactly
   like the phone did, so the server and the printed badge cannot disagree. */
agentSchema.statics.certNumber = function (name, ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const seed = String(name).toLowerCase().replace(/\s+/g, ' ') + '|' + d.toDateString();
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    /* ⛔ NOT Math.imul: the phone multiplies as a double (precision is lost
       above 2^53) and THAT is the number on every printed badge. Same
       expression, same result. */
    h = (h * 16777619) >>> 0;
  }
  return 'LMA-' + d.getFullYear() + '-' + ('00000' + (h % 1000000)).slice(-6);
};

module.exports = mongoose.model('CertifiedAgent', agentSchema);
