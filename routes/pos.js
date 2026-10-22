/* LajanMaker POS - device registry and the kill switch.
 *
 * POST /api/pos/hello                    public  - a phone asking who it is
 * GET  /api/pos/devices                  admin   - the list
 * POST /api/pos/devices/:id/status       admin   - block / unblock one phone
 * POST /api/pos/devices/:id/grant        admin   - team / lifetime / none
 * POST /api/pos/devices/block-others     admin   - "start fresh": block all but
 *                                                  the phones he names
 *
 * /hello has to be public: a phone cannot prove who it is before it has been
 * told. It is a write, so it is deliberately narrow - it can only touch the row
 * for its own deviceId, it can only set the display-only fields, and it can
 * never set status or grant. Everything that decides access takes the console
 * code, listed in middleware/adminOnly.js.
 */
const express = require('express');
const router = express.Router();
const PosDevice = require('../models/PosDevice');
const PosTrial = require('../models/PosTrial');
const { phoneKey } = require('../utils/ticketDelivery');

/* The free trial is 7 days everywhere - website, POS and marketing. */
const TRIAL_DAYS = 7;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

/* ------------------------------------------------------------------ hello */
router.post('/hello', async (req, res) => {
  try {
    const deviceId = clip(req.body.deviceId, 64);
    if (!ID_RE.test(deviceId)) return res.status(400).json({ error: 'bad deviceId' });

    /* Only the display fields, and only ever for this one id. status and grant
     * are not in this object on purpose - a phone must not be able to award
     * itself a lifetime licence by posting one. */
    const reported = {
      label: clip(req.body.label, 80),
      plan: clip(req.body.plan, 24),
      exp: clip(req.body.exp, 40),
      ver: clip(req.body.ver, 12),
      ua: clip(req.headers['user-agent'], 200),
      staff: Array.isArray(req.body.staff)
        ? req.body.staff.slice(0, 20).map(s => clip(s, 40)).filter(Boolean)
        : [],
      lastSeen: new Date()
    };

    const doc = await PosDevice.findOneAndUpdate(
      { deviceId },
      {
        $set: reported,
        $inc: { seenCount: 1 },
        $setOnInsert: { deviceId, firstSeen: new Date(), status: 'active', grant: 'none' }
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json({
      ok: true,
      status: doc.status,
      grant: doc.grant,
      note: doc.note || '',
      serverTime: new Date().toISOString()
    });
  } catch (e) {
    /* A duplicate-key race on first contact just means two tabs said hello at
     * once. Ask again rather than answering 500 to a working phone. */
    if (e && e.code === 11000) return res.status(409).json({ error: 'retry' });
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ trial
 *
 * POST /api/pos/trial   { phone }  ->  { trialEndsAt, daysLeft, firstTime }
 *
 * Jeffery, 4 Oct 2026: "I do not want someone clearing their app data and
 * receiving another 7-day trial... Reinstalling the app or clearing data must
 * NOT restart another trial."
 *
 * One question, one answer. The FIRST time a number is seen it is given seven
 * full days and that date is written down. Every time after that - including
 * after a reinstall, a cleared cache or a new phone - the SAME date comes back,
 * whether it is still in the future or long past.
 *
 * 🔑 That is also the whole of the "global reset for existing agents": this
 * table starts empty, so every agent's first visit after this goes live finds
 * nothing and earns a clean week. Nothing is deleted and nothing is migrated,
 * so no account, referral, commission, sale or certificate can be harmed.
 *
 * ⛔ Public, like /hello, because a phone cannot prove who it is first. It is
 * safe to be public because it can only ever CREATE a trial or READ one back -
 * there is no input that can extend, shorten or clear an existing row. The
 * worst a stranger can do is cause a row to exist for a number that then gets
 * its seven days, which is what that number was going to get anyway.
 */
router.post('/trial', async (req, res) => {
  try {
    const raw = String((req.body && req.body.phone) || '');
    const key = phoneKey(raw);
    /* ⛔ No number, no answer - and NOT an error. The phone falls back to
       deciding for itself, exactly as it did before, rather than locking an
       agent out because they have not typed a number yet. */
    if (!key || key.length < 6) {
      return res.json({ ok: false, reason: 'no_phone' });
    }

    const now = new Date();
    const fresh = new Date(now.getTime() + TRIAL_DAYS * 86400000);

    /* Look first, then write. Two queries rather than one clever upsert,
       because "was this row created just now" has to be ANSWERED HONESTLY -
       the app shows the agent a different message for a brand new trial, and
       a flag that quietly reports the wrong thing is worse than no flag.
       This runs once when the app opens, so the extra query costs nothing. */
    let row = await PosTrial.findOne({ phoneKey: key });
    let createdNow = false;

    if (!row) {
      try {
        row = await PosTrial.create({
          phoneKey: key, phone: clip(raw, 32), label: clip(req.body.label, 80),
          trialStartedAt: now, trialEndsAt: fresh, seenCount: 1, lastSeen: now
        });
        createdNow = true;
      } catch (err) {
        /* Two tabs opened at the same second. The other one won; use its row -
           and on NO account create a second trial for the same number. */
        if (!err || err.code !== 11000) throw err;
        row = await PosTrial.findOne({ phoneKey: key });
      }
    }

    if (!createdNow && row) {
      /* ⛔ trialEndsAt is NEVER in this update. That omission is the rule the
         whole table exists for: a reinstall may move the counters and nothing
         else. */
      await PosTrial.updateOne({ phoneKey: key }, {
        $set: { phone: clip(raw, 32), label: clip(req.body.label, 80), lastSeen: now },
        $inc: { seenCount: 1 }
      });
    }

    const ends = new Date(row.trialEndsAt);
    const daysLeft = Math.ceil((ends.getTime() - now.getTime()) / 86400000);

    res.json({
      ok: true,
      trialEndsAt: ends.toISOString(),
      daysLeft: daysLeft,
      expired: daysLeft < 0,
      firstTime: createdNow,
      serverTime: now.toISOString()
    });
  } catch (e) {
    if (e && e.code === 11000) return res.status(409).json({ error: 'retry' });
    /* ⛔ A trial lookup that fails must never stop an agent working. The phone
       treats any failure as "no answer" and carries on. */
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------- list */
router.get('/devices', async (req, res) => {
  try {
    const docs = await PosDevice.find({}).sort({ lastSeen: -1 }).limit(500).lean();
    res.json({ ok: true, count: docs.length, devices: docs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- block one */
router.post('/devices/:deviceId/status', async (req, res) => {
  try {
    const status = req.body.status === 'blocked' ? 'blocked' : 'active';
    const set = { status, note: clip(req.body.note, 200) };
    if (status === 'blocked') set.blockedAt = new Date();
    const doc = await PosDevice.findOneAndUpdate(
      { deviceId: req.params.deviceId }, { $set: set }, { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'no such device' });
    res.json({ ok: true, device: doc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- grant one */
router.post('/devices/:deviceId/grant', async (req, res) => {
  try {
    const allowed = ['none', 'team', 'lifetime'];
    const grant = allowed.indexOf(req.body.grant) >= 0 ? req.body.grant : 'none';
    const doc = await PosDevice.findOneAndUpdate(
      { deviceId: req.params.deviceId },
      { $set: { grant, note: clip(req.body.note, 200) } },
      { new: true }
    );
    if (!doc) return res.status(404).json({ error: 'no such device' });
    res.json({ ok: true, device: doc });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* --------------------------------------------------------- "start fresh" */
/* "I need to delete everyone so we can start fresh." Blocks every phone except
 * the ones he names. `keep` is required and must not be empty - a button that
 * can lock him out of his own app on a mis-tap is not a button worth having. */
router.post('/devices/block-others', async (req, res) => {
  try {
    const keep = Array.isArray(req.body.keep)
      ? req.body.keep.map(s => clip(s, 64)).filter(s => ID_RE.test(s))
      : [];
    if (!keep.length) {
      return res.status(400).json({ error: 'name at least one phone to keep (normally your own)' });
    }
    const r = await PosDevice.updateMany(
      { deviceId: { $nin: keep }, status: { $ne: 'blocked' } },
      { $set: { status: 'blocked', blockedAt: new Date(), note: clip(req.body.note, 200) || 'start fresh' } }
    );
    res.json({ ok: true, blocked: r.modifiedCount, kept: keep.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ═══ SALES SYNC — every LajanMaker POS sale reaches the server ═══════════════
 *
 * Jeffery, 22 Oct 2026 (GO): automatic sync, offline sales sent when the
 * signal returns, no duplicates, attribution to the Ajan's approved code,
 * recorded vs CONFIRMED paid, cancellations and refunds (administrators
 * only, reason + date + original sale + administrator, cancelled ≠
 * refunded, never an automatic refund), no commission twice.
 *
 *   POST /api/pos/sales        public, like /hello: a phone sends its own
 *                              sales {deviceId, agentPhone, sales:[…]}; a sale
 *                              already here is UPDATED (by rev), never added
 *                              twice; answers each sale's server state.
 *   POST /api/pos/sales/void   console code: {deviceId, saleId, kind:
 *                              'cancel'|'refund', reason, by, amount?, sale?}
 *
 * ⛔ The phone can never set state, cancellation, refunds or "confirmed":
 *    those fields are not read from the upload at all.
 * ⛔ Nothing here creates a commission or moves money.
 * ═══════════════════════════════════════════════════════════════════════════ */
const PosSale = require('../models/PosSale');
const CertifiedAgent = require('../models/CertifiedAgent');
const { paymentConfirmed } = require('../utils/verifyPayment');
const { requirePin } = require('../utils/consolePin');

const SALE_ID_RE = /^[A-Za-z0-9_-]{2,32}$/;
const ELECTRONIC = ['moncash', 'natcash', 'mc', 'nc', 'pix'];
const num = (v, max) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n * 100) / 100 : 0; };

/* A small per-address brake: a phone syncs a few times a minute at most. */
const syncHits = new Map();
function tooFast(ip) {
  const now = Date.now(), w = syncHits.get(ip) || [];
  const recent = w.filter((t) => now - t < 60000); recent.push(now); syncHits.set(ip, recent);
  if (syncHits.size > 5000) syncHits.clear();
  return recent.length > 60;
}

async function agentForPhone(key) {
  if (!key || key.length < 8) return null;
  const re = new RegExp(key.split('').join('[^0-9]*') + '[^0-9]*$');
  const list = await CertifiedAgent.find({ phone: re, status: 'active' }).select('agentId referralCode').limit(2).lean();
  return list.length === 1 ? list[0] : null;      // two badges on one number: attribute to neither
}

function wantsCheck(s) {
  return !!s.payRef && ELECTRONIC.indexOf(String(s.payment || '').toLowerCase()) >= 0 && s.amount > 0;
}

/* Ask the gateway. Only trans_status 'ok' for at least the amount confirms. */
async function checkPayment(doc) {
  if (!doc || !wantsCheck(doc) || doc.confirm.state === 'confirmed') return doc;
  const r = await paymentConfirmed(doc.payRef, 'pos sale ' + doc.saleId, doc.amount, doc.payClient);
  const set = { 'confirm.checkedAt': new Date(), 'confirm.tries': (doc.confirm.tries || 0) + 1 };
  if (r.confirmed) { set['confirm.state'] = 'confirmed'; set['confirm.amount'] = Number(r.provider && r.provider.montant) || doc.amount; }
  else if (r.provider && r.provider.status === true && r.provider.trans_status && r.provider.trans_status !== 'ok' && set['confirm.tries'] >= 6) set['confirm.state'] = 'not_paid';
  else set['confirm.state'] = 'pending';
  return PosSale.findOneAndUpdate({ _id: doc._id }, { $set: set }, { new: true });
}

function stateOf(d) {
  return { id: d.saleId, rev: d.rev, state: d.state, confirmed: d.confirm.state === 'confirmed', refunded: d.refunded || 0 };
}

async function upsertSale(deviceId, key, agent, raw) {
  const saleId = clip(raw.id, 32);
  if (!SALE_ID_RE.test(saleId)) return null;
  const soldAt = new Date(raw.ts);
  if (isNaN(soldAt)) return null;
  const rev = Math.max(1, Math.floor(Number(raw.rev) || 1));
  const fields = {
    staff: clip(raw.staff, 40), type: clip(raw.type, 16) || 'sale', module: clip(raw.module, 40), service: clip(raw.svcName, 80),
    amount: num(raw.amount, 10000000), currency: clip(raw.currency, 6) || 'HTG', payment: clip(raw.payment, 16),
    payStatus: clip(raw.payStatus, 12), payRef: clip(raw.payRef, 64), payClient: clip(raw.payClient, 48),
    posShare: num(raw.posShare, 10000000), posPct: num(raw.posPct, 100), status: clip(raw.status, 12), soldAt, rev
  };
  const have = await PosSale.findOne({ deviceId, saleId });
  if (have) {
    if (rev <= have.rev) return have;                  // already have this version (or newer)
    /* An amount the gateway already confirmed is not rewritten by the phone. */
    if (have.confirm.state === 'confirmed') { delete fields.amount; delete fields.payRef; delete fields.payment; }
    const set = Object.assign({}, fields);
    if (!have.agentId && agent) { set.agentId = agent.agentId; set.referralCode = agent.referralCode || ''; }
    if (!have.phoneKey && key) set.phoneKey = key;
    const upd = await PosSale.findOneAndUpdate({ _id: have._id, rev: { $lt: rev } }, { $set: set }, { new: true });
    return upd || await PosSale.findById(have._id);    // a newer version won the race
  }
  try {
    return await PosSale.create(Object.assign({ deviceId, saleId, phoneKey: key || '',
      agentId: agent ? agent.agentId : '', referralCode: agent ? (agent.referralCode || '') : '',
      confirm: { state: wantsCheck(fields) ? 'pending' : 'none' },
      history: [{ action: 'synced', note: 'rev ' + rev }] }, fields));
  } catch (e) {
    if (e && e.code === 11000) return PosSale.findOne({ deviceId, saleId });   // two uploads raced
    throw e;
  }
}

router.post('/sales', async (req, res) => {
  try {
    if (tooFast(req.ip)) return res.status(429).json({ error: 'slow down' });
    const b = req.body || {};
    const deviceId = clip(b.deviceId, 64);
    if (!ID_RE.test(deviceId)) return res.status(400).json({ error: 'bad deviceId' });
    const sales = Array.isArray(b.sales) ? b.sales.slice(0, 100) : [];
    const key = phoneKey(b.agentPhone);
    const agent = await agentForPhone(key);
    const out = [];
    for (const raw of sales) {
      let d = await upsertSale(deviceId, key, agent, raw || {});
      if (!d) { out.push({ id: raw && raw.id, error: 'bad sale' }); continue; }
      if (d.confirm.state === 'pending' && (d.confirm.tries || 0) === 0) d = await checkPayment(d);
      out.push(stateOf(d));
    }
    res.json({ ok: true, attributed: !!agent, sales: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/sales/void', requirePin, async (req, res) => {
  try {
    const b = req.body || {};
    const deviceId = clip(b.deviceId, 64), saleId = clip(b.saleId, 32);
    const kind = b.kind === 'refund' ? 'refund' : b.kind === 'cancel' ? 'cancel' : '';
    const reason = String(b.reason || '').trim().slice(0, 300);
    const by = String(b.by || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!ID_RE.test(deviceId) || !SALE_ID_RE.test(saleId)) return res.status(400).json({ error: 'bad sale' });
    if (!kind) return res.status(400).json({ error: 'bad kind' });
    if (reason.length < 3) return res.status(400).json({ error: 'reason_required' });
    if (by.length < 2) return res.status(400).json({ error: 'name_required' });
    let d = await PosSale.findOne({ deviceId, saleId });
    if (!d && b.sale) {                               // not synced yet: take it from the phone first
      const key = phoneKey(b.agentPhone);
      d = await upsertSale(deviceId, key, await agentForPhone(key), Object.assign({}, b.sale, { id: saleId }));
    }
    if (!d) return res.status(404).json({ error: 'no such sale' });
    const now = new Date();
    if (kind === 'cancel') {
      if (d.state === 'cancelled') return res.status(409).json({ error: 'already_cancelled' });
      if (d.state === 'refunded') return res.status(409).json({ error: 'already_refunded' });
      d = await PosSale.findOneAndUpdate({ _id: d._id, state: 'active' },
        { $set: { state: 'cancelled', cancelled: { at: now, by, reason } },
          $push: { history: { at: now, by, action: 'cancelled', note: reason } } }, { new: true });
      if (!d) return res.status(409).json({ error: 'changed, try again' });
    } else {
      if (d.state === 'cancelled') return res.status(409).json({ error: 'already_cancelled' });
      const left = Math.max(0, (d.amount || 0) - (d.refunded || 0));
      const amount = b.amount == null || b.amount === '' ? left : num(b.amount, 10000000);
      if (!(amount > 0) || amount > left + 0.001) return res.status(400).json({ error: 'bad_amount', left });
      d = await PosSale.findOneAndUpdate({ _id: d._id, state: { $ne: 'cancelled' }, refunded: d.refunded || 0 },
        { $set: { state: 'refunded' }, $inc: { refunded: amount },
          $push: { refunds: { at: now, by, reason, amount }, history: { at: now, by, action: 'refunded', note: amount + ' · ' + reason } } }, { new: true });
      if (!d) return res.status(409).json({ error: 'changed, try again' });
    }
    console.warn('[POS] ' + kind + ' ' + deviceId + '/' + saleId + ' by ' + by + ': ' + reason);
    res.json({ ok: true, sale: stateOf(d), cancelled: d.cancelled, refunds: d.refunds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Payments the gateway has not confirmed yet are asked about again, on a
   widening schedule (the gateway can lag the phone by minutes). */
async function sweepPosPayments() {
  try {
    const due = await PosSale.find({ 'confirm.state': 'pending', 'confirm.tries': { $lt: 12 },
      $or: [{ 'confirm.checkedAt': null }, { 'confirm.checkedAt': { $lt: new Date(Date.now() - 10 * 60000) } }] }).limit(50);
    for (const d of due) await checkPayment(d);
  } catch (e) { console.error('[POS] payment sweep: ' + e.message); }
}
if (process.env.NODE_ENV !== 'test') setInterval(sweepPosPayments, 10 * 60000).unref();
router.sweepPosPayments = sweepPosPayments;

module.exports = router;
