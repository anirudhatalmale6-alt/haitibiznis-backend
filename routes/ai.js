const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk').default;
const upload = require('../middleware/upload');

const typeConfig = {
  konferans:{emoji:'🎤',gradient:'linear-gradient(135deg,#0A1235,#00209F,#0A3ACC)',tagBg:'rgba(0,32,159,.85)',label:'Konferans'},
  party:{emoji:'🎉',gradient:'linear-gradient(135deg,#5a1a3a,#D21034,#FF4466)',tagBg:'rgba(210,16,52,.85)',label:'Fèt/Party'},
  gala:{emoji:'💝',gradient:'linear-gradient(135deg,#1a3a1a,#D4A017,#E8B82E)',tagBg:'rgba(212,160,23,.9)',label:'Gala/Kolèk'},
  seminè:{emoji:'📚',gradient:'linear-gradient(135deg,#1a2a4a,#2a4a8a,#4a7acc)',tagBg:'rgba(42,74,138,.85)',label:'Seminè'},
  maryaj:{emoji:'💍',gradient:'linear-gradient(135deg,#f5e6d0,#e8c9a0,#d4a870)',tagBg:'rgba(180,140,80,.9)',label:'Maryaj'},
  legliz:{emoji:'⛪',gradient:'linear-gradient(135deg,#2a1a5a,#5a3a8a,#8a6abd)',tagBg:'rgba(90,58,138,.85)',label:'Legliz'},
  biznis:{emoji:'💼',gradient:'linear-gradient(135deg,#0a2a4a,#00209F,#D4A017)',tagBg:'rgba(0,32,159,.85)',label:'Biznis'},
  konsè:{emoji:'🎵',gradient:'linear-gradient(135deg,#1a0a3a,#4a1a8a,#8a3acc)',tagBg:'rgba(74,26,138,.85)',label:'Konsè'},
  fòmasyon:{emoji:'🎓',gradient:'linear-gradient(135deg,#0a3a2a,#1B8C3D,#2acc5a)',tagBg:'rgba(27,140,61,.85)',label:'Fòmasyon/Workshop'},
  kominyon:{emoji:'🕊️',gradient:'linear-gradient(135deg,#e8e0d0,#c0a880,#d4a870)',tagBg:'rgba(180,140,80,.85)',label:'Premye Kominyon'},
  batèm:{emoji:'💧',gradient:'linear-gradient(135deg,#d0e8f0,#80b0d0,#4a8ab0)',tagBg:'rgba(74,138,176,.85)',label:'Batèm'},
  futbol:{emoji:'⚽',gradient:'linear-gradient(135deg,#0a3a0a,#1B8C3D,#2acc5a)',tagBg:'rgba(27,140,61,.85)',label:'Futbol'},
  baskètbòl:{emoji:'🏀',gradient:'linear-gradient(135deg,#8a3a0a,#cc6a1a,#e8982a)',tagBg:'rgba(204,106,26,.85)',label:'Baskètbòl'},
  volibòl:{emoji:'🏐',gradient:'linear-gradient(135deg,#2a3a5a,#4a6a9a,#6a8acc)',tagBg:'rgba(74,106,154,.85)',label:'Volibòl'},
  tenis:{emoji:'🎾',gradient:'linear-gradient(135deg,#2a4a0a,#6a8a2a,#8aaa4a)',tagBg:'rgba(106,138,42,.85)',label:'Tenis'},
  bòks:{emoji:'🥊',gradient:'linear-gradient(135deg,#4a0a0a,#8a1a1a,#cc2a2a)',tagBg:'rgba(138,26,26,.85)',label:'Bòks'},
  karate:{emoji:'🥋',gradient:'linear-gradient(135deg,#1a1a1a,#4a4a4a,#7a7a7a)',tagBg:'rgba(74,74,74,.85)',label:'Karate/Judo'},
  gradyasyon:{emoji:'🎓',gradient:'linear-gradient(135deg,#0a2a4a,#1a4a8a,#2a6acc)',tagBg:'rgba(26,74,138,.85)',label:'Gradyasyon'},
  bal:{emoji:'💃',gradient:'linear-gradient(135deg,#3a0a3a,#8a2a8a,#cc4acc)',tagBg:'rgba(138,42,138,.85)',label:'Bal/Dans'},
  kanaval:{emoji:'🎭',gradient:'linear-gradient(135deg,#D21034,#D4A017,#00209F)',tagBg:'rgba(210,16,52,.85)',label:'Kanaval'},
  lòt:{emoji:'📌',gradient:'linear-gradient(135deg,#2a2a4a,#4a4a8a,#6a6abd)',tagBg:'rgba(74,74,138,.85)',label:'Lòt'}
};

const SCAN_PROMPT = `You are an event data extractor for Tikè Lakay, a Haitian event platform. Analyze this event flyer/poster image and extract all event details.

Return ONLY a valid JSON object with these fields (no markdown, no explanation):
{
  "title": "event title exactly as shown",
  "type": "one of: konferans, party, gala, seminè, maryaj, legliz, biznis, konsè, fòmasyon, kominyon, batèm, futbol, baskètbòl, volibòl, tenis, bòks, karate, gradyasyon, bal, kanaval, lòt",
  "date": "YYYY-MM-DD format",
  "startTime": "HH:MM 24h format",
  "endTime": "HH:MM 24h format or empty string",
  "location": "venue name and address",
  "description": "event description in the language of the flyer, 2-3 sentences summarizing what the event is about",
  "organizer": "organizing person or group name",
  "organizerPhone": "phone number if visible, with country code",
  "tickets": [{"name": "ticket type name", "price": number_in_HTG, "qty": 100, "desc": "short description"}]
}

Rules:
- If the price is in USD, convert to HTG (1 USD = approximately 135 HTG)
- If the price is in Gdes/Gourdes, use that as HTG
- If multiple ticket types are visible, list them all
- If only one price, create a single "General" ticket
- If the event is free, set price to 0 and name it "RSVP Gratis"
- For the date, if the year is not specified, assume 2026
- Extract phone numbers exactly as shown
- Keep the title in the original language (French, Kreyol, or English)`;

router.post('/scan-flyer', upload.single('flyer'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'AI service not configured' });
    }

    const client = new Anthropic({ apiKey });
    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250514',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Image } },
          { type: 'text', text: SCAN_PROMPT }
        ]
      }]
    });

    const text = response.content[0].text.trim();
    let extracted;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      extracted = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    } catch (parseErr) {
      return res.status(422).json({ error: 'Could not parse AI response', raw: text });
    }

    const evType = extracted.type || 'lòt';
    const cfg = typeConfig[evType] || typeConfig['lòt'];
    extracted.typeLabel = cfg.label;
    extracted.typeEmoji = cfg.emoji;
    extracted.gradient = cfg.gradient;
    extracted.tagBg = cfg.tagBg;
    extracted.flyerBase64 = 'data:' + mediaType + ';base64,' + base64Image;

    res.json(extracted);
  } catch (err) {
    console.error('AI scan error:', err.message);
    res.status(500).json({ error: 'AI processing failed: ' + err.message });
  }
});

module.exports = router;
