// server.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';

import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

import twilio from 'twilio';
import { google } from 'googleapis';

/* ================================
   APP + MIDDLEWARE
================================ */
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

/* ================================
   TWILIO (SMS + Voice)
================================ */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM; // must be E.164

/* ================================
   OPENAI (concise + fast)
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ================================
   ELEVENLABS (TTS)
   (latency: lower optimize_streaming_latency is faster; 0 = fastest)
================================ */
const EL_KEY   = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

/* ================================
   GOOGLE CALENDAR (Service Account)
================================ */
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID =
  process.env.GOOGLE_CALENDAR_ID ||
  process.env.CALENDAR_ID ||
  'primary';

let googleReady = false;
async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
    console.log('✅ Google service account authorized');
  }
}

/* ================================
   ZOOM DETAILS (env-configurable)
================================ */
const ZOOM_LINK       = process.env.ZOOM_LINK
  || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1&omn=88292946669';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE   = process.env.ZOOM_PASSCODE   || 'jcJx8M';

function formatDateForSms(iso) {
  return formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
}
function buildConfirmationSms({ summary, startISO }) {
  const when = formatDateForSms(startISO);
  return [
    'MyBizPal — Business Consultation (15 min)',
    `Date: ${when}`,
    'Please be on time and bring any questions.',
    `Zoom: ${ZOOM_LINK}`,
    `Meeting ID  ${ZOOM_MEETING_ID}`,
    `Passcode    ${ZOOM_PASSCODE}`,
    'Reply CHANGE to reschedule.'
  ].join('\n');
}
function buildReminderSms({ summary, startISO }) {
  const when = formatDateForSms(startISO);
  return [
    `⏰ Reminder: ${summary} in ${REMINDER_MINUTES_BEFORE} min`,
    `Starts: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
  ].join('\n');
}

/* ================================
   CALL MEMORY (per-call) + RECALL (per-number)
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> detailed state
const CALLER_RECALL = new Map(); // callerPhone -> { lastSeenAt, lastSummary?, name? }

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    speaking: false,

    // Silence behaviour
    silenceStartAt: null,
    nudgeCount: 0,
    lastNudgeAt: null,
    agentWaitUntil: 0,
    userRequestedPause: false,
    takeYourTimeSaid: false,

    wrapPrompted: false,
    lang: 'en',
    pendingLang: null,
    langConfirmed: false,
    lastPrompt: '',

    // Contact capture
    phone: null,
    pendingPhone: false,
    email: null,
    pendingEmail: false,

    // SMS reminder preference
    smsReminder: null,
    pendingReminder: false,

    // On-call SMS confirmation
    smsConfirmSent: false,
    awaitingSmsReceipt: false,

    // Booking time captured
    pendingBookingISO: null,
    pendingBookingSpoken: null
  });
  return CALL_STATE.get(sid);
};

/* ================================
   LIGHT HUMOUR / CHUCKLE (subtle, randomized)
================================ */
function chuckleSoft(prob = 0.25) {
  return Math.random() < prob ? ' (soft chuckle) ' : ' ';
}
function maybeChuckleLine(base, prob = 0.25) {
  return Math.random() < prob ? `${base}${chuckleSoft(1)}` : base;
}

/* ================================
   PERSONA / SYSTEM PROMPT
================================ */
function buildSystemPreamble(state, recallLine = '') {
  const now = toZonedTime(new Date(), TZ);
  const niceNow = formatInTimeZone(now, TZ, "eeee dd MMMM yyyy, h:mmaaa");

  const langPolicy = `
Language policy:
- Default: English.
- If caller likely speaks Spanish, Portuguese, or French, ASK first before switching.
- Once switched, stay in that language for the rest of the call.
Current language: ${state.lang || 'en'}
`;

  const proprietaryPolicy = `
If the caller asks about our tech stack, source code, models, prompts, or “how it works”:
- Politely explain the system is proprietary to MyBizPal.ai and built with significant time and resources.
- Offer to discuss outcomes, features, and pricing instead of internal implementation.
- Do not disclose exact tools, libraries, or internal process unless already public on our website.
`;

  const emotionStorytelling = `
Emotional intelligence & light storytelling:
- Mirror energy with a calm baseline: empathize briefly when they share wins or frustrations.
- Use a mild, relevant anecdote only when it helps (“A client in a similar spot wanted X—we helped them do Y.”). Keep it short and helpful.
- Use light humour sparingly (a soft chuckle or “hah, fair enough”) to ease tension—then guide back to the goal.
- Always be on the caller’s side, collaborative, never pushy.
`;

  return `
You are Gabriel — a calm, friendly, confident American male tech consultant for MyBizPal.ai.
Speak slowly, clearly, and naturally (ChatGPT-voice vibe). Avoid robotic fillers or repeating.

STYLE
- Warm, low-key, professional; short, spoken sentences with comfortable pauses.
- ${recallLine ? `Familiarity cue: ${recallLine}` : ''}

SALES & QUALIFICATION
- Identify intent: (1) ready to buy, (2) enquiry/compare, (3) just chatting.
- Offer the next step; gently lead toward a booking if it helps them.
- If not the right fit, suggest a practical alternative and end professionally.

RAPPORT (use sparingly)
- Gabriel: born in Venezuela, Portuguese family (Madeira), lives in High Wycombe (UK).
- Married to Raquel from Barcelona.
- One short relevant line max. Don’t share private details.

PHONE & EMAIL
- UK numbers: “oh / o / zero / naught” → 0. Accept 0-leading, +44.
- Emails: “at / at sign / at symbol / arroba” → @, and “dot / punto / ponto / point” → .
- When repeating phone/email back, speak SLOWLY, spacing characters.

ENDING RULES
- Don’t end just because you hear “thanks/okay/that’s fine”.
- Only end after you ask: “Is there anything else I can help you with?” and the caller declines.
- Use our TTS for the goodbye (not Twilio <Say>).

SILENCE / NUDGE
- If caller is silent: wait calmly. “Are you still there?” only after ~30s.
- If you asked them to wait, do NOT nudge during that time.
- If THEY asked you to wait, you can say “take your time” once, then listen.
- If you’ve asked “are you still there?” twice (about 7–8s apart) and no reply, end politely.

TIME & LOCALE
- Local time is ${TZ}. Today is ${niceNow} (${TZ}).

${proprietaryPolicy}
${emotionStorytelling}
${langPolicy}
`;
}

/* ================================
   TWIML HELPERS
================================ */
const twiml = (xmlInner) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`;

function gatherWithPlay({ host, text, action = '/twilio/handle' }) {
  const enc    = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${enc}`;
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        actionOnEmptyResult="true"
        action="${action}"
        method="POST"
        partialResultCallback="/twilio/partial"
        partialResultCallbackMethod="POST"
        timeout="6"
        speechTimeout="auto">
  <Play>${ttsUrl}</Play>
</Gather>`;
}
function silentGather({ action = '/twilio/handle' }) {
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        actionOnEmptyResult="true"
        action="${action}"
        method="POST"
        timeout="6"
        speechTimeout="auto">
</Gather>`;
}
function playOnly({ host, text }) {
  const enc    = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${enc}`;
  return `<Play>${ttsUrl}</Play>`;
}

/* ================================
   ELEVENLABS TTS (faster + natural)
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 480);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=0`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.36,
        similarity_boost: 0.92,
        speaking_rate: 0.82,      // slightly faster than before, still calm
        style: 0.3,               // mild expressiveness
        use_speaker_boost: true
      }
    };
    const r = await axios.post(url, payload, {
      responseType: 'arraybuffer',
      headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' }
    });
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(r.data));
  } catch (e) {
    console.error('TTS error:', e?.response?.status, e?.response?.data?.toString?.() || e.message);
    res.status(500).end();
  }
});

/* ================================
   HELPERS (phone/email/lang/etc.)
================================ */
function normalizeUkPhone(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0');
  s = s.replace(/\bone\b/g, '1')
       .replace(/\btwo\b/g, '2')
       .replace(/\bthree\b/g, '3')
       .replace(/\bfour\b/g, '4')
       .replace(/\bfive\b/g, '5')
       .replace(/\bsix\b/g, '6')
       .replace(/\bseven\b/g, '7')
       .replace(/\beight\b/g, '8')
       .replace(/\bnine\b/g, '9');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) s = '0' + s.slice(3);
  if (!s.startsWith('0') && s.length === 10) s = '0' + s;
  return s.trim();
}
function isLikelyUkNumber(n) {
  if (!n) return false;
  return /^0\d{10}$/.test(n) || /^0\d{9}$/.test(n) || /^\+44\d{10}$/.test(n);
}
function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s
    .replace(/\bat sign\b/g, '@')
    .replace(/\bat symbol\b/g, '@')
    .replace(/\bat-?sign\b/g, '@')
    .replace(/\barroba\b/g, '@')
    .replace(/\bat\b/g, '@');
  s = s
    .replace(/\bdot\b/g, '.')
    .replace(/\bpunto\b/g, '.')
    .replace(/\bponto\b/g, '.')
    .replace(/\bpoint\b/g, '.');
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, ' ').trim();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
function slowPhoneSpeak(num) {
  if (!num) return '';
  return num.split('').join(', ');
}
function slowEmailSpeak(email) {
  if (!email) return '';
  return email.replace(/@/g, ' at ').replace(/\./g, ' dot ');
}
function userAskedToWait(text) {
  const t = (text || '').toLowerCase();
  return /(one (sec|second|moment)|just a sec|give me a (sec|second)|wait|hold on|let me check)/i.test(t);
}
function detectLanguage(text) {
  const t = (text || '').toLowerCase();
  const es = /(hola|gracias|por favor|buenos|buenas|quiero|necesito|mañana|tarde|semana)/i.test(t);
  const pt = /(olá|ola|obrigado|obrigada|por favor|amanhã|tarde|semana|preciso|quero)/i.test(t);
  const fr = /(bonjour|bonsoir|merci|s'il vous plaît|svp|demain|semaine|je voudrais|je veux)/i.test(t);
  if (es) return 'es';
  if (pt) return 'pt';
  if (fr) return 'fr';
  return 'en';
}
function yesInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(yes|yeah|yep|sure|ok|okay|si|sí|sim|oui|d'accord)\b/.test(t);
}
function noInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(no|nope|nah|not now|pas maintenant|não|nao)\b/.test(t);
}
function detectEndOfConversation(phrase) {
  const p = (phrase || '').toLowerCase();
  const ends = [
    'no thanks','nothing else',"that's all",'that’s all','all good','that’s it','thats it',
    'we’re good','were good','i’m good','im good','no thank you','that will be all','that would be all','no, thanks'
  ];
  return ends.some(e => p.includes(e));
}
function ackPhrase() {
  // Occasionally include a tiny chuckle for warmth
  const base = ['Sure.', 'Okay.', 'Alright.', 'Got it.'][Math.floor(Math.random() * 4)];
  return maybeChuckleLine(base, 0.18); // ~18% of the time
}
function partOfDay() {
  const now = toZonedTime(new Date(), TZ);
  const h = Number(formatInTimeZone(now, TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/* ================================
   LOCALIZED PHRASES (with subtle humour hooks)
================================ */
const localized = {
  greet: {
    en: 'Hey—this is Gabriel with MyBizPal. How can I help today?',
    es: 'Hola—soy Gabriel de MyBizPal. ¿En qué te puedo ayudar hoy?',
    pt: 'Olá—é o Gabriel da MyBizPal. Como posso ajudar hoje?',
    fr: 'Salut—ici Gabriel de MyBizPal. Comment puis-je vous aider aujourd’hui ?'
  },
  gentleNudge: {
    en: 'Take your time—whenever you’re ready.',
    es: 'Tómate tu tiempo—cuando estés listo.',
    pt: 'Sem pressa—quando estiver pronto.',
    fr: 'Prenez votre temps—quand vous serez prêt.'
  },
  didntCatch: {
    en: "I didn’t catch that—how can I help?",
    es: 'No alcancé a entender—¿en qué puedo ayudarte?',
    pt: 'Não percebi—como posso ajudar?',
    fr: 'Je n’ai pas bien compris—comment puis-je vous aider ?'
  },
  stillThere: {
    en: 'Are you still there?',
    es: '¿Sigues ahí?',
    pt: 'Você ainda está aí?',
    fr: 'Vous êtes toujours là ?'
  },
  askPhone: {
    en: maybeChuckleLine('What’s the best mobile number for a quick text confirmation?', 0.2),
    es: maybeChuckleLine('¿Cuál es el mejor número móvil para enviarte una confirmación por SMS?', 0.2),
    pt: maybeChuckleLine('Qual é o melhor número de telemóvel para enviar a confirmação por SMS?', 0.2),
    fr: maybeChuckleLine('Quel est le meilleur numéro de mobile pour vous envoyer une confirmation par SMS ?', 0.2)
  },
  confirmPhone: {
    en: (p) => `Thanks — let me repeat it slowly${chuckleSoft(0.12)}${slowPhoneSpeak(p)}. Is that correct?`,
    es: (p) => `Gracias — lo repito despacio${chuckleSoft(0.12)}${slowPhoneSpeak(p)}. ¿Es correcto?`,
    pt: (p) => `Obrigado — vou repetir devagar${chuckleSoft(0.12)}${slowPhoneSpeak(p)}. Está correto?`,
    fr: (p) => `Merci — je répète lentement${chuckleSoft(0.12)}${slowPhoneSpeak(p)}. C’est correct ?`
  },
  askEmail: {
    en: 'What email should I send the calendar invite to?',
    es: '¿A qué correo te envío la invitación del calendario?',
    pt: 'Para qual e-mail envio o convite do calendário?',
    fr: 'À quelle adresse e-mail dois-je envoyer l’invitation du calendrier ?'
  },
  confirmEmail: {
    en: (e) => `Perfect—here’s how I heard it${chuckleSoft(0.12)}${slowEmailSpeak(e)}. Is that right?`,
    es: (e) => `Perfecto—lo oí así${chuckleSoft(0.12)}${slowEmailSpeak(e)}. ¿Es correcto?`,
    pt: (e) => `Perfeito—ouvi assim${chuckleSoft(0.12)}${slowEmailSpeak(e)}. Está correto?`,
    fr: (e) => `Parfait—je l’ai entendu comme ceci${chuckleSoft(0.12)}${slowEmailSpeak(e)}. C’est correct ?`
  },
  askReminder: {
    en: (m) => `Would you like a text reminder ${m} minutes before, or prefer no reminder?`,
    es: (m) => `¿Quieres un recordatorio por SMS ${m} minutos antes, o prefieres sin recordatorio?`,
    pt: (m) => `Quer um lembrete por SMS ${m} minutos antes, ou prefere sem lembrete?`,
    fr: (m) => `Souhaitez-vous un SMS de rappel ${m} minutes avant, ou préférez-vous sans rappel ?`
  },
  confirmReminderOn: {
    en: maybeChuckleLine('Alright — I’ll text a reminder before we start.', 0.15),
    es: maybeChuckleLine('De acuerdo — te enviaré un recordatorio antes de empezar.', 0.15),
    pt: maybeChuckleLine('Combinado — vou enviar um lembrete antes de começarmos.', 0.15),
    fr: maybeChuckleLine('Très bien — je vous enverrai un rappel avant de commencer.', 0.15)
  },
  confirmReminderOff: {
    en: 'No problem — I won’t send a reminder.',
    es: 'Sin problema — no enviaré recordatorio.',
    pt: 'Sem problema — não vou enviar lembrete.',
    fr: 'Pas de problème — je n’enverrai pas de rappel.'
  },
  askReceipt: {
    en: maybeChuckleLine('I’ve just sent the text—did you receive it?', 0.15),
    es: maybeChuckleLine('Acabo de enviarte el SMS—¿lo recibiste?', 0.15),
    pt: maybeChuckleLine('Acabei de enviar o SMS—você recebeu?', 0.15),
    fr: maybeChuckleLine('Je viens d’envoyer le SMS—l’avez-vous reçu ?', 0.15)
  },
  wrapPrompt: {
    en: 'Is there anything else I can help you with?',
    es: '¿Hay algo más en lo que pueda ayudarte?',
    pt: 'Há mais alguma coisa em que eu possa ajudar?',
    fr: 'Y a-t-il autre chose avec laquelle je peux vous aider ?'
  },
  goodbye: {
    en: (pod) => `Thanks for calling MyBizPal—have a great ${pod}.`,
    es: (pod) => `Gracias por llamar a MyBizPal—que tengas un excelente ${pod === 'evening' ? 'fin de la tarde' : pod === 'afternoon' ? 'tarde' : 'día'}.`,
    pt: (pod) => `Obrigado por ligar para a MyBizPal—tenha um ótimo ${pod === 'evening' ? 'fim de tarde' : 'tarde'}.`,
    fr: (pod) => `Merci d’avoir appelé MyBizPal—passez une excellente ${pod === 'evening' ? 'soirée' : 'journée'}.`
  }
};

/* ================================
   NATURAL DATE PARSER
================================ */
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;
  const zoned  = toZonedTime(parsed, tz);
  const iso    = fromZonedTime(zoned, tz).toISOString();
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}

/* ================================
   BOOK APPOINTMENT + SMS
================================ */
async function bookAppointment({ who, whenISO, spokenWhen, phone, email }) {
  await ensureGoogleAuth();
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 15 * 60000).toISOString();

  const event = {
    summary: `MyBizPal — Business Consultation (15 min)`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: `Booked by MyBizPal (Gabriel). When: ${spokenWhen}`,
    attendees: email ? [{ email }] : []
  };

  console.log('📅 Inserting event:', CALENDAR_ID, startISO);
  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all'
  });
  console.log('✅ Event created:', created.data.id);

  if (phone && TWILIO_NUMBER) {
    const smsBody = buildConfirmationSms({ summary: event.summary, startISO });
    console.log('📨 Sending SMS to', phone);
    await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: smsBody });
    console.log('✅ SMS sent');
  }

  // Update recall memory by email/phone
  if (phone) {
    const prev = CALLER_RECALL.get(phone) || {};
    CALLER_RECALL.set(phone, {
      ...prev,
      lastSeenAt: Date.now(),
      lastSummary: 'Booked consultation',
    });
  }

  return created.data;
}

function scheduleSmsReminder({ event, phone }) {
  if (!phone || !TWILIO_NUMBER) return;
  const startTime = new Date(event?.start?.dateTime || '').getTime();
  if (!startTime) return;

  const fireAt = startTime - REMINDER_MINUTES_BEFORE * 60000;
  const delay  = fireAt - Date.now();
  if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;

  setTimeout(async () => {
    try {
      const sms = buildReminderSms({ summary: event.summary, startISO: event.start.dateTime });
      await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: sms });
      console.log('✅ Reminder SMS sent');
    } catch (e) {
      console.error('Reminder SMS error:', e?.message || e);
    }
  }, delay);
}

/* ================================
   LLM (concise; with proprietary + emotion hooks)
================================ */
async function llm({ history, latestText, state, recallLine }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state, recallLine) });

  for (const h of history.slice(-14)) if (h.role !== 'system') messages.push(h);

  // Hook: if caller asks for internal tech
  const lower = (latestText || '').toLowerCase();
  const isTechProbe =
    /\b(stack|tech|technology|model|prompt|code|source|how (it|this) works?|under the hood)\b/.test(lower) ||
    /\b(openai|gpt|llm|elevenlabs|twilio|google calendar)\b/.test(lower);

  if (isTechProbe) {
    messages.push({
      role: 'system',
      content:
        'If asked about internal tech: say the system is proprietary to MyBizPal.ai; discuss outcomes/features/pricing instead; do not reveal implementation details.'
    });
  }

  messages.push({
    role: 'system',
    content: state.lang !== 'en'
      ? `Caller prefers language: ${state.lang}. Respond in that language.`
      : 'Caller language: English.'
  });
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.45,
    max_tokens: 130,
    messages
  });

  return resp.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ================================
   CONTINUATION: if all fields ready, book now
================================ */
async function continueBookingIfReady({ req, res, state, memory }) {
  if (
    state.pendingBookingISO &&
    state.phone &&
    state.email &&
    state.smsReminder !== null
  ) {
    try {
      const phoneForSms = isLikelyUkNumber(state.phone) ? state.phone : (req.body.From || null);
      const event = await bookAppointment({
        who: 'Prospect',
        whenISO: state.pendingBookingISO,
        spokenWhen: state.pendingBookingSpoken,
        phone: phoneForSms,
        email: state.email
      });

      if (state.smsReminder === true) {
        scheduleSmsReminder({ event, phone: phoneForSms });
      }

      if (phoneForSms && TWILIO_NUMBER) {
        const smsBody = buildConfirmationSms({ summary: event.summary, startISO: event.start.dateTime });
        await twilioClient.messages.create({ to: phoneForSms, from: TWILIO_NUMBER, body: smsBody });
        state.smsConfirmSent = true;
        state.awaitingSmsReceipt = true;
      }

      const lang = state.lang || 'en';
      const askReceipt = (localized.askReceipt[lang] || localized.askReceipt.en);

      state.pendingBookingISO = null;
      state.pendingBookingSpoken = null;
      state.wrapPrompted = false;

      state.lastPrompt = askReceipt;
      const xml = twiml(gatherWithPlay({ host: req.headers.host, text: askReceipt, action: '/twilio/handle' }));
      state.speaking = true;
      res.type('text/xml').send(xml);
      return true;
    } catch (e) {
      console.error('Calendar insert failed:', e?.message || e);
      const fail = 'Hmm — I couldn’t book that just now. I’ll note your details and follow up.';
      const xml = twiml(gatherWithPlay({ host: req.headers.host, text: fail, action: '/twilio/handle' }));
      state.speaking = true;
      res.type('text/xml').send(xml);
      return true;
    }
  }
  return false;
}

/* ================================
   ENTRY
================================ */
app.post('/twilio/voice', (req, res) => {
  const callSid = req.body.CallSid || '';
  const memory  = memFor(callSid);
  memory.length = 0;

  const state = stateFor(callSid);
  state.silenceStartAt = null;
  state.nudgeCount = 0;
  state.lastNudgeAt = null;
  state.userRequestedPause = false;
  state.takeYourTimeSaid = false;

  // Familiarity if known caller
  const callerPhone = req.body.From;
  let recallLine = '';
  if (callerPhone && CALLER_RECALL.has(callerPhone)) {
    recallLine = 'This caller may have reached out before—sound familiar and helpful.';
  }

  memory.push({ role: 'system', content: buildSystemPreamble(state, recallLine) });

  const greetBase = (localized.greet[state.lang] || localized.greet.en);
  const greet = recallLine ? `${greetBase} Good to hear from you again${chuckleSoft(0.15)}.` : greetBase;
  state.lastPrompt = greet;

  const xml = twiml(gatherWithPlay({ host: req.headers.host, text: greet, action: '/twilio/handle' }));
  state.speaking = true;
  res.type('text/xml').send(xml);
});

/* ================================
   PARTIAL (debug only)
================================ */
app.post('/twilio/partial', (req, res) => {
  const partial = req.body.UnstableSpeechResult || req.body.SpeechResult || '';
  if (partial) console.log('PARTIAL:', partial);
  res.sendStatus(200);
});

/* ================================
   MAIN HANDLER
================================ */
app.post('/twilio/handle', async (req, res) => {
  try {
    const saidRaw = (req.body.SpeechResult || '');
    const said    = saidRaw.trim();
    const callSid = req.body.CallSid || 'unknown';
    const memory  = memFor(callSid);
    const state   = stateFor(callSid);
    const callerPhone = req.body.From;

    // Remember the caller across calls
    if (callerPhone) {
      const prev = CALLER_RECALL.get(callerPhone) || {};
      CALLER_RECALL.set(callerPhone, { ...prev, lastSeenAt: Date.now() });
    }

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    const lang = state.lang || 'en';
    const now  = Date.now();

    // If user explicitly asks us to wait
    if (said && userAskedToWait(said)) {
      state.userRequestedPause = true;
      if (!state.takeYourTimeSaid) {
        const msg = localized.gentleNudge[lang] || localized.gentleNudge.en;
        state.takeYourTimeSaid = true;
        state.lastPrompt = msg;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: msg, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else {
        const xml = twiml(silentGather({ action: '/twilio/handle' }));
        state.speaking = false;
        return res.type('text/xml').send(xml);
      }
    }

    // Silence handling (no speech)
    if (!said) {
      if (state.silenceStartAt == null) state.silenceStartAt = now;

      if (state.agentWaitUntil && now < state.agentWaitUntil) {
        const xml = twiml(silentGather({ action: '/twilio/handle' }));
        return res.type('text/xml').send(xml);
      }

      const silenceMs = now - state.silenceStartAt;

      if (silenceMs < 30000) {
        const xml = twiml(silentGather({ action: '/twilio/handle' }));
        return res.type('text/xml').send(xml);
      }

      if (state.nudgeCount === 0) {
        const prompt = localized.stillThere[lang] || localized.stillThere.en;
        state.lastPrompt = prompt;
        state.nudgeCount = 1;
        state.lastNudgeAt = now;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

      if (state.nudgeCount === 1 && (now - state.lastNudgeAt) >= 7000) {
        const prompt = localized.stillThere[lang] || localized.stillThere.en;
        state.lastPrompt = prompt;
        state.nudgeCount = 2;
        state.lastNudgeAt = now;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

      if (state.nudgeCount >= 2 && (now - state.lastNudgeAt) >= 7000) {
        const pod = partOfDay();
        const bye = (localized.goodbye[lang] || localized.goodbye.en)(pod);
        const xml = twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`);
        return res.type('text/xml').send(xml);
      }

      const xml = twiml(silentGather({ action: '/twilio/handle' }));
      return res.type('text/xml').send(xml);
    } else {
      state.silenceStartAt = null;
      state.nudgeCount = 0;
      state.lastNudgeAt = null;
      state.userRequestedPause = false;
      state.takeYourTimeSaid = false;
    }

    // Language detection & confirmation
    if (!state.langConfirmed) {
      const detected = detectLanguage(said);
      if (detected !== 'en' && !state.pendingLang && state.lang === 'en') {
        state.pendingLang = detected;
        const prompt = {
          es: '¿Prefieres que sigamos en español?',
          pt: 'Prefere continuar em português?',
          fr: 'Préférez-vous continuer en français?'
        }[detected] || 'Would you like to continue in that language?';
        state.lastPrompt = prompt;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else if (state.pendingLang) {
        if (yesInAnyLang(said)) {
          state.lang = state.pendingLang;
          state.langConfirmed = true;
          state.pendingLang = null;
          const confirm = {
            es: 'Perfecto — seguimos en español. ¿En qué te ayudo?',
            pt: 'Perfeito — seguimos em português. Como posso ajudar?',
            fr: 'Parfait — on continue en français. Comment puis-je vous aider ?'
          }[state.lang] || 'Great — we’ll continue in your language. How can I help?';
          state.lastPrompt = confirm;
          const xml = twiml(gatherWithPlay({ host: req.headers.host, text: confirm, action: '/twilio/handle' }));
          state.speaking = true;
          return res.type('text/xml').send(xml);
        } else if (noInAnyLang(said)) {
          state.pendingLang = null;
          state.lang = 'en';
        }
      }
    }

    // Awaiting SMS receipt?
    if (state.awaitingSmsReceipt) {
      if (yesInAnyLang(said)) {
        state.awaitingSmsReceipt = false;
        if (state.smsReminder === null) {
          state.pendingReminder = true;
          const askR = (localized.askReminder[lang] || localized.askReminder.en)(REMINDER_MINUTES_BEFORE);
          state.lastPrompt = askR;
          const xml = twiml(gatherWithPlay({ host: req.headers.host, text: askR, action: '/twilio/handle' }));
          state.speaking = true;
          return res.type('text/xml').send(xml);
        }
      } else if (noInAnyLang(said)) {
        const p = state.phone || callerPhone;
        const txt = {
          en: `No worries — I’ll resend it to ${p}.`,
          es: `Sin problema — lo reenvío a ${p}.`,
          pt: `Sem problema — vou reenviar para ${p}.`,
          fr: `Pas de souci — je le renvoie à ${p}.`
        }[lang];
        if (p && TWILIO_NUMBER) {
          const smsBody =
            'Re-sent: your MyBizPal confirmation.\n' +
            `Zoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`;
        await twilioClient.messages.create({ to: p, from: TWILIO_NUMBER, body: smsBody });
        }
        state.lastPrompt = txt;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: txt, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    /* ---------- PHONE STEP ---------- */
    if (state.pendingPhone) {
      const normalized = normalizeUkPhone(said);
      if (normalized && isLikelyUkNumber(normalized)) {
        state.phone = normalized;
        state.pendingPhone = false;

        state.pendingEmail = true;
        const confirmThenAskEmail =
          (localized.confirmPhone[lang] || localized.confirmPhone.en)(normalized) + ' ' +
          (localized.askEmail[lang] || localized.askEmail.en);

        state.lastPrompt = confirmThenAskEmail;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: confirmThenAskEmail, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else {
        const ask = localized.askPhone[lang] || localized.askPhone.en;
        state.lastPrompt = ask;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    /* ---------- EMAIL STEP ---------- */
    if (state.pendingEmail) {
      const email = extractEmail(said);
      if (email) {
        state.email = email;
        state.pendingEmail = false;

        if (state.smsReminder === null) {
          state.pendingReminder = true;
          const confirmThenAskReminder =
            (localized.confirmEmail[lang] || localized.confirmEmail.en)(email) + ' ' +
            (localized.askReminder[lang] || localized.askReminder.en)(REMINDER_MINUTES_BEFORE);

          state.lastPrompt = confirmThenAskReminder;
          const xml = twiml(gatherWithPlay({ host: req.headers.host, text: confirmThenAskReminder, action: '/twilio/handle' }));
          state.speaking = true;
          return res.type('text/xml').send(xml);
        }

        const handled = await continueBookingIfReady({ req, res, state, memory });
        if (handled) return;

        const ok = (localized.confirmEmail[lang] || localized.confirmEmail.en)(email);
        state.lastPrompt = ok;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: ok, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else {
        const ask = localized.askEmail[lang] || localized.askEmail.en;
        state.lastPrompt = ask;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    /* ---------- REMINDER STEP ---------- */
    if (state.pendingReminder) {
      if (yesInAnyLang(said)) {
        state.smsReminder = true;
        state.pendingReminder = false;
        const conf = localized.confirmReminderOn[lang] || localized.confirmReminderOn.en;
        state.lastPrompt = conf;

        const handled = await continueBookingIfReady({ req, res, state, memory });
        if (handled) return;

        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else if (noInAnyLang(said)) {
        state.smsReminder = false;
        state.pendingReminder = false;
        const conf = localized.confirmReminderOff[lang] || localized.confirmReminderOff.en;
        state.lastPrompt = conf;

        const handled = await continueBookingIfReady({ req, res, state, memory });
        if (handled) return;

        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else {
        const askR = (localized.askReminder[lang] || localized.askReminder.en)(REMINDER_MINUTES_BEFORE);
        state.lastPrompt = askR;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: askR, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    // Opportunistic phone pull
    const aspirant = normalizeUkPhone(said);
    if (aspirant && isLikelyUkNumber(aspirant) && !state.phone) {
      state.phone = aspirant;
      state.pendingEmail = true;
      const reply =
        (localized.confirmPhone[lang] || localized.confirmPhone.en)(aspirant) + ' ' +
        (localized.askEmail[lang] || localized.askEmail.en);
      state.lastPrompt = reply;
      const xml = twiml(gatherWithPlay({ host: req.headers.host, text: reply, action: '/twilio/handle' }));
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    /* ---------- BOOKING TRIGGER ---------- */
    const nat = parseNaturalDate(said, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(said);

    let voiceReply;
    if (wantsBooking && nat?.iso) {
      state.pendingBookingISO     = nat.iso;
      state.pendingBookingSpoken  = nat.spoken;

      if (!state.phone) {
        state.pendingPhone = true;
        const ask = localized.askPhone[lang] || localized.askPhone.en;
        state.lastPrompt = ask;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
      if (!state.email) {
        state.pendingEmail = true;
        const ask = localized.askEmail[lang] || localized.askEmail.en;
        state.lastPrompt = ask;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
      if (state.smsReminder === null) {
        state.pendingReminder = true;
        const askR = (localized.askReminder[lang] || localized.askReminder.en)(REMINDER_MINUTES_BEFORE);
        state.lastPrompt = askR;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: askR, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

      const handled = await continueBookingIfReady({ req, res, state, memory });
      if (handled) return;
      voiceReply = maybeChuckleLine('Great—one moment.', 0.15);

    } else {
      // Normal conversation with soft humour/emotion & gentle lead
      let intentHint = '';
      if (/\b(price|cost|how much|fee|quote)\b/i.test(said)) intentHint = 'INTENT: pricing/enquiry.';
      else if (/\bbook|schedule|appointment|reserve|call\b/i.test(said)) intentHint = 'INTENT: booking/ready to buy.';

      const smallTalkPhrases = ['weather', 'day going', 'how are you', 'chat', 'talk'];
      if (smallTalkPhrases.some(p => said.toLowerCase().includes(p))) {
        intentHint = 'INTENT: chit-chat. Add a light, friendly line (tiny chuckle ok), then guide to how we can help.';
      }

      // Familiarity line if known caller
      let recallLine = '';
      if (callerPhone && CALLER_RECALL.has(callerPhone)) {
        recallLine = 'They might have called before — sound familiar and supportive.';
      }

      const saidAug = intentHint ? `${said}\n\n(${intentHint})` : said;
      const response = await llm({ history: memory, latestText: saidAug, state, recallLine });
      voiceReply = response;

      if (!state.wrapPrompted && detectEndOfConversation(said)) {
        voiceReply = localized.wrapPrompt[lang] || localized.wrapPrompt.en;
        state.wrapPrompted = true;
      }
    }

    // If our reply asks THEM to wait, suppress nudges briefly
    if (/(one moment|just a sec|give me a (sec|second)|let me check|hang on)/i.test(voiceReply)) {
      state.agentWaitUntil = Date.now() + 12000;
    }

    // Final wrap & goodbye
    if (state.wrapPrompted && detectEndOfConversation(said)) {
      const pod = partOfDay();
      const bye = (localized.goodbye[lang] || localized.goodbye.en)(pod);
      const xml = twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`);
      return res.type('text/xml').send(xml);
    }

    if (wasSpeaking) voiceReply = `${ackPhrase()} ${voiceReply}`;
    state.lastPrompt = voiceReply;

    const xml = twiml(`
      ${gatherWithPlay({ host: req.headers.host, text: voiceReply, action: '/twilio/handle' })}
      <Pause length="1"/>
    `);
    state.speaking = true;
    res.type('text/xml').send(xml);

    memory.push({ role: 'user', content: said });
    memory.push({ role: 'assistant', content: voiceReply });

  } catch (err) {
    console.error('handle error', err);
    res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

/* ================================
   REPROMPT
================================ */
app.post('/twilio/reprompt', (req, res) => {
  const state = stateFor(req.body.CallSid || 'unknown');
  const lang  = state.lang || 'en';
  const text  = state.lastPrompt || (localized.didntCatch[lang] || localized.didntCatch.en);
  const xml   = twiml(gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' }));
  res.type('text/xml').send(xml);
});

/* ================================
   CLEANUP
================================ */
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) {
    CALL_MEMORY.delete(sid);
    CALL_STATE.delete(sid);
  }
  res.type('text/xml').send(twiml('<Hangup/>'));
});

/* ================================
   START
================================ */
app.listen(PORT, () => {
  console.log(`✅ IVR running on ${PORT}`);
});
