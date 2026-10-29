/* Paying for and making AI flyer designs. See models/FlyerOrder.js for why
 * this is not a ticket, and utils/flyerAi.js for what the AI is (and is not)
 * allowed to draw.
 *
 * The rules are the ticket rules:
 *   - only the provider says a payment happened (SolutionIP for wallets,
 *     Stripe for cards), and only for the amount we asked;
 *   - nothing is made before that;
 *   - a paid order is made exactly once, however many phones are polling it.
 * ⛔ Nothing here refunds. A paid order the AI cannot make stays "failed"
 * with its reference, so it can be retried or settled by a person.
 */
const FlyerOrder = require('../models/FlyerOrder');
const Event = require('../models/Event');
const stripe = require('./stripe');
const { paymentConfirmed } = require('./verifyPayment');
const flyerAi = require('./flyerAi');

const MAX_ATTEMPTS = 3;
/* A worker that has not finished in this long is assumed dead (a restart in
   the middle of a call) and the order may be claimed again. */
const STALE_MS = 6 * 60 * 1000;
/* Platform-wide ceiling on generations per day - a guard against a bug or a
   loop spending the OpenAI credit, not a sales limit. A paid order over the
   ceiling simply waits as "paid" until the next day. */
const DAILY_CAP = () => Number(process.env.FLYER_DAILY_CAP || 100);
const CHECK_EVERY_MS = 4000;

function price() { return Number(process.env.FLYER_PRICE_HTG || 500); }

/* Returns the fresh order. Fails closed: if the provider cannot be asked, the
   order stays pending. */
async function reconcile(order, force) {
  if (!order || order.status !== 'pending') return order;
  if (!force && order.lastCheckAt && Date.now() - order.lastCheckAt.getTime() < CHECK_EVERY_MS) return order;
  await FlyerOrder.updateOne({ _id: order._id }, { $set: { lastCheckAt: new Date() } });

  let confirmed = false;
  const extra = {};
  if (order.stripeSessionId) {
    const out = await stripe.confirmCheckout(order.stripeSessionId, order.amount, order.currency);
    if (!out.ok) return order;
    if (out.stripe_paid && !out.amount_matches) {
      console.error('flyer reconcile: ' + order.referenceId + ' paid at Stripe for ' + out.amount_total +
        ' but we asked ' + order.amount + ' ' + order.currency + '. NOT marking it paid.');
      return order;
    }
    confirmed = out.paid;
    if (confirmed) Object.assign(extra, { stripePaymentIntent: out.payment_intent || null,
                                          paidAmount: out.amount_total, paidCurrency: out.currency });
  } else {
    confirmed = (await paymentConfirmed(order.referenceId, 'flyer reconcile', order.amount)).confirmed;
    if (confirmed) Object.assign(extra, { paidAmount: order.amount, paidCurrency: order.currency });
  }
  if (!confirmed) return order;

  /* pending -> paid, once. */
  await FlyerOrder.updateOne({ _id: order._id, status: 'pending' },
    { $set: Object.assign({ status: 'paid', paidAt: new Date() }, extra) });
  return FlyerOrder.findById(order._id).select('-images.data');
}

function startOfToday() { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d; }

/* Claims the order for ONE worker and makes the designs. Safe to call from
   every poll: the claim is a single conditional update, so only one caller
   ever gets past it. Resolves when finished; callers do not wait for it. */
async function runGeneration(referenceId) {
  if (!flyerAi.configured()) return;
  const today = await FlyerOrder.countDocuments({ genStartedAt: { $gte: startOfToday() } });
  if (today >= DAILY_CAP()) {
    console.error('flyer: daily cap of ' + DAILY_CAP() + ' generations reached - ' + referenceId + ' waits');
    return;
  }
  const now = new Date();
  const claimed = await FlyerOrder.findOneAndUpdate(
    { referenceId, genAttempts: { $lt: MAX_ATTEMPTS },
      $or: [{ status: 'paid' }, { status: 'generating', genStartedAt: { $lt: new Date(now - STALE_MS) } }] },
    { $set: { status: 'generating', genStartedAt: now, genError: '' }, $inc: { genAttempts: 1 } },
    { returnDocument: 'after' }
  ).select('-images.data');
  if (!claimed) return;

  try {
    const event = await Event.findById(claimed.event).select('type title').lean();
    const out = await flyerAi.generateDesigns(event || {}, claimed.look);
    if (!out.images.length) {
      await FlyerOrder.updateOne({ _id: claimed._id, status: 'generating' },
        { $set: { status: 'failed', genError: out.errors.join(' | ').slice(0, 500) } });
      console.error('flyer: no design for ' + referenceId + ': ' + out.errors.join(' | '));
      return;
    }
    const cost = out.images.reduce((s, i) => s + (i.costUsd || 0), 0);
    await FlyerOrder.updateOne({ _id: claimed._id, status: 'generating' }, { $set: {
      status: 'ready', readyAt: new Date(), images: out.images,
      aiCostUsd: Math.round(cost * 1000) / 1000,
      genError: out.errors.length ? out.errors.join(' | ').slice(0, 500) : '' } });
  } catch (e) {
    await FlyerOrder.updateOne({ _id: claimed._id, status: 'generating' },
      { $set: { status: 'failed', genError: String(e.message || e).slice(0, 500) } }).catch(() => {});
    console.error('flyer: generation crashed for ' + referenceId + ': ' + e.message);
  }
}

/* A payment provider said something about this reference (webhook). */
async function nudge(referenceId) {
  const order = await FlyerOrder.findOne({ referenceId }).select('-images.data');
  if (!order) return null;
  const fresh = await reconcile(order, true);
  if (fresh && fresh.status === 'paid') runGeneration(referenceId).catch(() => {});
  return fresh;
}

module.exports = { reconcile, runGeneration, nudge, price, MAX_ATTEMPTS };
