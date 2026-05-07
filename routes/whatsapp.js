const express = require('express');
const router = express.Router();
const ChatSession = require('../models/ChatSession');
const Driver = require('../models/Driver');
const Ride = require('../models/Ride');
const Refund = require('../models/Refund');

const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || 'msouwout_verify_2026';
const ACCESS_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_ID;
const WHATSAPP_NUMBER = '+509 4685 9702';

const ZONES = ['Delmas', 'Pétion-Ville', 'Tabarre', 'Carrefour', 'Centre-ville'];

const KEYWORDS = {
  ride: ['kous', 'ride', 'transport', 'transpò', 'vwayaj'],
  driver: ['chofe', 'chofè', 'travay', 'driver', 'moto', 'machin'],
  koutye: ['biznis', 'koutye', 'broker', 'lajan', 'rekòmande'],
  refund: ['refund', 'ranbousman', 'problem', 'pwoblèm', 'ranbouseman'],
  help: ['help', 'ede', 'info', 'bonjou', 'bonswa', 'hello', 'hi', 'salut']
};

// --- WhatsApp Cloud API sender ---

async function sendMessage(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    console.log(`[WA-DRY] To: ${to}\n${text}\n`);
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
      })
    });
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
  }
}

// --- Session management ---

async function getSession(phone) {
  let session = await ChatSession.findOne({ phone });
  if (!session) {
    session = new ChatSession({ phone });
    await session.save();
  }
  return session;
}

async function resetSession(session) {
  session.flow = null;
  session.step = 0;
  session.data = {};
  session.lastActivity = new Date();
  await session.save();
}

async function updateSession(session, updates) {
  Object.assign(session, updates);
  session.lastActivity = new Date();
  await session.save();
}

// --- Keyword detection ---

function detectFlow(text) {
  const lower = text.toLowerCase().trim();
  for (const [flow, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => lower.includes(w))) return flow;
  }
  return null;
}

// --- Price estimation ---

function estimatePrice(vehicleType) {
  if (vehicleType === 'moto') return { low: 100, high: 300 };
  return { low: 250, high: 500 };
}

// --- Reference ID generators ---

function rideRef() {
  return 'MSW-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

function koutyeCode(name) {
  const base = name.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
  const num = Math.floor(100 + Math.random() * 900);
  return `KT-${base}${num}`;
}

function refundRef() {
  return 'REF-' + Math.random().toString(36).substring(2, 7).toUpperCase();
}

// --- Webhook verification (GET) ---

router.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  res.sendStatus(403);
});

// --- Webhook handler (POST) ---

router.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (!body.object || body.object !== 'whatsapp_business_account') return;

    for (const entry of (body.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const val = change.value || {};
        for (const msg of (val.messages || [])) {
          const from = msg.from;
          const contactName = val.contacts?.[0]?.profile?.name || '';
          if (msg.type === 'text') {
            await handleMessage(from, msg.text.body, contactName);
          } else if (msg.type === 'location') {
            await handleLocation(from, msg.location, contactName);
          } else if (msg.type === 'image') {
            await handleImage(from, contactName);
          }
        }
      }
    }
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// --- Main message handler ---

async function handleMessage(phone, text, contactName) {
  const session = await getSession(phone);
  const trimmed = text.trim();

  if (trimmed.toLowerCase() === 'anile' || trimmed.toLowerCase() === 'cancel' || trimmed === '0') {
    await resetSession(session);
    return sendMessage(phone, 'Anile. Ekri "Ede" pou wè opsyon yo.');
  }

  if (session.flow) {
    return handleFlowStep(phone, session, trimmed, contactName);
  }

  const flow = detectFlow(trimmed);
  if (!flow) return sendDefaultResponse(phone);

  if (flow === 'help') return sendHelpResponse(phone);

  await updateSession(session, { flow, step: 1, data: {} });
  if (!session.name && contactName) session.name = contactName;
  await session.save();

  switch (flow) {
    case 'ride': return sendRideStep1(phone);
    case 'driver': return sendDriverStep1(phone);
    case 'koutye': return sendKoutyeStep1(phone);
    case 'refund': return sendRefundStep1(phone);
  }
}

// --- Flow step router ---

async function handleFlowStep(phone, session, text, contactName) {
  switch (session.flow) {
    case 'ride': return handleRideFlow(phone, session, text, contactName);
    case 'driver': return handleDriverFlow(phone, session, text, contactName);
    case 'koutye': return handleKoutyeFlow(phone, session, text, contactName);
    case 'refund': return handleRefundFlow(phone, session, text, contactName);
  }
}

// ===========================
// FLOW 1: RIDE REQUEST
// ===========================

function sendRideStep1(phone) {
  return sendMessage(phone,
    `Bonjou! Byenveni sou MsouWout 🚗🏍️\nKote ou ye kounye a? (Ekri adrès ou oswa voye lokasyon ou)`
  );
}

async function handleRideFlow(phone, session, text, contactName) {
  switch (session.step) {
    case 1: {
      await updateSession(session, { step: 2, data: { ...session.data, pickup: text } });
      return sendMessage(phone, `Kote ou prale? (Ekri destinasyon ou)`);
    }
    case 2: {
      await updateSession(session, { step: 3, data: { ...session.data, destination: text } });
      return sendMessage(phone,
        `Ki kalite transpò ou vle?\n1️⃣ Moto 🏍️ (Pi rapid, pi abodab)\n2️⃣ Machin 🚗 (Konfortab, AC)\n\nEkri 1 oswa 2`
      );
    }
    case 3: {
      const choice = text.trim();
      let vType;
      if (choice === '1' || choice.toLowerCase().includes('moto')) vType = 'moto';
      else if (choice === '2' || choice.toLowerCase().includes('machin') || choice.toLowerCase().includes('car')) vType = 'car';
      else return sendMessage(phone, `Tanpri ekri 1 pou Moto oswa 2 pou Machin.`);

      const price = estimatePrice(vType);
      const vLabel = vType === 'moto' ? 'Moto 🏍️' : 'Machin 🚗';
      await updateSession(session, { step: 4, data: { ...session.data, vehicleType: vType } });

      return sendMessage(phone,
        `📍 ${session.data.pickup} ➡️ ${session.data.destination}\n🚗 ${vLabel}\n💰 Estimasyon: ~${price.low}-${price.high} HTG\n\nOu vle konfime kous sa a?\n1️⃣ Wi, mande kous ✅\n2️⃣ Non, anile ❌`
      );
    }
    case 4: {
      const choice = text.trim();
      if (choice === '2' || choice.toLowerCase().includes('non') || choice.toLowerCase().includes('anile')) {
        await resetSession(session);
        return sendMessage(phone, `Kous la anile. Ekri "Kous" nenpòt lè ou bezwen transpò!`);
      }
      if (choice !== '1' && !choice.toLowerCase().includes('wi') && !choice.toLowerCase().includes('yes')) {
        return sendMessage(phone, `Ekri 1 pou konfime oswa 2 pou anile.`);
      }

      if (!session.name) {
        await updateSession(session, { step: 5 });
        return sendMessage(phone, `Pou konfime, ki non ou?`);
      }

      return completeRide(phone, session, session.name);
    }
    case 5: {
      await updateSession(session, { name: text });
      return completeRide(phone, session, text);
    }
  }
}

async function completeRide(phone, session, name) {
  const ref = rideRef();
  const price = estimatePrice(session.data.vehicleType);

  try {
    await Ride.create({
      riderName: name,
      riderPhone: phone,
      vehicleType: session.data.vehicleType,
      pickupAddress: session.data.pickup,
      dropoffAddress: session.data.destination,
      isNow: true,
      status: 'pending',
      estimatedFare: Math.round((price.low + price.high) / 2),
      notes: `WhatsApp - Ref: ${ref}`
    });
  } catch (err) {
    console.error('Ride save error:', err.message);
  }

  await resetSession(session);

  return sendMessage(phone,
    `✅ Mèsi ${name}! Nou resevwa demann ou an.\n\nNou nan faz lansman epi n ap aktive premye chofè verifye yo nan zòn ou an. Ekip nou an ap kontakte ou sou WhatsApp lè nou gen transpò ki disponib nan zòn ou an.\n\n🚀 Rete konekte — MsouWout ap rive nan zòn ou trè byento!\n\nRef: ${ref}`
  );
}

// ===========================
// FLOW 2: DRIVER SIGNUP
// ===========================

function sendDriverStep1(phone) {
  return sendMessage(phone,
    `Byenveni! Ou vle touche lajan ak machin/moto ou? 💰\nMsouWout ap chache chofè verifye.\n\nTouche 500-3,000 HTG chak jou!\n\nPou kòmanse, ki non ou?`
  );
}

async function handleDriverFlow(phone, session, text, contactName) {
  switch (session.step) {
    case 1: {
      const name = text.trim();
      await updateSession(session, { step: 2, name, data: { ...session.data, driverName: name } });
      return sendMessage(phone,
        `Mèsi ${name}!\nKi nimewo telefon ou? (Si se pa menm nimewo sa a)`
      );
    }
    case 2: {
      const driverPhone = text.trim();
      const ph = (driverPhone.toLowerCase() === 'menm' || driverPhone.toLowerCase() === 'same' || driverPhone.match(/^menm/i))
        ? phone : driverPhone;
      await updateSession(session, { step: 3, data: { ...session.data, driverPhone: ph } });
      return sendMessage(phone,
        `Ki kalite machin ou genyen?\n1️⃣ Moto 🏍️\n2️⃣ Machin 🚗\n\nEkri 1 oswa 2`
      );
    }
    case 3: {
      let vType;
      if (text === '1' || text.toLowerCase().includes('moto')) vType = 'moto';
      else if (text === '2' || text.toLowerCase().includes('machin') || text.toLowerCase().includes('car')) vType = 'car';
      else return sendMessage(phone, `Tanpri ekri 1 pou Moto oswa 2 pou Machin.`);

      await updateSession(session, { step: 4, data: { ...session.data, vehicleType: vType } });
      return sendMessage(phone,
        `Ki ane machin/moto ou an ye? (Eksemp: 2015)\n⚠️ Minimòm: 2010`
      );
    }
    case 4: {
      const year = parseInt(text.trim());
      if (isNaN(year) || year < 1990 || year > 2030) {
        return sendMessage(phone, `Tanpri ekri yon ane valid (eksemp: 2015).`);
      }
      if (year < 2010) {
        return sendMessage(phone, `Dezole, minimòm ane a se 2010. Machin/moto ou an twò ansyen pou MsouWout.`);
      }
      await updateSession(session, { step: 5, data: { ...session.data, vehicleYear: year } });
      return sendMessage(phone,
        `Nan ki zòn ou travay plis?\n1️⃣ Delmas\n2️⃣ Pétion-Ville\n3️⃣ Tabarre\n4️⃣ Carrefour\n5️⃣ Centre-ville\n6️⃣ Lòt (ekri zòn nan)`
      );
    }
    case 5: {
      let zone;
      const num = parseInt(text.trim());
      if (num >= 1 && num <= 5) zone = ZONES[num - 1];
      else zone = text.trim();

      await updateSession(session, { step: 6, data: { ...session.data, zone } });
      return completeDriverSignup(phone, session);
    }
  }
}

async function completeDriverSignup(phone, session) {
  const d = session.data;
  const vLabel = d.vehicleType === 'moto' ? 'Moto 🏍️' : 'Machin 🚗';
  const nameParts = d.driverName.split(' ');

  try {
    await Driver.create({
      firstName: nameParts[0] || d.driverName,
      lastName: nameParts.slice(1).join(' ') || '',
      phone: d.driverPhone || phone,
      vehicleType: d.vehicleType,
      vehicleYear: d.vehicleYear,
      zone: d.zone,
      licensePlate: 'PENDING',
      status: 'offline',
      verified: false
    });
  } catch (err) {
    if (err.code === 11000) {
      console.log('Driver already registered:', phone);
    } else {
      console.error('Driver save error:', err.message);
    }
  }

  await resetSession(session);

  return sendMessage(phone,
    `✅ Mèsi ${d.driverName}! Men enfòmasyon ou:\n\n🚗 ${vLabel} - Ane ${d.vehicleYear}\n📍 Zòn: ${d.zone}\n📱 Nimewo: ${d.driverPhone || phone}\n\nNou pral verifye enfòmasyon ou yo epi kontakte ou nan 24è.\n\nPou kòmanse touche pi vit, voye:\n📸 Foto machin/moto ou\n📄 Foto lisans ou\n\nByenveni nan ekip MsouWout! 🎉`
  );
}

// ===========================
// FLOW 3: KOUTYE (BROKER)
// ===========================

function sendKoutyeStep1(phone) {
  return sendMessage(phone,
    `Ou vle fè lajan ak MsouWout san ou pa gen machin? 💰\n\nVin yon Parenaj Biznis (Broker)!\nRekòmande MsouWout bay lòt moun epi touche 10% sou chak kous.\n\nPou kòmanse, ki non ou?`
  );
}

async function handleKoutyeFlow(phone, session, text, contactName) {
  switch (session.step) {
    case 1: {
      const name = text.trim();
      await updateSession(session, { step: 2, name, data: { ...session.data, koutyeName: name } });
      return sendMessage(phone,
        `Mèsi ${name}!\nKi nimewo telefon ou?`
      );
    }
    case 2: {
      const kPhone = text.trim();
      const code = koutyeCode(session.data.koutyeName);
      await updateSession(session, { koutyeCode: code });
      await resetSession(session);

      return sendMessage(phone,
        `✅ Ou enskri kòm Parenaj Biznis MsouWout!\n\nMen kòd referans ou: ${code}\nChak fwa yon moun itilize kòd sa a, ou touche 10%!\n\nPataje mesaj sa a:\n"Bezwen kous? Ekri 'Kous' sou WhatsApp ${WHATSAPP_NUMBER} epi mete kòd ${code}"\n\nPlis moun ou rekòmande = Plis lajan ou touche! 💰`
      );
    }
  }
}

// ===========================
// FLOW 4: REFUND
// ===========================

function sendRefundStep1(phone) {
  return sendMessage(phone,
    `Ou gen yon pwoblèm ak yon kous? Nou la pou ede ou.\n\nTanpri bay nou nimewo referans kous la (Eksemp: MSW-XXXXX)`
  );
}

async function handleRefundFlow(phone, session, text, contactName) {
  switch (session.step) {
    case 1: {
      const ref = text.trim().toUpperCase();
      const ride = await Ride.findOne({ notes: { $regex: ref, $options: 'i' } });

      if (!ride) {
        return sendMessage(phone,
          `Nou pa jwenn kous sa a. Tanpri verifye nimewo referans la epi eseye ankò.\nEksemp: MSW-XXXXX`
        );
      }

      await updateSession(session, {
        step: 2,
        data: { ...session.data, rideId: ride._id.toString(), rideRef: ref, rideFare: ride.estimatedFare, ridePickup: ride.pickupAddress, rideDrop: ride.dropoffAddress }
      });

      const date = ride.createdAt.toLocaleDateString('fr-HT');
      return sendMessage(phone,
        `Nou jwenn kous ou an:\n📍 ${ride.pickupAddress} ➡️ ${ride.dropoffAddress}\n📅 ${date}\n💰 ${ride.estimatedFare} HTG\n\nKi pwoblèm ou te genyen?\n1️⃣ Machin/Moto tonbe an pàn\n2️⃣ Chofè anile kous la\n3️⃣ Pa t gen chofè\n4️⃣ Yo fè m peye twòp\n5️⃣ Move wout\n6️⃣ Pwoblèm sekirite\n7️⃣ Lòt`
      );
    }
    case 2: {
      const reasons = { '1': 'breakdown', '2': 'driver_cancelled', '3': 'no_driver', '4': 'overcharged', '5': 'wrong_route', '6': 'safety', '7': 'other' };
      const reason = reasons[text.trim()];

      if (!reason) {
        return sendMessage(phone, `Tanpri ekri yon nimewo ant 1 ak 7.`);
      }

      const ref = refundRef();
      try {
        await Refund.create({
          ride: session.data.rideId,
          riderPhone: phone,
          reason,
          rideAmount: session.data.rideFare || 0,
          status: 'pending'
        });
      } catch (err) {
        console.error('Refund save error:', err.message);
      }

      await resetSession(session);

      return sendMessage(phone,
        `Mèsi pou enfòmasyon an. Nou ap revize demann ou an.\n\n📋 Demann ranbousman: ${ref}\n📊 Estati: An atant\n\nEkip nou an ap reponn nan 24-48è.\nSi ou bezwen ede ankò, ekri "EDE".`
      );
    }
  }
}

// ===========================
// HELP & DEFAULT
// ===========================

function sendHelpResponse(phone) {
  return sendMessage(phone,
    `Byenveni sou MsouWout! 🚗🏍️\nPremye sèvis transpò dijital Ayiti.\n\nKisa ou bezwen?\n1️⃣ Ekri "Kous" → pou jwenn transpò\n2️⃣ Ekri "Chofè" → pou vin travay kòm chofè\n3️⃣ Ekri "Biznis" → pou touche kòm Koutye\n4️⃣ Ekri "Ranbousman" → si ou gen pwoblèm\n\n📍 Nou disponib nan: Delmas, Pétion-Ville, Tabarre, Carrefour\n⏰ 6AM - 10PM chak jou\n\nPa HaitiBiznis 🇭🇹`
  );
}

function sendDefaultResponse(phone) {
  return sendMessage(phone,
    `Mèsi pou mesaj ou!\n\nEkri youn nan mo sa yo pou kòmanse:\n📱 "Kous" → jwenn transpò\n🚗 "Chofè" → vin travay\n💰 "Biznis" → touche kòm Koutye\n❓ "Ede" → plis enfòmasyon\n\nOswa ekri sa ou bezwen epi yon moun nan ekip la ap reponn ou.`
  );
}

// --- Location handler ---

async function handleLocation(phone, location, contactName) {
  const session = await getSession(phone);
  if (session.flow === 'ride' && session.step === 1) {
    const addr = `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`;
    await updateSession(session, {
      step: 2,
      data: { ...session.data, pickup: addr, pickupLat: location.latitude, pickupLng: location.longitude }
    });
    return sendMessage(phone, `📍 Lokasyon resevwa!\nKote ou prale? (Ekri destinasyon ou)`);
  }
  return sendDefaultResponse(phone);
}

// --- Image handler (for driver photos) ---

async function handleImage(phone, contactName) {
  const session = await getSession(phone);
  if (session.flow === 'driver' || !session.flow) {
    return sendMessage(phone, `📸 Mèsi pou foto a! Ekip nou an ap revize li.\nSi ou bezwen ede, ekri "EDE".`);
  }
  return sendDefaultResponse(phone);
}

// --- Test endpoint ---

router.post('/test', async (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const session = await getSession(phone);
  const before = { flow: session.flow, step: session.step, data: session.data };

  await handleMessage(phone, message, 'Test User');

  const after = await ChatSession.findOne({ phone });
  res.json({
    input: { phone, message },
    sessionBefore: before,
    sessionAfter: { flow: after?.flow, step: after?.step, data: after?.data }
  });
});

module.exports = router;
