/* 5 Nov 2026 - an AI flyer must not depend on the buyer coming back to the page.
   Jennifer paid 50 HTG on MonCash, came back with the phone's Back button (to the purchase screen, not
   to her order) and "never received her flyer": a flyer order is only checked with the gateway when
   flyer-ai.html?ref=... asks for it. Same fix as utils/ticketSweep.js for tickets: the server asks on
   its own, every 3 minutes, and starts the designs as soon as the money is confirmed.
   It reuses flyerOrders.nudge / runGeneration (their conditional updates are the only claims), so a
   payment found by the page and by the sweep in the same second is still paid and generated once. */
const FlyerOrder = require('../models/FlyerOrder');
const flyerOrders = require('./flyerOrders');

const EVERY_MS = 3 * 60 * 1000;
const MIN_AGE_MS = 90 * 1000;              // someone is on the payment screen right now
const MAX_AGE_MS = 48 * 60 * 60 * 1000;    // after 2 days an unpaid order is a changed mind
const BATCH = 25;

async function sweepOnce() {
  const now = Date.now();
  const pending = await FlyerOrder.find({ status: 'pending',
    createdAt: { $gte: new Date(now - MAX_AGE_MS), $lte: new Date(now - MIN_AGE_MS) } })
    .select('referenceId').sort({ createdAt: -1 }).limit(BATCH).lean();
  let paid = 0;
  for (const o of pending) {
    const fresh = await flyerOrders.nudge(o.referenceId).catch(() => null);
    if (fresh && fresh.status === 'paid') paid++;
  }
  /* paid but the designs never started (process restarted in between), or a run that died */
  const stuck = await FlyerOrder.find({ createdAt: { $gte: new Date(now - MAX_AGE_MS) },
    $or: [{ status: 'paid' }, { status: 'generating', genStartedAt: { $lt: new Date(now - 6 * 60 * 1000) } }] })
    .select('referenceId').limit(10).lean();
  for (const o of stuck) flyerOrders.runGeneration(o.referenceId).catch(() => {});
  if (paid) console.log('flyer sweep: ' + paid + ' payment(s) confirmed without the buyer coming back');
  return { checked: pending.length, paid, restarted: stuck.length };
}

function startFlyerSweep() {
  const tick = () => { sweepOnce().catch((e) => console.error('flyer sweep error:', e.message)); };
  setTimeout(tick, 2 * 60 * 1000);
  const timer = setInterval(tick, EVERY_MS);
  if (timer.unref) timer.unref();
  console.log('Flyer payment sweep enabled (every 3 min)');
  return timer;
}

module.exports = { startFlyerSweep, sweepOnce };
