/* The AI half of a Tike Lakay flyer: three background pictures for one event.
 *
 * ⛔ The model is asked for a picture with NO writing on it at all. Everything
 * that has to be right - the title, the date, the place, the organiser's logo,
 * the sponsors' logos and the QR code - is drawn on top by flyer-ai.html from
 * real data. An image model misspells words, bends logos, and draws QR codes
 * that look real and scan as nothing (the LajanMaker Academy flyers in August
 * had two of those).
 *
 * Three calls, one per style, rather than n:3 on one prompt - three samples of
 * one prompt come back as three versions of the same picture, and the
 * organiser is paying for a choice.
 *
 * Uses Jeffery's own OpenAI account (OPENAI_API_KEY, the same key the
 * MyPlopPlop assistant runs on). Model, quality and the per-token price are
 * settings, so a price change at OpenAI is an env change, not a deploy.
 */
const OPENAI_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/images/generations';
const MODEL = process.env.FLYER_IMAGE_MODEL || 'gpt-image-2';
const QUALITY = process.env.FLYER_IMAGE_QUALITY || 'medium';
const SIZE = '1024x1536';
/* USD per 1M image output tokens, from OpenAI's pricing page on 29 Oct 2026
   (gpt-image-2: $30). Only used to record what each design cost. */
const USD_PER_M_OUT = Number(process.env.FLYER_USD_PER_M_OUTPUT || 30);
const USD_PER_M_IN = Number(process.env.FLYER_USD_PER_M_INPUT || 5);

function configured() { return !!process.env.OPENAI_API_KEY; }

/* What kind of scene suits the event. Keyed on the saved type keys
   (event-types.js ORDER); anything unknown gets the general one. */
const SCENES = {
  'konferans': 'a modern conference hall with a stage, soft blue spotlights and an audience silhouette',
  'seminè': 'a bright modern seminar room with clean light and subtle geometric shapes',
  'fòmasyon': 'a bright modern training room with notebooks, laptops and warm daylight',
  'biznis': 'a modern business skyline at golden hour with clean professional light',
  'party': 'a vibrant night party with colourful lights, confetti and a dance floor glow',
  'gala': 'an elegant gala ballroom with chandeliers, gold accents and deep velvet tones',
  'bàl': 'an elegant dance ball with chandeliers and warm golden light',
  'maryaj': 'an elegant wedding setting with white and blush flowers, soft romantic light',
  'legliz': 'a peaceful church interior with warm light through stained glass windows',
  'kominyon': 'a gentle first communion scene with white flowers and soft church light',
  'batèm': 'a gentle baptism scene with white flowers, soft light and calm water',
  'gradyasyon': 'a graduation celebration with caps in the air and festive golden light',
  'konsè': 'a concert stage with dramatic coloured stage lights and a crowd glow',
  'fèt-manman': 'a warm celebration with flowers for Mother\'s Day, soft pink and gold tones',
  'fèt-papa': 'a warm Father\'s Day celebration with deep blue and gold tones',
  'jmj': 'a joyful youth gathering with bright sky and hopeful light',
  'valentinn': 'a romantic Valentine\'s evening with red roses and soft candle light',
  'nwèl': 'a festive Christmas scene with warm lights, ornaments and a decorated tree',
  'nouvel-ane': 'a New Year celebration with fireworks over a night sky',
  'kanaval': 'a colourful Haitian carnival with costumes, masks and festive lights',
  'foutbòl': 'a football stadium at night under bright floodlights',
  'baskètbòl': 'a basketball court with dramatic arena lighting',
  'volebòl': 'a volleyball court with energetic sports lighting',
  'tenis': 'a tennis court in bright sunlight',
  'badmintonn': 'an indoor badminton court with clean sports lighting',
  'bòks': 'a boxing ring under dramatic spotlights',
  'karate': 'a martial arts dojo with dramatic light',
  'spò': 'a sports arena with dramatic lighting',
  'jounen_nasyonal': 'a proud Haitian national celebration with blue and red flags and festive light',
  'lòt': 'a festive Caribbean event setting with warm lights'
};

/* Three looks that are meant to be told apart at a glance - the first real
   run (29 Oct) with three softer wordings came back as three versions of the
   same dark stage. */
const STYLES = [
  { key: 'photo', text: 'Style: a vivid, colourful cinematic PHOTOGRAPH, bright and full of detail, warm lively atmosphere.' },
  { key: 'graphic', text: 'Style: bold ILLUSTRATED poster artwork (not a photograph) - flat vector shapes, bright saturated colours, playful patterns and dynamic geometric forms.' },
  { key: 'elegant', text: 'Style: ELEGANT luxury design - rich textures such as velvet, marble or gold foil, soft golden bokeh lights, refined and premium.' }
];

/* The organiser's own words go in only as a hint about colours and mood, and
   are cut short and stripped of anything that is not plain text. */
function cleanLook(look) {
  return String(look || '').replace(/[^\p{L}\p{N}\s,.'&-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
}

function buildPrompt(event, style, look) {
  const scene = SCENES[event && event.type] || SCENES['lòt'];
  const hint = cleanLook(look);
  return [
    'Vertical event poster BACKGROUND image: ' + scene + '.',
    style.text,
    hint ? 'Colours and mood requested by the organiser: ' + hint + '.' : '',
    'Fill the whole frame edge to edge with a rich, colourful image; keep the main subject around the middle and avoid important details at the very top and bottom edges.',
    'IMPORTANT: absolutely no text, no letters, no numbers, no words, no logos, no watermarks, no signs, no QR codes, no frames or borders.'
  ].filter(Boolean).join(' ');
}

async function generateOne(prompt) {
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, size: SIZE, quality: QUALITY, n: 1,
                           output_format: 'jpeg', output_compression: 85 })
  });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || !data || !data.data || !data.data[0] || !data.data[0].b64_json) {
    const err = (data && data.error) || {};
    const e = new Error('OpenAI ' + res.status + ': ' + (err.code || '') + ' ' + (err.message || 'no image returned'));
    e.code = err.code || '';
    e.status = res.status;
    throw e;
  }
  const usage = data.usage || {};
  const out = Number(usage.output_tokens || 0), inp = Number(usage.input_tokens || 0);
  return {
    data: Buffer.from(data.data[0].b64_json, 'base64'),
    outputTokens: out,
    costUsd: Math.round((out * USD_PER_M_OUT + inp * USD_PER_M_IN) / 1e4) / 100
  };
}

/* Three designs. A style that fails is tried once more; a request the
   moderation refused is retried WITHOUT the organiser's own words, since
   those are the only part of the prompt that is not ours. Returns whatever
   succeeded plus the last error - the caller decides what "enough" is. */
async function generateDesigns(event, look) {
  const results = await Promise.all(STYLES.map(async (style) => {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const useLook = attempt === 0 || !(lastErr && lastErr.code === 'moderation_blocked');
      try {
        const img = await generateOne(buildPrompt(event, style, useLook ? look : ''));
        return Object.assign({ style: style.key, model: MODEL, quality: QUALITY, mime: 'image/jpeg' }, img);
      } catch (e) {
        lastErr = e;
        /* Quota, a bad key, an unverified account: trying again cannot help
           and would only spend more. */
        if (e.status === 401 || e.status === 403 || e.code === 'insufficient_quota' || e.code === 'billing_hard_limit_reached') break;
      }
    }
    return { error: lastErr ? lastErr.message : 'unknown' };
  }));
  return {
    images: results.filter(r => r.data),
    errors: results.filter(r => r.error).map(r => r.error)
  };
}

module.exports = { configured, generateDesigns, buildPrompt, STYLES, MODEL, QUALITY };
