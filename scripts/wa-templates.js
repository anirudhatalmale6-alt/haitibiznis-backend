/* ═══ THE TWO WHATSAPP TEMPLATES, READY TO SUBMIT ══════════════════════════
 *
 * Meta will not let a business send a free-form WhatsApp message to somebody
 * who has not written to it in the last 24 hours, and a buyer who has just
 * paid never has. So these templates are the only way a ticket or a course
 * confirmation reaches a phone. They have to be approved by Meta first, which
 * takes about a day - hence writing them before the account exists rather
 * than after.
 *
 * 🚨 THE PARAMETER COUNT MUST MATCH THE CODE EXACTLY. utils/ticketDelivery.js
 * sends four body parameters and utils/courseDelivery.js sends four; a
 * template with a different number of placeholders is rejected at send time
 * with error 132012, "Variable parameter values formatted incorrectly" - at
 * the worst possible moment, on somebody's paid ticket. scripts/check-wa-
 * templates.js asserts the two agree.
 *
 * 🔑 POSITIONAL parameters, which is still Meta's default: "If you do not
 * specify a format, the template uses positional format by default." Do not
 * set parameter_format to named here without changing utils/whatsappSend.js
 * to send parameter_name alongside each value.
 *
 * 🔑 The URL button's variable must be the LAST thing in the URL - Meta:
 * "Variable placeholder must be appended to the end of the URL string."
 *
 * TO SUBMIT (once the WhatsApp Business Account exists):
 *   WABA_ID=... WHATSAPP_TOKEN=... node scripts/wa-templates.js submit
 * To see what would be sent without sending it:
 *   node scripts/wa-templates.js
 * ═══════════════════════════════════════════════════════════════════════════ */

const LANG = process.env.WHATSAPP_TEMPLATE_LANG || 'fr';

/* Category UTILITY, not MARKETING: this is a confirmation of something the
   person just paid for. Utility templates are cheaper and are not subject to
   marketing opt-out rules. */
const TEMPLATES = [
  {
    name: 'tike_lakay_konfime',
    language: LANG,
    category: 'UTILITY',
    /* {{1}} buyer name · {{2}} event title · {{3}} ticket x qty · {{4}} ref
       — the order utils/ticketDelivery.js sends them in. */
    body: 'Bonjou {{1}}, tike ou pou {{2}} konfime. {{3}}. Referans: {{4}}. ' +
          'Montre kod QR la nan pot la.',
    example: ['Marie Joseph', 'Fomasyon Jesyon Biznis', 'Patisipasyon x1', 'TL-ABC123'],
    buttonText: 'Louvri tike a',
    buttonUrl: 'https://haitibiznis.com/ticket.html?ref={{1}}',
    buttonExample: 'TL-ABC123'
  },
  {
    name: 'kou_anliy_konfime',
    language: LANG,
    category: 'UTILITY',
    /* {{1}} student name · {{2}} course title · {{3}} their Gmail · {{4}} ref
       — the order utils/courseDelivery.js sends them in. The Gmail is in the
       body on purpose: it is the address the Classroom invitation goes to,
       and a student who typed it wrong needs to see that now, not later. */
    body: 'Bonjou {{1}}, enskripsyon ou nan {{2}} konfime. Tcheke Gmail ou ' +
          '({{3}}) pou envitasyon Google Classroom la. Referans: {{4}}.',
    example: ['Marie Joseph', 'Fomasyon Jesyon Biznis', 'marie@gmail.com', 'KO-ABC123'],
    buttonText: 'We enskripsyon an',
    buttonUrl: 'https://haitibiznis.com/kou-konfime.html?ref={{1}}',
    buttonExample: 'KO-ABC123'
  }
];

/* How many {{n}} placeholders the body actually has. Counted rather than
   trusted, because the whole point of check-wa-templates.js is to compare it
   against what the senders pass. */
function bodyParamCount(body) {
  const seen = new Set();
  String(body).replace(/\{\{(\d+)\}\}/g, (_, n) => { seen.add(Number(n)); return ''; });
  return seen.size;
}

function payloadFor(t) {
  return {
    name: t.name,
    language: t.language,
    category: t.category,
    components: [
      {
        type: 'BODY',
        text: t.body,
        example: { body_text: [t.example] }
      },
      {
        type: 'BUTTONS',
        buttons: [{
          type: 'URL',
          text: t.buttonText,
          url: t.buttonUrl,
          example: [t.buttonUrl.replace('{{1}}', t.buttonExample)]
        }]
      }
    ]
  };
}

async function submit() {
  const waba = process.env.WABA_ID;
  const token = process.env.WHATSAPP_TOKEN;
  if (!waba || !token) {
    console.error('Set WABA_ID and WHATSAPP_TOKEN first.');
    process.exit(1);
  }
  const ver = process.env.WHATSAPP_API_VERSION || 'v23.0';
  for (const t of TEMPLATES) {
    const r = await fetch(`https://graph.facebook.com/${ver}/${waba}/message_templates`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(payloadFor(t))
    });
    const text = await r.text();
    console.log(t.name, r.status, text.slice(0, 300));
  }
}

if (require.main === module) {
  if (process.argv[2] === 'submit') submit();
  else {
    for (const t of TEMPLATES) {
      console.log('\n=== ' + t.name + ' (' + t.language + ', ' + t.category + ') ===');
      console.log('body parameters: ' + bodyParamCount(t.body));
      console.log(JSON.stringify(payloadFor(t), null, 2));
    }
  }
}

module.exports = { TEMPLATES, payloadFor, bodyParamCount };
