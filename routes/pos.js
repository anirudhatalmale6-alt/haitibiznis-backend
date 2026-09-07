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
