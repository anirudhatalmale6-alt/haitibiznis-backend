/* ═══ WHEN A TICKET'S QR CODE BECOMES USABLE ════════════════════════════════
 *
 * Jeffery, 29 Oct 2026: "The QR code automatically becomes clear and scannable
 * exactly 2 hours before the event starts, based on the event's local time.
 * Before activation, the server must reject any attempt to validate the
 * ticket, even if someone obtains the QR data… If the event start time
 * changes, the activation time must update automatically… Do not rely on
 * visual blurring alone."
 *
 * So nothing here is stored: the activation moment is worked out from the
 * event's CURRENT date and start time every time it is asked, which is what
 * makes a rescheduled event move its tickets' activation by itself.
 *
 * Events are in Haiti and their date/time are typed as Haiti wall-clock time
 * ("2026-11-15", "20:00"). Haiti observes daylight saving, so the offset is
 * looked up for that very day (Intl), never hard-coded as -5 or -4.
 * ═══════════════════════════════════════════════════════════════════════════ */
const TZ = process.env.TL_EVENT_TZ || 'America/Port-au-Prince';
const BEFORE_MIN = Number(process.env.TL_QR_ACTIVATE_BEFORE_MIN || 120);

/* Offset (minutes) of TZ from UTC at the given UTC instant. */
function offsetMin(utcMs) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = {}; f.formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - utcMs) / 60000);
}

/* Haiti wall-clock date + time → the real instant (Date). Null if unreadable. */
function haitiToDate(ymd, hm) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!d) return null;
  const t = /^(\d{1,2}):(\d{2})/.exec(String(hm || '')) || [null, '0', '00'];
  const guess = Date.UTC(+d[1], +d[2] - 1, +d[3], +t[1], +t[2]);
  // two passes settle the offset even on a daylight-saving changeover day
  let ms = guess - offsetMin(guess) * 60000;
  ms = guess - offsetMin(ms) * 60000;
  return new Date(ms);
}

/* The event's start. No start time typed ⇒ the start of that day. */
function eventStart(event) {
  if (!event) return null;
  return haitiToDate(event.date, event.startTime || '00:00');
}

/* When the tickets of this event become scannable. */
function activationAt(event) {
  const s = eventStart(event);
  return s ? new Date(s.getTime() - BEFORE_MIN * 60000) : null;
}

/* An event we cannot date is never "active" - a ticket is not let in on a guess. */
function isActive(event, now) {
  const a = activationAt(event);
  return !!a && (now || new Date()) >= a;
}

module.exports = { TZ, BEFORE_MIN, haitiToDate, eventStart, activationAt, isActive, offsetMin };
