/* AI flyers for Tike Lakay events (29 Oct 2026).
 *
 * The organiser pays one fixed price (FLYER_PRICE_HTG, 500 HTG - Jeffery's
 * figure) for three AI background designs; flyer-ai.html puts the event's own
 * words, logos, sponsors and the promotional QR on top and lets them download
 * or share the result. See utils/flyerOrders.js for the payment rules.
 */
const express = require('express');
const router = express.Router();
const QRCode = require('qrcode');
const mongoose = require('mongoose');
const FlyerOrder = require('../models/FlyerOrder');
const Event = require('../models/Event');
const stripe = require('../utils/stripe');
const flyerAi = require('../utils/flyerAi');
const flyerOrders = require('../utils/flyerOrders');
const { requirePin } = require('../utils/consolePin');
const { phoneKey } = require('../utils/ticketDelivery');
const clientIp = require('../utils/clientIp');

const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const FLYER_PAGE = process.env.FLYER_PAGE_URL || (require('../utils/tlBase') + '/flyer-ai.html');

/* ⛔ THE PROMOTIONAL QR IS THE PUBLIC EVENT PAGE AND NOTHING ELSE.
   An admission QR carries a ticket's secret; this one carries an event id that
   is already in every shared link. The door page refuses it - it is not a
   ticket reference and not an admission token - so it can never let anyone in. */
const PROMO_BASE = process.env.TL_PROMO_BASE || 'https://tikelakay.com/event.html?id=';
function promoUrl(eventId) { return PROMO_BASE + encodeURIComponent(String(eventId)); }

function genRef() {
  return 'FL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/* Opening checkouts costs nothing but clutters the gateway; 10 an hour per
   address is far more than an organiser needs. */
const HITS = new Map();
function orderLimit(req, res, next) {
  const ip = clientIp(req), now = Date.now();
  const list = (HITS.get(ip) || []).filter(t => now - t < 3600 * 1000);
  if (list.length >= 10) return res.status(429).json({ error: 'Twòp demann. Eseye ankò nan yon èdtan.' });
  list.push(now); HITS.set(ip, list);
  if (HITS.size > 5000) HITS.clear();
  next();
}

function publicView(o) {
  return {
    referenceId: o.referenceId,
    status: o.status,
    eventId: String(o.event),
    eventTitle: o.eventTitle || '',
    amount: o.amount,
    currency: o.currency,
    paymentMethod: o.paymentMethod,
    paymentUrl: o.status === 'pending' ? (o.paymentUrl || '') : undefined,
    images: (o.images || []).map((im, i) => ({ i, style: im.style })),
    canRetry: o.status === 'failed' && (o.genAttempts || 0) < flyerOrders.MAX_ATTEMPTS,
    attempts: o.genAttempts || 0,
    promoUrl: promoUrl(o.event)
  };
}

router.get('/config', (req, res) => {
  res.json({
    price: flyerOrders.price(), currency: 'HTG',
    designs: flyerAi.STYLES.length,
    ai: flyerAi.configured(),
    methods: { moncash: true, natcash: true, card: stripe.configured() }
  });
});

router.get('/qr/:eventId', async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.eventId)) return res.status(404).json({ error: 'Event not found' });
    const event = await Event.findById(req.params.eventId).select('_id').lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const png = await QRCode.toBuffer(promoUrl(event._id),
      { type: 'png', width: 600, margin: 2, errorCorrectionLevel: 'M', color: { dark: '#0A0E1A', light: '#FFFFFF' } });
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(png);
  } catch (err) {
    res.status(500).json({ error: 'QR failed' });
  }
});

router.post('/order', orderLimit, async (req, res) => {
  try {
    const { eventId, paymentMethod, phone, look } = req.body || {};
    if (!['moncash', 'natcash', 'card'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Chwazi MonCash, NatCash oswa kat.' });
    }
    if (!mongoose.isValidObjectId(eventId)) return res.status(404).json({ error: 'Event not found' });
    const event = await Event.findById(eventId).select('title status').lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'cancelled') return res.status(400).json({ error: 'Evènman sa a anile.' });
    if (!flyerAi.configured()) return res.status(503).json({ error: 'Flyer AI pa disponib pou kounye a.' });

    const amount = flyerOrders.price();
    const ref = genRef();
    const order = await FlyerOrder.create({
      referenceId: ref, event: event._id, eventTitle: event.title,
      amount, currency: 'HTG', paymentMethod,
      phone: String(phone || '').slice(0, 30), phoneKey: phoneKey(phone),
      look: String(look || '').slice(0, 200)
    });
    const returnUrl = FLYER_PAGE + '?ref=' + encodeURIComponent(ref);

    if (paymentMethod === 'card') {
      if (!stripe.configured()) {
        await FlyerOrder.deleteOne({ _id: order._id });
        return res.status(503).json({ error: 'Kat kredi pa disponib pou kounye a.' });
      }
      const sess = await stripe.createCheckout({
        amount, currency: 'HTG', label: 'Flyer AI — ' + event.title, reference: ref,
        successUrl: returnUrl, cancelUrl: FLYER_PAGE + '?id=' + encodeURIComponent(String(event._id)),
        metadata: { kind: 'flyer', event: String(event._id) }
      });
      if (!sess.ok) {
        await FlyerOrder.deleteOne({ _id: order._id });
        return res.status(502).json({ error: 'Nou pa ka louvri paj peman an. Eseye ankò.' });
      }
      await FlyerOrder.updateOne({ _id: order._id }, { $set: { stripeSessionId: sess.id, paymentUrl: sess.url } });
      return res.json({ success: true, referenceId: ref, paymentUrl: sess.url, amount });
    }

    const sipRes = await fetch(SIP_URL + '/api/paiement-marchand', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SIP_CLIENT, refference_id: ref, montant: amount,
                             payment_method: paymentMethod, return_url: returnUrl })
    });
    const sip = await sipRes.json().catch(() => ({}));
    if (sip.status && sip.url) {
      await FlyerOrder.updateOne({ _id: order._id },
        { $set: { sipTransactionId: sip.transaction_id || '', paymentUrl: sip.url } });
      return res.json({ success: true, referenceId: ref, paymentUrl: sip.url, amount });
    }
    await FlyerOrder.deleteOne({ _id: order._id });
    res.status(502).json({ error: 'Nou pa ka louvri paj peman an. Eseye ankò.' });
  } catch (err) {
    console.error('flyer order error:', err.message);
    res.status(500).json({ error: 'Erè. Eseye ankò.' });
  }
});

/* The admin list sits above /:ref so "admin" is never read as a reference. */
router.get('/admin/orders', requirePin, async (req, res) => {
  try {
    const orders = await FlyerOrder.find({}).select('-images.data').sort({ createdAt: -1 }).limit(500).lean();
    const paid = orders.filter(o => ['paid', 'generating', 'ready', 'failed'].includes(o.status));
    res.json({
      totals: {
        paidOrders: paid.length,
        revenueHtg: paid.reduce((s, o) => s + (o.amount || 0), 0),
        aiCostUsd: Math.round(orders.reduce((s, o) => s + (o.aiCostUsd || 0), 0) * 100) / 100,
        failed: orders.filter(o => o.status === 'failed').length
      },
      orders: orders.map(o => ({
        referenceId: o.referenceId, status: o.status, eventTitle: o.eventTitle, amount: o.amount,
        paymentMethod: o.paymentMethod, phone: o.phone, createdAt: o.createdAt, paidAt: o.paidAt,
        designs: (o.images || []).length, aiCostUsd: o.aiCostUsd, attempts: o.genAttempts, error: o.genError || ''
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:ref', async (req, res) => {
  try {
    let order = await FlyerOrder.findOne({ referenceId: String(req.params.ref) }).select('-images.data');
    if (!order) return res.status(404).json({ error: 'Not found' });
    order = await flyerOrders.reconcile(order);
    if (order.status === 'paid' || order.status === 'generating') {
      flyerOrders.runGeneration(order.referenceId).catch(() => {});
    }
    res.json(publicView(order));
  } catch (err) {
    res.status(500).json({ error: 'Erè. Eseye ankò.' });
  }
});

router.post('/:ref/retry', async (req, res) => {
  try {
    const order = await FlyerOrder.findOneAndUpdate(
      { referenceId: String(req.params.ref), status: 'failed', genAttempts: { $lt: flyerOrders.MAX_ATTEMPTS } },
      { $set: { status: 'paid' } }, { returnDocument: 'after' }).select('-images.data');
    if (!order) return res.status(409).json({ error: 'Pa ka eseye ankò.' });
    flyerOrders.runGeneration(order.referenceId).catch(() => {});
    res.json(publicView(order));
  } catch (err) {
    res.status(500).json({ error: 'Erè. Eseye ankò.' });
  }
});

router.get('/:ref/img/:i', async (req, res) => {
  try {
    const i = Number(req.params.i);
    if (!Number.isInteger(i) || i < 0 || i > 5) return res.status(404).end();
    const order = await FlyerOrder.findOne({ referenceId: String(req.params.ref), status: 'ready' })
      .select({ images: { $slice: [i, 1] } }).lean();
    const im = order && order.images && order.images[0];
    if (!im || !im.data) return res.status(404).end();
    const buf = Buffer.isBuffer(im.data) ? im.data : Buffer.from(im.data.buffer || im.data);
    res.set('Content-Type', im.mime || 'image/jpeg');
    res.set('Cache-Control', 'private, max-age=86400');
    res.send(buf);
  } catch (err) {
    res.status(500).end();
  }
});

module.exports = router;
