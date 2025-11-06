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
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

/* ================================
   OPENAI (concise + fast)
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ================================
   ELEVENLABS (TTS)
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
   PERSONA / SYSTEM PROMPT
================================ */
function buildSystemPreamble(state) {
  const now = toZonedTime(new Date(), TZ);
  const niceNow = formatInTimeZone(now, TZ, "eeee dd MMMM yyyy, h:mmaaa");

  const langPolicy = `
Language policy:
- Default: English.
- If caller likely speaks Spanish, Portuguese, or French, ASK first before switching.
- Once switched, stay in that language for the rest of the call.
Current language: ${state.lang || 'en'}
`;

  return `
You are Gabriel — a calm, friendly, confident **American male** tech consultant for **MyBizPal.ai**.
Speak **slowly**, clearly, and naturally, like ChatGPT voice. Avoid robotic fillers and repeating the same sentence.

STYLE
- Warm, low-key, professional. No hype.
- Short, spoken-style sentences. Comfortable pauses. No rushing.
- If caller chats casually, respond briefly, then gently steer toward how we can help.

SALES & QUALIFICATION
- Identify intent: (1) ready to buy, (2) enquiry/compare, (3) just chatting.
- Offer a simple next step. Suggest booking if helpful AFTER they ask to book.
- If we’re not the right fit, give a practical alternative and end professionally.

RAPPORT (use sparingly)
- Founder Gabriel: born in Venezuela, Portuguese family (Madeira), lives in High Wycombe (UK).
- Married to Raquel from Barcelona.
- Use at most one light, relevant line to build rapport. Never share private/sensitive info.

PHONE & EMAIL
- UK numbers: “oh / o / zero / naught” → 0. Accept 0-leading, +44.
- For emails: understand “at / at sign / at symbol / arroba” → @, and “dot / punto / ponto / point” → .
- When repeating phone/email back, speak **slowly**, spacing the characters.

ENDING RULES
- Don’t hang up just because you heard “thanks/okay/that’s fine” mid-conversation.
- Only end after YOU ask: “Is there anything else I can help you with?” and the caller declines.
- Use our TTS for the goodbye (not Twilio <Say>).

SILENCE / NUDGE
- Wait calmly. Nudge “Are you still there?” only after ~30 seconds of silence.

TIME & LOCALE
- Local time is ${TZ}. Today is ${niceNow} (${TZ}).

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
        timeout="8"
        speechTimeout="auto">
  <Play>${ttsUrl}</Play>
</Gather>`;
}
function playOnly({ host, text }) {
  const enc    = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${enc}`;
  return `<Play>${ttsUrl}</Play>`;
}

/* ================================
   ELEVENLABS TTS (steady + clear)
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 480);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=1`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.38,
        similarity_boost: 0.9,
        speaking_rate: 0.78 // slower, friendlier pace
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
   STATE (Memory)
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> detailed state

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    speaking: false,
    silenceCount: 0,
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
   HELPERS (phone/email/read-back)
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
    .replace(/\bat-sym(bol)?\b/g, '@')
    .replace(/\bat-sign\b/g, '@')
    .replace(/\barroba\b/g, '@')
    .replace(/\bat\b/g, '@'); // last
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
  return num.split('').join(', '); // “0, 7, 8, …” → read slower
}
function slowEmailSpeak(email) {
  if (!email) return '';
  // speak local part and domain with slight spacing
  return email.replace(/@/g, ' at ').replace(/\./g, ' dot ');
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
  const acks = ['Sure.', 'Okay.', 'Alright.', 'Got it.'];
  return acks[Math.floor(Math.random() * acks.length)];
}
function partOfDay() {
  const now = toZonedTime(new Date(), TZ);
  const h = Number(formatInTimeZone(now, TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

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
    en: 'I didn’t catch that—how can I help?',
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
    en: 'What’s the best mobile number for a quick text confirmation?',
    es: '¿Cuál es el mejor número móvil para enviarte una confirmación por SMS?',
    pt: 'Qual é o melhor número de telemóvel para enviar a confirmação por SMS?',
    fr: 'Quel est le meilleur numéro de mobile pour vous envoyer une confirmation par SMS ?'
  },
  confirmPhone: {
    en: (p) => `Thanks — let me repeat it slowly: ${slowPhoneSpeak(p)}. Is that correct?`,
    es: (p) => `Gracias — lo repito despacio: ${slowPhoneSpeak(p)}. ¿Es correcto?`,
    pt: (p) => `Obrigado — vou repetir devagar: ${slowPhoneSpeak(p)}. Está correto?`,
    fr: (p) => `Merci — je répète lentement: ${slowPhoneSpeak(p)}. C’est correct ?`
  },
  askEmail: {
    en: 'What email should I send the calendar invite to?',
    es: '¿A qué correo te envío la invitación del calendario?',
    pt: 'Para qual e-mail envio o convite do calendário?',
    fr: 'À quelle adresse e-mail dois-je envoyer l’invitation du calendrier ?'
  },
  confirmEmail: {
    en: (e) => `Perfect—here’s how I heard it: ${slowEmailSpeak(e)}. Is that right?`,
    es: (e) => `Perfecto—lo oí así: ${slowEmailSpeak(e)}. ¿Es correcto?`,
    pt: (e) => `Perfeito—ouvi assim: ${slowEmailSpeak(e)}. Está correto?`,
    fr: (e) => `Parfait—je l’ai entendu comme ceci: ${slowEmailSpeak(e)}. C’est correct ?`
  },
  askReminder: {
    en: (m) => `Would you like a text reminder ${m} minutes before, or prefer no reminder?`,
    es: (m) => `¿Quieres un recordatorio por SMS ${m} minutos antes, o prefieres sin recordatorio?`,
    pt: (m) => `Quer um lembrete por SMS ${m} minutos antes, ou prefere sem lembrete?`,
    fr: (m) => `Souhaitez-vous un SMS de rappel ${m} minutes avant, ou préférez-vous sans rappel ?`
  },
  confirmReminderOn: {
    en: 'Alright — I’ll text a reminder before we start.',
    es: 'De acuerdo — te enviaré un recordatorio antes de empezar.',
    pt: 'Combinado — vou enviar um lembrete antes de começarmos.',
    fr: 'Très bien — je vous enverrai un rappel avant de commencer.'
  },
  confirmReminderOff: {
    en: 'No problem — I won’t send a reminder.',
    es: 'Sin problema — no enviaré recordatorio.',
    pt: 'Sem problema — não vou enviar lembrete.',
    fr: 'Pas de problème — je n’enverrai pas de rappel.'
  },
  askReceipt: {
    en: 'I’ve just sent the text—did you receive it?',
    es: 'Acabo de enviarte el SMS—¿lo recibiste?',
    pt: 'Acabei de enviar o SMS—você recebeu?',
    fr: 'Je viens d’envoyer le SMS—l’avez-vous reçu ?'
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
    description: 'Booked by MyBizPal (Gabriel).',
    attendees: email ? [{ email }] : []
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all'
  });

  if (phone && TWILIO_NUMBER) {
    const smsBody = buildConfirmationSms({ summary: event.summary, startISO });
    await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: smsBody });
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
    } catch (e) {
      console.error('Reminder SMS error:', e?.message || e);
    }
  }, delay);
}

/* ================================
   LLM (concise)
================================ */
async function llm({ history, latestText, state }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state) });

  for (const h of history.slice(-14)) if (h.role !== 'system') messages.push(h);
  messages.push({
    role: 'system',
    content: state.lang !== 'en'
      ? `Caller prefers language: ${state.lang}. Respond in that language.`
      : 'Caller language: English.'
  });
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 120,
    messages
  });

  return resp.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ================================
   ENTRY
================================ */
app.post('/twilio/voice', (req, res) => {
  const callSid = req.body.CallSid || '';
  const memory  = memFor(callSid);
  memory.length = 0;

  const state = stateFor(callSid);
  memory.push({ role: 'system', content: buildSystemPreamble(state) });

  const greet = localized.greet[state.lang] || localized.greet.en;
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
    const said    = (req.body.SpeechResult || '').trim();
    const callSid = req.body.CallSid || 'unknown';
    const memory  = memFor(callSid);
    const state   = stateFor(callSid);
    const callerPhone = req.body.From;

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    const lang = state.lang || 'en';

    // — Silence handling (very gentle) —
    if (!said) {
      state.silenceCount = (state.silenceCount || 0) + 1;
      let prompt;
      if (state.silenceCount <= 2)      prompt = localized.gentleNudge[lang] || localized.gentleNudge.en;
      else if (state.silenceCount === 3) prompt = localized.didntCatch[lang] || localized.didntCatch.en;
      else                                prompt = localized.stillThere[lang] || localized.stillThere.en;

      state.lastPrompt = prompt;
      const xml = twiml(gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' }));
      state.speaking = true;
      return res.type('text/xml').send(xml);
    } else {
      state.silenceCount = 0;
    }

    // — Language detection & confirmation —
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

    // — Awaiting SMS receipt? —
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

    // — Phone capture —
    if (state.pendingPhone) {
      const normalized = normalizeUkPhone(said);
      if (normalized && isLikelyUkNumber(normalized)) {
        state.phone = normalized;
        state.pendingPhone = false;
        const conf = (localized.confirmPhone[lang] || localized.confirmPhone.en)(normalized);
        state.lastPrompt = conf;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' }));
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

    // — Email capture —
    if (state.pendingEmail) {
      const email = extractEmail(said);
      if (email) {
        state.email = email;
        state.pendingEmail = false;
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

    // — Reminder preference —
    if (state.pendingReminder) {
      if (yesInAnyLang(said)) {
        state.smsReminder = true;
        state.pendingReminder = false;
        const conf = localized.confirmReminderOn[lang] || localized.confirmReminderOn.en;
        state.lastPrompt = conf;
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else if (noInAnyLang(said)) {
        state.smsReminder = false;
        state.pendingReminder = false;
        const conf = localized.confirmReminderOff[lang] || localized.confirmReminderOff.en;
        state.lastPrompt = conf;
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

    // Opportunistic phone pull if they blurt it out
    const aspirant = normalizeUkPhone(said);
    if (aspirant && isLikelyUkNumber(aspirant) && !state.phone) {
      state.phone = aspirant;
      const reply = (localized.confirmPhone[lang] || localized.confirmPhone.en)(aspirant);
      state.lastPrompt = reply;
      const xml = twiml(gatherWithPlay({ host: req.headers.host, text: reply, action: '/twilio/handle' }));
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    /* =========================
       OPTION A — user-initiated booking
       Trigger only when they explicitly ask to book and give a time.
    ========================== */
    const nat = parseNaturalDate(said, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(said);

    let voiceReply;
    if (wantsBooking && nat?.iso) {
      state.pendingBookingISO = nat.iso;
      state.pendingBookingSpoken = nat.spoken;

      // ask for phone → then email → then reminder → then book
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

      // BOOK NOW
      try {
        const phoneForSms = isLikelyUkNumber(state.phone) ? state.phone : callerPhone;
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

        // ask if SMS received
        if (phoneForSms && TWILIO_NUMBER) {
          const smsBody = buildConfirmationSms({ summary: event.summary, startISO: event.start.dateTime });
          await twilioClient.messages.create({ to: phoneForSms, from: TWILIO_NUMBER, body: smsBody });
          state.smsConfirmSent = true;
          state.awaitingSmsReceipt = true;
        }

        const askReceipt = localized.askReceipt[lang] || localized.askReceipt.en;
        voiceReply = askReceipt;

        // clear pending booking markers
        state.pendingBookingISO = null;
        state.pendingBookingSpoken = null;
        state.wrapPrompted = false;
      } catch (e) {
        console.error('Calendar insert failed:', e?.message || e);
        const fail = 'Hmm — I couldn’t book that just now. I’ll note your details and follow up.';
        const xml = twiml(gatherWithPlay({ host: req.headers.host, text: fail, action: '/twilio/handle' }));
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

    } else {
      // Normal conversation
      let intentHint = '';
      if (/\b(price|cost|how much|fee|quote)\b/i.test(said)) intentHint = 'INTENT: pricing/enquiry.';
      else if (/\bbook|schedule|appointment|reserve|call\b/i.test(said)) intentHint = 'INTENT: booking/ready to buy.';

      // Light small talk detector
      const smallTalkPhrases = ['weather', 'day going', 'how are you', 'chat', 'talk'];
      if (smallTalkPhrases.some(p => said.toLowerCase().includes(p))) {
        intentHint = 'INTENT: chit-chat.';
      }

      const saidAug = intentHint ? `${said}\n\n(${intentHint})` : said;
      const response = await llm({ history: memory, latestText: saidAug, state });

      if (/\b(price|cost|how much|timeline|time|demo|consult|book|schedule)\b/i.test(said)) {
        const tail = {
          en: ' If you’d like, we can secure a quick slot and make it easy.',
          es: ' Si quieres, puedo reservar un hueco rápido y lo dejamos listo.',
          pt: ' Se quiser, posso agendar um horário rápido e simplificar.',
          fr: ' Si vous voulez, on peut bloquer un créneau rapidement et simplifier.'
        }[lang];
        voiceReply = (response + tail).trim();
      } else {
        voiceReply = response;
      }

      // Only prompt wrap up if caller is actually closing
      if (!state.wrapPrompted && detectEndOfConversation(said)) {
        voiceReply = localized.wrapPrompt[lang] || localized.wrapPrompt.en;
        state.wrapPrompted = true;
      }
    }

    // — Final wrap & goodbye —
    if (state.wrapPrompted && detectEndOfConversation(said)) {
      const pod = partOfDay();
      const bye = (localized.goodbye[lang] || localized.goodbye.en)(pod);
      const xml = twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`);
      return res.type('text/xml').send(xml);
    }

    if (wasSpeaking) voiceReply = `${ackPhrase()} ${voiceReply}`;

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
