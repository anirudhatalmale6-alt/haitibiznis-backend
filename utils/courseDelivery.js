/* ═══ TELLING A STUDENT THEY ARE IN ════════════════════════════════════════
 *
 * Until now a student who paid for a class received nothing at all. They had
 * to keep the confirmation page open, or find their registration again by
 * phone number. Jeffery, 7 Oct: "the customer/student needs to automatically
 * receive their confirmation and access information without depending on the
 * browser page."
 *
 * 🔑 THIS IS THE ONE MODULE WHERE EMAIL IS THE STRONG CHANNEL. Course
 * registration requires a Gmail address - Google Classroom runs on Google
 * accounts, so there is no such thing as a student without one. That is the
 * opposite of a ticket buyer, who usually has only a phone number. So classes
 * can be delivered the day the email account exists, without waiting for the
 * WhatsApp number.
 *
 * ⚠️ This is called from markRegPaid(), which is the atomic claim - so it runs
 * exactly once per registration, no matter how many things discover the
 * payment at the same moment.
 * ═══════════════════════════════════════════════════════════════════════════ */
const { deliver, wrapEmail, row, esc } = require('./deliver');

function confirmUrl(referenceId) {
  return 'https://haitibiznis.com/kou-konfime.html?ref=' + encodeURIComponent(referenceId);
}

/* The WhatsApp free-form version. Deliberately does NOT carry the Classroom
   link: a WhatsApp message gets forwarded in a group without a second
   thought, and the link is the thing being sold. It carries the confirmation
   page instead, which is tied to one reference. */
/* In person: the WhatsApp text gives the date, time and TOWN, never the
   address - same reasoning as the Classroom link above. The address is on the
   confirmation page and in the email. */
function venueWhen(v) {
  if (!v) return '';
  const d = v.startDate + (v.endDate && v.endDate !== v.startDate ? ' → ' + v.endDate : '');
  return [d, v.sessionTime].filter(Boolean).join(' · ');
}

function courseMessage(reg, course, venue) {
  if (venue) {
    return [
      '🎓 Enskripsyon ou konfime! / Votre inscription est confirmée!',
      '',
      reg.courseTitle || (course && course.title) || 'Fòmasyon an',
      '🏫 Fòmasyon AN PÈSÒN',
      '📅 ' + venueWhen(venue),
      venue.city ? '📍 ' + venue.city : '',
      '',
      '🔖 ' + reg.referenceId,
      '',
      'Adrès egzak la ak enstriksyon yo isit la:',
      confirmUrl(reg.referenceId),
      '',
      'HaitiBiznis — LajanMaker Academy'
    ].filter(l => l !== '').join('\n');
  }
  return [
    '🎓 Enskripsyon ou konfime! / Votre inscription est confirmée!',
    '',
    reg.courseTitle || (course && course.title) || 'Kou a',
    (course && course.instructor) ? '👩‍🏫 ' + course.instructor : '',
    (course && course.startDate) ? '📅 ' + course.startDate : '',
    '',
    '📧 ' + reg.email,
    '🔖 ' + reg.referenceId,
    '',
    'Enfòmasyon pou antre nan klas la isit la:',
    confirmUrl(reg.referenceId),
    '',
    'Enpòtan: tcheke Gmail ou. Se la envitasyon Google Classroom la ap rive.',
    '',
    'HaitiBiznis — Kou Anliy'
  ].filter(l => l !== '').join('\n');
}

function venueEmail(reg, course, classroom, venue) {
  const title = reg.courseTitle || (course && course.title) || 'Fòmasyon an';
  const cr = classroom || {};
  let body = '<p style="margin:0 0 14px;">Bonjou ' + esc(reg.studentName || '') +
    ',<br>Peman ou konfime epi plas ou nan fòmasyon an rezève.</p>';
  body += row('Fòmasyon', title);
  body += row('Kalite', 'AN PÈSÒN');
  if (course && course.instructor) body += row('Fòmatè', course.instructor);
  body += row('Dat', venueWhen(venue) || '—');
  if (venue.city) body += row('Vil', venue.city);
  body += row('Montan', Number(reg.amount) > 0
    ? Number(reg.amount).toLocaleString('en-US') + ' ' + (reg.currency || 'HTG')
    : 'GRATIS');
  body += row('Referans', reg.referenceId);
  body += '<div style="margin:18px 0 0;padding:14px;background:#FDF3D7;border:1px solid #EBD9A0;' +
    'border-radius:10px;font-size:14px;line-height:1.65;color:#6B5208;">' +
    '<b style="display:block;margin-bottom:6px;">KI KOTE</b>' +
    esc(venue.location || '') + (venue.city ? '<br>' + esc(venue.city) : '') + '</div>';
  if (cr.instructions) {
    body += '<div style="margin:16px 0;padding:14px;background:#F0F3F7;border-radius:10px;' +
      'font-size:14px;line-height:1.6;white-space:pre-wrap;">' + esc(cr.instructions) + '</div>';
  }
  return {
    subject: '🎓 Enskripsyon konfime — ' + title,
    html: wrapEmail({
      heading: 'PEMAN KONFIME',
      subheading: 'PLAS OU REZÈVE',
      bodyHtml: body,
      buttonText: 'WÈ ENSKRIPSYON OU',
      buttonUrl: confirmUrl(reg.referenceId),
      footer: 'HaitiBiznis — LajanMaker Academy<br>Ou ka jwenn fòmasyon ou yo nenpòt lè sou haitibiznis.com/kou-mwen.html'
    })
  };
}

function courseEmail(reg, course, classroom, venue) {
  if (venue) return venueEmail(reg, course, classroom, venue);
  const title = reg.courseTitle || (course && course.title) || 'Kou a';
  const cr = classroom || {};
  const link = /^https?:\/\//i.test(String(cr.link || '').trim()) ? String(cr.link).trim() : '';

  let body = '<p style="margin:0 0 14px;">Bonjou ' + esc(reg.studentName || '') +
    ',<br>Peman ou konfime epi plas ou nan kou a rezève.</p>';
  body += row('Kou', title);
  if (course && course.instructor) body += row('Pwofesè', course.instructor);
  if (course && course.startDate) body += row('Kòmanse', course.startDate);
  body += row('Montan', Number(reg.amount) > 0
    ? Number(reg.amount).toLocaleString('en-US') + ' ' + (reg.currency || 'HTG')
    : 'GRATIS');
  body += row('Referans', reg.referenceId);

  /* The instructions the organiser wrote on the course, if any. */
  if (cr.instructions) {
    body += '<div style="margin:16px 0;padding:14px;background:#F0F3F7;border-radius:10px;' +
      'font-size:14px;line-height:1.6;white-space:pre-wrap;">' + esc(cr.instructions) + '</div>';
  }

  body += '<div style="margin:18px 0 0;padding:14px;background:#FDF3D7;border:1px solid #EBD9A0;' +
    'border-radius:10px;font-size:14px;line-height:1.65;color:#6B5208;">' +
    '<b style="display:block;margin-bottom:6px;">KIJAN POU W ANTRE NAN KLAS LA</b>' +
    '1. Tcheke Gmail sa a: <b>' + esc(reg.email) + '</b><br>' +
    '2. W ap jwenn yon envitasyon Google Classroom. Peze "Join" oswa "Aksepte".<br>' +
    '3. Apre sa ou ka antre nan kou a.' +
    '</div>';

  if (cr.code) {
    body += '<p style="margin:16px 0 0;text-align:center;font-size:14px;color:#5A6B8A;">' +
      'Kòd klas la: <b style="font-family:monospace;font-size:16px;color:#0A0E1A;">' +
      esc(cr.code) + '</b></p>';
  }

  return {
    subject: '🎓 Enskripsyon konfime — ' + title,
    html: wrapEmail({
      heading: 'PEMAN KONFIME',
      subheading: 'KOU OU A PARE',
      bodyHtml: body,
      /* The Classroom link when there is one, otherwise the confirmation page,
         which will show the link the moment the organiser adds it. Never a
         dead button. */
      buttonText: link ? 'ANTRE NAN KOU A' : 'WÈ ENSKRIPSYON OU',
      buttonUrl: link || confirmUrl(reg.referenceId),
      footer: 'HaitiBiznis — Kou Anliy<br>Ou ka jwenn kou ou yo nenpòt lè sou haitibiznis.com/kou-mwen.html'
    })
  };
}

async function sendCourseAccess(reg, course, classroom, venue) {
  if (!reg) return { sent: false, reason: 'no registration' };
  return deliver(
    { phone: reg.phone, email: reg.email, name: reg.studentName },
    {
      wa: {
        template: process.env.WHATSAPP_TEMPLATE_COURSE || '',
        lang: process.env.WHATSAPP_TEMPLATE_LANG || 'fr',
        bodyParams: [
          reg.studentName || 'Etidyan',
          reg.courseTitle || (course && course.title) || 'kou a',
          reg.email,
          reg.referenceId
        ],
        urlSuffix: reg.referenceId,
        text: courseMessage(reg, course, venue)
      },
      email: courseEmail(reg, course, classroom, venue)
    }
  );
}

module.exports = { sendCourseAccess, courseEmail, courseMessage, confirmUrl };
