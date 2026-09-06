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

/* What the door sees. Read only on purpose: anybody can hold up a phone, so
 * nothing here may change a ticket's state, and it must never invent a pass -
 * a ticket that cannot be confirmed reads "not paid", not "ok". */
router.get('/check/:referenceId', async (req, res) => {
  try {
    let txn = await Transaction.findOne({ referenceId: req.params.referenceId });
    if (!txn) return res.status(404).json({ valid: false, reason: 'not_found' });
    txn = (await reconcile(txn)) || txn;
    const event = await Event.findById(txn.event).select(EVENT_FIELDS).lean();
    res.json({
      valid: txn.status === 'completed',
      reason: txn.status === 'completed' ? 'ok' : txn.status,
      referenceId: txn.referenceId,
      buyerName: txn.buyerName || '',
      ticketName: txn.ticketName,
      qty: txn.qty,
      totalAmount: txn.totalAmount,
      paidAt: txn.paidAt || null,
      event: event || null
    });
  } catch (err) {
    res.status(500).json({ valid: false, reason: 'error', error: err.message });
  }
});

module.exports = router;
