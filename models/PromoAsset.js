const mongoose = require('mongoose');

/* Promotional material an agent can hand out: flyers and videos.
 *
 * Jeffery, 26 Sep: "add an upload button for promotional materials to add
 * flyers and videos". The promo screen in LajanMaker has been telling agents
 * "Videyo pwomosyon ap vini talè" since it was built, with a hard-coded list
 * of eight flyers that only I could add to. This is the other half of that
 * promise: he adds them himself, from his phone, and every agent sees them.
 *
 * ── WHY THE BYTES LIVE IN `data` AS A Buffer, NOT AS BASE64 ────────────────
 * A BSON document cannot exceed 16 MB. Base64 inflates by a third, so a 12 MB
 * video stored as a string is 16 MB before a single field of metadata is
 * added, and the save fails - on the biggest file, which is the one he most
 * wanted to upload. A Buffer is stored as BSON binary at its true size.
 * MAX_VIDEO below is set from that ceiling, not from a guess.
 *
 * ⚠️ `data` and `thumb` are `select: false`. Every list query would otherwise
 * drag every video through memory to render a page of titles. A route that
 * wants the bytes must ask for them by name - see routes/promo.js.
 */
const promoAssetSchema = new mongoose.Schema({
  kind: { type: String, enum: ['flyer', 'video'], required: true, index: true },
  title: { type: String, required: true, maxlength: 120 },

  /* Either the file is here... */
  mime: { type: String },
  size: { type: Number },
  data: { type: Buffer, select: false },

  /* ...or it is somewhere else and this is a link to it. A real promo video is
     often far larger than anything that belongs in a database, so a link is
     not a lesser option - for long videos it is the correct one. */
  link: { type: String },

  /* Optional poster frame, so a video list is not a wall of black rectangles. */
  thumbMime: { type: String },
  thumb: { type: Buffer, select: false },

  order: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
});

/* Newest first within a kind - what a list screen actually asks for. */
promoAssetSchema.index({ kind: 1, order: 1, createdAt: -1 });

module.exports = mongoose.model('PromoAsset', promoAssetSchema);
