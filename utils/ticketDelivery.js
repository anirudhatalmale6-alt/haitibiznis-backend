/* Getting a ticket to the person who paid for it.
 *
 * His words on 10 September: "i paid for it with moncash bu i never receided
 * the QR code either by SMS or WhatsApp or email ! It only asks for my phone
 * number."
 *
 * He is right on both counts, and the second half is the important one. The
 * checkout asks for a phone number and nothing else - no email, no account, no
 * password - because that is all most buyers in Haiti have. So the phone
 * number is the only thing that can ever be used to find a ticket again, and
 * until now nothing used it for that.
 *
 * Two ways out of here, and the platform should have both:
 *   1. push  - send the buyer their ticket link (this file, sendTicketLink)
 *   2. pull  - let the buyer look it up by the number they paid with
 *              (routes/payments.js, /my-tickets)
 *
 * The push half rides on the WhatsApp Cloud API that already carries the
 * MsouWout ride bot. It is the same graph.facebook.com send that answers
 * "Kous" today, so this needs no new supplier and no new number.
 *
 * ⚠️ It is only a push if the credentials are actually set. sendMessage in
 * routes/whatsapp.js falls back to writing [WA-DRY] into the log and returning
 * as though it had sent - which is the correct behaviour for a bot in
 * development and a silent lie for a ticket somebody paid for. So this reports
 * honestly what it did, and the caller records it on the transaction. A ticket
 * whose delivery failed must look different from one that was delivered.
 */
const WA_ENABLED = () => !!(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID);

/* Haitian mobiles are eight digits. WhatsApp wants them in full international
   form with no plus and no spaces. The same person's number reaches us as
   "31234567", "+509 3123 4567", "509-3123-4567" and "(509) 31234567" over
   the months, depending on who typed it. */
function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 8) d = '509' + d;              /* local, add the country */
  if (d.length === 11 && d.startsWith('509')) return d;
  /* Anything else is a foreign number the buyer typed in full. Send to it as
     given rather than mangling it into a Haitian one. */
  return d.length >= 10 ? d : null;
}

/* The same normalisation, used to FIND a ticket by phone. Stored numbers were
   typed by hand over months in every one of the formats above, so a lookup
   that compares the raw strings finds nothing and tells the buyer, wrongly,
   that they never bought a ticket. */
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  /* Compare on the last eight digits: that is the part that identifies a
     Haitian subscriber whether or not whoever typed it included the 509. */
  return d.length > 8 ? d.slice(-8) : d;
}

function ticketUrl(referenceId) {
  return 'https://haitibiznis.com/ticket.html?ref=' + encodeURIComponent(referenceId);
}

function ticketMessage(txn, event) {
  const title = (event && event.title) || 'evènman an';
  const when = (event && event.date) || '';
  const where = (event && event.location) || '';
  return [
    '🎟️ Tikè ou pare! / Votre billet est prêt!',
    '',
    (event && event.typeEmoji ? event.typeEmoji + ' ' : '') + title,
    when ? '📅 ' + when + (event && event.startTime ? ' ' + event.startTime : '') : '',
    where ? '📍 ' + where : '',
    '',
    '🎫 ' + (txn.ticketName || 'Tikè') + ' x' + (txn.qty || 1),
    '🔖 ' + txn.referenceId,
    '',
    'Louvri tikè ou ak kòd QR la isit la:',
    ticketUrl(txn.referenceId),
    '',
    'Montre kòd QR sa a nan pòt la. / Présentez ce QR code à l\'entrée.',
    '',
    'Tikè Lakay — HaitiBiznis'
  ].filter(l => l !== '').join('\n');
}

/* Returns what actually happened, never a bare true. */
async function sendTicketLink(txn, event) {
  const to = waNumber(txn && txn.buyerPhone);
  if (!to) return { sent: false, channel: 'whatsapp', reason: 'no usable phone number' };
  if (!WA_ENABLED()) return { sent: false, channel: 'whatsapp', reason: 'WhatsApp credentials not configured' };
  try {
    const url = 'https://graph.facebook.com/v21.0/' + process.env.WHATSAPP_PHONE_ID + '/messages';
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.WHATSAPP_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { preview_url: true, body: ticketMessage(txn, event) }
      })
    });
    /* fetch does not throw on 4xx. A ticket reported as delivered because
       nobody read the status code is the bug this whole file exists to end. */
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return { sent: false, channel: 'whatsapp', reason: 'HTTP ' + r.status + ' ' + body.slice(0, 200) };
    }
    return { sent: true, channel: 'whatsapp', to };
  } catch (err) {
    return { sent: false, channel: 'whatsapp', reason: err.message };
  }
}

module.exports = { sendTicketLink, ticketUrl, ticketMessage, waNumber, phoneKey, WA_ENABLED };
