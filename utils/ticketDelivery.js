/* Getting a ticket to the person who paid for it.
 *
 * His words on 10 September: "i paid for it with moncash bu i never receided
 * the QR code either by SMS or WhatsApp or email ! It only asks for my phone
 * number."
 *
 * He is right on both counts, and the second half is the important one. The
 * checkout asks for a phone number and nothing else - no email, no account, no
 * password - because that is all most buyers in Haiti have. So the phone
 * number is the only thing that can ever be used to find a ticket again.
 *
 * Two ways out of here, and the platform has both:
 *   1. push  - send the buyer their ticket (this file)
 *   2. pull  - let the buyer look it up by the number they paid with
 *              (routes/payments.js, /my-tickets)
 *
 * ⚠️ CORRECTING WHAT THIS COMMENT USED TO SAY. It claimed the push "rides on
 * the WhatsApp Cloud API that already carries the MsouWout ride bot… so this
 * needs no new supplier and no new number". Both halves are wrong and I wrote
 * them. There is no live bot - whatsapp-bot/ is a prototype whose service was
 * never created - and connecting a number to Meta's Cloud API takes that
 * number OUT of the ordinary WhatsApp app, so his business number cannot be
 * the one used. It needs a second SIM. Told him again on 7 Oct.
 *
 * The sending itself now lives in utils/deliver.js, shared with the online
 * classes, so there is one answer to "how do we reach this person" instead of
 * one per module.
 */
const { deliver, wrapEmail, row, esc } = require('./deliver');
const { waNumber, configured: WA_ENABLED } = require('./whatsappSend');

/* The same normalisation, used to FIND a ticket by phone. Stored numbers were
   typed by hand over months in every format, so a lookup that compares the raw
   strings finds nothing and tells the buyer, wrongly, that they never bought a
   ticket. Kept here because routes/pos.js and routes/courses.js both import it
   from this file, and models/PosTrial.js documents that it must match. */
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

function ticketEmail(txn, event) {
  const title = (event && event.title) || 'Evènman';
  const when = [(event && event.date) || '', (event && event.startTime) || '']
    .filter(Boolean).join(' ');
  let body = '<p style="margin:0 0 14px;">Bonjou ' + esc(txn.buyerName || '') +
    ',<br>Tikè ou konfime. Men detay yo:</p>';
  body += row('Evènman', title);
  if (when) body += row('Dat', when);
  if (event && event.location) body += row('Kote', event.location);
  body += row('Tikè', (txn.ticketName || 'Tikè') + ' x' + (txn.qty || 1));
  body += row('Referans', txn.referenceId);
  body += '<p style="margin:16px 0 0;font-size:14px;color:#5A6B8A;">' +
    'Montre kòd QR la nan pòt la. / Présentez le QR code à l\'entrée.</p>';
  return {
    subject: '🎟️ Tikè ou — ' + title,
    html: wrapEmail({
      heading: 'TIKÈ OU KONFIME',
      subheading: 'Votre billet est confirmé',
      bodyHtml: body,
      buttonText: 'LOUVRI TIKÈ A',
      buttonUrl: ticketUrl(txn.referenceId),
      footer: 'Tikè Lakay — HaitiBiznis<br>Ou ka jwenn tikè ou nenpòt lè sou haitibiznis.com/my-tickets.html'
    })
  };
}

/* Returns what actually happened, never a bare true. */
async function sendTicketLink(txn, event) {
  if (!txn) return { sent: false, reason: 'no transaction' };
  const mail = ticketEmail(txn, event);
  return deliver(
    { phone: txn.buyerPhone, email: txn.buyerEmail, name: txn.buyerName },
    {
      wa: {
        /* Set once the template is approved by Meta. Until then the free-form
           text below is attempted, which only reaches somebody with an open
           24-hour window - see utils/whatsappSend.js. */
        template: process.env.WHATSAPP_TEMPLATE_TICKET || '',
        lang: process.env.WHATSAPP_TEMPLATE_LANG || 'fr',
        bodyParams: [
          txn.buyerName || 'Kliyan',
          (event && event.title) || 'evènman an',
          (txn.ticketName || 'Tikè') + ' x' + (txn.qty || 1),
          txn.referenceId
        ],
        urlSuffix: txn.referenceId,
        text: ticketMessage(txn, event)
      },
      email: mail
    }
  );
}

module.exports = { sendTicketLink, ticketUrl, ticketMessage, ticketEmail,
                   waNumber, phoneKey, WA_ENABLED };
