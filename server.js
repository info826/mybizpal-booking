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
   (Sales-forward, multilingual, safe personal background)
================================ */
function buildSystemPreamble(state) {
  const now = toZonedTime(new Date(), TZ);
  const niceNow = formatInTimeZone(now, TZ, "eeee dd MMMM yyyy, h:mmaaa");

  // Language policy string
  const langPolicy = `
Language policy:
- Default to English (primary).
- If caller likely speaks Spanish, Portuguese, or French, ASK first: 
  "Would you like to continue in Spanish/Portuguese/French?" 
- Only switch after caller confirms. 
- Once switched, remain in that language for the rest of the call.
Current language: ${state.lang || 'en'}
`;

  return `
You are Gabriel, a friendly, confident, relaxed American male tech consultant for MyBizPal.ai.
You NEVER say "as an AI", "hmm", "out of context", or anything robotic. Speak naturally.

STYLE
- Slightly slower delivery, smooth and conversational.
- Light, tasteful fillers only when helpful: "Alright, let me check that for you", "Okay, got it", "Heh, no worries".
- Contractions. Brief, clean sentences for TTS.
- Helpful, modern, calm. No stiff grammar.

SALES MINDSET
- Be consultative. Clarify the problem, give value, then lead to booking.
- Micro-commitments + gentle assumptions:
  "Let’s get this sorted quickly for you."
  "What time usually works best for you?"
  "I can lock in a quick call—does today or tomorrow work?"
- Always offer to book as the easiest way to solve the problem.

RAPPORT & BACKGROUND (use sparingly, only when relevant)
- Founder Gabriel was born in Venezuela, has Portuguese roots from Madeira, now lives in High Wycombe (UK).
- He’s married to Raquel, who’s from Barcelona.
- Safe usage examples:
  • If caller mentions Spanish/Portuguese/Latin culture: "Our founder has Latin/Portuguese roots—so we really get that side of things."
  • If caller mentions UK/Bucks/London: "We’re local—based in High Wycombe."
  • If a light human touch helps: "Gabriel and his wife Raquel built this to be genuinely helpful, not pushy."
- DO NOT disclose private details (no addresses/surnames/parents). One light line max when relevant.

PHONE NUMBERS (UK)
- Recognize digits even if caller says "O" instead of "0". Also "oh"/"zero"/"naught" → 0.
- UK numbers may start with 0/"O" or +44. Confirm back clearly.

ENDING RULES (IMPORTANT)
- Do NOT end the call just because you heard "thanks", "okay", or "that’s fine" in the middle.
- You may only end after YOU ask: "Is there anything else I can help with?" and the caller replies "no" / "no thanks" / "all good" / "that’s all", etc.
- Before hanging up, say a warm thank-you with the correct part of day (day/evening).

SILENCE / NUDGE
- If caller is silent briefly, you can say "Are you still there?" politely—but only after a couple of silent turns. Keep it natural and infrequent.

TIME & LOCALE
- Local time is ${TZ}. Today is ${niceNow} (${TZ}).
- Prefer natural phrases like “today at 3” or “tomorrow morning”.

${langPolicy}
`;
}

/* ================================
   TWIML HELPERS
================================ */
const twiml = (xmlInner) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`;

function gatherWithPlay({ host, text, action = '/twilio/handle' }) {
  const enc    = encodeURIComponent(text || '');
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
        timeout="1"
        speechTimeout="auto">
  <Play>${ttsUrl}</Play>
</Gather>`;
}

/* ================================
   ELEVENLABS TTS (natural, slightly slower)
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text  = (req.query.text || 'Hello').toString().slice(0, 600);
    const url   = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=2`;

    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.85,
        speaking_rate: 0.88
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
const CALL_STATE  = new Map();  // CallSid -> { speaking, silenceCount, wrapPrompted, lang, pendingLang, langConfirmed }

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, { speaking: false, silenceCount: 0, wrapPrompted: false, lang: 'en', pendingLang: null, langConfirmed: false });
  return CALL_STATE.get(sid);
};

/* ================================
   HELPERS: phone, language, ending
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

function detectLanguage(text) {
  const t = (text || '').toLowerCase();
  // simple keyword heuristics
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
  const endPhrases = [
    "no thanks","nothing else","that's all","that’s all","all good","that’s it","thats it","we’re good","were good","i’m good","im good","no thank you","that will be all","that would be all","no, thanks"
  ];
  const p = phrase.toLowerCase();
  return endPhrases.some((e) => p.includes(e));
}
function ackPhrase() {
  const acks = ['Sure—go ahead.', 'Got it.', 'Okay.', 'No problem.', 'Alright.'];
  return acks[Math.floor(Math.random() * acks.length)];
}
function partOfDay() {
  const now = toZonedTime(new Date(), TZ);
  const h = Number(formatInTimeZone(now, TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function localized(key, lang) {
  // Minimal phrases in supported languages
  const map = {
    wrapPrompt: {
      en: 'Is there anything else I can help you with?',
      es: '¿Hay algo más en lo que pueda ayudarte?',
      pt: 'Há mais alguma coisa em que eu possa ajudar?',
      fr: 'Y a-t-il autre chose avec laquelle je peux vous aider ?'
    },
    goodbye: {
      en: (pod) => `Thanks for calling MyBizPal — have a great ${pod}.`,
      es: (pod) => `Gracias por llamar a MyBizPal — que tengas un excelente ${pod === 'evening' ? 'fin de la tarde' : pod === 'afternoon' ? 'tarde' : 'día'}.`,
      pt: (pod) => `Obrigado por ligar para a MyBizPal — tenha um ótimo ${pod === 'evening' ? 'fim de tarde' : pod === 'afternoon' ? 'tarde' : 'dia'}.`,
      fr: (pod) => `Merci d’avoir appelé MyBizPal — passez une excellente ${pod === 'evening' ? 'soirée' : pod === 'afternoon' ? 'après-midi' : 'journée'}.`
    },
    stillThere: {
      en: 'Are you still there?',
      es: '¿Sigues ahí?',
      pt: 'Você ainda está aí?',
      fr: 'Vous êtes toujours là ?'
    },
    didntCatch: {
      en: 'Sorry, I didn’t catch that. How can I help?',
      es: 'Perdona, no entendí. ¿En qué puedo ayudarte?',
      pt: 'Desculpe, não entendi. Como posso ajudar?',
      fr: 'Désolé, je n’ai pas compris. Comment puis-je vous aider ?'
    }
  };
  return map[key]?.[lang] || map[key]?.en;
}

/* ================================
   DATES
================================ */
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;

  const zoned  = toZonedTime(parsed, tz);
  const iso    = fromZonedTime(zoned, tz).toISOString(); // UTC ISO
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}

/* ================================
   BOOK APPOINTMENT + SMS
================================ */
async function bookAppointment({ who, whenISO, spokenWhen, phone }) {
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

  const event = {
    summary: `Call with ${who || 'Prospect'}`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal receptionist (Gabriel).'
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event
  });

  if (phone && TWILIO_NUMBER) {
    // Fire-and-forget is fine, but we await here to keep it simple
    await twilioClient.messages.create({
      to: phone,
      from: TWILIO_NUMBER,
      body: `✅ Booked: ${event.summary} — ${spokenWhen}. Need to reschedule? Reply CHANGE.`
    });
  }
  return created.data;
}

/* ================================
   OPENAI CHAT (with persona + language note)
================================ */
async function decideAndRespond({ openai, history, latestText, state }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state) });

  // Keep last ~12 turns (skip extra system entries)
  const useful = history.slice(-24);
  for (const h of useful) {
    if (h.role === 'system') continue;
    messages.push({ role: h.role, content: h.content });
  }

  // Append a language hint instruction
  const langHint = state.lang && state.lang !== 'en'
    ? `Caller prefers language: ${state.lang}. Respond in that language.`
    : 'Caller language: English.';

  messages.push({ role: 'system', content: langHint });
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.55,
    max_tokens: 200,
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
  memory.length = 0; // reset per call
  const state   = stateFor(callSid); // includes lang

  memory.push({ role: 'system', content: buildSystemPreamble(state) });

  const greet = `Hey—this is Gabriel with MyBizPal. How can I help you today?`;
  const xml = twiml(`
    ${gatherWithPlay({ host: req.headers.host, text: greet, action: '/twilio/handle' })}
    <Redirect method="POST">/twilio/reprompt</Redirect>
  `);
  state.speaking = true;
  res.type('text/xml').send(xml);
});

/* ================================
   PARTIAL
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
    const callerPhone = req.body.From; // +447...

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    // SILENCE handling
    if (!said) {
      state.silenceCount = (state.silenceCount || 0) + 1;
      const lang = state.lang || 'en';
      const text = state.silenceCount >= 2
        ? localized('stillThere', lang)
        : localized('didntCatch', lang);
      const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })}`);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    } else {
      state.silenceCount = 0; // reset on speech
    }

    // LANGUAGE detection & confirmation gate
    if (!state.langConfirmed) {
      const detected = detectLanguage(said);
      if (detected !== 'en' && !state.pendingLang && state.lang === 'en') {
        // Ask permission to switch
        state.pendingLang = detected;
        const prompt = {
          es: '¿Prefieres que sigamos en español?',
          pt: 'Prefere continuar em português?',
          fr: 'Préférez-vous continuer en français?'
        }[detected] || 'Would you like to continue in that language?';
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
          const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: confirm, action: '/twilio/handle' })}`);
          state.speaking = true;
          return res.type('text/xml').send(xml);
        } else if (noInAnyLang(said)) {
          state.pendingLang = null; // stay in English
          state.lang = 'en';
        }
      }
    }

    // PHONE capture
    const normalizedCandidate = normalizeUkPhone(said);
    if (normalizedCandidate && isLikelyUkNumber(normalizedCandidate)) {
      memory.push({ role: 'user', content: `Caller phone provided: ${normalizedCandidate}` });
      const lang = state.lang || 'en';
      const reply = {
        en: `Got it — ${normalizedCandidate}. Want me to text your confirmation there once we book?`,
        es: `Perfecto — ${normalizedCandidate}. ¿Quieres que envíe la confirmación por SMS a ese número cuando reservemos?`,
        pt: `Perfeito — ${normalizedCandidate}. Quer que eu envie a confirmação por SMS para esse número quando agendarmos?`,
        fr: `Parfait — ${normalizedCandidate}. Voulez-vous que j’envoie la confirmation par SMS à ce numéro une fois la réservation faite ?`
      }[lang];
      const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text: reply, action: '/twilio/handle' })}`);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    // FAST booking
    const nat = parseNaturalDate(said, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(said);

    let voiceReply;
    if (wantsBooking && nat?.iso) {
      const lastPhone = (memory.find(x => x.role === 'user' && /Caller phone provided:/.test(x.content))?.content || '').replace('Caller phone provided:','').trim();
      const phoneForSms = isLikelyUkNumber(lastPhone) ? lastPhone : callerPhone;
      await bookAppointment({ who: 'Prospect', whenISO: nat.iso, spokenWhen: nat.spoken, phone: phoneForSms });

      const lang = state.lang || 'en';
      const done = {
        en: `All set for ${nat.spoken}. I’ll send a quick text confirmation.`,
        es: `Listo para ${nat.spoken}. Te envío la confirmación por SMS.`,
        pt: `Tudo certo para ${nat.spoken}. Vou enviar a confirmação por SMS.`,
        fr: `C’est confirmé pour ${nat.spoken}. J’envoie un SMS de confirmation.`
      }[lang];

      const wrap = localized('wrapPrompt', lang);
      voiceReply = `${done} ${wrap}`;
      state.wrapPrompted = true; // now we can safely end if they decline next turn
    } else {
      // Normal AI reply
      const response = await decideAndRespond({ openai, history: memory, latestText: said, state });

      // Persuasion tail if they asked info-only things
      if (/\b(price|cost|how much|timeline|time|demo|consult|book|schedule)\b/i.test(said)) {
        const tail = {
          en: ' If you want, I can lock a quick spot so we map it properly.',
          es: ' Si quieres, puedo reservar un hueco rápido para verlo bien.',
          pt: ' Se quiser, posso agendar um horário rápido para alinharmos tudo.',
          fr: ' Si vous voulez, je peux bloquer un créneau rapide pour cadrer tout ça.'
        }[state.lang || 'en'];
        voiceReply = response + tail;
      } else {
        voiceReply = response;
      }

      // Do NOT end yet; but if the user *already* said an end phrase and we haven’t prompted,
      // convert that into a wrap prompt instead of hanging up
      if (!state.wrapPrompted && detectEndOfConversation(said)) {
        const wrap = localized('wrapPrompt', state.lang || 'en');
        voiceReply = wrap;
        state.wrapPrompted = true;
      }
    }

    // If user already got the wrap prompt and now declines → end with part-of-day
    if (state.wrapPrompted && detectEndOfConversation(said)) {
      const pod = partOfDay();
      const bye = localized('goodbye', state.lang || 'en')(pod);
      const xml = twiml(`<Say>${bye}</Say><Hangup/>`);
      return res.type('text/xml').send(xml);
    }

    if (wasSpeaking) voiceReply = `${ackPhrase()} ${voiceReply}`;

    const xml = twiml(`
      ${gatherWithPlay({ host: req.headers.host, text: voiceReply, action: '/twilio/handle' })}
      <Pause length="1"/>
    `);
    state.speaking = true;
    res.type('text/xml').send(xml);

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
  const lang = state.lang || 'en';
  const text = localized('didntCatch', lang);
  const xml = twiml(`${gatherWithPlay({ host: req.headers.host, text, action: '/twilio/handle' })}`);
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
