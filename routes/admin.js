const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const Transaction = require('../models/Transaction');
const Refund = require('../models/Refund');
const Event = require('../models/Event');

const { requirePin, isCustom, setConsolePin } = require('../utils/consolePin');

router.use(requirePin);

/* Has he replaced the bootstrap code yet? The console nags until he has. */
router.get('/pin-state', async (req, res) => {
  try {
    res.json({ success: true, custom: await isCustom() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Set your own console code. requirePin above already proved the caller holds
   the code currently in force, so there is nothing more to check here. The
   console sends this to both APIs, because one code opens both. */
router.post('/change-pin', async (req, res) => {
  try {
    await setConsolePin(req.body && req.body.newPin);
    res.json({ success: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalRides, todayRides, pendingRides,
      totalDrivers, verifiedDrivers,
      totalTickets, todayTickets, ticketRevenue,
      totalRefunds, pendingRefunds,
      totalEvents
    ] = await Promise.all([
      Ride.countDocuments(),
      Ride.countDocuments({ createdAt: { $gte: today } }),
      Ride.countDocuments({ status: 'pending' }),
      Driver.countDocuments(),
      Driver.countDocuments({ verified: true }),
      Transaction.countDocuments(),
      Transaction.countDocuments({ createdAt: { $gte: today } }),
      Transaction.aggregate([
        { $match: { status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, fees: { $sum: '$platformFee' } } }
      ]),
      Refund.countDocuments(),
      Refund.countDocuments({ status: 'pending' }),
      Event.countDocuments()
    ]);

    const rev = ticketRevenue[0] || { total: 0, fees: 0 };

    const recent = [];

    const recentRides = await Ride.find().sort({ createdAt: -1 }).limit(5).lean();
    recentRides.forEach(r => recent.push({
      type: 'ride', date: r.createdAt,
      label: (r.riderName || 'Unknown') + ' — ' + r.vehicleType,
      detail: r.pickupAddress + ' → ' + r.dropoffAddress,
      status: r.status, phone: r.riderPhone
    }));

    const recentDrivers = await Driver.find().sort({ createdAt: -1 }).limit(5).lean();
    recentDrivers.forEach(d => recent.push({
      type: 'driver', date: d.createdAt,
      label: d.firstName + ' ' + d.lastName + ' — ' + d.vehicleType,
      detail: d.zone || 'No zone', status: d.verified ? 'verified' : 'pending',
      phone: d.phone
    }));

    const recentTickets = await Transaction.find().sort({ createdAt: -1 }).limit(5).populate('event', 'title').lean();
    recentTickets.forEach(t => recent.push({
      type: 'ticket', date: t.createdAt,
      label: (t.buyerName || 'Unknown') + ' — ' + (t.event ? t.event.title : t.ticketName),
      detail: t.referenceId + ' · ' + t.qty + 'x ' + t.ticketName,
      status: t.status, phone: t.buyerPhone
    }));

    recent.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({
      success: true,
      stats: {
        totalRides, todayRides, pendingRides,
        totalDrivers, verifiedDrivers,
        totalTickets, todayTickets,
        totalRevenue: rev.total, totalFees: rev.fees,
        totalRefunds, pendingRefunds, totalEvents
      },
      recent: recent.slice(0, 15)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rides', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { riderName: { $regex: search, $options: 'i' } },
        { riderPhone: { $regex: search, $options: 'i' } },
        { pickupAddress: { $regex: search, $options: 'i' } },
        { dropoffAddress: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Ride.countDocuments(filter);
    const rides = await Ride.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, rides, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drivers', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status === 'verified') filter.verified = true;
    else if (status === 'pending') filter.verified = false;
    if (search) {
      filter.$or = [
        { firstName: { $regex: search, $options: 'i' } },
        { lastName: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { zone: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Driver.countDocuments(filter);
    const drivers = await Driver.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, drivers, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/tickets', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { buyerName: { $regex: search, $options: 'i' } },
        { buyerPhone: { $regex: search, $options: 'i' } },
        { referenceId: { $regex: search, $options: 'i' } },
        { ticketName: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Transaction.countDocuments(filter);
    const tickets = await Transaction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('event', 'title typeEmoji').lean();
    res.json({ success: true, tickets, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/refunds', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { riderPhone: { $regex: search, $options: 'i' } },
        { reasonText: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Refund.countDocuments(filter);
    const refunds = await Refund.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('ride', 'riderName pickupAddress dropoffAddress').lean();
    res.json({ success: true, refunds, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
