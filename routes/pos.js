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

module.exports = router;
