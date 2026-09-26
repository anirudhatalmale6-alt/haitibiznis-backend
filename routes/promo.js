/* Promotional material: flyers and videos an agent downloads and shares.
 *
 * ── WHO CAN DO WHAT ────────────────────────────────────────────────────────
 * READING is open. Every agent's phone has to be able to list and download
 * this without a credential - that is the whole point of the screen, and the
 * POS carries no secret an agent could be trusted with anyway.
 *
 * WRITING is behind the console code (`x-admin-pin`, utils/consolePin). If
 * uploading were open, anyone who found the URL could push a picture of their
 * choosing onto the promo screen of every agent in the country. The gate is
 * the same one that already guards the console, so there is no second code
 * for him to remember.
 *
 * ⚠️ The multer instance here is LOCAL to this file. middleware/upload.js is
 * shared with /api/ai/scan-flyer, and widening its filter to accept video
 * would let anyone post a video to the OCR scanner. A limit that is loosened
 * for one caller is loosened for every caller.
 */
const express = require('express');
const multer = require('multer');
const router = express.Router();
const PromoAsset = require('../models/PromoAsset');
const { requirePin } = require('../utils/consolePin');

/* 16 MB is the hard BSON document ceiling. These sit under it with room for
   the metadata and a poster frame, and are what the upload screen quotes to
   him - the number a person is told must be the number the server enforces. */
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_VIDEO = 12 * 1024 * 1024;
const MAX_THUMB = 1 * 1024 * 1024;

const IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const VIDEO_MIME = ['video/mp4', 'video/quicktime', 'video/webm', 'video/3gpp'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO, files: 2 },
  fileFilter: (req, file, cb) => {
    const ok = file.fieldname === 'thumb'
      ? IMAGE_MIME.includes(file.mimetype)
      : IMAGE_MIME.concat(VIDEO_MIME).includes(file.mimetype);
    cb(null, ok);
  }
}).fields([{ name: 'file', maxCount: 1 }, { name: 'thumb', maxCount: 1 }]);

/* multer rejects by THROWING, and an unhandled throw here is a 500 that tells
   him nothing. Turn its errors into the sentence that explains what to do. */
function receive(req, res, next) {
  upload(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `That file is too big. Photos up to ${MAX_IMAGE / 1048576} MB, ` +
               `videos up to ${MAX_VIDEO / 1048576} MB. For a longer video, ` +
               `paste a link instead of uploading the file.`
      });
    }
    return res.status(400).json({ error: err.message || 'Upload failed' });
  });
}

const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

/* Only http(s). A link field that accepts javascript: or data: is a way to put
   a script into a screen every agent opens. */
function safeLink(v) {
  const s = clip(v, 500);
  if (!s) return null;
  if (!/^https?:\/\/[^\s]+$/i.test(s)) return false;   // false = present but bad
  return s;
}

/* What the list screen needs, and nothing it does not.
   ⚠️ TWO things keep video bytes out of a list response, and it needs both:
   `select: false` on the model (so the query never loads them) AND this
   function naming every field it returns. Relying on the model alone means the
   day some future route does .select('+data') and hands the document here, a
   whole video goes out in a JSON list. A whitelist cannot leak a field nobody
   added to it. */
function publicView(d) {
  return {
    id: String(d._id),
    kind: d.kind,
    title: d.title,
    mime: d.mime || null,
    size: d.size || null,
    link: d.link || null,
    has_file: !!d.size,
    has_thumb: !!d.thumbMime,
    created_at: d.createdAt
  };
}

/* ------------------------------------------------------------------ list */
// GET /api/promo?kind=flyer|video — open, the agent app reads this
router.get('/', async (req, res) => {
  try {
    const q = {};
    if (req.query.kind === 'flyer' || req.query.kind === 'video') q.kind = req.query.kind;
    const docs = await PromoAsset.find(q)
      .sort({ order: 1, createdAt: -1 }).limit(200).lean();
    res.json({ ok: true, count: docs.length, assets: docs.map(publicView) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ bytes */
/* The file itself. Asked for by name because the model hides it by default.
   Cached hard: an asset's bytes never change - a replacement is a new id. */
function serveBinary(field, mimeField) {
  return async (req, res) => {
    try {
      const doc = await PromoAsset.findById(req.params.id).select('+' + field + ' ' + mimeField);
      if (!doc || !doc[field]) return res.status(404).json({ error: 'Not found' });
      res.set('Content-Type', doc[mimeField] || 'application/octet-stream');
      res.set('Cache-Control', 'public, max-age=604800, immutable');
      if (field === 'data') {
        /* Filenames go through a Content-Disposition header, so a quote or a
           newline in a title must never reach it verbatim. */
        const safe = String(doc.title || 'promo').replace(/[^A-Za-z0-9 ._-]/g, '_').slice(0, 60);
        const ext = (doc.mime || '').split('/')[1] || 'bin';
        res.set('Content-Disposition', `inline; filename="${safe}.${ext}"`);
      }
      res.send(doc[field]);
    } catch (e) {
      res.status(400).json({ error: 'Not found' });
    }
  };
}
router.get('/:id/file', serveBinary('data', 'mime'));
router.get('/:id/thumb', serveBinary('thumb', 'thumbMime'));

/* ---------------------------------------------------------------- upload */
// POST /api/promo  (console code) — multipart: file/thumb, or a link
router.post('/', requirePin, receive, async (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind === 'video' ? 'video' : 'flyer';
    const title = clip(body.title, 120);
    if (!title) return res.status(400).json({ error: 'Give it a name so agents know what it is.' });

    const file = (req.files && req.files.file && req.files.file[0]) || null;
    const thumb = (req.files && req.files.thumb && req.files.thumb[0]) || null;
    const link = safeLink(body.link);
    if (link === false) return res.status(400).json({ error: 'That link does not look like a web address (it must start with http).' });

    if (!file && !link) {
      return res.status(400).json({ error: 'Choose a file to upload, or paste a link.' });
    }

    const doc = new PromoAsset({ kind, title, link: link || undefined, order: Number(body.order) || 0 });

    if (file) {
      const isVideo = VIDEO_MIME.includes(file.mimetype);
      /* A video uploaded under kind=flyer would render inside an <img>. Trust
         what the bytes say they are over what the form said. */
      doc.kind = isVideo ? 'video' : 'flyer';
      const cap = isVideo ? MAX_VIDEO : MAX_IMAGE;
      if (file.size > cap) {
        return res.status(413).json({
          error: `${isVideo ? 'Video' : 'Photo'} is ${(file.size / 1048576).toFixed(1)} MB. ` +
                 `The limit is ${cap / 1048576} MB.` +
                 (isVideo ? ' For a longer video, paste a link instead.' : '')
        });
      }
      doc.mime = file.mimetype;
      doc.size = file.size;
      doc.data = file.buffer;
    }

    if (thumb && thumb.size <= MAX_THUMB) {
      doc.thumbMime = thumb.mimetype;
      doc.thumb = thumb.buffer;
    }

    await doc.save();
    res.json({ ok: true, asset: publicView(doc) });
  } catch (e) {
    /* Mongo refuses anything over 16 MB at the wire. Say what happened rather
       than letting it surface as a bare 500. */
    if (/BSONObj|document.*too large|16777216/i.test(e.message || '')) {
      return res.status(413).json({ error: 'That file is too large to store. Paste a link to it instead.' });
    }
    res.status(500).json({ error: e.message });
  }
});

/* ---------------------------------------------------------------- rename */
router.patch('/:id', requirePin, async (req, res) => {
  try {
    const set = {};
    if (req.body.title !== undefined) {
      const title = clip(req.body.title, 120);
      if (!title) return res.status(400).json({ error: 'A name cannot be empty.' });
      set.title = title;
    }
    if (req.body.order !== undefined) set.order = Number(req.body.order) || 0;
    if (!Object.keys(set).length) return res.status(400).json({ error: 'Nothing to change.' });
    const doc = await PromoAsset.findByIdAndUpdate(req.params.id, { $set: set }, { new: true }).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, asset: publicView(doc) });
  } catch (e) {
    res.status(400).json({ error: 'Not found' });
  }
});

/* ---------------------------------------------------------------- delete */
router.delete('/:id', requirePin, async (req, res) => {
  try {
    const doc = await PromoAsset.findByIdAndDelete(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true, deleted: String(doc._id), title: doc.title });
  } catch (e) {
    res.status(400).json({ error: 'Not found' });
  }
});

module.exports = router;
module.exports.LIMITS = { MAX_IMAGE, MAX_VIDEO, MAX_THUMB, IMAGE_MIME, VIDEO_MIME };
/* Exported so the whitelist can be checked against a document that DOES carry
   bytes. Tested only through the list route, the check passes for the wrong
   reason - the query had not loaded them in the first place. */
module.exports.publicView = publicView;
