// server.js
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';

import OpenAI from 'openai';
import { decideAndRespond } from './logic.js';

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { format as formatDate } from 'date-fns';

import twilio from 'twilio';
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

// ──────────────────────────────────────────────────────────────
// Config
// ──────────────────────────────────────────────────────────────
const TZ = process.env.TZ || 'Europe/London';
const PORT     = process.env.PORT || 3000;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const EL_KEY   = process.env.ELEVENLABS_API_KEY;

// ──────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// serve /public if you later add assets
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// ──────────────────────────────────────────────────────────────
// OpenAI
// ──────────────────────────────────────────────────────────────
if (!process.env.OPENAI_API_KEY) {
  console.warn('Warning: OPENAI_API_KEY is not set.');
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ──────────────────────────────────────────────────────────────
// Twilio (env validation + client)
// ──────────────────────────────────────────────────────────────
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER; // must be E.164 (+44...)

// ──────────────────────────────────────────────────────────────
// Google Calendar (Service Account)
// ──────────────────────────────────────────────────────────────
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

// Authorize SA at boot (good early failure)
try {
  await jwt.authorize();
  console.log('✅ Google Service Account authorized.');
} catch (e) {
  console.warn('⚠️  Google SA authorization failed. Check GOOGLE_* env vars and calendar sharing.');
}

// ──────────────────────────────────────────────────────────────
// In-memory per-call state
// ──────────────────────────────────────────────────────────────
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

// ──────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────
const twiml = (xmlInner) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${xmlInner}</Response>`;

function nowInTZ() {
  return toZonedTime(new Date(), TZ);
}

// System prompt
function buildSystemPreamble() {
  const niceNow = formatInTimeZone(new Date(), TZ, "eeee dd MMMM yyyy, h:mmaaa");
  return `
You are MyBizPal — the AI receptionist for MyBizPal.ai.
Mission: answer calls, qualify leads, book/reschedule/cancel appointments, and send SMS follow-ups.
Tone: warm, concise, action-oriented. Use short sentences. Confirm key details.
Time & Locale: Assume local time is ${TZ}. Today is ${niceNow} (${TZ}). Never act like it’s a past year.
Dates: When speaking, use natural phrases (“today”, “tomorrow”, “next Tuesday morning”). Internally, use precise timestamps.
Interruptions: If the caller starts talking while you’re speaking, pause immediately, acknowledge briefly, and adapt.
Capabilities: You can book appointments (calendar API), send SMS confirmations, and update/cancel bookings.
Constraint: Don’t say “contact the business directly” if we can do it here—offer the closest action or escalate.
`;
}

// Natural date parser → { iso, spoken }
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;

  const zoned  = toZonedTime(parsed, tz);
  const iso    = fromZonedTime(zoned, tz).toISOString(); // UTC ISO
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}

// <Gather> with TTS (no background noise)
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

// End intent detection
function detectEndOfConversation(phrase) {
  const endPhrases = [
    "that's fine",
    "all good",
    "thank you",
    "no thanks",
    "nothing else",
    "that's all",
    "thank you very much",
    "goodbye",
    "bye"
  ];
  return endPhrases.some((e) => phrase?.toLowerCase().includes(e));
}

// quick ack when user barges in
function ackPhrase() {
  const acks = ['Sure—go ahead.', 'Got it.', 'Okay.', 'No problem.', 'Alright.'];
  return acks[Math.floor(Math.random() * acks.length)];
}

// ──────────────────────────────────────────────────────────────
// ElevenLabs TTS endpoint (Twilio <Play> pulls from here)
// ──────────────────────────────────────────────────────────────
app.get('/tts', async (req, res) => {
  try {
    const text  = (req.query.text || 'Hello').toString().slice(0, 500);
    const voice = VOICE_ID;

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?optimize_streaming_latency=2`;
    const r = await axios.post(
      url,
      { text, model_id: 'eleven_multilingual_v2' },
      {
        responseType: 'arraybuffer',
        headers: {
          'xi-api-key': EL_KEY,
          'Content-Type': 'application/json',
        },
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

// ──────────────────────────────────────────────────────────────
// Booking action (Calendar + SMS)
// ──────────────────────────────────────────────────────────────
async function bookAppointment({ who, whenISO, spokenWhen, phone }) {
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();

  const event = {
    summary: `Call with ${who || 'Prospect'}`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal receptionist.',
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
  });

  if (phone && TWILIO_NUMBER) {
    try {
      await twilioClient.messages.create({
        to: phone,               // Twilio passes E.164 (e.g., +447...)
        from: TWILIO_NUMBER,     // must be E.164
        body: `✅ Booked: ${event.summary} — ${spokenWhen}. Need to reschedule? Reply CHANGE.`,
      });
    } catch (err) {
      console.error('SMS send error:', err?.message || err);
    }
  }

  return created.data;
}

// AI helper (adds parsed date hints)
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

// ──────────────────────────────────────────────────────────────
// Health
// ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'MyBizPal-IVR',
    time_london: formatInTimeZone(new Date(), TZ, "yyyy-MM-dd HH:mm:ss 'BST/GMT'"),
  });
});

// ──────────────────────────────────────────────────────────────
// Twilio Voice Webhooks
// ──────────────────────────────────────────────────────────────
app.post('/twilio/voice', async (req, res) => {
  const callSid = req.body.CallSid || '';
  const memory  = memFor(callSid);
  memory.length = 0;
  const state   = stateFor(callSid);

  memory.push({ role: 'system', content: buildSystemPreamble() });

  const greet = `Welcome to MyBizPal. How can I help you today?`;
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
    const said       = (req.body.SpeechResult || '').trim();
    const callSid    = req.body.CallSid || 'unknown';
    const memory     = memFor(callSid);
    const state      = stateFor(callSid);
    const callerPhone= req.body.From; // E.164

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    if (!said) {
      const xml = twiml(`
        ${gatherWithPlay({ host: req.headers.host, text: `Sorry, I didn’t catch that. How can I help?`, action: '/twilio/handle' })}
      `);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    // end-of-convo intent
    if (detectEndOfConversation(said)) {
      const wrapUpMessage = `Thank you for calling MyBizPal. Have a great day!`;
      const xml = twiml(`
        <Say>${wrapUpMessage}</Say>
        <Hangup/>
      `);
      return res.type('text/xml').send(xml);
    }

    // quick booking path
    const nat = parseNaturalDate(said, TZ);
    const wantsBooking = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve)\b/i.test(said);

    let voiceReply;
    if (wantsBooking && nat?.iso) {
      await bookAppointment({
        who: 'Prospect',
        whenISO: nat.iso,
        spokenWhen: nat.spoken,
        phone: callerPhone,
      });
      voiceReply = `All set for ${nat.spoken}. I’ve texted you the confirmation.`;
    } else {
      voiceReply = await handleUserText(said, memory);

      // Replace ISO with spoken phrasing if model emits timestamps
      if (nat && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(voiceReply)) {
        voiceReply = voiceReply.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, nat.spoken);
      }
    }

    if (wasSpeaking) {
      voiceReply = `${ackPhrase()} ${voiceReply}`;
    }

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
    ${gatherWithPlay({ host: req.headers.host, text: `How can I help?`, action: '/twilio/handle' })}
  `);
  res.type('text/xml').send(xml);
});

// optional: cleanup hook
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) { CALL_MEMORY.delete(sid); CALL_STATE.delete(sid); }
  res.type('text/xml').send(twiml('<Hangup/>'));
});

// ──────────────────────────────────────────────────────────────
// Start
// ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const ts = formatDate(nowInTZ(), 'yyyy-MM-dd HH:mm:ss');
  console.log(`[server] MyBizPal-IVR listening on :${PORT} — London ${ts}`);
});

Add IVR agent with Twilio + Calendar + SMS booking

