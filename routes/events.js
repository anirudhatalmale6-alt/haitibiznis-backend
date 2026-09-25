const express = require('express');
const router = express.Router();
const Event = require('../models/Event');
const { notifyAdmin } = require('../utils/notify');
const { pinIsValid, requirePin } = require('../utils/consolePin');

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
    /* An invitation whose event is gone.
     *
     * This used to redirect to events.html, whose biggest buttons say "create
     * an event" - so somebody invited to a training arrived at a page inviting
     * them to build their own, and reasonably concluded the link was broken.
     * It went out to a WhatsApp group the morning of a session.
     *
     * Tell them what actually happened instead. Same escaping rules as below:
     * nothing here comes from a stranger, but the page is public. */
    if (!event) return res.status(404).send(`<!DOCTYPE html><html lang="ht"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Evènman sa a pa disponib ankò — Tikè Lakay</title>
<style>
 *{box-sizing:border-box;margin:0;padding:0}
 body{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#F3F6FB;
   color:#152341;line-height:1.55;display:flex;align-items:center;justify-content:center;
   min-height:100vh;padding:22px}
 .card{background:#fff;border:1px solid #DDE4EF;border-radius:18px;padding:26px 22px;
   max-width:420px;width:100%;text-align:center}
 .em{font-size:42px}
 h1{font-size:1.18rem;font-weight:800;margin:10px 0 8px}
 p{color:#5A6B8A;font-size:.95rem}
 .btn{display:block;margin-top:16px;padding:14px;border-radius:13px;font-weight:800;
   text-decoration:none;background:#0B2E6F;color:#fff}
 .btn.ghost{background:#fff;color:#0B2E6F;border:2px solid #0B2E6F;margin-top:9px}
 small{display:block;margin-top:14px;color:#93A0B8;font-size:.8rem}
</style></head><body><div class="card">
 <div class="em">&#128197;</div>
 <h1>Evènman sa a pa disponib ankò</h1>
 <p>Lyen sa a te pou yon evènman ki pa la ankò. Li ka fin pase oswa moun ki t ap
    òganize l la retire l.</p>
 <p style="margin-top:8px">Cet événement n'est plus disponible. Le lien correspond à un
    événement supprimé ou terminé.</p>
 <a class="btn" href="https://haitibiznis.com/events.html">Wè lòt evènman yo / Voir les autres événements</a>
 <a class="btn ghost" href="https://wa.me/50946859702">Kontakte nou / Nous contacter</a>
 <small>Tikè Lakay &middot; HaitiBiznis</small>
</div></body></html>`);
    const title = event.title || 'Evènman';
    const date = event.date ? new Date(event.date + 'T00:00:00').toLocaleDateString('fr-HT', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
    /* The time was in the database all along and never reached the preview
     * card, so every event shared to WhatsApp told people the day but not the
     * hour. It goes immediately after the date, before the address, because
     * that is the order somebody reads to decide whether they can come. */
    const time = [event.startTime, event.endTime].filter(Boolean).join(' – ');
    const loc = event.location || '';
    const when = date + (time ? ` · ${time}` : '');
    const desc = `${when}${loc ? ' | ' + loc : ''}${event.description ? ' — ' + event.description.substring(0, 120) : ''}`;
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
/* "Where do we get the event code?"
 *
 * A fair question with an embarrassing answer: nowhere. The manage code was
 * generated when an event was created, stored on the creating phone, and never
 * shown to a human being. And every event that existed before manage codes
 * were added has no code at all — so for those, the attendee list had no key
 * in the world that would open it except the console code.
 *
 * This is the recovery door, and it takes the console code because that is the
 * only credential that can prove ownership of an event nobody holds a code
 * for. It issues a code and returns it once.
 *
 * It REPLACES any existing code rather than revealing it — the stored value is
 * a PBKDF2 derivation and there is nothing to reveal. The response says which
 * of the two happened, because replacing a code an organiser is already using
 * is a thing he should be told about rather than discover.
 */
router.post('/:id/manage-code', requirePin, async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).select('+manageSalt +manageHash');
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const existed = !!(event.manageSalt && event.manageHash);
    const manageCode = Event.newManageCode();
    event.setManageCode(manageCode);
    await event.save();

    res.json({
      success: true,
      manageCode,
      replaced: existed,
      event: { _id: event._id, title: event.title, date: event.date }
    });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

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
    /* The names of the people coming WITH them. Trimmed, capped at the number
       of extra guests, and blanks dropped - somebody who fills in one of two
       boxes should not create an empty attendee. */
    const guestNames = (Array.isArray(req.body.guest_names) ? req.body.guest_names : [])
      .map(function (x) { return String(x || '').trim().slice(0, 80); })
      .filter(Boolean)
      .slice(0, Math.max(0, guests - 1));

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'cancelled') return res.status(410).json({ error: 'This event has been cancelled' });

    /* 🚨 24 Sep 2026. Jennifer set a workshop to 25 places and 26 people got in.
       Jeffery: "Eventhough she set it up for 25 tickets it took 26!"
       Her own diagnosis was the right one: "li monte 26 e gen 2 moun ki mete
       yap vinn ak 3 moun lot lan ak 2 moun" - two of the people who said yes
       are bringing guests.

       There was no capacity check on this route AT ALL. It counted the answers,
       reported them, and let them run past the limit.

       And the limit has to be counted in PEOPLE, not in answers. 22 people
       tapped yes and 26 are coming; a cap on the number of RSVPs would have
       let 25 answers in and 30 through the door. That is the whole bug.

       A "no" is never capped - declining a full event must always be possible. */
    const capacity = (event.tickets || [])
      .reduce((a, t) => a + (Number(t.qty) > 0 ? Number(t.qty) : 0), 0);
    if (response === 'yes' && capacity > 0) {
      /* Everyone else's head count. Excluding this person so that somebody
         changing "me plus two" to "just me" is not blocked by their own
         earlier answer. */
      const others = (event.rsvps || [])
        .filter(r => r.response === 'yes' && r.phoneKey !== key)
        .reduce((a, r) => a + (Number(r.guests) || 1), 0);
      if (others + guests > capacity) {
        const left = Math.max(0, capacity - others);
        return res.status(409).json({
          error: left === 0
            ? 'This event is full'
            : `Only ${left} place${left === 1 ? '' : 's'} left`,
          full: true, capacity, places_left: left, requested: guests
        });
      }
    }

    /* Changing your mind updates your answer instead of adding a second one.
       Two taps by one person is one attendee. */
    const existing = (event.rsvps || []).find(r => r.phoneKey === key);
    if (existing) {
      existing.response = response;
      existing.guests = guests;
      existing.guestNames = guestNames;
      if (name) existing.name = name;
      existing.updatedAt = new Date();
    } else {
      event.rsvps.push({ name, phone, phoneKey: key, response, guests, guestNames });
    }
    await event.save();

    const yes = event.rsvps.filter(r => r.response === 'yes');
    res.json({
      success: true,
      response,
      /* Their own answer back, and the headline count. Never the list. */
      attending: yes.reduce((a, r) => a + (r.guests || 1), 0),
      going: yes.length,
      /* So the page can say how many places are left instead of finding out by
         being refused. attending counts PEOPLE, which is what fills a room. */
      capacity: capacity || null,
      places_left: capacity > 0
        ? Math.max(0, capacity - yes.reduce((a, r) => a + (Number(r.guests) || 1), 0))
        : null
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
        /* Who is coming with them. The door needs names, not a number - "+2"
           tells you how many chairs, not who to let past. */
        guestNames: r.guestNames || [],
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
