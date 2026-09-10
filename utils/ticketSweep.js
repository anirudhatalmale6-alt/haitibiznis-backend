/* Confirming a payment without waiting for anybody to open a page.
 *
 * THE COMPLAINT THIS EXISTS TO FIX. On 10 September a real ticket was bought
 * for 20 HTG on MonCash. The money left the buyer. The ticket sat at "pending"
 * and no QR code ever appeared, so as far as the buyer was concerned he had
 * paid for nothing.
 *
 * Nothing was broken at the gateway - asked directly, it said the payment had
 * arrived. The problem is WHERE the asking happens. A ticket only reconciles
 * when routes/payments.js serves it, which needs the buyer to land back on
 * ticket.html after paying. On a Haitian phone that return trip is the least
 * reliable part of the whole flow: MonCash finishes inside its own app, the
 * buyer closes it, and nobody ever opens the page. The ticket then stays
 * unpaid for ever with the money already gone.
 *
 * So the server asks on its own, on a timer, for every ticket still unpaid.
 * Nobody has to open anything.
 *
 * Deliberate limits:
 *   - It reuses markPaid from routes/payments.js rather than writing its own
 *     update. markPaid is the atomic claim that stops a sale being counted
 *     twice when the sweep and the ticket page find the same payment in the
 *     same second. A second implementation here would be a second bug.
 *   - MIN_AGE_MS: a ticket that was created seconds ago is somebody standing
 *     at the payment screen right now. Asking about it is pointless and only
 *     adds load.
 *   - MAX_AGE_MS: after two days an unpaid ticket is somebody who changed
 *     their mind, not a lost payment. Without this the sweep would ask the
 *     gateway about every abandoned checkout in the platform's history, for
 *     ever.
 *   - BATCH: bounded work per tick, so a backlog drains over several minutes
 *     instead of firing hundreds of gateway calls at once.
 *   - Failure is silent and harmless: paymentConfirmed only returns true for a
 *     real confirmation, so an unreachable gateway leaves every ticket exactly
 *     as it was.
 */
const Transaction = require('../models/Transaction');

const EVERY_MS = 3 * 60 * 1000;
const MIN_AGE_MS = 90 * 1000;
const MAX_AGE_MS = 48 * 60 * 60 * 1000;
const BATCH = 25;

/* Injected rather than required at the top of the file: routes/payments.js
   already requires plenty, and requiring it back from here would make a cycle
   whose failure mode is an empty object at call time - undefined is not a
   function, at three in the morning, on the one path that handles money. */
async function sweepOnce({ reconcile, onPaid }) {
  const now = Date.now();
  const pending = await Transaction.find({
    status: 'pending',
    createdAt: { $gte: new Date(now - MAX_AGE_MS), $lte: new Date(now - MIN_AGE_MS) }
  }).sort({ createdAt: 1 }).limit(BATCH);

  let confirmed = 0;
  for (const txn of pending) {
    try {
      const after = await reconcile(txn);
      if (after && after.status === 'completed') {
        confirmed++;
        console.log('ticket sweep: ' + txn.referenceId + ' was paid at the gateway. Marked paid.');
        if (onPaid) await onPaid(after).catch(() => {});
      }
    } catch (err) {
      /* One bad record must never stop the rest of the batch. */
      console.error('ticket sweep: ' + txn.referenceId + ' failed: ' + err.message);
    }
  }
  return { looked: pending.length, confirmed };
}

function startTicketSweep(deps) {
  const tick = () => {
    sweepOnce(deps).catch(err => console.error('ticket sweep error:', err.message));
  };
  /* Not immediately on boot: Render restarts this process often, and a sweep
     racing the first database connection just logs a confusing error. */
  setTimeout(tick, 30 * 1000);
  const timer = setInterval(tick, EVERY_MS);
  if (timer.unref) timer.unref();
  console.log('Ticket payment sweep enabled (every ' + (EVERY_MS / 60000) + ' min)');
  return timer;
}

module.exports = { startTicketSweep, sweepOnce, EVERY_MS, MIN_AGE_MS, MAX_AGE_MS, BATCH };
