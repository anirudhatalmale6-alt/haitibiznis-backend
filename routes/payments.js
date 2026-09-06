const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const Event = require('../models/Event');

const { notifyAdmin } = require('../utils/notify');
const { paymentConfirmed, isConfirmed, askGateway } = require('../utils/verifyPayment');

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
  return claimed;
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
        paidAt: new Date(), koutyeCode
      });
      await txn.save();
      await countSold(txn);
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
      buyerName, buyerPhone, buyerEmail, koutyeCode
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
