const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { notifyAdmin } = require('../utils/notify');

/* Fields nobody browsing Tike Lakay is allowed to read.
 *
 * The public list and the public event page were handing out the organiser's
 * MonCash number, NatCash number and email address to anybody who asked - and
 * these are real third-party organisers, not us. Checked against the pages
 * first: event.html reads organizerPhone (the "contact the organiser" WhatsApp
 * button, deliberately public) and never touches the other three. They are
 * written by create-event.html and read by nothing, so removing them from the
 * public responses breaks no screen.
 *
 * Two projections, not one: the LIST also drops inviteImage for size, as it
 * always did, but the single-event page must keep it - event.html draws the
 * invitation from event.inviteImage, so hiding it there would blank the
 * picture on every event page. */
const PRIVATE_FIELDS = '-moncashNumber -natcashNumber -organizerEmail';
const LIST_FIELDS = PRIVATE_FIELDS + ' -inviteImage';

/* Anything a stranger typed that ends up inside HTML. The share page below
 * builds a page out of the event title, and anybody can create an event. */
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.post('/', async (req, res) => {
  try {
    const event = new Event(req.body);
    await event.save();
    notifyAdmin('event', {
      title: event.title, date: event.date, location: event.location
    }).catch(() => {});
    res.status(201).json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { type, status, limit, skip } = req.query;
    const filter = { status: status || 'published' };
    if (type) filter.type = type;
    const events = await Event.find(filter)
      .sort({ date: -1 })
      .skip(parseInt(skip) || 0)
      .limit(parseInt(limit) || 50)
      .select(LIST_FIELDS);
    const total = await Event.countDocuments(filter);
    res.json({ events, total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id/share', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.redirect('https://haitibiznis.com/events.html');
    const title = event.title || 'Evènman';
    const date = event.date ? new Date(event.date + 'T00:00:00').toLocaleDateString('fr-HT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
    const loc = event.location || '';
    const desc = `${date}${loc ? ' | ' + loc : ''}${event.description ? ' — ' + event.description.substring(0, 120) : ''}`;
    const emoji = event.typeEmoji || '🎪';
    const pageUrl = `https://haitibiznis.com/event.html?id=${event._id}`;

    /* Everything below is written by whoever created the event, and creating
     * an event needs no account. Only the double quote used to be escaped,
     * which is enough inside an attribute but not inside <title> - an event
     * called </title><script>... turned this share link, the one that gets
     * pasted into WhatsApp and Facebook, into a page that runs the stranger's
     * script. Escaped properly now, everywhere, and the emoji and the URL are
     * ours rather than theirs. */
    const t = escapeHtml(title);
    const d = escapeHtml(desc);
    const e = escapeHtml(emoji);
    const url = escapeHtml(pageUrl);
    res.send(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta property="og:title" content="${e} ${t} — Tikè Lakay">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="https://haitibiznis.com/assets/og-tike-lakay.jpg">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tikè Lakay | HaitiBiznis">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://haitibiznis.com/assets/og-tike-lakay.jpg">
<meta name="twitter:title" content="${e} ${t}">
<meta name="twitter:description" content="${d}">
<meta http-equiv="refresh" content="0;url=${url}">
<title>${t} — Tikè Lakay</title>
</head><body><p>Redirection...</p><script>window.location.href=${JSON.stringify(pageUrl)};</script></body></html>`);
  } catch (err) {
    res.redirect('https://haitibiznis.com/events.html');
  }
});

router.get('/:id', async (req, res) => {
  try {
    /* The view counter used to be event.views += 1 followed by event.save(),
     * which rewrites the WHOLE document on every single page view - including
     * inviteImage, which is a base64 picture. Two people looking at the same
     * event at the same moment also lost one of the counts. $inc does it in
     * the database, touches one number, and cannot race.
     *
     * The invitation picture stays - event.html draws it - but the
     * organiser's payout details do not. */
    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $inc: { views: 1 } },
      { new: true }
    ).select(PRIVATE_FIELDS);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
