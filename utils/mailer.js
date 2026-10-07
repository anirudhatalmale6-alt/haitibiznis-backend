/* ═══ SENDING AN EMAIL ══════════════════════════════════════════════════════
 *
 * Jeffery, 7 Oct 2026: "Once payment is confirmed, the customer/student needs
 * to automatically receive their confirmation and access information without
 * depending on the browser page."
 *
 * Brevo's HTTP API, called with plain fetch. No npm package on purpose:
 * nodemailer would mean a new dependency and a lockfile change on a service
 * that handles money, to do something that is one POST. The same reasoning as
 * utils/stripe.js.
 *
 * Why Brevo rather than one of the better-known senders: the alternatives want
 * DNS records on haitibiznis.com before they will send to anybody but you, and
 * the DNS for that domain is not something I can touch. Brevo will send from a
 * single address that its owner has confirmed by clicking a link in their own
 * inbox, which is a thing Jeffery can do from his phone in five minutes.
 *
 * ⛔ Never returns a bare true. A ticket reported as delivered because nobody
 * read the status code is the bug this whole area exists to end.
 * ═══════════════════════════════════════════════════════════════════════════ */

const API = 'https://api.brevo.com/v3/smtp/email';

function key() { return process.env.BREVO_API_KEY || ''; }
function configured() { return !!key() && !!fromAddress(); }

/* Who the mail comes from. Must be an address confirmed inside Brevo, or
   every send is rejected - which is the single most likely way for this to be
   "configured" and still not work. */
function fromAddress() { return process.env.MAIL_FROM || ''; }
function fromName() { return process.env.MAIL_FROM_NAME || 'HaitiBiznis'; }

function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(String(s || '').trim());
}

/* Plain text from HTML, for the text part. Mail clients that cannot or will
   not render HTML are still common on cheap Android handsets, and an empty
   text part is one of the things that pushes a message into spam. */
function textFromHtml(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendMail({ to, toName, subject, html, text, replyTo }) {
  if (!configured()) {
    return { sent: false, channel: 'email',
             reason: !key() ? 'BREVO_API_KEY not configured'
                            : 'MAIL_FROM not configured' };
  }
  if (!looksLikeEmail(to)) {
    return { sent: false, channel: 'email', reason: 'no usable email address' };
  }

  const body = {
    sender: { email: fromAddress(), name: fromName() },
    to: [{ email: String(to).trim(), name: String(toName || '').slice(0, 70) || undefined }],
    subject: String(subject || '').slice(0, 180),
    htmlContent: html,
    textContent: text || textFromHtml(html)
  };
  if (replyTo && looksLikeEmail(replyTo)) body.replyTo = { email: replyTo };

  let r, payload;
  try {
    r = await fetch(API, {
      method: 'POST',
      headers: { 'api-key': key(), 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body)
    });
    payload = await r.text().catch(() => '');
  } catch (err) {
    /* Unreachable is not "delivered" and it is not "refused" either - the
       caller leaves it undelivered and may try again. */
    return { sent: false, channel: 'email', reason: 'network: ' + err.message };
  }

  /* 201 on an immediate send, 202 when scheduled. fetch does not throw on 4xx,
     so without this check a wrong API key would read as a delivered email. */
  if (r.status !== 201 && r.status !== 202) {
    return { sent: false, channel: 'email',
             reason: 'HTTP ' + r.status + ' ' + String(payload).slice(0, 200) };
  }
  let id = '';
  try { id = (JSON.parse(payload) || {}).messageId || ''; } catch (e) {}
  return { sent: true, channel: 'email', to: String(to).trim(), id: id };
}

module.exports = { sendMail, configured, fromAddress, textFromHtml, looksLikeEmail };
