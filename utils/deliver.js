/* ═══ GETTING A CONFIRMATION TO THE PERSON WHO PAID ═════════════════════════
 *
 * Jeffery, 7 Oct 2026: "Once payment is confirmed, the customer/student needs
 * to automatically receive their confirmation and access information without
 * depending on the browser page."
 *
 * One place for both Tikè Lakay and the online classes. Before this there was
 * one half-built path for tickets and nothing at all for courses, which is how
 * two different "it never arrived" problems grow out of one cause.
 *
 * 🔑 WHATSAPP FIRST, THEN EMAIL, AND THAT ORDER IS NOT ARBITRARY.
 * A ticket buyer in Haiti gives a phone number and often has no email at all -
 * the checkout does not even ask for one. A course student always gives a
 * Gmail, because Google Classroom needs it. So whichever channel is going to
 * work, trying WhatsApp first and email second reaches more people than any
 * other order.
 *
 * ⛔ IT NEVER REPORTS SUCCESS IT DID NOT HAVE. Every attempt comes back with
 * what was tried and why it failed, and the caller writes that down. The whole
 * reason this module exists is that a ticket bought on 10 September was paid
 * for, never delivered, and looked in the database exactly like one that had
 * arrived safely.
 * ═══════════════════════════════════════════════════════════════════════════ */

const { sendWhatsApp, configured: waConfigured } = require('./whatsappSend');
const mailer = require('./mailer');

/* person  { phone, email, name }
 * message { wa: {template, lang, bodyParams, urlSuffix, text},
 *           email: {subject, html, text} }
 *
 * Returns { sent, channel, reason, attempts:[…] }. `attempts` is kept because
 * "WhatsApp refused it and the email worked" and "there was no email address"
 * are different stories and both need to be readable afterwards. */
async function deliver(person, message) {
  const attempts = [];
  person = person || {};
  message = message || {};

  if (message.wa && person.phone) {
    const r = await sendWhatsApp(person.phone, message.wa);
    attempts.push(r);
    if (r.sent) return { sent: true, channel: 'whatsapp', attempts: attempts };
  }

  if (message.email && person.email) {
    const r = await mailer.sendMail({
      to: person.email, toName: person.name,
      subject: message.email.subject,
      html: message.email.html, text: message.email.text
    });
    attempts.push(r);
    if (r.sent) return { sent: true, channel: 'email', attempts: attempts };
  }

  /* Nothing worked. Say which of the two situations it is, because they call
     for completely different actions: one needs an account opened, the other
     needs a phone number corrected. */
  let reason;
  if (!attempts.length) {
    reason = (!person.phone && !person.email)
      ? 'no phone number and no email address for this person'
      : 'no channel is configured on the server';
  } else {
    reason = attempts.map(a => a.channel + ': ' + (a.reason || 'failed')).join(' | ');
  }
  return { sent: false, channel: null, reason: reason, attempts: attempts };
}

/* What this instance can actually do. Booleans only - a credential must never
   leave the process. Used by /api/status/channels, which used to say
   "sms: false, email: false" as hard-coded literals. */
function channels() {
  return {
    whatsapp: waConfigured(),
    whatsappTemplateTicket: !!process.env.WHATSAPP_TEMPLATE_TICKET,
    whatsappTemplateCourse: !!process.env.WHATSAPP_TEMPLATE_COURSE,
    email: mailer.configured(),
    emailFrom: !!process.env.MAIL_FROM,
    emailKey: !!process.env.BREVO_API_KEY
  };
}

/* ─── SHARED PIECES OF THE WRITTEN MESSAGES ─────────────────────────────── */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/* An email that has to look right in Gmail on a cheap Android phone. Tables
   and inline styles on purpose: the mail clients people actually use here
   strip <style> blocks and know nothing about flexbox. */
function wrapEmail({ heading, subheading, bodyHtml, buttonText, buttonUrl, footer }) {
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#F5F7FA;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F5F7FA;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#FFFFFF;border-radius:16px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;">
    <tr><td style="height:4px;background:#00209F;"></td></tr>
    <tr><td style="background:#1B8C3D;padding:26px 20px;text-align:center;color:#FFFFFF;">
      <div style="font-size:30px;line-height:1;margin-bottom:8px;">&#9989;</div>
      <div style="font-size:21px;font-weight:bold;">${esc(heading)}</div>
      ${subheading ? `<div style="font-size:14px;margin-top:6px;opacity:.95;">${esc(subheading)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:22px 20px;color:#1A2A4A;font-size:15px;line-height:1.6;">
      ${bodyHtml}
      ${buttonUrl ? `<div style="text-align:center;margin:24px 0 6px;">
        <a href="${esc(buttonUrl)}" style="display:inline-block;background:#00209F;color:#FFFFFF;text-decoration:none;font-weight:bold;font-size:15px;padding:14px 26px;border-radius:10px;">${esc(buttonText)}</a>
      </div>
      <div style="text-align:center;font-size:12px;color:#8A95AA;word-break:break-all;">${esc(buttonUrl)}</div>` : ''}
    </td></tr>
    <tr><td style="padding:16px 20px;background:#F0F3F7;color:#5A6B8A;font-size:12px;line-height:1.6;text-align:center;">
      ${footer || 'HaitiBiznis'}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;
}

function row(label, value) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #F0F3F7;">
    <tr><td style="padding:9px 0;color:#5A6B8A;font-size:14px;">${esc(label)}</td>
        <td style="padding:9px 0;text-align:right;font-weight:bold;color:#0A0E1A;font-size:14px;word-break:break-word;">${esc(value)}</td></tr></table>`;
}

module.exports = { deliver, channels, wrapEmail, row, esc };
