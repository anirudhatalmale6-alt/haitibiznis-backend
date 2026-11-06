/* 6 Nov 2026, Jeffery: "the 30% must be restricted to Ajan with an ACTIVE, VERIFIED LajanMaker certification badge
   (LMA-...). An active referral code alone should not qualify." The Ajan codes printed on a badge that is ACTIVE and not
   expired - exactly what the public badge page shows as VERIFYE (CertifiedAgent.publicState() === 'active').
   Read fresh at every confirmed payment: a badge suspended or revoked a minute ago no longer qualifies. */
const CertifiedAgent = require('../models/CertifiedAgent');
async function certifiedAjanCodes() {
  const now = new Date();
  const rows = await CertifiedAgent.find({ status: 'active', referralCode: { $nin: ['', null] },
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).select('referralCode').limit(20000).lean();
  return Array.from(new Set(rows.map(function (a) { return String(a.referralCode || '').trim().toUpperCase().replace(/\s+/g, ''); }).filter(Boolean)));
}
module.exports = { certifiedAjanCodes };
