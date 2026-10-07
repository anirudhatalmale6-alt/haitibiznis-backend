/* ═══ SENDING A WHATSAPP MESSAGE ════════════════════════════════════════════
 *
 * 🚨 THE RULE THAT BREAKS THE OBVIOUS IMPLEMENTATION.
 *
 * Meta, in their own words: "When a WhatsApp user messages you or calls you, a
 * 24-hour timer called a customer service window starts… When the window
 * closes, you can only send pre-approved template messages."
 *
 * A person who has just paid for a ticket has never messaged the business. So
 * there is NO open window, and a free-form text message to them is refused.
 * The original utils/ticketDelivery.js sent exactly that - type:"text" - which
 * means that even on the day the WhatsApp credentials arrived, almost every
 * ticket would still have gone undelivered, and the failure would have looked
 * like a credentials problem rather than a design one.
 *
 * So: a template is the real path, and free-form is the exception.
 *
 * ⛔ Free-form is still attempted when no template name is configured, because
 * that is exactly the situation during setup with Meta's test number (where
 * the five allow-listed testers DO have an open window), and because silently
 * doing nothing would be worse. But what was actually sent is recorded, so a
 * rejection reads as "free-form was refused, the template is not set up" and
 * not as a mystery.
 * ═══════════════════════════════════════════════════════════════════════════ */

/* Meta's own current examples use v23.0 and v25.0; v21.0 still answers but is
   old. Overridable, because the version is the kind of thing that has to
   change without a deploy when Meta sunsets one. */
const GRAPH = () => 'https://graph.facebook.com/' +
  (process.env.WHATSAPP_API_VERSION || 'v23.0') + '/';

function token() { return process.env.WHATSAPP_TOKEN || ''; }
function phoneId() { return process.env.WHATSAPP_PHONE_ID || ''; }
function configured() { return !!(token() && phoneId()); }

/* Haitian mobiles are eight digits. WhatsApp wants full international form
   with no plus and no spaces. The same person's number reaches us as
   "31234567", "+509 3123 4567", "509-3123-4567" and "(509) 31234567". */
function waNumber(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.length === 8) d = '509' + d;
  if (d.length === 11 && d.startsWith('509')) return d;
  /* Anything else is a foreign number typed in full. Send to it as given
     rather than mangling it into a Haitian one. */
  return d.length >= 10 ? d : null;
}

/* A template body parameter may not contain a newline, a tab, or four or more
   consecutive spaces. Meta rejects the whole message with error 132012,
   "Variable parameter values formatted incorrectly".

   ⚠️ Stated honestly: this rule is NOT in Meta's documentation. The whole
   WhatsApp documentation tree was searched for it - the page that used to
   carry the formatting rules now redirects to one that does not reproduce
   them. It is observed runtime behaviour, known from the error string the API
   returns, not a published contract. Cleaning here costs nothing, and the
   failure it prevents is a message that simply never arrives. */
function cleanParam(v) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();
}

async function post(body) {
  let r, text;
  try {
    r = await fetch(GRAPH() + phoneId() + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    text = await r.text().catch(() => '');
  } catch (err) {
    return { sent: false, reason: 'network: ' + err.message };
  }
  /* fetch does not throw on 4xx. Without this check a rejected message reads
     as a delivered one. */
  if (!r.ok) return { sent: false, reason: 'HTTP ' + r.status + ' ' + String(text).slice(0, 220) };
  let id = '';
  try { id = (((JSON.parse(text) || {}).messages || [])[0] || {}).id || ''; } catch (e) {}
  return { sent: true, id: id };
}

/* ─── THE ONE ENTRY POINT ────────────────────────────────────────────────────
   spec = {
     template:   name of an APPROVED template, or '' to force free-form
     lang:       template language code, e.g. 'fr'
     bodyParams: [ ... ] the {{1}} {{2}} values, in order
     urlSuffix:  the variable tail of a dynamic URL button, if the template
                 has one (the template defines https://…/x/{{1}})
     text:       the free-form message, used only when no template is set
   }                                                                          */
async function sendWhatsApp(toRaw, spec) {
  const to = waNumber(toRaw);
  if (!to) return { sent: false, channel: 'whatsapp', reason: 'no usable phone number' };
  if (!configured()) {
    return { sent: false, channel: 'whatsapp', reason: 'WhatsApp credentials not configured' };
  }

  if (spec && spec.template) {
    const components = [];
    if (spec.bodyParams && spec.bodyParams.length) {
      components.push({ type: 'body',
        parameters: spec.bodyParams.map(v => ({ type: 'text', text: cleanParam(v) })) });
    }
    if (spec.urlSuffix) {
      /* index is the button's ZERO-BASED position among the template's
         buttons. Meta publishes it both as a JSON string ("0") and as a number
         in different official examples; both are accepted, and the string is
         the commoner form in their docs.

         🔑 PERCENT-ENCODED, because Meta is explicit about this one: "If your
         URL button parameter values contain special characters, you must
         percent-encode them before including them... Unencoded special
         characters can cause the generated URL to fail validation, resulting
         in a message send error." Our references are plain A-Z0-9 and a
         hyphen, so today this changes nothing - which is exactly when it is
         cheap to get right. */
      components.push({ type: 'button', sub_type: 'url', index: '0',
        parameters: [{ type: 'text',
                       text: encodeURIComponent(cleanParam(spec.urlSuffix)) }] });
    }
    /* POSITIONAL parameters, which is still Meta's default: "If you do not
       specify a format, the template uses positional format by default." The
       template must therefore be CREATED positional too - sending positional
       values to a named template is error 132012. */
    const out = await post({
      messaging_product: 'whatsapp', recipient_type: 'individual', to,
      type: 'template',
      template: { name: spec.template, language: { code: spec.lang || 'fr' },
                  components: components }
    });
    return Object.assign({ channel: 'whatsapp', mode: 'template',
                           template: spec.template, to }, out);
  }

  if (!spec || !spec.text) {
    return { sent: false, channel: 'whatsapp', reason: 'nothing to send' };
  }

  /* No template configured. This only reaches somebody who has messaged the
     business in the last 24 hours; for anybody else Meta refuses it, and the
     refusal is recorded as such rather than swallowed. */
  const out = await post({
    messaging_product: 'whatsapp', to, type: 'text',
    text: { preview_url: true, body: spec.text }
  });
  if (!out.sent && /131047|132000|re-?engagement|24 hour/i.test(out.reason || '')) {
    out.reason = 'outside the 24-hour window and no approved template is ' +
                 'configured — ' + out.reason;
  }
  return Object.assign({ channel: 'whatsapp', mode: 'freeform', to }, out);
}

module.exports = { sendWhatsApp, waNumber, configured, cleanParam };
