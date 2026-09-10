const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { notifyAdmin } = require('../utils/notify');
const { pinIsValid } = require('../utils/consolePin');

/* May this request manage this event?
 *
 * Two credentials open the door and nothing else does:
 *   - the console code, which is his and opens everything, as before
 *   - the event's own manage code, which belongs to the organiser who created
 *     it and opens only that one event
 *
 * Written as a function that returns the event or answers the request itself,
 * so a route cannot accidentally continue past a failed check - the caller
 * gets null and returns. Default deny: any path that does not positively
 * establish a credential ends in a 403.
 *
 * ⚠️ This REPLACES the blanket console-code gate that middleware/adminOnly.js
 * used to hold over PUT and DELETE. Loosening a lock is only safe if the thing
 * replacing it is at least as strict for everyone the old one kept out, and it
 * is: without one of the two codes there is still no way through. What changed
 * is that an organiser now has a code of their own.
 */
async function openEventFor(req, res, id) {
  const event = await Event.findById(id).select('+manageSalt +manageHash');
  if (!event) {
    res.status(404).json({ error: 'Event not found' });
    return null;
  }
  const supplied = req.headers['x-manage-code'] || (req.body && req.body.manageCode) || req.query.manageCode;
  if (supplied && event.checkManageCode(supplied)) return event;

  if (await pinIsValid(req.headers['x-admin-pin'] || req.query.pin)) return event;

  /* Same answer whether the code was wrong or the caller had none, and it must
     not reveal whether this event even has a manage code. */
  res.status(403).json({ error: 'This event can only be changed by its organizer' });
  return null;
}

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
// doorCode belongs here for the same reason as the payout numbers: the public
// event page is what a ticket buyer loads, and anybody holding the door code
// can check themselves in.
// rsvps is on this list for the strongest reason of any of them: it is a list
// of real people's names and mobile numbers, gathered from attendees who were
// answering an invitation and not publishing a directory. The public event page
// needs the COUNT of who is coming, never the rows. Only the organiser reads
// those, through GET /:id/rsvps, behind their manage code.
const PRIVATE_FIELDS = '-moncashNumber -natcashNumber -organizerEmail -doorCode -rsvps';
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
    /* Whatever the browser sent, the codes are decided here. A manage code
       posted by the client would be a manage code chosen by the client. */
    const body = { ...req.body };
    delete body.manageSalt;
    delete body.manageHash;
    delete body.rsvps;

    const event = new Event(body);
    const manageCode = Event.newManageCode();
    event.setManageCode(manageCode);
    await event.save();

    notifyAdmin('event', {
      title: event.title, date: event.date, location: event.location
    }).catch(() => {});

    /* The one and only time this code is ever readable. create-event.html
       stores it against the event id and shows it to the organiser so they can
       manage the event from another phone. */
    const out = event.toObject();
    delete out.manageSalt;
    delete out.manageHash;
    res.status(201).json({ ...out, manageCode });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
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

/* THE LINK JEFFERY CIRCLED IN RED.
 *
 * When the Academy director shared the workshop to WhatsApp, what her group received was
 *
 *   https://haitibiznis-api.onrender.com/api/events/6aa2e749010a303701e3f5c1/share
 *
 * A buyer in Haiti sees somebody else's domain, the word "api", and a
 * thirty-character identifier. That does not read as Tikè Lakay; it reads as
 * something you should not tap.
 *
 * It cannot simply move to haitibiznis.com. That site is on GitHub Pages,
 * which serves static files only, and WhatsApp does not run JavaScript - the
 * preview card with the event's own name and date can only be produced by a
 * server, and this is the only server there is.
 *
 * So two things here:
 *   1. The path is short and human now: /e/<id>. No "api", no "share".
 *   2. Where it lives is configurable. The day a subdomain of his own domain
 *      points at this service, SHARE_BASE becomes https://tike.haitibiznis.com
 *      and every link generated from then on is branded, with no code change
 *      and nothing already shared broken - the old path still answers.
 */
router.get('/:id/share', shareHandler);

async function shareHandler(req, res) {
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
<meta property="og:image" content="${escapeHtml(event.flyerUrl && /^https:\/\//.test(event.flyerUrl) ? event.flyerUrl : 'https://haitibiznis.com/assets/og-tike-lakay.jpg')}">
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
}

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

    /* The counts without the people. "18 going" is what makes an invitation
       feel alive; the eighteen phone numbers behind it are the organiser's
       business and nobody else's. Fetched separately because the projection
       above deliberately refuses to carry the rows at all. */
    /* Only the two fields needed to count. Not `.select('rsvps')`: that pulls
       every attendee's name and mobile number out of the database on every
       single public page view, just to throw them away after counting. The
       safest place for data nobody needs is where it already is. */
    const counts = await Event.findById(req.params.id)
      .select('rsvps.response rsvps.guests').lean();
    const rows = (counts && counts.rsvps) || [];
    const yes = rows.filter(r => r.response === 'yes');
    const out = event.toObject();
    out.rsvpGoing = yes.length;
    out.rsvpAttending = yes.reduce((a, r) => a + (r.guests || 1), 0);
    out.rsvpDeclined = rows.filter(r => r.response === 'no').length;
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const event = await openEventFor(req, res, req.params.id);
    if (!event) return;

    /* Fields nobody may set by sending them. The codes are not editable, the
       attendee list is written by the RSVP route rather than by whoever is
       editing the event, and the sold counts are money - they are moved by
       $inc from a confirmed payment and must not be settable by hand. */
    const body = { ...req.body };
    ['manageSalt', 'manageHash', 'manageCode', 'rsvps', 'views', '_id', '__v'].forEach(k => delete body[k]);
    if (Array.isArray(body.tickets)) {
      const soldByName = {};
      (event.tickets || []).forEach(t => { soldByName[t.name] = t.sold || 0; });
      body.tickets = body.tickets.map(t => ({ ...t, sold: soldByName[t.name] || 0 }));
    }

    const updated = await Event.findByIdAndUpdate(req.params.id, body, { new: true, runValidators: true })
      .select(PRIVATE_FIELDS);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* Deleting an event that has sold tickets.
 *
 * The Academy director asked for delete because she published a duplicate. That is the
 * common case and it is harmless. The uncommon case is not: an event with paid
 * tickets against it, where deleting the event leaves every one of those
 * tickets pointing at nothing - the buyer's QR page cannot name what they
 * bought, and the door has nothing to check them into. The money has already
 * moved.
 *
 * So a sold event is not deleted silently. It is refused, and the caller is
 * told how many tickets exist and offered the honest alternative, which is to
 * cancel rather than erase. `?force=1` deletes anyway, because it is his
 * platform and there will be a day he means it. */
router.delete('/:id', async (req, res) => {
  try {
    const event = await openEventFor(req, res, req.params.id);
    if (!event) return;

    const Transaction = require('../models/Transaction');
    const sold = await Transaction.countDocuments({
      event: event._id, status: { $in: ['completed', 'pending'] }
    });
    const force = req.query.force === '1' || req.query.force === 'true';

    if (sold > 0 && !force) {
      return res.status(409).json({
        error: 'This event has tickets against it',
        ticketsSold: sold,
        suggestion: 'cancel',
        message: sold + ' ticket(s) have been bought for this event. Cancelling keeps them valid and tells buyers; deleting would leave those tickets pointing at nothing.'
      });
    }

    await Event.findByIdAndDelete(req.params.id);
    res.json({ message: 'Event deleted', ticketsAffected: sold });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* Cancelling: the safe half of delete. The event stops appearing in the public
   list, every ticket already bought stays valid and still names its event. */
router.post('/:id/cancel', async (req, res) => {
  try {
    const event = await openEventFor(req, res, req.params.id);
    if (!event) return;
    event.status = 'cancelled';
    await event.save();
    res.json({ message: 'Event cancelled', status: event.status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* --------------------------------------------------------------- RSVP -----
 * The Academy director's third point. A free event should ask one question and take one
 * tap.
 *
 * Public on purpose - that is the whole point, an attendee has no account -
 * but it can only ever add or change that person's own answer, and it cannot
 * read anybody else's. Only the organiser can see the list.
 */
function rsvpKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length > 8 ? d.slice(-8) : d;
}

router.post('/:id/rsvp', async (req, res) => {
  try {
    const response = req.body.response === 'no' ? 'no' : (req.body.response === 'yes' ? 'yes' : null);
    if (!response) return res.status(400).json({ error: 'response must be yes or no' });

    const phone = String(req.body.phone || '').trim();
    const key = rsvpKey(phone);
    if (!key || key.length < 8) {
      return res.status(400).json({ error: 'A phone number is required so the organizer can find you at the door' });
    }
    const name = String(req.body.name || '').trim().slice(0, 80);
    const guests = Math.max(1, Math.min(20, parseInt(req.body.guests) || 1));

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'cancelled') return res.status(410).json({ error: 'This event has been cancelled' });

    /* Changing your mind updates your answer instead of adding a second one.
       Two taps by one person is one attendee. */
    const existing = (event.rsvps || []).find(r => r.phoneKey === key);
    if (existing) {
      existing.response = response;
      existing.guests = guests;
      if (name) existing.name = name;
      existing.updatedAt = new Date();
    } else {
      event.rsvps.push({ name, phone, phoneKey: key, response, guests });
    }
    await event.save();

    const yes = event.rsvps.filter(r => r.response === 'yes');
    res.json({
      success: true,
      response,
      /* Their own answer back, and the headline count. Never the list. */
      attending: yes.reduce((a, r) => a + (r.guests || 1), 0),
      going: yes.length
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* What one person answered, so the page can show them their own state when
   they come back. Needs the phone they used - it returns nothing else. */
router.get('/:id/rsvp/me', async (req, res) => {
  try {
    const key = rsvpKey(req.query.phone);
    if (!key || key.length < 8) return res.json({ response: null });
    const event = await Event.findById(req.params.id).select('rsvps status');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    const mine = (event.rsvps || []).find(r => r.phoneKey === key);
    const yes = (event.rsvps || []).filter(r => r.response === 'yes');
    res.json({
      response: mine ? mine.response : null,
      name: mine ? mine.name : '',
      guests: mine ? mine.guests : 1,
      going: yes.length,
      attending: yes.reduce((a, r) => a + (r.guests || 1), 0)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* The attendee list. Names and phone numbers of real people, so it takes the
   organiser's manage code or his console code - the same gate as editing. */
router.get('/:id/rsvps', async (req, res) => {
  try {
    const event = await openEventFor(req, res, req.params.id);
    if (!event) return;
    const rows = (event.rsvps || []).slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const yes = rows.filter(r => r.response === 'yes');
    res.json({
      event: { _id: event._id, title: event.title, date: event.date },
      total: rows.length,
      going: yes.length,
      attending: yes.reduce((a, r) => a + (r.guests || 1), 0),
      declined: rows.filter(r => r.response === 'no').length,
      rsvps: rows.map(r => ({
        name: r.name, phone: r.phone, response: r.response, guests: r.guests,
        checkedInAt: r.checkedInAt || null, createdAt: r.createdAt
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
/* AFTER the line above, never before it. `module.exports = router` replaces
   the whole exports object, so a property hung on it earlier in the file is
   silently thrown away - server.js then passed undefined to app.get() and the
   entire API refused to boot with "argument handler must be a function". Every
   route on every service, down, because of where one line sat. */
module.exports.shareHandler = shareHandler;
