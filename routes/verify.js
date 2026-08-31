const express = require('express');
const router = express.Router();
const VerifiedProfile = require('../models/VerifiedProfile');
const Rating = require('../models/Rating');
const FraudReport = require('../models/FraudReport');
const SOSAlert = require('../models/SOSAlert');
const Driver = require('../models/Driver');
const { notifyAdmin } = require('../utils/notify');

function genQR() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'HBV-';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genOTP() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

// POST /api/verify/register — Create verification profile
router.post('/register', async (req, res) => {
  try {
    const { phone, firstName, lastName, email, profileType, platforms,
            businessName, businessCategory, businessAddress,
            professionalTitle, professionalCategory,
            syndicateName, syndicateId } = req.body;

    if (!phone || !firstName || !lastName || !profileType) {
      return res.status(400).json({ error: 'phone, firstName, lastName, profileType obligatwa' });
    }

    let profile = await VerifiedProfile.findOne({ phone });
    if (profile) {
      return res.status(409).json({ error: 'Nimewo sa deja anrejistre', profileId: profile._id, qrCode: profile.qrCode });
    }

    let qrCode = genQR();
    while (await VerifiedProfile.findOne({ qrCode })) qrCode = genQR();

    profile = await VerifiedProfile.create({
      phone, firstName, lastName, email, profileType,
      displayName: firstName + ' ' + lastName,
      qrCode,
      platforms: platforms || [],
      businessName, businessCategory, businessAddress,
      professionalTitle, professionalCategory,
      syndicateName, syndicateId,
      statusHistory: [{ status: 'pending', by: 'self', note: 'Registration' }]
    });

    const otp = genOTP();
    profile.phoneOtp = otp;
    profile.phoneOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await profile.save();

    notifyAdmin(`Nouvo enskripsyon verifikasyon: ${firstName} ${lastName} (${profileType}) - ${phone}`);

    res.status(201).json({
      profileId: profile._id,
      qrCode: profile.qrCode,
      status: profile.status,
      otp,
      message: 'Profil kreye. Verifye telefon ou ak OTP a.'
    });
  } catch (err) {
    console.error('Register verify error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/phone — Verify phone with OTP
router.post('/phone', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    if (!phone || !otp) return res.status(400).json({ error: 'phone ak otp obligatwa' });

    const profile = await VerifiedProfile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });
    if (profile.phoneVerified) return res.json({ message: 'Telefon deja verifye', verified: true });

    if (profile.phoneOtp !== otp || profile.phoneOtpExpires < new Date()) {
      return res.status(400).json({ error: 'OTP pa valid oswa ekspire' });
    }

    profile.phoneVerified = true;
    profile.phoneOtp = undefined;
    profile.phoneOtpExpires = undefined;
    profile.computeTrustScore();
    await profile.save();

    res.json({ message: 'Telefon verifye!', verified: true, trustScore: profile.trustScore });
  } catch (err) {
    console.error('Phone verify error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/resend-otp — Resend OTP
router.post('/resend-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    const profile = await VerifiedProfile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    const otp = genOTP();
    profile.phoneOtp = otp;
    profile.phoneOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
    await profile.save();

    res.json({ otp, message: 'Nouvo OTP voye' });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/upload — Upload verification document
router.post('/upload', async (req, res) => {
  try {
    const { phone, docType, url, label } = req.body;
    if (!phone || !docType || !url) {
      return res.status(400).json({ error: 'phone, docType, url obligatwa' });
    }

    const profile = await VerifiedProfile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    const validTypes = ['photo', 'selfie', 'government_id', 'driver_license', 'vehicle_doc', 'business_doc', 'certification'];
    if (!validTypes.includes(docType)) {
      return res.status(400).json({ error: 'docType pa valid', validTypes });
    }

    switch (docType) {
      case 'photo': profile.photoUrl = url; break;
      case 'selfie': profile.selfieUrl = url; break;
      case 'government_id': profile.governmentIdUrl = url; break;
      case 'driver_license': profile.driverLicenseUrl = url; break;
      case 'business_doc': profile.businessDocUrl = url; break;
      case 'vehicle_doc':
        profile.vehicleDocs.push({ type: 'vehicle', url, label: label || 'Vehicle document' });
        break;
      case 'certification':
        profile.certifications.push({ name: label || 'Certification', url, date: new Date() });
        break;
    }

    profile.computeTrustScore();
    await profile.save();

    notifyAdmin(`Dokiman upload: ${profile.displayName} (${docType})`);
    res.json({ message: 'Dokiman anrejistre', trustScore: profile.trustScore });
  } catch (err) {
    console.error('Upload doc error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/profile/:identifier — Get public profile (by QR code, phone, or ID)
router.get('/profile/:identifier', async (req, res) => {
  try {
    const id = req.params.identifier;
    let profile;
    if (id.startsWith('HBV-')) {
      profile = await VerifiedProfile.findOne({ qrCode: id });
    } else if (id.match(/^\+?\d{8,15}$/)) {
      profile = await VerifiedProfile.findOne({ phone: id });
    } else {
      profile = await VerifiedProfile.findById(id).catch(() => null);
    }

    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    const ratings = await Rating.find({ profile: profile._id })
      .sort({ createdAt: -1 }).limit(10).lean();

    const fraudCount = await FraudReport.countDocuments({
      reportedProfile: profile._id, status: { $in: ['open', 'investigating'] }
    });

    res.json({
      profileId: profile._id,
      qrCode: profile.qrCode,
      displayName: profile.displayName,
      firstName: profile.firstName,
      lastName: profile.lastName,
      profileType: profile.profileType,
      status: profile.status,
      photoUrl: profile.photoUrl,
      phoneVerified: profile.phoneVerified,
      businessName: profile.businessName,
      businessCategory: profile.businessCategory,
      professionalTitle: profile.professionalTitle,
      professionalCategory: profile.professionalCategory,
      syndicateName: profile.syndicateName,
      syndicateVerified: profile.syndicateVerified,
      rating: profile.rating,
      totalRatings: profile.totalRatings,
      trustScore: profile.trustScore,
      platforms: profile.platforms,
      totalTrips: profile.totalTrips,
      totalOrders: profile.totalOrders,
      totalServices: profile.totalServices,
      trainingsCompleted: profile.trainingsCompleted.length,
      certifications: profile.certifications.length,
      verifiedAt: profile.verifiedAt,
      memberSince: profile.createdAt,
      recentRatings: ratings,
      openReports: fraudCount,
      hasGovernmentId: !!profile.governmentIdUrl,
      hasSelfie: !!profile.selfieUrl,
      hasDriverLicense: !!profile.driverLicenseUrl,
      hasBusinessDoc: !!profile.businessDocUrl
    });
  } catch (err) {
    console.error('Get profile error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/badge/:phone — Quick badge check (for embedding in other platforms)
router.get('/badge/:phone', async (req, res) => {
  try {
    const profile = await VerifiedProfile.findOne({ phone: req.params.phone }).lean();
    if (!profile) return res.json({ verified: false });

    res.json({
      verified: ['verified', 'premium_verified', 'syndicate_verified'].includes(profile.status),
      status: profile.status,
      displayName: profile.displayName,
      profileType: profile.profileType,
      rating: profile.rating,
      trustScore: profile.trustScore,
      qrCode: profile.qrCode,
      photoUrl: profile.photoUrl,
      platforms: profile.platforms
    });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/rate — Submit a rating
router.post('/rate', async (req, res) => {
  try {
    const { profileId, phone, raterPhone, raterName, score, comment, platform, transactionType, transactionId } = req.body;

    if ((!profileId && !phone) || !raterPhone || !score || !platform) {
      return res.status(400).json({ error: 'profileId/phone, raterPhone, score, platform obligatwa' });
    }
    if (score < 1 || score > 5) return res.status(400).json({ error: 'Score dwe ant 1-5' });

    let profile;
    if (profileId) profile = await VerifiedProfile.findById(profileId);
    else profile = await VerifiedProfile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    if (raterPhone === profile.phone) return res.status(400).json({ error: 'Ou pa ka evalye tèt ou' });

    const rating = await Rating.create({
      profile: profile._id, raterPhone, raterName,
      score, comment, platform,
      transactionType: transactionType || 'general',
      transactionId
    });

    const allRatings = await Rating.find({ profile: profile._id });
    const avg = allRatings.reduce((sum, r) => sum + r.score, 0) / allRatings.length;
    profile.rating = parseFloat(avg.toFixed(2));
    profile.totalRatings = allRatings.length;
    profile.computeTrustScore();
    await profile.save();

    res.status(201).json({
      message: 'Evalyasyon anrejistre',
      newRating: profile.rating,
      totalRatings: profile.totalRatings
    });
  } catch (err) {
    console.error('Rate error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/report — Report fraud
router.post('/report', async (req, res) => {
  try {
    const { profileId, phone, reporterPhone, reporterName, category, description, evidenceUrls, platform, transactionId } = req.body;

    if ((!profileId && !phone) || !reporterPhone || !category || !description) {
      return res.status(400).json({ error: 'profileId/phone, reporterPhone, category, description obligatwa' });
    }

    let profile;
    if (profileId) profile = await VerifiedProfile.findById(profileId);
    else profile = await VerifiedProfile.findOne({ phone });
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    const report = await FraudReport.create({
      reportedProfile: profile._id, reporterPhone, reporterName,
      category, description, evidenceUrls: evidenceUrls || [],
      platform, transactionId
    });

    notifyAdmin(`RAPÒ FRO: ${profile.displayName} (${category}) - rapòte pa ${reporterPhone}`);

    res.status(201).json({ message: 'Rapò anrejistre. N ap envestige.', reportId: report._id });
  } catch (err) {
    console.error('Report error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/sos — Emergency SOS
router.post('/sos', async (req, res) => {
  try {
    const { phone, name, lat, lng, platform, rideId, orderId, message, emergencyContacts } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone obligatwa' });

    const profile = await VerifiedProfile.findOne({ phone });

    const alert = await SOSAlert.create({
      phone, name, lat, lng, platform,
      rideId, orderId, message,
      emergencyContacts: emergencyContacts || [],
      profile: profile ? profile._id : undefined
    });

    notifyAdmin(`SOS IJANS! ${name || phone} - ${platform || 'unknown'} - Lat:${lat || '?'} Lng:${lng || '?'}`);

    res.status(201).json({
      message: 'Alèt SOS voye! Ekip sekirite a ap reponn.',
      alertId: alert._id,
      status: 'active'
    });
  } catch (err) {
    console.error('SOS error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/search — Search verified profiles
router.get('/search', async (req, res) => {
  try {
    const { q, type, platform, status, page = 1, limit = 20 } = req.query;
    const filter = {};

    if (q) {
      filter.$or = [
        { displayName: { $regex: q, $options: 'i' } },
        { businessName: { $regex: q, $options: 'i' } },
        { phone: { $regex: q } },
        { qrCode: q.toUpperCase() }
      ];
    }
    if (type) filter.profileType = type;
    if (platform) filter.platforms = platform;
    if (status) filter.status = status;
    else filter.status = { $in: ['verified', 'premium_verified', 'syndicate_verified'] };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [profiles, total] = await Promise.all([
      VerifiedProfile.find(filter)
        .select('displayName profileType status photoUrl rating trustScore qrCode platforms businessName professionalTitle totalRatings createdAt')
        .sort({ trustScore: -1, rating: -1 })
        .skip(skip).limit(parseInt(limit)).lean(),
      VerifiedProfile.countDocuments(filter)
    ]);

    res.json({ profiles, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// ===== ADMIN ROUTES =====
// The console code is no longer a literal here — see utils/consolePin.js.
const { requirePin } = require('../utils/consolePin');

// POST /api/verify/admin/migrate-drivers — Import existing drivers into verified system
router.post('/admin/migrate-drivers', requirePin, async (req, res) => {
  try {
    const drivers = await Driver.find({});
    let migrated = 0, skipped = 0, errors = 0;
    const results = [];

    for (const d of drivers) {
      const existing = await VerifiedProfile.findOne({ phone: d.phone });
      if (existing) {
        if (!existing.linkedDriverId) {
          existing.linkedDriverId = d._id;
          existing.totalTrips = Math.max(existing.totalTrips, d.totalRides || 0);
          if (d.rating && d.rating > 0) existing.rating = d.rating;
          existing.computeTrustScore();
          await existing.save();
        }
        skipped++;
        results.push({ phone: d.phone, name: d.firstName + ' ' + d.lastName, action: 'already_exists' });
        continue;
      }

      try {
        let qrCode = genQR();
        while (await VerifiedProfile.findOne({ qrCode })) qrCode = genQR();

        const profile = await VerifiedProfile.create({
          phone: d.phone,
          email: d.email,
          firstName: d.firstName,
          lastName: d.lastName,
          displayName: d.firstName + ' ' + d.lastName,
          profileType: 'driver',
          status: d.verified ? 'verified' : 'pending',
          photoUrl: d.photoUrl || undefined,
          driverLicenseUrl: d.licensePhotoUrl || undefined,
          phoneVerified: true,
          qrCode,
          platforms: ['msouwout'],
          linkedDriverId: d._id,
          rating: d.rating || 0,
          totalRatings: 0,
          totalTrips: d.totalRides || 0,
          verifiedAt: d.verified ? new Date() : undefined,
          verifiedBy: d.verified ? 'migration' : undefined,
          vehicleDocs: d.licensePlate && d.licensePlate !== 'PENDING' ? [{ type: 'plate', label: d.licensePlate }] : [],
          statusHistory: [{ status: d.verified ? 'verified' : 'pending', by: 'migration', note: 'Migrated from MsouWout driver registration' }]
        });

        profile.computeTrustScore();
        await profile.save();

        migrated++;
        results.push({ phone: d.phone, name: d.firstName + ' ' + d.lastName, qrCode, action: 'migrated', status: profile.status });
      } catch (err) {
        errors++;
        results.push({ phone: d.phone, name: d.firstName + ' ' + d.lastName, action: 'error', error: err.message });
      }
    }

    res.json({
      message: 'Migrasyon fini',
      total_drivers: drivers.length,
      migrated, skipped, errors,
      results
    });
  } catch (err) {
    console.error('Migration error:', err);
    res.status(500).json({ error: 'Erè sèvè' });
  }
});
// GET /api/verify/admin/pending — List pending verifications
router.get('/admin/pending', requirePin, async (req, res) => {
  try {
    const profiles = await VerifiedProfile.find({ status: 'pending' })
      .sort({ createdAt: 1 }).lean();
    res.json({ profiles, total: profiles.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/admin/dashboard — Verification stats
router.get('/admin/dashboard', requirePin, async (req, res) => {
  try {
    const [total, pending, verified, premium, syndicate, suspended,
           byType, recentAlerts, openReports] = await Promise.all([
      VerifiedProfile.countDocuments(),
      VerifiedProfile.countDocuments({ status: 'pending' }),
      VerifiedProfile.countDocuments({ status: 'verified' }),
      VerifiedProfile.countDocuments({ status: 'premium_verified' }),
      VerifiedProfile.countDocuments({ status: 'syndicate_verified' }),
      VerifiedProfile.countDocuments({ status: 'suspended' }),
      VerifiedProfile.aggregate([{ $group: { _id: '$profileType', count: { $sum: 1 } } }]),
      SOSAlert.find({ status: 'active' }).sort({ createdAt: -1 }).limit(5).lean(),
      FraudReport.countDocuments({ status: { $in: ['open', 'investigating'] } })
    ]);

    res.json({
      total, pending, verified, premium, syndicate, suspended,
      byType: byType.reduce((acc, t) => { acc[t._id] = t.count; return acc; }, {}),
      recentAlerts,
      openReports
    });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/admin/approve — Approve verification
router.post('/admin/approve', requirePin, async (req, res) => {
  try {
    const { profileId, level, note } = req.body;
    const validLevels = ['verified', 'premium_verified', 'syndicate_verified'];
    const newStatus = validLevels.includes(level) ? level : 'verified';

    const profile = await VerifiedProfile.findById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    profile.status = newStatus;
    profile.verifiedAt = new Date();
    profile.verifiedBy = 'admin';
    profile.rejectedAt = undefined;
    profile.rejectedReason = undefined;
    profile.statusHistory.push({ status: newStatus, by: 'admin', note: note || 'Approved' });
    profile.computeTrustScore();
    await profile.save();

    if (profile.profileType === 'driver' && profile.linkedDriverId) {
      await Driver.findByIdAndUpdate(profile.linkedDriverId, { verified: true });
    }

    res.json({ message: 'Profil apwouve!', status: profile.status, trustScore: profile.trustScore });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/admin/reject — Reject verification
router.post('/admin/reject', requirePin, async (req, res) => {
  try {
    const { profileId, reason } = req.body;
    const profile = await VerifiedProfile.findById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    profile.status = 'pending';
    profile.rejectedAt = new Date();
    profile.rejectedReason = reason || 'Dokiman pa konplè';
    profile.statusHistory.push({ status: 'rejected', by: 'admin', note: reason });
    await profile.save();

    res.json({ message: 'Verifikasyon rejte', reason });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/admin/suspend — Suspend a user
router.post('/admin/suspend', requirePin, async (req, res) => {
  try {
    const { profileId, reason } = req.body;
    const profile = await VerifiedProfile.findById(profileId);
    if (!profile) return res.status(404).json({ error: 'Profil pa jwenn' });

    profile.status = 'suspended';
    profile.suspendedAt = new Date();
    profile.suspendReason = reason;
    profile.statusHistory.push({ status: 'suspended', by: 'admin', note: reason });
    await profile.save();

    if (profile.profileType === 'driver' && profile.linkedDriverId) {
      await Driver.findByIdAndUpdate(profile.linkedDriverId, { verified: false, status: 'offline' });
    }

    res.json({ message: 'Kont sispann', reason });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/admin/alerts — SOS alerts
router.get('/admin/alerts', requirePin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const alerts = await SOSAlert.find(filter).sort({ createdAt: -1 }).limit(50)
      .populate('profile', 'displayName qrCode').lean();
    res.json({ alerts, total: alerts.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// POST /api/verify/admin/alert/:id/respond — Respond to SOS
router.post('/admin/alert/:id/respond', requirePin, async (req, res) => {
  try {
    const { status, note } = req.body;
    const alert = await SOSAlert.findByIdAndUpdate(req.params.id, {
      status: status || 'responded',
      respondedAt: new Date(),
      adminNote: note,
      ...(status === 'resolved' ? { resolvedAt: new Date() } : {})
    }, { new: true });
    if (!alert) return res.status(404).json({ error: 'Alèt pa jwenn' });
    res.json({ message: 'Alèt aktyalize', alert });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/admin/reports — Fraud reports
router.get('/admin/reports', requirePin, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = status ? { status } : {};
    const reports = await FraudReport.find(filter).sort({ createdAt: -1 }).limit(50)
      .populate('reportedProfile', 'displayName phone qrCode profileType').lean();
    res.json({ reports, total: reports.length });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

// GET /api/verify/admin/all — All profiles (paginated)
router.get('/admin/all', requirePin, async (req, res) => {
  try {
    const { type, status, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (type) filter.profileType = type;
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [profiles, total] = await Promise.all([
      VerifiedProfile.find(filter).sort({ createdAt: -1 })
        .skip(skip).limit(parseInt(limit)).lean(),
      VerifiedProfile.countDocuments(filter)
    ]);

    res.json({ profiles, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ error: 'Erè sèvè' });
  }
});

module.exports = router;
