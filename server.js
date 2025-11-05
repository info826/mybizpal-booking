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
   CONFIG
================================ */
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60); // SMS reminder lead time

// Twilio
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ElevenLabs (TTS)
const EL_KEY   = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// Google Calendar (Service Account)
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID || 'primary';

/* ================================
   PERSONA / SYSTEM PROMPT
   Calm, consultative, multilingual, rapport
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
You are Gabriel — a calm, friendly, confident American male tech consultant for MyBizPal.ai.
Speak naturally, not rushed. No robotic phrases. No "out of context". Keep a relaxed, human pace.

STYLE
- Warm, low-key, professional; not overly enthusiastic.
- Short, spoken-style sentences. Small pauses are okay. Avoid repeating yourself.
- If the caller chats about their day or random topics, respond briefly and politely, then gently steer toward how we can help.

SALES & QUALIFICATION
- Recognize intent: (1) buy/ready, (2) enquire/compare, (3) just chatting.
- Offer real value fast. Then softly guide toward a booking if it makes sense.
- If we are not the right solution, suggest a practical alternative and end professionally.

RAPPORT (use sparingly)
- Founder Gabriel: born in Venezuela, Portuguese roots from Madeira, lives in High Wycombe (UK).
- Married to Raquel (from Barcelona).
- Use only a brief relevant line to build trust (culture/UK/local context). Do not disclose private or sensitive details.

PHONE NUMBERS (UK)
- Interpret “O/oh/zero/naught” as 0. Accept 0-leading and +44. Confirm back.

ENDING RULES (IMPORTANT)
- Never end just because you heard “thanks/okay/that’s fine” mid-conversation.
- Only end after YOU ask: “Is there anything else I can help you with?” and the caller then declines.
- When ending, use your own TTS voice, not Twilio <Say>.

SILENCE / NUDGE
- Don’t panic on short pauses. Wait comfortably.
- Nudge “Are you still there?” only after a long pause (~30s), not sooner.

TIME & LOCALE
- Local time is ${TZ}. Today is ${niceNow} (${TZ}).
- Prefer natural phrases: “today at 3”, “tomorrow morning”.

${langPolicy}
`;
}

/* ================================
   TWIML HELPERS
================================ */
const twiml = (xmlInner) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`;

function gatherWithPlay({ host, text, action = '/twilio/handle' }) {
  const enc = encodeURIComponent(text || '');
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
        timeout="7"
        speechTimeout="auto">
  <Play>${ttsUrl}</Play>
</Gather>`;
}
function playOnly({ host, text }) {
  const enc = encodeURIComponent(text || '');
  const ttsUrl = `https://${host}/tts?text=${enc}`;
  return `<Play>${ttsUrl}</Play>`;
}

/* ================================
   ELEVENLABS TTS (natural, slower)
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 500);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=2`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        speaking_rate: 0.84
      }
    };
    const r = await axios.post(url, payload, {
      responseType: 'arraybuffer',
      headers: {
        'xi-api-key': EL_KEY,
        'Content-Type': 'application/json'
      }
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
   CALL MEMORY & STATE
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> { speaking, silenceCount, wrapPrompted, lang, pendingLang, langConfirmed, lastPrompt, email, pendingEmail, smsReminder, pendingReminder, pendingBookingISO, pendingBookingSpoken, reminderTimerId }

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
    email: null,
    pendingEmail: false,
    smsReminder: null,          // true/false
    pendingReminder: false,
    pendingBookingISO: null,
    pendingBookingSpoken: null,
    reminderTimerId: null
  });
  return CALL_STATE.get(sid);
};

/* ================================
   HELPERS: phone, email, language, ending
================================ */
function normalizeUkPhone(spoken) {
  if (!spoken) return null;
  let s = spoken.toLowerCase();
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
  return s;
}
function isLikelyUkNumber(n) {
  if (!n) return false;
  return /^0\d{10}$/.test(n) || /^0\d{9}$/.test(n) || /^\+44\d{10}$/.test(n);
}
function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ' ' + spoken.toLowerCase() + ' ';
  // common voice patterns
  s = s.replace(/ at /g, '@')
       .replace(/ arroba /g, '@')
       .replace(/ dot /g, '.')
       .replace(/ punto /g, '.')
       .replace(/ ponto /g, '.')
       .replace(/ point /g, '.')
       .replace(/\s+/g, ' ')
       .trim();
  // remove spaces around @ and .
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  // crude email pull
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
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
  const p = phrase.toLowerCase();
  const ends = [
    "no thanks","nothing else","that's all","that’s all","all good","that’s it","thats it",
    "we’re good","were good","i’m good","im good","no thank you","that will be all","that would be all","no, thanks"
  ];
  return ends.some(e => p.includes(e));
}
function ackPhrase() {
  const acks = ['Sure.', 'Got it.', 'Okay.', 'No problem.', 'Alright.'];
  return acks[Math.floor(Math.random() * acks.length)];
}
function partOfDay() {
  const now = toZonedTime(new Date(), TZ);
  const h = Number(formatInTimeZone(now, TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

// Minimal localized strings
function localized(key, lang) {
  const map = {
    wrapPrompt: {
      en: 'Is there anything else I can help you with?',
      es: '¿Hay algo más en lo que pueda ayudarte?',
      pt: 'Há mais alguma coisa em que eu possa ajudar?',
      fr: 'Y a-t-il autre chose avec laquelle je peux vous aider ?'
    },
    gentleNudge: {
      en: 'Take your time—whenever you’re ready.',
      es: 'Tómate tu tiempo—cuando estés listo.',
      pt: 'Sem pressa—quando estiver pronto.',
      fr: 'Prenez votre temps—quand vous serez prêt.'
    },
    stillThere: {
      en: 'Are you still there?',
      es: '¿Sigues ahí?',
      pt: 'Você ainda está aí?',
      fr: 'Vous êtes toujours là ?'
    },
    didntCatch: {
      en: 'I didn’t catch that—how can I help?',
      es: 'No alcancé a entender—¿en qué puedo ayudarte?',
      pt: 'Não percebi—como posso ajudar?',
      fr: 'Je n’ai pas bien compris—comment puis-je vous aider ?'
    },
    greet: {
      en: 'Hey—this is Gabriel with MyBizPal. How can I help today?',
      es: 'Hola—soy Gabriel de MyBizPal. ¿En qué te puedo ayudar hoy?',
      pt: 'Olá—é o Gabriel da MyBizPal. Como posso ajudar hoje?',
      fr: 'Salut—ici Gabriel de MyBizPal. Comment puis-je vous aider aujourd’hui ?'
    },
    goodbye: {
      en: (pod) => `Thanks for calling MyBizPal—have a great ${pod}.`,
      es: (pod) => `Gracias por llamar a MyBizPal—que tengas un excelente ${pod === 'evening' ? 'fin de la tarde' : pod === 'afternoon' ? 'tarde' : 'día'}.`,
      pt: (pod) => `Obrigado por ligar para a MyBizPal—tenha um ótimo ${pod === 'evening' ? 'fim de tarde' : pod === 'afternoon' ? 'tarde' : 'dia'}.`,
      fr: (pod) => `Merci d’avoir appelé MyBizPal—passez une excellente ${pod === 'evening' ? 'soirée' : pod === 'afternoon' ? 'après-midi' : 'journée'}.`
    },
    askEmail: {
      en: 'What email should I send the calendar invite to?',
      es: '¿A qué correo te envío la invitación del calendario?',
      pt: 'Para qual e-mail envio o convite do calendário?',
      fr: 'À quelle adresse e-mail dois-je envoyer l’invitation du calendrier ?'
    },
    confirmEmail: {
      en: (e) => `Perfect—I'll send it to ${e}.`,
      es: (e) => `Perfecto—lo envío a ${e}.`,
      pt: (e) => `Perfeito—vou enviar para ${e}.`,
      fr: (e) => `Parfait—je l’envoie à ${e}.`
    },
    askReminder: {
      en: (m) => `Would you like a text reminder ${m} minutes before the meeting, or would you prefer no reminder?`,
      es: (m) => `¿Quieres un recordatorio por SMS ${m} minutos antes de la reunión, o prefieres sin recordatorio?`,
      pt: (m) => `Você quer um lembrete por SMS ${m} minutos antes da reunião, ou prefere sem lembrete?`,
      fr: (m) => `Souhaitez-vous un SMS de rappel ${m} minutes avant la réunion, ou préférez-vous sans rappel ?`
    },
    confirmReminderOn: {
      en: 'Got it — I’ll text you a reminder before we start.',
      es: 'Perfecto — te enviaré un recordatorio antes de empezar.',
      pt: 'Perfeito — vou enviar um lembrete antes de começarmos.',
      fr: 'Parfait — je vous enverrai un rappel avant de commencer.'
    },
    confirmReminderOff: {
      en: 'No problem — I won’t send a reminder.',
      es: 'Sin problema — no enviaré recordatorio.',
      pt: 'Sem problema — não vou enviar lembrete.',
      fr: 'Pas de problème — je n’enverrai pas de rappel.'
    }
  };
  return map[key]?.[lang] || map[key]?.en;
}

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
   BOOK APPOINTMENT + SMS (+ email attendee)
================================ */
const REMINDER_TIMERS = new Map(); // eventId -> timeoutId

async function bookAppointment({ who, whenISO, spokenWhen, phone, email }) {
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

  const event = {
    summary: `Call with ${who || 'Prospect'}`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal receptionist (Gabriel).',
    attendees: email ? [{ email }] : []
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all' // email invite to attendees
  });

  const eventData = created.data;
  // Immediate confirmation SMS (existing)
  if (phone && TWILIO_NUMBER) {
    await twilioClient.messages.create({
      to: phone,
      from: TWILIO_NUMBER,
      body: `✅ Booked: ${event.summary} — ${spokenWhen}. Need to reschedule? Reply CHANGE.`
    });
  }

  return eventData; // return full event data (id + times)
}

function scheduleSmsReminder({ event, phone }) {
  if (!phone || !TWILIO_NUMBER) return;
  if (!event?.start?.dateTime) return;

  const startTime = new Date(event.start.dateTime).getTime();
  const now = Date.now();
  const fireAt = startTime - REMINDER_MINUTES_BEFORE * 60000;
  const delay = fireAt - now;

  // Only schedule if within 7 days and in the future
  if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
    const timerId = setTimeout(async () => {
      try {
        await twilioClient.messages.create({
          to: phone,
          from: TWILIO_NUMBER,
          body: `⏰ Reminder: ${event.summary} in ${REMINDER_MINUTES_BEFORE} minutes.`
        });
      } catch (e) {
        console.error('Reminder SMS error:', e?.message || e);
      }
    }, delay);
    REMINDER_TIMERS.set(event.id, timerId);
  }
}

/* ================================
   OPENAI CHAT (calm persona)
================================ */
async function decideAndRespond({ openai, history, latestText, state }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state) });

  const useful = history.slice(-18); // concise memory
  for (const h of useful) {
    if (h.role === 'system') continue;
    messages.push({ role: h.role, content: h.content });
  }
  const langHint = state.lang && state.lang !== 'en'
    ? `Caller prefers language: ${state.lang}. Respond in that language.`
    : 'Caller language: English.';
  messages.push({ role: 'system', content: langHint });
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.45,
    max_tokens: 160,
    messages
  });

  const text = resp.choices?.[0]?.message?.content?.trim() || "Alright—how can I help?";
  return text;
}

/* ================================
   ENTRY
================================ */
app.post('/twilio/voice', async (req, res) => {
  const callSid = req.body.CallSid || '';
  const memory  = memFor(callSid);
  memory.length = 0;
  const state   = stateFor(callSid);

  memory.push({ role: 'system', content: buildSystemPreamble(state) });

  const greet = localized('greet', state.lang || 'en');
  state.lastPrompt = greet;

  const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: greet, action: '/twilio/handle' })}`);
  state.speaking = true;
  res.type('text/xml').send(xml);
});

/* ================================
   PARTIAL LOGGING
================================ */
app.post('/twilio/partial', bodyParser.urlencoded({ extended: true }), (req, res) => {
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

    // SILENCE handling (long, calm)
    if (!said) {
      state.silenceCount = (state.silenceCount || 0) + 1;
      let prompt;
      if (state.silenceCount <= 2) {
        prompt = localized('gentleNudge', lang);
      } else if (state.silenceCount === 3) {
        prompt = localized('didntCatch', lang);
      } else {
        prompt = localized('stillThere', lang);
      }
      state.lastPrompt = prompt;
      const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' })}`);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    } else {
      state.silenceCount = 0;
    }

    // LANGUAGE detection & confirmation
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
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: prompt, action: '/twilio/handle' })}`);
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
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: confirm, action: '/twilio/handle' })}`);
          state.speaking = true;
          return res.type('text/xml').send(xml);
        } else if (noInAnyLang(said)) {
          state.pendingLang = null; // stay EN
          state.lang = 'en';
        }
      }
    }

    // Handle pending EMAIL capture
    if (state.pendingEmail) {
      const email = extractEmail(said);
      if (email) {
        state.email = email;
        state.pendingEmail = false;
        const ok = localized('confirmEmail', lang)(email);
        // ask reminder next
        state.pendingReminder = true;
        const askR = localized('askReminder', lang)(REMINDER_MINUTES_BEFORE);
        const follow = `${ok} ${askR}`;
        state.lastPrompt = follow;
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: follow, action: '/twilio/handle' })}`);
        state.speaking = true;
        return res.type('text/xml').send(xml);
      } else {
        // gently re-ask
        const ask = localized('askEmail', lang);
        state.lastPrompt = ask;
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' })}`);
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    // Handle pending REMINDER choice
    if (state.pendingReminder) {
      if (yesInAnyLang(said)) {
        state.smsReminder = true;
        state.pendingReminder = false;
        const conf = localized('confirmReminderOn', lang);
        // If we already have a pending booking time, book now
        if (state.pendingBookingISO) {
          const lastPhone = (memory.find(x => x.role === 'user' && /Caller phone provided:/.test(x.content))?.content || '').replace('Caller phone provided:','').trim();
          const phoneForSms = isLikelyUkNumber(lastPhone) ? lastPhone : callerPhone;
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
          const wrap = localized('wrapPrompt', lang);
          const text = `${conf} ${wrap}`;
          state.wrapPrompted = true;
          state.lastPrompt = text;
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })}`);
          state.pendingBookingISO = null;
          state.pendingBookingSpoken = null;
          state.speaking = true;
          return res.type('text/xml').send(xml);
        } else {
          // Not booking now, just confirm preference
          state.lastPrompt = conf;
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' })}`);
          state.speaking = true;
          return res.type('text/xml').send(xml);
        }
      } else if (noInAnyLang(said)) {
        state.smsReminder = false;
        state.pendingReminder = false;
        const conf = localized('confirmReminderOff', lang);
        if (state.pendingBookingISO) {
          const lastPhone = (memory.find(x => x.role === 'user' && /Caller phone provided:/.test(x.content))?.content || '').replace('Caller phone provided:','').trim();
          const phoneForSms = isLikelyUkNumber(lastPhone) ? lastPhone : callerPhone;
          const event = await bookAppointment({
            who: 'Prospect',
            whenISO: state.pendingBookingISO,
            spokenWhen: state.pendingBookingSpoken,
            phone: phoneForSms,
            email: state.email
          });
          // no reminder scheduled
          const wrap = localized('wrapPrompt', lang);
          const text = `${conf} ${wrap}`;
          state.wrapPrompted = true;
          state.lastPrompt = text;
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })}`);
          state.pendingBookingISO = null;
          state.pendingBookingSpoken = null;
          state.speaking = true;
          return res.type('text/xml').send(xml);
        } else {
          state.lastPrompt = conf;
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: conf, action: '/twilio/handle' })}`);
          state.speaking = true;
          return res.type('text/xml').send(xml);
        }
      } else {
        // Clarify reminder choice
        const askR = localized('askReminder', lang)(REMINDER_MINUTES_BEFORE);
        state.lastPrompt = askR;
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: askR, action: '/twilio/handle' })}`);
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }
    }

    // PHONE capture opportunistically
    const normalizedCandidate = normalizeUkPhone(said);
    if (normalizedCandidate && isLikelyUkNumber(normalizedCandidate)) {
      memory.push({ role: 'user', content: `Caller phone provided: ${normalizedCandidate}` });
      const reply = {
        en: `Got it — ${normalizedCandidate}.`,
        es: `Perfecto — ${normalizedCandidate}.`,
        pt: `Perfeito — ${normalizedCandidate}.`,
        fr: `Parfait — ${normalizedCandidate}.`
      }[lang];
      state.lastPrompt = reply;
      const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: reply, action: '/twilio/handle' })}`);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    // FAST booking: capture email + reminder if missing
    const nat = parseNaturalDate(said, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(said);

    let voiceReply;
    if (wantsBooking && nat?.iso) {
      state.pendingBookingISO = nat.iso;
      state.pendingBookingSpoken = nat.spoken;

      // Ask email if missing
      if (!state.email) {
        state.pendingEmail = true;
        const ask = localized('askEmail', lang);
        state.lastPrompt = ask;
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: ask, action: '/twilio/handle' })}`);
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

      // Ask reminder preference if not set
      if (state.smsReminder === null) {
        state.pendingReminder = true;
        const askR = localized('askReminder', lang)(REMINDER_MINUTES_BEFORE);
        state.lastPrompt = askR;
        const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: askR, action: '/twilio/handle' })}`);
        state.speaking = true;
        return res.type('text/xml').send(xml);
      }

      // We have email + reminder preference → proceed to book
      const lastPhone = (memory.find(x => x.role === 'user' && /Caller phone provided:/.test(x.content))?.content || '').replace('Caller phone provided:','').trim();
      const phoneForSms = isLikelyUkNumber(lastPhone) ? lastPhone : callerPhone;
      const event = await bookAppointment({
        who: 'Prospect',
        whenISO: nat.iso,
        spokenWhen: nat.spoken,
        phone: phoneForSms,
        email: state.email
      });

      if (state.smsReminder === true) {
        scheduleSmsReminder({ event, phone: phoneForSms });
      }

      const done = {
        en: `All set for ${nat.spoken}. I’ve sent the calendar invite.`,
        es: `Listo para ${nat.spoken}. Ya envié la invitación del calendario.`,
        pt: `Tudo certo para ${nat.spoken}. Já enviei o convite do calendário.`,
        fr: `C’est confirmé pour ${nat.spoken}. J’ai envoyé l’invitation calendrier.`
      }[lang];

      const wrap = localized('wrapPrompt', lang);
      voiceReply = `${done} ${wrap}`;
      state.wrapPrompted = true;
      state.lastPrompt = voiceReply;

      // Clear booking state
      state.pendingBookingISO = null;
      state.pendingBookingSpoken = null;

    } else {
      // Normal AI reply — classify intent (buy/enquire/chat) to shape tone
      let intentHint = '';
      if (/\b(price|cost|how much|fee|quote)\b/i.test(said)) intentHint = 'INTENT: pricing/enquiry.';
      else if (/\bbook|schedule|appointment|reserve|call\b/i.test(said)) intentHint = 'INTENT: booking/ready to buy.';
      else if (/\bweather|day going|how are you|chat|talk\b/i.test(said)) intentHint = 'INTENT: chit-chat.';

      const saidAug = intentHint ? `${said}\n\n(${intentHint})` : said;
      const response = await decideAndRespond({ openai, history: memory, latestText: saidAug, state });

      // Subtle steer only when relevant
      if (/\b(price|cost|how much|timeline|time|demo|consult|book|schedule)\b/i.test(said)) {
        const tail = {
          en: ' If you like, I can secure a quick slot and we’ll sort it properly.',
          es: ' Si quieres, puedo reservar un hueco rápido y lo vemos bien.',
          pt: ' Se quiser, posso agendar um horário rápido e alinhamos tudo.',
          fr: ' Si vous voulez, je peux bloquer un créneau rapide pour cadrer tout ça.'
        }[lang];
        voiceReply = (response + tail).trim();
      } else {
        voiceReply = response;
      }

      // If user hints to end but we haven’t prompted, convert into wrap prompt (don’t hang up yet)
      if (!state.wrapPrompted && detectEndOfConversation(said)) {
        const wrap = localized('wrapPrompt', lang);
        voiceReply = wrap;
        state.wrapPrompted = true;
      }
      state.lastPrompt = voiceReply;
    }

    // If we already asked the wrap question and they now decline → end with your TTS
    if (state.wrapPrompted && detectEndOfConversation(said)) {
      const pod = partOfDay();
      const bye = localized('goodbye', lang)(pod);
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

    // Memory
    memory.push({ role: 'user', content: said });
    memory.push({ role: 'assistant', content: voiceReply });

  } catch (err) {
    console.error('handle error', err);
    res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

/* ================================
   REPROMPT (keeps continuity)
================================ */
app.post('/twilio/reprompt', (req, res) => {
  const state = stateFor(req.body.CallSid || 'unknown');
  const lang = state.lang || 'en';
  const text = state.lastPrompt || localized('didntCatch', lang);
  const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })}`);
  res.type('text/xml').send(xml);
});

/* ================================
   CLEANUP
================================ */
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) {
    // clear any scheduled reminder
    const st = stateFor(sid);
    if (st.reminderTimerId) clearTimeout(st.reminderTimerId);
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
