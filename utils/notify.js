const ADMIN_PHONE = process.env.ADMIN_PHONE || '50946859702';
const NOTIFY_WEBHOOK = process.env.NOTIFY_WEBHOOK || '';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'business@haitibiznis.com';

async function notifyAdmin(type, data) {
  const emojis = { ride: '🚗', driver: '👤', ticket: '🎫', refund: '💸', event: '📅' };
  const emoji = emojis[type] || '📢';
  const subjects = { ride: 'New Ride Request', driver: 'New Driver Signup', ticket: 'New Ticket Purchase', refund: 'Refund Request', event: 'New Event Created' };

  let message = '';
  switch (type) {
    case 'ride':
      message = `${emoji} NOUVO KOUS!\n\nNon: ${data.name || 'N/A'}\nTel: ${data.phone}\nMachin: ${data.vehicleType}\nDepi: ${data.pickup}\nAle: ${data.dropoff}\nPri: ${data.fare} HTG`;
      break;
    case 'driver':
      message = `${emoji} NOUVO CHOFE!\n\nNon: ${data.name}\nTel: ${data.phone}\nMachin: ${data.vehicleType}\nPlak: ${data.plate}\nZon: ${data.zone || 'N/A'}`;
      break;
    case 'ticket':
      message = `${emoji} NOUVO TIKE!\n\nNon: ${data.name || 'N/A'}\nTel: ${data.phone || 'N/A'}\nEvènman: ${data.event}\nTikè: ${data.ticket}\nKantite: ${data.qty}\nRef: ${data.ref}`;
      break;
    case 'refund':
      message = `${emoji} DEMANN RANBOUSMAN!\n\nTel: ${data.phone}\nRezon: ${data.reason}\nMontan: ${data.amount} HTG`;
      break;
    case 'event':
      message = `${emoji} NOUVO EVENMAN!\n\nTit: ${data.title}\nDat: ${data.date}\nKote: ${data.location}`;
      break;
  }

  console.log('[NOTIFY]', message.replace(/\n/g, ' | '));

  if (NOTIFY_WEBHOOK) {
    try {
      await fetch(NOTIFY_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, message, data, phone: ADMIN_PHONE })
      });
    } catch (e) {
      console.error('[NOTIFY] Webhook error:', e.message);
    }
  }

  // Email notification via formsubmit.co
  try {
    const subject = (subjects[type] || 'HaitiBiznis Notification') + ' - HaitiBiznis';
    const emailBody = message.replace(/\n/g, '\r\n');
    const params = new URLSearchParams();
    params.append('_subject', subject);
    params.append('message', emailBody);
    params.append('type', type);
    Object.keys(data).forEach(k => {
      if (data[k]) params.append(k, String(data[k]));
    });
    await fetch('https://formsubmit.co/ajax/' + ADMIN_EMAIL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: params.toString()
    });
    console.log('[NOTIFY] Email sent to', ADMIN_EMAIL);
  } catch (e) {
    console.error('[NOTIFY] Email error:', e.message);
  }

  return { whatsappUrl: `https://wa.me/${ADMIN_PHONE}?text=${encodeURIComponent(message)}` };
}

module.exports = { notifyAdmin };
