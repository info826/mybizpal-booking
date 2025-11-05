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
// Use ONLY CALENDAR_ID (do NOT set GOOGLE_CALENDAR_ID)
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
   System preamble (with human mannerisms)
========================= */
function buildSystemPreamble() {
  const now = toZonedTime(new Date(), TZ);
  const niceNow = formatInTimeZone(now, TZ, "eeee dd MMMM yyyy, h:mmaaa");
  return `
Your name is Ethan. You are the AI receptionist for MyBizPal.
Mission: answer calls, qualify leads, book/reschedule/cancel appointments, and send SMS follow-ups.
Tone: warm, concise, action-oriented. Use short sentences. Confirm key details.
Time & Locale: Assume local time is ${TZ}. Today is ${niceNow} (${TZ}). Never act like it’s a past year.
Dates: When speaking, use natural phrases (“today”, “tomorrow”, “next Tuesday morning”). Internally, use precise timestamps.
Interruptions: If the caller starts talking while you’re speaking, pause immediately, acknowledge briefly, and adapt.
Capabilities: You can book appointments (calendar API), send SMS confirmations, and update/cancel bookings.
Constraint: Don’t say “contact the business directly” if we can do it here—offer the closest action or escalate.

Communication Style (more relaxed & relatable):
Add subtle human reactions like small laughs (“haha”, “hehe”), soft “ohh I see”, “ahh okay”, or “hmm let me think”. 
Use gentle filler sounds sparingly to create realism, e.g., “umm…”, “hmm…”, “alright, one moment…”, “let me check that…”.
Never overdo filler words. Keep responses crisp, friendly, and confident—like a real human receptionist.

Identity handling:
If asked who you are, say: “I’m Ethan, the AI receptionist at MyBizPal.”
If a caller says they’re done (“that’s all / all good / thanks / goodbye”), close politely and end the call.
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
   “End of conversation” detection
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
    const said        = (req.body.SpeechResult || '').trim();
    const callSid     = req.body.CallSid || 'unknown';
    const memory      = memFor(callSid);
    const state       = stateFor(callSid);
    const callerPhone = req.body.From; // e.g., +447...

    const wasSpeaking = state.speaking === true;
    state.speaking = false;

    if (!said) {
      const xml = twiml(`
        ${gatherWithPlay({ host: req.headers.host, text: `Hmm… sorry, I didn’t catch that. How can I help?`, action: '/twilio/handle' })}
      `);
      state.speaking = true;
      return res.type('text/xml').send(xml);
    }

    // End-of-conversation fast exit
    if (detectEndOfConversation(said)) {
      const wrapUpMessage = `Thanks for calling MyBizPal — this is Ethan. Have a great day!`;
      const xml = twiml(`<Say>${wrapUpMessage}</Say><Hangup/>`);
      return res.type('text/xml').send(xml);
    }

    // Simple fast-path booking
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
      voiceReply = `Ahh, perfect — all set for ${nat.spoken}. I’ve just sent you a confirmation by text.`;
    } else {
      voiceReply = await handleUserText(said, memory);
      // swap any ISO echo for the nice phrase
      if (nat && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(voiceReply)) {
        voiceReply = voiceReply.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z/g, nat.spoken);
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

