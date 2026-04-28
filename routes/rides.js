const express = require('express');
const router = express.Router();
const Ride = require('../models/Ride');
const Driver = require('../models/Driver');
const Event = require('../models/Event');

const FARE_PER_KM_CAR = 75;
const FARE_PER_KM_MOTO = 40;
const BASE_FARE_CAR = 150;
const BASE_FARE_MOTO = 75;
const PLATFORM_FEE_PCT = 0.10;

function estimateFare(vehicleType, distanceKm) {
  const base = vehicleType === 'car' ? BASE_FARE_CAR : BASE_FARE_MOTO;
  const perKm = vehicleType === 'car' ? FARE_PER_KM_CAR : FARE_PER_KM_MOTO;
  const subtotal = base + Math.round(perKm * (distanceKm || 5));
  const fee = Math.round(subtotal * PLATFORM_FEE_PCT);
  return { subtotal, fee, total: subtotal + fee };
}

router.post('/request', async (req, res) => {
  try {
    const { riderName, riderPhone, vehicleType, pickupAddress, pickupLat, pickupLng,
            dropoffAddress, dropoffLat, dropoffLng, scheduledDate, scheduledTime,
            eventId, ticketRef, notes, distance } = req.body;

    if (!riderPhone || !vehicleType || !pickupAddress || !dropoffAddress) {
      return res.status(400).json({ error: 'Missing required fields: riderPhone, vehicleType, pickupAddress, dropoffAddress' });
    }

    const fare = estimateFare(vehicleType, distance);

    const isNow = !scheduledDate && !scheduledTime;
    const now = new Date();
    const ride = new Ride({
      riderName: riderName || '',
      riderPhone, vehicleType,
      pickupAddress, pickupLat, pickupLng,
      dropoffAddress, dropoffLat, dropoffLng,
      scheduledDate: scheduledDate || now.toISOString().split('T')[0],
      scheduledTime: scheduledTime || now.toTimeString().slice(0, 5),
      isNow,
      event: eventId || undefined,
      ticketRef: ticketRef || '',
      notes: notes || '',
      distance: distance || 0,
      estimatedFare: fare.total
    });
    await ride.save();

    res.json({
      success: true, ride: ride._id,
      estimatedFare: fare.total, fareBreakdown: fare,
      status: 'pending'
    });
  } catch (err) {
    console.error('Ride request error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/estimate', (req, res) => {
  const { vehicleType, distance } = req.query;
  const fare = estimateFare(vehicleType || 'car', parseFloat(distance) || 5);
  res.json(fare);
});

router.get('/status/:id', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('driver', 'firstName lastName phone vehicleType vehicleMake vehicleModel vehicleColor licensePlate photoUrl rating totalRides')
      .populate('event', 'title date startTime location typeEmoji');
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/my-rides', async (req, res) => {
  try {
    const { phone } = req.query;
    if (!phone) return res.status(400).json({ error: 'Phone required' });
    const rides = await Ride.find({ riderPhone: phone })
      .populate('driver', 'firstName lastName phone vehicleType licensePlate photoUrl rating')
      .populate('event', 'title date location typeEmoji')
      .sort({ createdAt: -1 }).limit(20);
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/cancel/:id', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (['completed', 'cancelled'].includes(ride.status)) {
      return res.status(400).json({ error: 'Cannot cancel this ride' });
    }
    ride.status = 'cancelled';
    ride.cancelledBy = req.body.by || 'rider';
    ride.cancelReason = req.body.reason || '';
    await ride.save();

    if (ride.driver) {
      const driver = await Driver.findById(ride.driver);
      if (driver) { driver.status = 'available'; await driver.save(); }
    }
    res.json({ success: true, status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/rate/:id', async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (ride.status !== 'completed') return res.status(400).json({ error: 'Ride not completed' });

    const { rating, by } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1-5' });

    if (by === 'driver') {
      ride.riderRating = rating;
    } else {
      ride.driverRating = rating;
      if (ride.driver) {
        const driver = await Driver.findById(ride.driver);
        if (driver) {
          const newTotal = driver.totalRides || 1;
          driver.rating = Math.round(((driver.rating * (newTotal - 1)) + rating) / newTotal * 10) / 10;
          await driver.save();
        }
      }
    }
    await ride.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ═══════════════════════════════════════
// DRIVER ENDPOINTS
// ═══════════════════════════════════════

router.post('/driver/register', async (req, res) => {
  try {
    const { firstName, lastName, phone, email, vehicleType, vehicleMake,
            vehicleModel, vehicleColor, licensePlate, photoUrl, licensePhotoUrl, zone } = req.body;

    if (!firstName || !lastName || !phone || !vehicleType || !licensePlate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const existing = await Driver.findOne({ phone });
    if (existing) return res.status(409).json({ error: 'Phone already registered', driverId: existing._id });

    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    const driver = new Driver({
      firstName, lastName, phone, email,
      vehicleType, vehicleMake, vehicleModel, vehicleColor,
      licensePlate, photoUrl, licensePhotoUrl, zone, pin
    });
    await driver.save();

    res.json({ success: true, driverId: driver._id, pin, message: 'Registration submitted. Pending verification.' });
  } catch (err) {
    console.error('Driver register error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/login', async (req, res) => {
  try {
    const { phone, pin } = req.body;
    if (!phone || !pin) return res.status(400).json({ error: 'Phone and PIN required' });

    const driver = await Driver.findOne({ phone });
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (driver.pin !== pin) return res.status(401).json({ error: 'Wrong PIN' });

    res.json({ success: true, driver });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/status', async (req, res) => {
  try {
    const { driverId, status } = req.body;
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (!driver.verified) return res.status(403).json({ error: 'Driver not verified yet' });

    driver.status = status;
    await driver.save();
    res.json({ success: true, status: driver.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/location', async (req, res) => {
  try {
    const { driverId, lat, lng } = req.body;
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    driver.location = { lat, lng, updatedAt: new Date() };
    await driver.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/driver/rides', async (req, res) => {
  try {
    const { driverId, status } = req.query;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const filter = { driver: driverId };
    if (status) filter.status = status;

    const rides = await Ride.find(filter)
      .populate('event', 'title date location typeEmoji')
      .sort({ scheduledDate: -1, scheduledTime: -1 }).limit(50);
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/driver/available-rides', async (req, res) => {
  try {
    const { driverId } = req.query;
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const rides = await Ride.find({
      status: 'pending',
      vehicleType: driver.vehicleType,
      driver: null
    }).populate('event', 'title date location typeEmoji').sort({ createdAt: -1 }).limit(20);
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/accept/:rideId', async (req, res) => {
  try {
    const { driverId } = req.body;
    const driver = await Driver.findById(driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    if (!driver.verified) return res.status(403).json({ error: 'Not verified' });

    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (ride.status !== 'pending') return res.status(400).json({ error: 'Ride no longer available' });

    ride.driver = driverId;
    ride.status = 'accepted';
    ride.acceptedAt = new Date();
    await ride.save();

    driver.status = 'busy';
    await driver.save();

    res.json({ success: true, ride });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/update-ride/:rideId', async (req, res) => {
  try {
    const { driverId, status } = req.body;
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (ride.driver?.toString() !== driverId) return res.status(403).json({ error: 'Not your ride' });

    const validTransitions = {
      'accepted': ['driver_enroute', 'cancelled'],
      'driver_enroute': ['arrived', 'cancelled'],
      'arrived': ['in_progress', 'cancelled'],
      'in_progress': ['completed']
    };

    if (!validTransitions[ride.status]?.includes(status)) {
      return res.status(400).json({ error: `Cannot go from ${ride.status} to ${status}` });
    }

    ride.status = status;
    if (status === 'in_progress') ride.startedAt = new Date();
    if (status === 'completed') {
      ride.completedAt = new Date();
      ride.fare = ride.estimatedFare;
      const driver = await Driver.findById(driverId);
      if (driver) {
        driver.totalRides += 1;
        driver.totalEarnings += Math.round(ride.fare * (1 - PLATFORM_FEE_PCT));
        driver.status = 'available';
        await driver.save();
      }
    }
    if (status === 'cancelled') {
      ride.cancelledBy = 'driver';
      const driver = await Driver.findById(driverId);
      if (driver) { driver.status = 'available'; await driver.save(); }
    }
    await ride.save();

    res.json({ success: true, ride });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/driver/stats/:driverId', async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const today = new Date().toISOString().split('T')[0];
    const todayRides = await Ride.countDocuments({ driver: driver._id, status: 'completed', scheduledDate: today });
    const pendingRides = await Ride.countDocuments({ driver: driver._id, status: { $in: ['accepted', 'driver_enroute', 'arrived', 'in_progress'] } });

    res.json({
      totalRides: driver.totalRides,
      totalEarnings: driver.totalEarnings,
      rating: driver.rating,
      todayRides, pendingRides,
      verified: driver.verified,
      status: driver.status
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/driver/verify/:driverId', async (req, res) => {
  try {
    const driver = await Driver.findById(req.params.driverId);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    driver.verified = true;
    await driver.save();
    res.json({ success: true, message: 'Driver verified' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
