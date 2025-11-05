// server.js (ESM)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import fs from 'fs';

import OpenAI from 'openai';
import { decideAndRespond } from './logic.js';

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

// Google Calendar + Twilio
import twilio from 'twilio';
import { google } from 'googleapis';

/* =========================
   Config / Clients
========================= */
const TZ = process.env.TZ || 'Europe/London';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT     = process.env.PORT || 3000;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const EL_KEY   = process.env.ELEVENLABS_API_KEY;

// OpenAI (for decideAndRespond in logic.js)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_NUMBER } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Google Calendar auth: supports ENV or a JSON file path if you ever add it
function buildGoogleAuth() {
  // Preferred path: env vars
  let clientEmail = process.env.GOOGLE_CLIENT_EMAIL || '';
  let privateKey  = (process.env.GOOGLE_PRIVATE_KEY || '');

  // Optional fallback to a JSON file if you decide to use one later
  const credsPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if ((!clientEmail || !privateKey) && credsPath && fs.existsSync(credsPath)) {
    const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
    clientEmail = raw.client_email;
    privateKey  = raw.private_key;
  }

  if (!clientEmail || !privateKey) {
    throw new Error('Google creds missing: set GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY (escaped \\n).');
  }

  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );
}

const jwt = buildGoogleAuth();
const calendar = google.calendar({ version: 'v3', auth: jwt });
// Use ONLY CALENDAR_ID (do NOT set GOOGLE_CALENDAR_ID unless you want fallback)
const CALENDAR_ID = process.env.CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || 'primary';

/* =========================
   In-memory call state
========================= */
const CALL_MEMORY = new Map(); // CallSid -> [{role, content}, ...]
const CALL_STATE  = new Map(); // CallSid -> { speaking: boolean }

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, { speaking: false });
  return CALL_STATE.get(sid);
};

/* =========================
   TwiML helper
========================= */
const twiml = (xmlInner) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`;

/* =========================
   System preamble (sales-forward + human mannerisms)
========================= */
function buildSystemPreamble() {
  const now = toZonedTime(new Date(), TZ);
  const niceNow = formatInTimeZone(now, TZ, "eeee dd MMMM yyyy, h:mmaaa");
  return `
Your name is Ethan. You are the AI receptionist for MyBizPal.ai.
Mission: answer calls, qualify leads, handle objections lightly, and guide the caller to book an appointment as the best next step to solve their problem. You can also reschedule/cancel appointments and send SMS confirmations.
Tone: warm, concise, action-oriented. Use short sentences. Confirm key details.
Sales DNA: Ask 2–4 short qualifying questions (goal, timeline, budget sense, current tool/process). Summarize what you heard in one sentence. Offer a crisp benefit-led reason to book (“so we can map your situation and show you options in 15–20 minutes”). Use gentle micro-closes (“shall we pop 3pm tomorrow in the diary?”). If they hesitate, offer a nearby alternative time. Always keep momentum toward a booking.
Time & Locale: Assume local time is ${TZ}. Today is ${niceNow} (${TZ}). Never act like it’s a past year.
Dates: When speaking, use natural phrases (“today”, “tomorrow”, “next Tuesday morning”). Internally, use precise timestamps.
Interruptions: If the caller starts talking while you’re speaking, pause immediately, acknowledge briefly, and adapt.
Capabilities: You can book appointments (calendar API), send SMS confirmations, and update/cancel bookings.
Constraint: Don’t say “contact the business directly” if we can do it here—offer the closest action or escalate.

Communication Style (more relaxed & relatable):
Add subtle human reactions like small laughs (“haha”, “hehe”), soft “ohh I see”, “ahh okay”, or “hmm let me think”. 
Use gentle filler sounds sparingly to create realism, e.g., “umm…”, “hmm…”, “alright, one moment…”, “let me check that…”.
Never overdo filler words. Keep responses crisp, friendly, and confident—like a real human receptionist who can also sell.

Identity handling:
If asked who you are, say: “I’m Ethan, the AI receptionist at MyBizPal.”
If a caller says they’re done (“that’s all / all good / thanks / goodbye”), close politely and end the call.

Phone number handling:
If the caller reads a UK number and says “O” or “oh”, treat it as zero. Accept formats that start with 0 or +44. If you capture a different number than the caller ID, confirm it briefly (e.g., “ending 2166, shall I text that one?”) and proceed.
`;
}

/* =========================
   Natural date parsing
========================= */
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;

  const zoned  = toZonedTime(parsed, tz);
  const iso    = fromZonedTime(zoned, tz).toISOString(); // back to UTC ISO for API
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}

/* =========================
   Phone extraction & UK normalization
========================= */
// Map common spoken tokens to digits
const DIGIT_WORDS = new Map([
  ['zero','0'], ['oh','0'], ['o','0'], ['owe','0'],
  ['one','1'], ['two','2'], ['to','2'], ['too','2'],
  ['three','3'], ['four','4'], ['for','4'],
  ['five','5'], ['six','6'], ['seven','7'],
  ['eight','8'], ['ate','8'], ['nine','9']
]);

function extractRawDigitsFromSpeech(text) {
  if (!text) return '';
  // Tokenize by non-alphanumeric, map number words & single letters
  const tokens = text.toLowerCase().split(/[^a-z0-9+]+/).filter(Boolean);
  const mapped = tokens.map(tok => {
    if (DIGIT_WORDS.has(tok)) return DIGIT_WORDS.get(tok);
    // Single letter "o" already covered; keep numeric chunks as-is
    if (/^\d+$/.test(tok)) return tok;
    // Handle things like +44
    if (/^\+?\d+$/.test(tok)) return tok.replace('+','');
    return '';
  }).join('');
  // Also capture inline digits if user spoke contiguous numbers
  return mapped.replace(/[^\d]/g, '');
}

function normalizeUKToE164(rawDigits) {
  if (!rawDigits) return null;
  // Trim leading 00 (international format spoken)
  let d = rawDigits.replace(/^00/, '');
  // If already looks like 44XXXXXXXXXX (12 digits) → +44…
  if (d.startsWith('44') && d.length === 12) return `+${d}`;
  // If starts with 0 and is 11 digits → UK national → +44…
  if (d.startsWith('0') && d.length === 11) return `+44${d.slice(1)}`;
  // If already 11 digits without 0 (rare) try +44 + digits
  if (d.length === 10 && !d.startsWith('0')) return `+44${d}`;
  // If already E.164 with +, leave it (handled above)
  return null;
}

function extractUKPhoneE164FromText(text) {
  const digits = extractRawDigitsFromSpeech(text);
  const e164 = normalizeUKToE164(digits);
  return { e164, digits };
}

/* =========================
   End-of-conversation detection
========================= */
function detectEndOfConversation(phrase) {
  const endPhrases = [
    "that's fine","all good","thank you","thanks","no thanks",
    "nothing else","that's all","thank you very much","goodbye","bye","cheers","that’s fine","that is all"
  ];
  const p = phrase.toLowerCase();
  return endPhrases.some(e => p.includes(e));
}

/* =========================
   Barge-in Gather helper
========================= */
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

/* =========================
   ElevenLabs TTS endpoint
========================= */
app.get('/tts', async (req, res) => {
  try {
    const text  = (req.query.text || 'Hello').toString().slice(0, 500);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=2`;
    const r = await axios.post(
      url,
      { text, model_id: 'eleven_multilingual_v2' },
      {
        responseType: 'arraybuffer',
        headers: { 'xi-api-key': EL_KEY, 'Content-Type': 'application/json' },
      }
    );
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.send(Buffer.from(r.data));
  } catch (e) {
    console.error('TTS error:', e?.response?.status, e?.response?.data?.toString?.() || e.message);
    res.status(500).end();
  }
});

/* =========================
   Calendar booking + SMS
========================= */
async function bookAppointment({ who, whenISO, spokenWhen, phone }) {
  // 30-minute booking
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

  const event = {
    summary: `Call with ${who || 'Prospect'}`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal receptionist (Ethan).',
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
  });

  if (phone && TWILIO_NUMBER) {
    await twilioClient.messages.create({
      to: phone,
      from: TWILIO_NUMBER,
      body: `✅ Your appointment is booked for ${spokenWhen}. This is Ethan from MyBizPal — reply CHANGE to reschedule.`
    });
  }

  return created.data;
}

/* =========================
   AI reply helper
========================= */
async function handleUserText(latestText, memory) {
  const nat = parseNaturalDate(latestText, TZ);
  let augmented = latestText;
  if (nat) {
    augmented += `\n\n[ParsedTimeISO:${nat.iso}; SpokenTime:${nat.spoken}; TZ:${TZ}]`;
  }

  const reply = await decideAndRespond({
    openai,
    history: memory,
    latestText: augmented,
  });

  memory.push({ role: 'user',      content: latestText });
  memory.push({ role: 'assistant', content: reply });

  return reply;
}

function ackPhrase() {
  const acks = ['Sure—go ahead.', 'Got it.', 'Okay.', 'No problem.', 'Alright.'];
  return acks[Math.floor(Math.random() * acks.length)];
}

/* =========================
   Twilio Voice endpoints
========================= */
app.post('/twilio/voice', async (req, res) => {
  const callSid = req.body.CallSid || '';
  const memory  = memFor(callSid);
  memory.length = 0;
  const state   = stateFor(callSid);

  memory.push({ role: 'system', content: buildSystemPreamble() });

  const greet = `Welcome to MyBizPal, this is Ethan speaking. How can I help you today?`;
  const xml = twiml(`
    ${gatherWithPlay({ host: req.headers.host, text: greet, action: '/twilio/handle' })}
    <Redirect method="POST">/twilio/reprompt</Redirect>
  `);
  state.speaking = true;

  res.type('text/xml').send(xml);
});

app.post('/twilio/partial', bodyParser.urlencoded({ extended: true }), (req, res) => {
  const partial = req.body.UnstableSpeechResult || req.body.SpeechResult || '';
  if (partial) console.log('PARTIAL:', partial);
  res.sendStatus(200);
});

app.post('/twilio/handle', async (req, res) => {
  try {
    const saidRaw    = (req.body.SpeechResult || '').trim();
    const callSid    = req.body.CallSid || 'unknown';
    const memory     = memFor(callSid);
    const state      = stateFor(callSid);

    // Try to capture a UK number from speech; fallback to caller ID
    const spokenPhone = extractUKPhoneE164FromText(saidRaw);
    let callerPhone   = spokenPhone?.e164 || (req.body.From || '').trim();

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    if (!saidRaw) {
      const xml = twiml(`
        ${gatherWithPlay({ host: req.headers.host, text: `Hmm… sorry, I didn’t catch that. How can I help?`, action: '/twilio/handle' })}
      `);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    // End-of-conversation fast exit
    if (detectEndOfConversation(saidRaw)) {
      const wrapUpMessage = `Thanks for calling MyBizPal — this is Ethan. Have a great day!`;
      const xml = twiml(`<Say>${wrapUpMessage}</Say><Hangup/>`);
      return res.type('text/xml').send(xml);
    }

    // Simple fast-path booking
    const nat = parseNaturalDate(saidRaw, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(saidRaw);

    let voiceReply;

    if (wantsBooking && nat?.iso) {
      await bookAppointment({
        who: 'Prospect',
        whenISO: nat.iso,
        spokenWhen: nat.spoken,
        phone: callerPhone,
      });

      // If user dictated a different phone, briefly confirm last 3–4 digits naturally
      if (spokenPhone?.e164 && spokenPhone.e164 !== (req.body.From || '').trim()) {
        const tail = spokenPhone.e164.slice(-4);
        voiceReply = `Ahh, perfect — all set for ${nat.spoken}. I’ll text the confirmation to the number ending ${tail}.`;
      } else {
        voiceReply = `Ahh, perfect — all set for ${nat.spoken}. I’ve just sent you a confirmation by text.`;
      }
    } else {
      // Sales-forward assistant response
      voiceReply = await handleUserText(saidRaw, memory);
      // swap any ISO echo for the nice phrase
      if (nat && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(voiceReply)) {
        voiceReply = voiceReply.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, nat.spoken);
      }

      // Micro-close nudge if they asked about features/pricing without booking language
      const infoSeeking = /\b(price|pricing|cost|features?|how (it )?works?|what do you do|services?)\b/i.test(saidRaw);
      if (infoSeeking && !wantsBooking) {
        voiceReply += ` Hmm… to make this easier, shall we pop a quick 15–20 minute slot in the diary so I can map your situation and show you the best fit?`;
      }
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

app.post('/twilio/reprompt', (req, res) => {
  const xml = twiml(`
    ${gatherWithPlay({ host: req.headers.host, text: `Alright… how can I help?`, action: '/twilio/handle' })}
  `);
  res.type('text/xml').send(xml);
});

app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) {
    CALL_MEMORY.delete(sid);
    CALL_STATE.delete(sid);
  }
  res.type('text/xml').send(twiml('<Hangup/>'));
});

/* =========================
   Start
========================= */
app.listen(PORT, () => {
  console.log(`✅ IVR running on ${PORT}`);
});


