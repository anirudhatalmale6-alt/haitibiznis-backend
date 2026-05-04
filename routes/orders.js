const express = require('express');
const router = express.Router();
const Order = require('../models/Order');

const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const PLATFORM_FEE_PCT = 0.20;
const DRIVER_PCT = 0.80;
const PERISHABLE_HOLD_HOURS = 4;
const REGULAR_HOLD_HOURS = 24;

function genRef() {
  return 'MP-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

function genPin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// Create order and initiate payment
router.post('/create', async (req, res) => {
  try {
    const { store, buyer, items, paymentMethod, isPerishable } = req.body;
    if (!store || !buyer || !items || !items.length || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const subtotal = items.reduce((sum, i) => sum + (i.price * (i.qty || 1)), 0);
    const platformFee = Math.round(subtotal * PLATFORM_FEE_PCT);
    const deliveryFee = req.body.deliveryFee || 0;
    const totalAmount = subtotal + platformFee + deliveryFee;

    const referenceId = genRef();
    const deliveryPin = genPin();

    const order = new Order({
      referenceId,
      store,
      buyer,
      items,
      subtotal,
      platformFee,
      deliveryFee,
      totalAmount,
      platformPct: PLATFORM_FEE_PCT,
      paymentMethod,
      deliveryPin,
      isPerishable: !!isPerishable,
      status: 'pending_payment'
    });

    // Call SolutionIP for payment
    const returnUrl = `https://myplopplop.com/order-status.html?ref=${referenceId}`;
    const sipRes = await fetch(`${SIP_URL}/api/paiement-marchand`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SIP_CLIENT,
        refference_id: referenceId,
        montant: totalAmount,
        payment_method: paymentMethod,
        return_url: returnUrl
      })
    });
    const sipData = await sipRes.json();

    order.sipTransactionId = sipData.transaction_id || sipData.id;
    order.paymentUrl = sipData.url || sipData.payment_url;
    await order.save();

    res.json({
      success: true,
      referenceId,
      totalAmount,
      subtotal,
      platformFee,
      deliveryFee,
      paymentUrl: order.paymentUrl,
      deliveryPin
    });
  } catch (err) {
    console.error('Order create error:', err.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Payment webhook from SolutionIP
router.post('/webhook/:method', async (req, res) => {
  try {
    const { refference_id, status } = req.body;
    if (!refference_id) return res.status(400).json({ error: 'Missing reference' });

    const order = await Order.findOne({ referenceId: refference_id });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (status === 'completed' || status === 'success') {
      order.status = 'paid';
      order.paidAt = new Date();
      await order.save();
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Order webhook error:', err.message);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// Verify payment status
router.get('/verify', async (req, res) => {
  try {
    const { ref } = req.query;
    const order = await Order.findOne({ referenceId: ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.status === 'pending_payment' && order.sipTransactionId) {
      const sipRes = await fetch(`${SIP_URL}/api/paiement-verify?client_id=${SIP_CLIENT}&order_id=${order.sipTransactionId}`);
      const sipData = await sipRes.json();
      if (sipData.status === 'completed' || sipData.status === 'success') {
        order.status = 'paid';
        order.paidAt = new Date();
        await order.save();
      }
    }

    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Verify error' });
  }
});

// Get order by reference
router.get('/:ref', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) {
    res.status(500).json({ error: 'Fetch error' });
  }
});

// Seller confirms order
router.post('/:ref/seller-confirm', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'paid') return res.status(400).json({ error: 'Order not in paid status' });

    order.status = 'seller_confirmed';
    await order.save();
    res.json({ success: true, status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Confirm error' });
  }
});

// Seller marks as preparing
router.post('/:ref/preparing', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'preparing';
    await order.save();
    res.json({ success: true, status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Update error' });
  }
});

// Seller marks ready for pickup
router.post('/:ref/ready', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'ready_for_pickup';
    await order.save();
    res.json({ success: true, status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Update error' });
  }
});

// Driver picks up
router.post('/:ref/pickup', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.body.driver) {
      order.driver = req.body.driver;
    }
    order.status = 'picked_up';
    await order.save();
    res.json({ success: true, status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Pickup error' });
  }
});

// Driver marks on the way
router.post('/:ref/on-the-way', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'on_the_way';
    await order.save();
    res.json({ success: true, status: order.status });
  } catch (err) {
    res.status(500).json({ error: 'Update error' });
  }
});

// Driver marks delivered
router.post('/:ref/deliver', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'delivered';
    if (req.body.photoUrl) order.deliveryPhotoUrl = req.body.photoUrl;

    const holdHours = order.isPerishable ? PERISHABLE_HOLD_HOURS : REGULAR_HOLD_HOURS;
    order.autoReleaseAt = new Date(Date.now() + holdHours * 60 * 60 * 1000);

    await order.save();
    res.json({ success: true, status: order.status, autoReleaseAt: order.autoReleaseAt, deliveryPin: order.deliveryPin });
  } catch (err) {
    res.status(500).json({ error: 'Deliver error' });
  }
});

// Customer confirms receipt (with PIN)
router.post('/:ref/confirm-received', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'delivered') return res.status(400).json({ error: 'Order not yet delivered' });

    if (req.body.pin && req.body.pin !== order.deliveryPin) {
      return res.status(400).json({ error: 'Invalid delivery PIN' });
    }

    order.status = 'confirmed_received';

    const holdHours = order.isPerishable ? PERISHABLE_HOLD_HOURS : REGULAR_HOLD_HOURS;
    order.autoReleaseAt = new Date(Date.now() + holdHours * 60 * 60 * 1000);

    await order.save();
    res.json({
      success: true,
      status: order.status,
      message: 'Mèsi! Lajan ap lage bay machann nan apre peryòd verifikasyon an.',
      autoReleaseAt: order.autoReleaseAt
    });
  } catch (err) {
    res.status(500).json({ error: 'Confirm error' });
  }
});

// Customer reports dispute
router.post('/:ref/dispute', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'disputed';
    order.disputeReason = req.body.reason || '';
    order.disputeAt = new Date();
    order.autoReleaseAt = null;
    await order.save();

    res.json({
      success: true,
      status: order.status,
      message: 'Nou resevwa reklamasyon ou. Ekip nou ap revize sa a. Lajan rete an sekirite.'
    });
  } catch (err) {
    res.status(500).json({ error: 'Dispute error' });
  }
});

// Admin: release funds manually
router.post('/:ref/release', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.sellerPayout = order.subtotal;
    order.driverPayout = Math.round(order.deliveryFee * DRIVER_PCT);
    order.platformEarnings = order.platformFee + (order.deliveryFee - order.driverPayout);
    order.payoutStatus = 'released';
    order.status = 'funds_released';
    order.releaseAt = new Date();
    await order.save();

    res.json({
      success: true,
      sellerPayout: order.sellerPayout,
      driverPayout: order.driverPayout,
      platformEarnings: order.platformEarnings
    });
  } catch (err) {
    res.status(500).json({ error: 'Release error' });
  }
});

// Admin: refund order
router.post('/:ref/refund', async (req, res) => {
  try {
    const order = await Order.findOne({ referenceId: req.params.ref });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    order.status = 'refunded';
    order.payoutStatus = 'refunded';
    await order.save();

    res.json({ success: true, status: 'refunded' });
  } catch (err) {
    res.status(500).json({ error: 'Refund error' });
  }
});

// Auto-release check (call this periodically)
router.post('/auto-release', async (req, res) => {
  try {
    const now = new Date();
    const orders = await Order.find({
      status: { $in: ['delivered', 'confirmed_received'] },
      payoutStatus: 'held',
      autoReleaseAt: { $lte: now }
    });

    let released = 0;
    for (const order of orders) {
      order.sellerPayout = order.subtotal;
      order.driverPayout = Math.round(order.deliveryFee * DRIVER_PCT);
      order.platformEarnings = order.platformFee + (order.deliveryFee - order.driverPayout);
      order.payoutStatus = 'released';
      order.status = 'funds_released';
      order.releaseAt = now;
      await order.save();
      released++;
    }

    res.json({ success: true, released });
  } catch (err) {
    res.status(500).json({ error: 'Auto-release error' });
  }
});

// List orders (for admin/seller dashboard)
router.get('/', async (req, res) => {
  try {
    const { status, store_phone, buyer_phone, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (store_phone) filter['store.phone'] = store_phone;
    if (buyer_phone) filter['buyer.phone'] = buyer_phone;

    const orders = await Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    const total = await Order.countDocuments(filter);

    res.json({ orders, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: 'List error' });
  }
});

module.exports = router;
