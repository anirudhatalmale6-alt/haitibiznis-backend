const express = require('express');
const router = express.Router();
const Transaction = require('../models/Transaction');
const Event = require('../models/Event');

const SIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SIP_CLIENT = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const PLATFORM_FEE_PCT = 0.05;

function genRef() {
  return 'TL-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
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
      ticket.sold = (ticket.sold || 0) + quantity;
      await event.save();
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

    const sipRes = await fetch(SIP_URL + '/api/paiement-marchand', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: SIP_CLIENT,
        refference_id: refId,
        montant: total,
        payment_method: paymentMethod
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

    const sipRes = await fetch(SIP_URL + '/api/paiement-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: SIP_CLIENT, refference_id: ref })
    });
    const sipData = await sipRes.json();

    if (sipData.trans_status === 'ok' || sipData.status === true) {
      txn.status = 'completed';
      txn.paidAt = new Date();
      await txn.save();

      const event = await Event.findById(txn.event);
      if (event) {
        const ticket = event.tickets.find(t => t.name === txn.ticketName);
        if (ticket) {
          ticket.sold = (ticket.sold || 0) + txn.qty;
          await event.save();
        }
      }

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

async function handleWebhook(req, res) {
  try {
    const ref = req.body.reference_id || req.body.refference_id || req.body.orderId;
    const status = req.body.status;
    if (!ref) return res.status(400).json({ error: 'Missing reference' });

    const txn = await Transaction.findOne({ referenceId: ref });
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    if ((status === 'completed' || status === 'success') && txn.status !== 'completed') {
      txn.status = 'completed';
      txn.paidAt = new Date();
      await txn.save();

      const event = await Event.findById(txn.event);
      if (event) {
        const ticket = event.tickets.find(t => t.name === txn.ticketName);
        if (ticket) {
          ticket.sold = (ticket.sold || 0) + txn.qty;
          await event.save();
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
}

router.get('/ticket/:referenceId', async (req, res) => {
  try {
    const txn = await Transaction.findOne({ referenceId: req.params.referenceId }).populate('event', 'title date startTime endTime location typeEmoji');
    if (!txn) return res.status(404).json({ error: 'Ticket not found' });
    res.json(txn);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
