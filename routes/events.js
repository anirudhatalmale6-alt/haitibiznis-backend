const express = require('express');
const router = express.Router();
const Event = require('../models/Event');

router.post('/', async (req, res) => {
  try {
    const event = new Event(req.body);
    await event.save();
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
      .select('-inviteImage');
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
    res.send(`<!DOCTYPE html><html><head>
<meta charset="utf-8">
<meta property="og:title" content="${emoji} ${title.replace(/"/g, '&quot;')} — Tikè Lakay">
<meta property="og:description" content="${desc.replace(/"/g, '&quot;')}">
<meta property="og:url" content="${pageUrl}">
<meta property="og:image" content="https://haitibiznis.com/assets/events-logo.png">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Tikè Lakay | HaitiBiznis">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://haitibiznis.com/assets/events-logo.png">
<meta name="twitter:title" content="${emoji} ${title.replace(/"/g, '&quot;')}">
<meta name="twitter:description" content="${desc.replace(/"/g, '&quot;')}">
<meta http-equiv="refresh" content="0;url=${pageUrl}">
<title>${title} — Tikè Lakay</title>
</head><body><p>Redirection...</p><script>window.location.href="${pageUrl}";</script></body></html>`);
  } catch (err) {
    res.redirect('https://haitibiznis.com/events.html');
  }
});

router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    event.views += 1;
    await event.save();
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
