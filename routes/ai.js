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

/* ═══ OCR FALLBACK (Tesseract) ═══ */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function ocrExtract(buffer) {
  const tmpFile = path.join(os.tmpdir(), 'flyer_' + Date.now() + '.jpg');
  fs.writeFileSync(tmpFile, buffer);
  try {
    const text = execSync(`tesseract "${tmpFile}" stdout -l fra+eng 2>/dev/null`, { timeout: 30000 }).toString();
    return text;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch(e) {}
  }
}

function parseOcrText(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
  const result = { title: '', type: 'lòt', date: '', startTime: '', endTime: '', location: '', description: '', organizer: '', organizerPhone: '', tickets: [] };

  const monthMap = { janvier:'01',février:'02',fevrier:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07',août:'08',aout:'08',septembre:'09',octobre:'10',novembre:'11',décembre:'12',decembre:'12',
    january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12' };

  const fullText = lines.join(' ');

  // Extract date
  const datePatterns = [
    /(\d{1,2})\s*(er|ème|e|st|nd|rd|th)?\s*(janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|january|february|march|april|may|june|july|august|september|october|november|december)\s*(\d{4})?/i,
    /(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2,4})/,
    /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})\s*(er|e)?\s*(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s*(\d{4})?/i
  ];
  for (const pat of datePatterns) {
    const m = fullText.match(pat);
    if (m) {
      if (monthMap[(m[3]||'').toLowerCase()]) {
        const day = m[1].padStart(2, '0');
        const month = monthMap[m[3].toLowerCase()];
        const year = m[4] || '2026';
        result.date = `${year}-${month}-${day}`;
      } else if (m[1] && m[2] && m[3] && !monthMap[(m[2]||'').toLowerCase()]) {
        const day = m[1].padStart(2, '0');
        const month = m[2].padStart(2, '0');
        let year = m[3]; if (year.length === 2) year = '20' + year;
        result.date = `${year}-${month}-${day}`;
      }
      break;
    }
  }

  // Extract times (deduplicated, sorted)
  const timeSet = new Set();
  const tp1 = /(\d{1,2})\s*[hH]\s*(\d{0,2})\s*(AM|PM)?/g;
  const tp2 = /(\d{1,2})\s*:\s*(\d{2})\s*(AM|PM)?/g;
  for (const pat of [tp1, tp2]) {
    let tm;
    while ((tm = pat.exec(fullText)) !== null) {
      let h = parseInt(tm[1]);
      const min = tm[2] ? tm[2].padStart(2, '0') : '00';
      if (tm[3] === 'PM' && h < 12) h += 12;
      if (tm[3] === 'AM' && h === 12) h = 0;
      timeSet.add(String(h).padStart(2, '0') + ':' + min);
    }
  }
  const times = [...timeSet].sort();
  if (times.length >= 1) result.startTime = times[0];
  if (times.length >= 2) result.endTime = times[times.length - 1];

  // Extract location - stop at parenthetical or common delimiters
  const locMatch = fullText.match(/(?:lieu|location|adresse|address|kote)\s*[:;]\s*([^=*@\n]+)/i);
  if (locMatch) {
    let loc = locMatch[1].trim();
    const parenEnd = loc.indexOf(')');
    if (parenEnd > 0) loc = loc.substring(0, parenEnd + 1);
    else if (loc.length > 120) loc = loc.substring(0, 120);
    result.location = loc;
  }

  // Extract price
  const pricePatterns = [
    /(\d[\d\s,.]*)\s*(gdes|gourdes|HTG)/i,
    /(\d[\d\s,.]*)\s*(USD|\$)/i
  ];
  for (const pat of pricePatterns) {
    const pm = fullText.match(pat);
    if (pm) {
      let price = parseInt(pm[1].replace(/[\s,.]/g, ''));
      if (pm[2] && (pm[2].toUpperCase() === 'USD' || pm[2] === '$')) price = Math.round(price * 135);
      result.tickets.push({ name: 'General', price, qty: 100, desc: '' });
      break;
    }
  }
  if (!result.tickets.length) result.tickets.push({ name: 'General', price: 0, qty: 100, desc: '' });

  // Extract phone
  const phoneMatch = fullText.match(/(?:\+?509[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,4}/);
  if (phoneMatch) result.organizerPhone = phoneMatch[0].trim();

  // Title: find uppercase lines in first half of text, skip metadata/slogans
  const skipTitle = /^(lieu|heure|date|frais|admission|phone|adresse|venez|ensemble|soyez|©|justice|promotion)/i;
  const halfIdx = Math.ceil(lines.length * 0.6);
  const titleLines = [];
  for (let li = 0; li < halfIdx; li++) {
    const line = lines[li];
    const cleaned = line.replace(/[^a-zA-ZÀ-ÿ\s&]/g, '').trim();
    const upperRatio = (line.replace(/[^A-ZÀ-ÖÙ-Ü]/g, '').length) / Math.max(cleaned.length, 1);
    if (upperRatio > 0.5 && cleaned.length > 3 && cleaned.length < 60 && !skipTitle.test(cleaned)) {
      titleLines.push(cleaned);
    }
  }
  if (titleLines.length > 0) {
    result.title = titleLines.slice(0, 2).join(' ').replace(/\s+/g, ' ').trim();
  } else {
    result.title = lines[0] || '';
  }

  // Description from bullet points and key phrases
  const descLines = lines.filter(l => l.match(/^[✓✔•vV>\-—]\s/)).map(l => l.replace(/^[✓✔•vV>\-—]\s*/, ''));
  if (descLines.length) result.description = descLines.join('. ');

  // Organizer: look for org names, acronyms, or "invite" patterns
  const orgPatterns = [
    /(?:organisé par|organized by|hosted by|présent[ée] par)\s*[:;]?\s*(.+?)(?:\.|$)/i,
    /(?:Le\s+)?([\w\s'À-ÿ]+?)\s*\((\w+)\)\s*(?:vous invite|présente|organise)/i,
    /(\w+)\s+vous invite/i
  ];
  for (const pat of orgPatterns) {
    const om = fullText.match(pat);
    if (om) {
      if (om[2]) { result.organizer = om[2].trim(); }
      else if (om[1] && om[1].trim().length > 2) { result.organizer = om[1].trim().substring(0, 80); }
      if (result.organizer) break;
    }
  }

  // Detect event type
  const lower = fullText.toLowerCase();
  if (lower.includes('foire') || lower.includes('gastronomique') || lower.includes('artisan')) result.type = 'biznis';
  else if (lower.includes('conférence') || lower.includes('konferans') || lower.includes('conference')) result.type = 'konferans';
  else if (lower.includes('concert') || lower.includes('konsè')) result.type = 'konsè';
  else if (lower.includes('mariage') || lower.includes('maryaj') || lower.includes('wedding')) result.type = 'maryaj';
  else if (lower.includes('gala')) result.type = 'gala';
  else if (lower.includes('église') || lower.includes('legliz') || lower.includes('louange') || lower.includes('church')) result.type = 'legliz';
  else if (lower.includes('party') || lower.includes('fèt') || lower.includes('soirée')) result.type = 'party';
  else if (lower.includes('formation') || lower.includes('workshop') || lower.includes('atelier') || lower.includes('séminaire')) result.type = 'fòmasyon';
  else if (lower.includes('football') || lower.includes('soccer') || lower.includes('futbol')) result.type = 'futbol';
  else if (lower.includes('basket')) result.type = 'baskètbòl';
  else if (lower.includes('baptême') || lower.includes('batèm')) result.type = 'batèm';
  else if (lower.includes('communion')) result.type = 'kominyon';

  return result;
}

router.post('/scan-flyer', upload.single('flyer'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No image uploaded' });
    }

    const base64Image = req.file.buffer.toString('base64');
    const mediaType = req.file.mimetype || 'image/jpeg';
    const apiKey = process.env.ANTHROPIC_API_KEY;

    let extracted;

    if (apiKey) {
      // Claude Vision (best quality)
      const client = new Anthropic({ apiKey });
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
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        extracted = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      } catch (parseErr) {
        return res.status(422).json({ error: 'Could not parse AI response', raw: text });
      }
    } else {
      try {
        execSync('which tesseract', { stdio: 'ignore' });
        console.log('Using OCR fallback (no API key)');
        const ocrText = ocrExtract(req.file.buffer);
        console.log('OCR text:', ocrText.substring(0, 500));
        extracted = parseOcrText(ocrText);
      } catch (noTess) {
        return res.status(503).json({ error: 'AI service not configured. Set ANTHROPIC_API_KEY environment variable.' });
      }
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
    res.status(500).json({ error: 'Processing failed: ' + err.message });
  }
});

module.exports = router;
