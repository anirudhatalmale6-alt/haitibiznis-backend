const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const Event = require('../models/Event');

const { notifyAdmin } = require('../utils/notify');
const { paymentConfirmed, isConfirmed, askGateway } = require('../utils/verifyPayment');
const { sendTicketLink, phoneKey } = require('../utils/ticketDelivery');

const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const PLATFORM_FEE_PCT = 0.05;

function genRef() {
  return 'TL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
}

/* Count the sale on the event, without the read-modify-write that used to be
 * here: two people paying at the same moment both loaded the event, both added
 * one, and the second save overwrote the first, so a sold ticket vanished. */
async function countSold(txn) {
  await Event.updateOne(
    { _id: txn.event, 'tickets.name': txn.ticketName },
    { $inc: { 'tickets.$.sold': txn.qty || 1 } }
  );
}

/* Mark a ticket paid, once. The find-and-update is the whole point: it is
 * atomic, so if the webhook and the ticket page both discover the same payment
 * at the same second, exactly one of them wins and the sale is counted once.
 * Returns the updated transaction, or null if somebody else got there first. */
async function markPaid(txn) {
  const claimed = await Transaction.findOneAndUpdate(
    { _id: txn._id, status: 'pending' },
    { $set: { status: 'completed', paidAt: new Date() } },
    { new: true }
  );
  if (!claimed) return null;
  await countSold(claimed);
  /* Delivery hangs off the atomic claim on purpose.
   *
   * Every route that can turn a ticket into a paid one - the webhook, /verify,
   * the ticket page reconciling on read, and the background sweep - comes
   * through here, and exactly one of them wins the claim. So this is the one
   * place in the codebase where "this ticket just became paid" is true exactly
   * once, which makes it the only correct place to send the buyer their
   * ticket. Putting the send in the callers instead would mean four copies and
   * a buyer receiving the same ticket four times.
   *
   * Not awaited: the buyer is watching a page load, and a slow WhatsApp call
   * must not hold up their QR code appearing. The result is recorded whichever
   * way it goes. */
  deliverTicket(claimed).catch(() => {});
  return claimed;
}

/* Send the buyer their ticket, once, and write down what happened.
 *
 * Fails soft in every direction: a ticket that cannot be sent is still a valid
 * ticket, and the buyer can still find it with /my-tickets. What must not
 * happen is a failure nobody can see afterwards. */
async function deliverTicket(txn) {
  if (!txn || txn.deliveredAt) return;
  let event = null;
  try {
    event = await Event.findById(txn.event).select(EVENT_FIELDS).lean();
  } catch (e) { /* an event we cannot read still has a reference number */ }

  const result = await sendTicketLink(txn, event);
  const update = { $inc: { deliveryAttempts: 1 } };
  if (result.sent) {
    update.$set = { deliveredAt: new Date(), deliveryChannel: result.channel, deliveryError: '' };
  } else {
    update.$set = { deliveryError: String(result.reason || 'unknown').slice(0, 300) };
    console.log('ticket delivery: ' + txn.referenceId + ' not sent - ' + result.reason);
  }
  /* Guarded on deliveredAt so two racing sends cannot both claim delivery. */
  await Transaction.updateOne({ _id: txn._id, deliveredAt: { $exists: false } }, update);
}

/* THE BUG THIS EXISTS TO FIX.
 *
 * A ticket only ever became "completed" in one of two places: the webhook, or
 * the /verify route. The gateway is never told where to send a webhook, so it
 * never calls one; and nothing in the site ever called /verify. Both doors
 * existed and neither was ever opened. Every one of the four tickets ever
 * bought on Tike Lakay sat at "pending" for ever, including one for 3,150 HTG
 * in May - while the gateway, asked directly, said all along that the money
 * had arrived.
 *
 * So the ticket now asks on its own behalf, every time it is looked at, for as
 * long as it is unpaid. Pulling like this needs nothing from the gateway and
 * nothing from the buyer's browser coming back, which is what makes it
 * reliable on a Haitian phone that may lose the redirect entirely.
 *
 * Fails closed: if the gateway cannot be reached, or says anything other than
 * paid, the ticket is left exactly as it was. */
async function reconcile(txn) {
  if (!txn || txn.status !== 'pending') return txn;
  const { confirmed } = await paymentConfirmed(txn.referenceId, 'ticket reconcile');
  if (!confirmed) return txn;
  const paid = await markPaid(txn);
  if (paid) {
    console.log('ticket reconcile: ' + txn.referenceId + ' was paid at the gateway ' +
      'but still said pending here. Marked paid.');
  }
  return paid || (await Transaction.findById(txn._id));
}

router.post('/buy-ticket', async (req, res) => {
  try {
    const { eventId, ticketName, qty, buyerName, buyerPhone, buyerEmail, paymentMethod, koutyeCode } = req.body;
    if (!eventId || !ticketName || !paymentMethod) {
      return res.status(400).json({ error: 'Missing required fields: eventId, ticketName, paymentMethod' });
    }

    const event = await Event.findById(eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const ticket = event.tickets.find(t => t.name === ticketName);
    if (!ticket) return res.status(404).json({ error: 'Ticket type not found' });

    const quantity = parseInt(qty) || 1;
    if (ticket.qty > 0 && ticket.sold + quantity > ticket.qty) {
      return res.status(400).json({ error: 'Not enough tickets available' });
    }

    const subtotal = ticket.price * quantity;
    const fee = Math.round(subtotal * PLATFORM_FEE_PCT);
    const total = subtotal + fee;

    if (total === 0) {
      const refId = genRef();
      const txn = new Transaction({
        event: eventId, ticketName, ticketPrice: ticket.price,
        qty: quantity, totalAmount: 0, platformFee: 0,
        referenceId: refId, paymentMethod: 'free',
        status: 'completed', buyerName, buyerPhone, buyerEmail,
        phoneKey: phoneKey(buyerPhone),
        paidAt: new Date(), koutyeCode
      });
      await txn.save();
      await countSold(txn);
      /* A free ticket never passes through markPaid - it is born completed -
         so it needs its own send, or the free workshops would be the one case
         where nobody receives anything. */
      deliverTicket(txn).catch(() => {});
      notifyAdmin('ticket', {
        name: buyerName, phone: buyerPhone, event: event.title,
        ticket: ticketName, qty: quantity, ref: refId
      }).catch(() => {});
      return res.json({ success: true, free: true, referenceId: refId, ticketName, qty: quantity });
    }

    const refId = genRef();
    const txn = new Transaction({
      event: eventId, ticketName, ticketPrice: ticket.price,
      qty: quantity, totalAmount: total, platformFee: fee,
      referenceId: refId, paymentMethod,
      buyerName, buyerPhone, buyerEmail, koutyeCode,
      phoneKey: phoneKey(buyerPhone)
    });
    await txn.save();

    const returnUrl = `https://haitibiznis.com/ticket.html?ref=${refId}`;
    const sipRes = await fetch(SIP_URL + '/api/paiement-marchand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SIP_CLIENT,
        refference_id: refId,
        montant: total,
        payment_method: paymentMethod,
        return_url: returnUrl
      })
    });
    const sipData = await sipRes.json();

    if (sipData.status && sipData.url) {
      txn.sipTransactionId = sipData.transaction_id || '';
      txn.paymentUrl = sipData.url;
      await txn.save();
      return res.json({
        success: true, referenceId: refId,
        paymentUrl: sipData.url,
        sipTransactionId: sipData.transaction_id,
        amount: total, fee, subtotal
      });
    }

    txn.status = 'failed';
    await txn.save();
    res.status(502).json({ error: 'Payment gateway error', details: sipData });
  } catch (err) {
    console.error('Buy ticket error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const { orderId, referenceId } = req.query;
    const ref = orderId || referenceId;
    if (!ref) return res.status(400).json({ error: 'Missing orderId or referenceId' });

    const txn = await Transaction.findOne({ referenceId: ref });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    if (txn.status === 'completed') {
      return res.json({ success: true, status: 'completed', transaction: txn });
    }

    const sipData = await askGateway(ref);

    if (isConfirmed(sipData)) {
      await markPaid(txn);
      const fresh = await Transaction.findById(txn._id);
      txn.paidAt = fresh.paidAt;

      return res.json({
        success: true, status: 'completed',
        payment: {
          amount: txn.totalAmount, method: txn.paymentMethod,
          date: txn.paidAt, ticketName: txn.ticketName, qty: txn.qty
        }
      });
    }

    res.json({ success: false, status: txn.status, sipStatus: sipData });
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/webhook/moncash', handleWebhook);
router.post('/webhook/natcash', handleWebhook);
router.post('/webhook/card', handleWebhook);

// This used to read "status" straight out of the POST body: anybody could
// POST {reference_id, status:"completed"} with no credential and walk out with
// a paid ticket. The reference is printed on the buyer's own ticket page
// (ticket.html?ref=...), so it was never a secret. The body is now only a
// nudge to go and ask the gateway; the gateway decides.
async function handleWebhook(req, res) {
  try {
    const ref = req.body.reference_id || req.body.refference_id || req.body.orderId;
    if (!ref) return res.status(400).json({ error: 'Missing reference' });

    const txn = await Transaction.findOne({ referenceId: ref });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });
    if (txn.status === 'completed') return res.json({ received: true, alreadyPaid: true });

    const { confirmed } = await paymentConfirmed(ref, 'ticket webhook');
    if (!confirmed) {
      // A real gateway retry must not get a 500, but nothing is issued.
      console.error('ticket webhook: ' + ref + ' was announced as paid but the ' +
        'gateway does not confirm it. Ticket left at "' + txn.status + '".');
      return res.json({ received: true, paid: false });
    }

    await markPaid(txn);
    res.json({ received: true, paid: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

const EVENT_FIELDS = 'title date startTime endTime location typeEmoji typeLabel gradient';

/* "It only asks for my phone number."
 *
 * That sentence was a complaint, but it is also the answer. The checkout asks
 * for a phone number and nothing else, so the phone number is the only handle
 * a buyer has on their own purchase. This turns it into one.
 *
 * Reconciles what it finds, which means a buyer who never came back from
 * MonCash gets their ticket confirmed by the act of looking for it.
 *
 * ⚠️ Judgement call, stated plainly rather than buried: this is not
 * authentication. Anybody who types a number that bought a ticket sees that
 * ticket. The alternatives were an account system on a platform whose buyers
 * have no email, or leaving people with no way at all to recover a ticket they
 * paid for - which is the situation that produced the complaint. What limits
 * the damage is elsewhere and already built: a ticket can only be used once at
 * the door, and a second scan is visible rather than silent.
 *
 * Rate limited so the whole ticket list cannot be walked by trying numbers.
 */
const lookupHits = new Map();
const LOOKUP_MAX = 12;
const LOOKUP_WINDOW_MS = 10 * 60 * 1000;

/* Only EMPTY lookups count against the limit.
 *
 * Counting every lookup was the obvious version and it is wrong in the place
 * that matters: at the door of a workshop, thirty people on one venue wifi all
 * look up their own ticket from the same public address, and the twelfth one
 * is told to come back in ten minutes. That is a queue in the street caused by
 * a security control that is not protecting anything - each of those thirty
 * asked about a number they own and got their own ticket.
 *
 * Somebody walking the ticket list, on the other hand, is guessing, and a
 * guess that misses returns nothing. So the miss is what gets counted. The
 * legitimate buyer is never rate limited; the person trying numbers is stopped
 * after twelve wrong ones.
 */
function lookupMisses(ip) {
  const now = Date.now();
  const hits = (lookupHits.get(ip) || []).filter(t => now - t < LOOKUP_WINDOW_MS);
  lookupHits.set(ip, hits);
  return hits.length;
}

function recordMiss(ip) {
  const now = Date.now();
  const hits = (lookupHits.get(ip) || []).filter(t => now - t < LOOKUP_WINDOW_MS);
  hits.push(now);
  lookupHits.set(ip, hits);
  /* Unbounded growth is a slow leak on a long-running process. */
  if (lookupHits.size > 5000) {
    for (const [k, v] of lookupHits) {
      if (!v.length || now - v[v.length - 1] > LOOKUP_WINDOW_MS) lookupHits.delete(k);
    }
  }
}

router.get('/my-tickets', async (req, res) => {
  try {
    const key = phoneKey(req.query.phone);
    if (!key || key.length < 8) {
      return res.status(400).json({ error: 'A full phone number is required', tickets: [] });
    }
    const ip = String(req.headers['x-forwarded-for'] || req.ip || 'unknown').split(',')[0].trim();
    if (lookupMisses(ip) >= LOOKUP_MAX) {
      return res.status(429).json({ error: 'Too many lookups. Try again in a few minutes.', tickets: [] });
    }

    /* phoneKey is only written from today onwards, so match on it OR on the
       raw number as it was typed. Without the second half every ticket bought
       before this deploy would be invisible to its own buyer - including the
       one that started all this. */
    const raw = String(req.query.phone || '').trim();
    const found = await Transaction.find({
      $or: [{ phoneKey: key }, { buyerPhone: raw }, { buyerPhone: key }]
    }).sort({ createdAt: -1 }).limit(40);

    const tickets = [];
    for (const txn of found) {
      const current = (await reconcile(txn)) || txn;
      /* Backfill as we go: the next lookup for this person is a single
         indexed hit instead of three. */
      if (!current.phoneKey) {
        await Transaction.updateOne({ _id: current._id }, { $set: { phoneKey: key } }).catch(() => {});
      }
      const event = await Event.findById(current.event).select(EVENT_FIELDS).lean();
      tickets.push({
        referenceId: current.referenceId,
        status: current.status,
        ticketName: current.ticketName,
        qty: current.qty,
        totalAmount: current.totalAmount,
        buyerName: current.buyerName || '',
        paidAt: current.paidAt || null,
        used: !!current.usedAt,
        createdAt: current.createdAt,
        event: event || null
      });
    }
    if (!tickets.length) recordMiss(ip);
    res.json({ count: tickets.length, tickets });
  } catch (err) {
    res.status(500).json({ error: err.message, tickets: [] });
  }
});

/* Send a paid ticket to its buyer again, on request. Used by the button on the
   ticket page, and by him from the console when somebody says it never came. */
router.post('/ticket/:referenceId/resend', async (req, res) => {
  try {
    const txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ error: 'Ticket not found' });
    if (txn.status !== 'completed') {
      return res.status(400).json({ error: 'This ticket is not paid yet', status: txn.status });
    }
    const event = await Event.findById(txn.event).select(EVENT_FIELDS).lean();
    const result = await sendTicketLink(txn, event);
    await Transaction.updateOne({ _id: txn._id }, result.sent
      ? { $set: { deliveredAt: new Date(), deliveryChannel: result.channel, deliveryError: '' }, $inc: { deliveryAttempts: 1 } }
      : { $set: { deliveryError: String(result.reason || '').slice(0, 300) }, $inc: { deliveryAttempts: 1 } });
    /* Honest either way. A button that always says "sent!" is how a ticket
       goes undelivered without anybody noticing. */
    res.json({ sent: result.sent, reason: result.reason || null, channel: result.channel });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/ticket/:referenceId', async (req, res) => {
  try {
    let txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ error: 'Ticket not found' });
    await reconcile(txn);
    txn = await Transaction.findOne({ referenceId: req.params.referenceId })
      .populate('event', EVENT_FIELDS);
    res.json(txn);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const QRCode = require('qrcode');

/* Where the QR code points.
 *
 * It used to be the raw API call that marks a payment verified. Two things
 * wrong with that: pointing a phone camera at a ticket showed the doorman a
 * screenful of computer text with no verdict in it, and the act of looking at
 * a ticket was also the act of confirming its payment. A ticket is now read at
 * a page written for the person on the door. */
function checkUrl(referenceId) {
  return 'https://haitibiznis.com/check.html?ref=' + encodeURIComponent(referenceId);
}

router.get('/ticket/:referenceId/qr', async (req, res) => {
  try {
    const txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ error: 'Ticket not found' });
    const current = await reconcile(txn);
    const qrDataUrl = await QRCode.toDataURL(checkUrl(txn.referenceId),
      { width: 300, margin: 2, color: { dark: '#0A0E1A', light: '#FFFFFF' } });
    res.json({ qr: qrDataUrl, referenceId: txn.referenceId, status: (current || txn).status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function checkPayload(txn, event) {
  return {
    valid: txn.status === 'completed',
    reason: txn.status === 'completed' ? 'ok' : txn.status,
    referenceId: txn.referenceId,
    buyerName: txn.buyerName || '',
    ticketName: txn.ticketName,
    qty: txn.qty,
    totalAmount: txn.totalAmount,
    paidAt: txn.paidAt || null,
    used: !!txn.usedAt,
    usedAt: txn.usedAt || null,
    usedBy: txn.usedBy || '',
    useCount: txn.useCount || 0,
    event: event || null
  };
}

/* What the door sees. Read only on purpose: anybody can hold up a phone, so
 * nothing here may change a ticket's state, and it must never invent a pass -
 * a ticket that cannot be confirmed reads "not paid", not "ok". */
router.get('/check/:referenceId', async (req, res) => {
  try {
    let txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ valid: false, reason: 'not_found' });
    txn = (await reconcile(txn)) || txn;
    const event = await Event.findById(txn.event).select(EVENT_FIELDS).lean();
    res.json(checkPayload(txn, event));
  } catch (err) {
    res.status(500).json({ valid: false, reason: 'error', error: err.message });
  }
});

/* ---------------------------------------------------------------------------
   Marking a ticket used.

   Reading a ticket and spending it are two different acts and only the second
   one needs a credential, which is why they are two routes. Anybody may hold up
   a phone at the door and see whether a ticket is paid; only somebody holding
   the event's door code may burn it.

   The code is per event. The console code opens escrow releases, refunds and
   driver approval - handing that to whoever is standing at the gate would mean
   the gate can pay sellers out. A door code unlocks one event and nothing else,
   so it can be read out over the phone to a helper and forgotten afterwards.
   The console code is accepted too, because the organiser is often the person
   on the door and should not need a second secret to get in.
   --------------------------------------------------------------------------- */
const { pinIsValid } = require('../utils/consolePin');

// No O/0/I/1: this gets read aloud down a bad phone line and typed on a phone.
const DOOR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function makeDoorCode() {
  const bytes = require('crypto').randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += DOOR_ALPHABET[bytes[i] % DOOR_ALPHABET.length];
  return out;
}
function normCode(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/* Who is allowed to burn this particular ticket. Returns '' for nobody. */
async function doorAuth(req, event) {
  const supplied = normCode(req.headers['x-door-code'] || (req.body && req.body.code) || req.query.code);
  if (!supplied) return '';
  if (event && event.doorCode && normCode(event.doorCode) === supplied) return 'door';
  // Checked second because it is 100k PBKDF2 rounds; a door code miss should
  // not pay for that on every scan.
  if (await pinIsValid(supplied)) return 'console';
  return '';
}

/* The organiser fetches (or creates) the door code for one event. Behind the
 * console code, because this is the thing that lets somebody in. */
router.get('/door-code/:eventId', require('../utils/consolePin').requirePin, async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId).select('title doorCode');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (!event.doorCode) {
      event.doorCode = makeDoorCode();
      await event.save();
    }
    res.json({ eventId: event._id, title: event.title, doorCode: event.doorCode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/check/:referenceId/use', async (req, res) => {
  try {
    let txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ valid: false, reason: 'not_found' });

    const event = await Event.findById(txn.event).select(EVENT_FIELDS + ' doorCode');
    const who = await doorAuth(req, event);
    if (!who) return res.status(403).json({ valid: false, reason: 'bad_code' });

    // An unpaid ticket is never burned. Otherwise a second scan of it would
    // read "already used", which at a gate is indistinguishable from "it was
    // fine and somebody else came in on it".
    txn = (await reconcile(txn)) || txn;
    const eventOut = event ? {
      title: event.title, date: event.date, startTime: event.startTime,
      endTime: event.endTime, location: event.location, typeEmoji: event.typeEmoji,
      typeLabel: event.typeLabel, gradient: event.gradient
    } : null;
    if (txn.status !== 'completed') return res.json(checkPayload(txn, eventOut));

    // Shown on the ticket card at the gate, so it is a word he can read, not
    // the internal name of the credential that was used.
    const label = String((req.body && req.body.door) || '').slice(0, 40) ||
      (who === 'console' ? 'Konsòl' : 'Pòt');

    // Whoever wins this update is the entry. Two phones scanning the same
    // ticket in the same second cannot both be the first one.
    const claimed = await Transaction.findOneAndUpdate(
      { _id: txn._id, status: 'completed', usedAt: null },
      { $set: { usedAt: new Date(), usedBy: label }, $inc: { useCount: 1 } },
      { new: true }
    );
    if (claimed) {
      return res.json(Object.assign(checkPayload(claimed, eventOut), { firstUse: true, secondsAgo: 0 }));
    }

    // Already used. Count the attempt, and say how long ago and by whom, because
    // "the doorman refreshed the page" and "this is the second person holding
    // the same photo" look identical without a clock.
    const again = await Transaction.findOneAndUpdate(
      { _id: txn._id }, { $inc: { useCount: 1 } }, { new: true }
    );
    const cur = again || txn;
    const secondsAgo = cur.usedAt ? Math.max(0, Math.round((Date.now() - new Date(cur.usedAt).getTime()) / 1000)) : null;
    res.json(Object.assign(checkPayload(cur, eventOut), { firstUse: false, secondsAgo }));
  } catch (err) {
    res.status(500).json({ valid: false, reason: 'error', error: err.message });
  }
});

module.exports = router;
/* Exported for the background sweep in utils/ticketSweep.js. It calls THIS
   reconcile rather than repeating the logic, so there is one definition of
   what "confirm a payment" means and one atomic claim behind it. */
module.exports.reconcile = reconcile;
module.exports.deliverTicket = deliverTicket;
