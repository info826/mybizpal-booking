// server.js  — MyBizPal Voice Agent (Gabriel)
// Fast build friendly, calm pacing, books to Google Calendar, sends SMS, handles email/phone cleanly.

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { google } from 'googleapis';
import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';
import twilio from 'twilio';

/* ──────────────────────────────────────────────────────────
   BASIC APP
────────────────────────────────────────────────────────── */
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

/* ──────────────────────────────────────────────────────────
   TWILIO
────────────────────────────────────────────────────────── */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

/* ──────────────────────────────────────────────────────────
   OPENAI (light + fast)
────────────────────────────────────────────────────────── */
const openai       = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ──────────────────────────────────────────────────────────
   ELEVENLABS TTS
────────────────────────────────────────────────────────── */
const EL_KEY   = process.env.ELEVENLABS_API_KEY || '';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || ''; // choose a warm male US voice in your account

// Helper: prepare spoken versions for important data
const slowPhoneSpeak = (num) => (num || '')
  .replace(/[^\d+]/g, '')
  .replace(/\+/g, ' plus ')
  .split('')
  .join(' ');

const slowEmailSpeak = (email) => (email || '')
  .replace(/@/g, ' at ')
  .replace(/\./g, ' dot ')
  .split('')
  .join(' ')
  .replace(/\s+/g, ' ');

// TTS endpoint (kept simple; optimize_streaming_latency=1 for snappy starts)
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello.').toString().slice(0, 480);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=1`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.38,
        similarity_boost: 0.9,
        speaking_rate: 0.78, // calm pace
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

/* ──────────────────────────────────────────────────────────
   GOOGLE CALENDAR — Service Account
────────────────────────────────────────────────────────── */
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar   = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID || 'primary';

let googleReady = false;
async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
    console.log('✅ Google authorized');
  }
}

/* ──────────────────────────────────────────────────────────
   ZOOM INFO + SMS TEXTS
────────────────────────────────────────────────────────── */
const ZOOM_LINK       = process.env.ZOOM_LINK
  || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1&omn=88292946669';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE   = process.env.ZOOM_PASSCODE   || 'jcJx8M';

const formatDateForSms = (iso) =>
  formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");

const buildConfirmationSms = ({ startISO }) => [
  'MyBizPal — Business Consultation (15 min)',
  `Date: ${formatDateForSms(startISO)}`,
  'Please be on time and bring any questions.',
  `Join via Zoom: ${ZOOM_LINK}`,
  `Meeting ID  ${ZOOM_MEETING_ID}`,
  `Passcode    ${ZOOM_PASSCODE}`,
  'To reschedule, reply CHANGE.'
].join('\n');

const buildReminderSms = ({ startISO }) => [
  `⏰ Reminder: consultation in ${REMINDER_MINUTES_BEFORE} min`,
  `Start: ${formatDateForSms(startISO)}`,
  `Zoom: ${ZOOM_LINK}`,
  `ID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
].join('\n');

/* ──────────────────────────────────────────────────────────
   TWIML HELPERS
────────────────────────────────────────────────────────── */
const twiml = (inner) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

const gatherWithPlay = ({ host, text, action = '/twilio/handle' }) => {
  const t = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${t}`;
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        action="${action}"
        method="POST"
        actionOnEmptyResult="true"
        partialResultCallback="/twilio/partial"
        partialResultCallbackMethod="POST"
        timeout="7"
        speechTimeout="auto">
  <Play>${ttsUrl}</Play>
</Gather>`;
};

const playOnly = ({ host, text }) => {
  const t = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${t}`;
  return `<Play>${ttsUrl}</Play>`;
};

/* ──────────────────────────────────────────────────────────
   STATE / MEMORY
────────────────────────────────────────────────────────── */
const CALL_MEMORY = new Map(); // CallSid -> [{role, content}]
const CALL_STATE  = new Map(); // CallSid -> {..}

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

    // contact
    phone: null,
    pendingPhone: false,
    email: null,
    pendingEmail: false,

    // reminder
    smsReminder: null,
    pendingReminder: false,

    // sms receipt check
    smsConfirmSent: false,
    awaitingSmsReceipt: false,

    // booking
    pendingBookingISO: null,
    pendingBookingSpoken: null,

    lastPrompt: ''
  });
  return CALL_STATE.get(sid);
};

/* ──────────────────────────────────────────────────────────
   UTIL: language, phone, email, wrap
────────────────────────────────────────────────────────── */
const detectLanguage = (t='') => {
  const s = t.toLowerCase();
  if (/(hola|gracias|por favor|buenos|buenas|quiero|necesito)/.test(s)) return 'es';
  if (/(olá|ola|obrigado|obrigada|por favor|amanhã|preciso|quero)/.test(s)) return 'pt';
  if (/(bonjour|bonsoir|merci|s'il vous plaît|svp|demain)/.test(s)) return 'fr';
  return 'en';
};
const yesInAny = (t='') => /\b(yes|yeah|yep|sure|ok|okay|si|sí|sim|oui|d'accord)\b/i.test(t);
const noInAny  = (t='') => /\b(no|nope|nah|not now|pas maintenant|não|nao)\b/i.test(t);

const partOfDay = () => {
  const h = Number(formatInTimeZone(new Date(), TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
};

const normalizeUkPhone = (spoken='') => {
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0')
       .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
       .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
       .replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8').replace(/\bnine\b/g, '9');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) s = '0' + s.slice(3);
  if (!s.startsWith('0') && s.length === 10) s = '0' + s;
  return s.trim();
};
const isLikelyUk = (n) => /^0\d{10}$/.test(n) || /^0\d{9}$/.test(n) || /^\+44\d{10}$/.test(n);

const extractEmail = (spoken='') => {
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\bat sign\b/g, '@').replace(/\bat symbol\b/g, '@').replace(/\barroba\b/g, '@').replace(/\bat\b/g, '@');
  s = s.replace(/\bdot\b/g, '.').replace(/\bpunto\b/g, '.').replace(/\bponto\b/g, '.').replace(/\bpoint\b/g, '.');
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.').replace(/\s+/g, ' ').trim();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
};

const detectEnd = (p='') => {
  const t = p.toLowerCase();
  return [
    'no thanks','nothing else',"that's all",'that’s all','all good',"that's it",'thats it',
    "we're good",'were good',"i'm good",'im good','no thank you','that will be all','that would be all'
  ].some(x => t.includes(x));
};

/* ──────────────────────────────────────────────────────────
   LANGUAGE LINES
────────────────────────────────────────────────────────── */
const msg = {
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
    en: (p) => `Got it — ${slowPhoneSpeak(p)}.`,
    es: (p) => `Perfecto — ${slowPhoneSpeak(p)}.`,
    pt: (p) => `Perfeito — ${slowPhoneSpeak(p)}.`,
    fr: (p) => `Parfait — ${slowPhoneSpeak(p)}.`
  },
  askEmail: {
    en: 'What email should I send the calendar invite to?',
    es: '¿A qué correo te envío la invitación del calendario?',
    pt: 'Para qual e-mail envio o convite do calendário?',
    fr: 'À quelle adresse e-mail dois-je envoyer l’invitation du calendrier ?'
  },
  confirmEmail: {
    en: (e) => `Great — I’ll send it to ${slowEmailSpeak(e)}.`,
    es: (e) => `Perfecto — lo envío a ${slowEmailSpeak(e)}.`,
    pt: (e) => `Perfeito — vou enviar para ${slowEmailSpeak(e)}.`,
    fr: (e) => `Parfait — je l’envoie à ${slowEmailSpeak(e)}.`
  },
  askReceipt: {
    en: 'I’ve just sent the text—did you receive it?',
    es: 'Acabo de enviarte el SMS—¿lo recibiste?',
    pt: 'Acabei de enviar o SMS—você recebeu?',
    fr: 'Je viens d’envoyer le SMS—l’avez-vous reçu ?'
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
  wrap: {
    en: 'Is there anything else I can help you with?',
    es: '¿Hay algo más en lo que pueda ayudarte?',
    pt: 'Há mais alguma coisa em que eu possa ajudar?',
    fr: 'Y a-t-il autre chose avec laquelle je peux vous aider ?'
  },
  bye: {
    en: (pod) => `Thanks for calling MyBizPal—have a great ${pod}.`,
    es: (pod) => `Gracias por llamar a MyBizPal—que tengas un excelente ${pod === 'evening' ? 'fin de la tarde' : pod === 'afternoon' ? 'tarde' : 'día'}.`,
    pt: (pod) => `Obrigado por ligar para a MyBizPal—tenha um ótimo ${pod === 'evening' ? 'fim de tarde' : pod === 'afternoon' ? 'tarde' : 'dia'}.`,
    fr: (pod) => `Merci d’avoir appelé MyBizPal—passez une excellente ${pod === 'evening' ? 'soirée' : 'journée'}.`
  }
};

/* ──────────────────────────────────────────────────────────
   SYSTEM PROMPT
────────────────────────────────────────────────────────── */
const systemPrompt = (state) => {
  const nowNice = formatInTimeZone(new Date(), TZ, "eeee dd MMMM yyyy, h:mmaaa '('zzzz')'");
  return `
You are Gabriel — a calm, friendly, confident American male tech consultant for MyBizPal.ai.
Speak slowly and naturally, like a human. Avoid robotic fillers and do not repeat stock phrases.

STYLE
- Warm, low-key, professional; not overly enthusiastic.
- Short spoken sentences, natural pacing, comfortable pauses.
- If the caller chats casually, respond briefly, then gently steer toward how we can help.

SALES & QUALIFICATION
- Identify intent: ready to buy / enquiry / just chatting.
- Offer an easy next step; suggest booking if helpful.
- If not a fit, offer a practical alternative and end professionally.

RAPPORT (use sparingly)
- Founder Gabriel: born in Venezuela, Portuguese roots from Madeira, lives in High Wycombe (UK).
- Married to Raquel from Barcelona.
- Use at most one light, relevant line to build rapport. Never share sensitive info.

PHONE & EMAIL
- UK numbers: “oh / o / zero / naught” → 0. Accept 0-leading, or +44 forms.
- Read back numbers and emails clearly and slowly.
- Email voice: understand “at / at sign / arroba” → @, and “dot / punto / ponto / point” → .

ENDING RULES
- Do not end because you heard “thanks/okay/that’s fine” mid-conversation.
- Only end after YOU ask: “Is there anything else I can help you with?” and they clearly decline.

SILENCE
- Be patient. Nudge only after long pauses (~30s), not immediately.

TIME
- Local timezone: ${TZ}. Now: ${nowNice}.

Language policy: default English. If caller likely Spanish/Portuguese/French, ask before switching. Current: ${state.lang}.
`;
};

/* ──────────────────────────────────────────────────────────
   NATURAL DATE PARSE
────────────────────────────────────────────────────────── */
const parseNaturalDate = (utterance, tz = TZ) => {
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;
  const zoned  = toZonedTime(parsed, tz);
  return {
    iso: fromZonedTime(zoned, tz).toISOString(),
    spoken: formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa")
  };
};

/* ──────────────────────────────────────────────────────────
   BOOKING / SMS
────────────────────────────────────────────────────────── */
async function bookAppointment({ whenISO, email }) {
  await ensureGoogleAuth();
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 15 * 60000).toISOString();

  const event = {
    summary: 'MyBizPal — Business Consultation (15 min)',
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal receptionist (Gabriel).',
    attendees: email ? [{ email }] : []
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all'  // email invite to attendee (if provided)
  });

  return created?.data;
}

function scheduleReminder({ event, phone }) {
  if (!phone || !TWILIO_NUMBER) return;
  const startTime = new Date(event.start.dateTime).getTime();
  const fireAt    = startTime - REMINDER_MINUTES_BEFORE * 60000;
  const delay     = fireAt - Date.now();
  if (delay <= 0 || delay > 7 * 24 * 60 * 60 * 1000) return;

  setTimeout(async () => {
    try {
      await twilioClient.messages.create({
        to: phone,
        from: TWILIO_NUMBER,
        body: buildReminderSms({ startISO: event.start.dateTime })
      });
    } catch (e) {
      console.error('Reminder SMS error:', e?.message || e);
    }
  }, delay);
}

/* ──────────────────────────────────────────────────────────
   LLM — calm, concise
────────────────────────────────────────────────────────── */
async function llm({ history, latestText, state }) {
  const messages = [{ role: 'system', content: systemPrompt(state) }];
  for (const h of history.slice(-14)) if (h.role !== 'system') messages.push(h);
  messages.push({ role: 'system', content: state.lang !== 'en'
    ? `Caller prefers ${state.lang}. Respond in that language.`
    : 'Caller language: English.' });
  messages.push({ role: 'user', content: latestText });

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 120,
    messages
  });
  return r.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ──────────────────────────────────────────────────────────
   ENTRY
────────────────────────────────────────────────────────── */
app.post('/twilio/voice', async (req, res) => {
  const sid    = req.body.CallSid || '';
  const memory = memFor(sid); memory.length = 0;
  const state  = stateFor(sid);

  memory.push({ role: 'system', content: systemPrompt(state) });

  const text = msg.greet[state.lang];
  state.lastPrompt = text;
  state.speaking = true;
  res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })));
});

/* ──────────────────────────────────────────────────────────
   PARTIAL (optional debug)
────────────────────────────────────────────────────────── */
app.post('/twilio/partial', (req, res) => res.sendStatus(200));

/* ──────────────────────────────────────────────────────────
   MAIN HANDLE
────────────────────────────────────────────────────────── */
app.post('/twilio/handle', async (req, res) => {
  try {
    const sid      = req.body.CallSid || 'unknown';
    const memory   = memFor(sid);
    const state    = stateFor(sid);
    const host     = req.headers.host;
    const callerPh = req.body.From || null;

    const saidRaw  = (req.body.SpeechResult || '').trim();
    const lang     = state.lang;

    // silence logic — patient first, then gentle nudge; no 1-second "are you there"
    if (!saidRaw) {
      state.silenceCount = (state.silenceCount || 0) + 1;
      let t;
      if (state.silenceCount <= 2)      t = msg.gentleNudge[lang];
      else if (state.silenceCount === 3) t = msg.didntCatch[lang];
      else                                t = msg.stillThere[lang];
      state.lastPrompt = t;
      state.speaking = true;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
    } else {
      state.silenceCount = 0;
    }

    // language offer
    if (!state.langConfirmed) {
      const detected = detectLanguage(saidRaw);
      if (detected !== 'en' && !state.pendingLang && state.lang === 'en') {
        state.pendingLang = detected;
        const ask = detected === 'es' ? '¿Prefieres que sigamos en español?'
                  : detected === 'pt' ? 'Prefere continuar em português?'
                  : detected === 'fr' ? 'Préférez-vous continuer en français?'
                  : 'Would you like to continue in that language?';
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      } else if (state.pendingLang) {
        if (yesInAny(saidRaw)) {
          state.lang = state.pendingLang;
          state.langConfirmed = true;
          state.pendingLang = null;
          const confirm = state.lang === 'es'
            ? 'Perfecto — seguimos en español. ¿En qué te ayudo?'
            : state.lang === 'pt'
              ? 'Perfeito — seguimos em português. Como posso ajudar?'
              : state.lang === 'fr'
                ? 'Parfait — on continue en français. Comment puis-je vous aider ?'
                : 'Great — we’ll continue in your language. How can I help?';
          state.lastPrompt = confirm;
          state.speaking   = true;
          return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: confirm })));
        } else if (noInAny(saidRaw)) {
          state.pendingLang = null;
          state.lang = 'en';
        }
      }
    }

    // awaiting sms receipt?
    if (state.awaitingSmsReceipt) {
      if (yesInAny(saidRaw)) {
        state.awaitingSmsReceipt = false;
        if (state.smsReminder === null) {
          state.pendingReminder = true;
          const ask = msg.askReminder[lang](REMINDER_MINUTES_BEFORE);
          state.lastPrompt = ask;
          state.speaking   = true;
          return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
        }
      } else if (noInAny(saidRaw)) {
        const p = state.phone || callerPh;
        if (p && TWILIO_NUMBER) {
          await twilioClient.messages.create({
            to: p,
            from: TWILIO_NUMBER,
            body: 'Re-sent: your MyBizPal confirmation.\n' +
                  `Zoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
          });
        }
        state.awaitingSmsReceipt = false;
        const t = lang === 'es' ? 'Listo — lo he reenviado.'
              : lang === 'pt' ? 'Pronto — reenviei.'
              : lang === 'fr' ? 'C’est renvoyé.'
              : 'All set — I’ve re-sent it.';
        state.lastPrompt = t;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
      }
    }

    // phone collection flow
    if (state.pendingPhone) {
      const n = normalizeUkPhone(saidRaw);
      if (n && isLikelyUk(n)) {
        state.phone = n;
        state.pendingPhone = false;
        const t = msg.confirmPhone[lang](n);
        state.lastPrompt = t;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
      } else {
        const ask = msg.askPhone[lang];
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
    }

    // email collection flow
    if (state.pendingEmail) {
      const e = extractEmail(saidRaw);
      if (e) {
        state.email = e;
        state.pendingEmail = false;
        const t = msg.confirmEmail[lang](e);
        state.lastPrompt = t;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
      } else {
        const ask = msg.askEmail[lang];
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
    }

    // reminder preference
    if (state.pendingReminder) {
      if (yesInAny(saidRaw)) {
        state.smsReminder = true; state.pendingReminder = false;
        const t = msg.confirmReminderOn[lang];
        state.lastPrompt = t;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
      } else if (noInAny(saidRaw)) {
        state.smsReminder = false; state.pendingReminder = false;
        const t = msg.confirmReminderOff[lang];
        state.lastPrompt = t;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
      } else {
        const ask = msg.askReminder[lang](REMINDER_MINUTES_BEFORE);
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
    }

    // opportunistic phone catch
    const nC = normalizeUkPhone(saidRaw);
    if (nC && isLikelyUk(nC)) {
      state.phone = nC;
      const t = msg.confirmPhone[lang](nC);
      state.lastPrompt = t;
      state.speaking   = true;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: t })));
    }

    // booking trigger
    const nat = parseNaturalDate(saidRaw, TZ);
    const wantsBooking = /\b(book|schedule|(set( up)? )?(a )?(call|meeting|appointment)|reserve)\b/i.test(saidRaw);

    let voiceReply = '';

    if (wantsBooking && nat?.iso) {
      state.pendingBookingISO    = nat.iso;
      state.pendingBookingSpoken = nat.spoken;

      if (!state.phone) {
        state.pendingPhone = true;
        const ask = msg.askPhone[lang];
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
      if (!state.email) {
        state.pendingEmail = true;
        const ask = msg.askEmail[lang];
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
      if (state.smsReminder === null) {
        state.pendingReminder = true;
        const ask = msg.askReminder[lang](REMINDER_MINUTES_BEFORE);
        state.lastPrompt = ask;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }

      // BOOK
      let event;
      try {
        event = await bookAppointment({ whenISO: state.pendingBookingISO, email: state.email });
      } catch (e) {
        console.error('Calendar error:', e?.message || e);
        const fail = lang === 'es' ? 'No he podido reservar ahora mismo; tomaré nota y te confirmo enseguida.'
                 : lang === 'pt' ? 'Não consegui reservar agora; vou anotar e confirmar já.'
                 : lang === 'fr' ? 'Je n’ai pas pu réserver tout de suite; je note et je vous confirme rapidement.'
                 : 'I couldn’t book that just now; I’ll note it and confirm shortly.';
        state.lastPrompt = fail;
        state.speaking   = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: fail })));
      }

      // SMS confirmation (immediately) + ask receipt
      const phoneForSms = isLikelyUk(state.phone) ? state.phone : callerPh;
      if (phoneForSms && TWILIO_NUMBER) {
        await twilioClient.messages.create({
          to: phoneForSms,
          from: TWILIO_NUMBER,
          body: buildConfirmationSms({ startISO: event.start.dateTime })
        });
        state.smsConfirmSent   = true;
        state.awaitingSmsReceipt = true;
      }

      if (state.smsReminder) scheduleReminder({ event, phone: phoneForSms });

      voiceReply = msg.askReceipt[lang];

      // clear pending
      state.pendingBookingISO = null;
      state.pendingBookingSpoken = null;
      state.wrapPrompted = false;
      state.lastPrompt   = voiceReply;

    } else {
      // conversation mode — give slight intent hint
      let intentHint = '';
      if (/\b(price|cost|how much|fee|quote)\b/i.test(saidRaw)) intentHint = '(INTENT: pricing/enquiry)';
      else if (/\bbook|schedule|appointment|reserve|call\b/i.test(saidRaw)) intentHint = '(INTENT: booking)';

      const saidAug = intentHint ? `${saidRaw}\n\n${intentHint}` : saidRaw;
      const response = await llm({ history: memory, latestText: saidAug, state });

      if (/\b(price|cost|how much|timeline|time|demo|consult|book|schedule)\b/i.test(saidRaw)) {
        const tail = state.lang === 'es' ? ' Si quieres, reservo un hueco rápido para verlo bien.'
                  : state.lang === 'pt' ? ' Se quiser, posso agendar um horário rápido para alinharmos.'
                  : state.lang === 'fr' ? ' Si vous voulez, je peux bloquer un créneau rapide pour cadrer cela.'
                  : ' If you like, I can secure a quick slot so we sort it properly.';
        voiceReply = (response + ' ' + tail).trim();
      } else {
        voiceReply = response;
      }

      // wrap invitation (don’t end yet)
      if (!state.wrapPrompted && detectEnd(saidRaw)) {
        voiceReply = msg.wrap[lang];
        state.wrapPrompted = true;
      }
      state.lastPrompt = voiceReply;
    }

    // final end after wrap + clear decline
    if (state.wrapPrompted && detectEnd(saidRaw)) {
      const bye = msg.bye[lang](partOfDay());
      return res.type('text/xml').send(twiml(`${playOnly({ host, text: bye })}<Hangup/>`));
    }

    // reply
    state.speaking = true;
    res.type('text/xml').send(twiml(`
      ${gatherWithPlay({ host, text: voiceReply })}
      <Pause length="1"/>
    `));

    // memory
    memory.push({ role: 'user', content: saidRaw });
    memory.push({ role: 'assistant', content: voiceReply });

  } catch (err) {
    console.error('handle error:', err);
    res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

/* ──────────────────────────────────────────────────────────
   REPROMPT & CLEANUP
────────────────────────────────────────────────────────── */
app.post('/twilio/reprompt', (req, res) => {
  const s = stateFor(req.body.CallSid || 'unknown');
  const t = s.lastPrompt || msg.didntCatch[s.lang || 'en'];
  res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: t })));
});

app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) { CALL_MEMORY.delete(sid); CALL_STATE.delete(sid); }
  res.type('text/xml').send(twiml('<Hangup/>'));
});

/* ──────────────────────────────────────────────────────────
   START
────────────────────────────────────────────────────────── */
app.listen(PORT, () => console.log(`✅ IVR running on ${PORT}`));
