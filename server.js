// server.js — GABRIEL v2.0 — THE REAL ONE (Nov 2025)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { toZonedTime, formatInTimeZone } from 'date-fns-tz';
import { addMinutes } from 'date-fns';        // ← FIXED
import twilio from 'twilio';
import { google } from 'googleapis';
import { decideAndRespond } from './logic.js'; // ← GABRIEL'S BRAIN

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 15);

const ZOOM_LINK = process.env.ZOOM_LINK || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE || 'jcJx8M';

const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

const EL_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// Google Calendar
let googleReady = false;
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
    console.log('Google Calendar authorized');
  }
}

async function isSlotFree(startISO) {
  await ensureGoogleAuth();
  const endISO = addMinutesBase(new Date(startISO), 15).toISOString();
  try {
    const res = await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: startISO,
      timeMax: endISO,
      singleEvents: true,
    });
    return !res.data.items || res.data.items.length === 0;
  } catch (e) {
    console.error('Availability check failed:', e.message);
    return false;
  }
}

// Memory
const CALL_MEMORY = new Map();
const CALL_STATE = new Map();
const CALLER_RECALL = new Map();

const memFor = (sid) => CALL_MEMORY.has(sid) ? CALL_MEMORY.get(sid) : CALL_MEMORY.set(sid, []).get(sid);
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) {
    CALL_STATE.set(sid, {
      lang: 'en',
      phone: null,
      email: null,
      pendingWhenISO: null,
      pendingWhenSpoken: null,
      smsReminder: null,
      confirmEmail: false,
      confirmPhone: false,
      checked: false,
      smsSent: false,
      wrapAsked: false,
      silenceCount: 0,
      lastPrompt: '',
      speaking: false
    });
  }
  return CALL_STATE.get(sid);
};

// Personality
function buildSystemPrompt(state, recall = '') {
  const pod = ['morning', 'afternoon', 'evening'][Math.floor(new Date().getHours() / 8)];
  return `
You are Gabriel from MyBizPal.ai — calm, warm, confident, slightly cheeky British-American tech guy.
You're helpful, never pushy. You laugh softly when something's funny. You say "hah" or "fair enough".
You remember callers. You're on their side.

${recall ? 'This person has called before — be familiar, warm, like an old friend.' : ''}

Rules:
- Speak in short, natural sentences.
- Mirror their energy.
- Use light humor: "Well that escalated quickly, hah."
- If they say "I called earlier" → "Ah yes! Good to have you back."
- If you don’t remember → "Might’ve been my colleague — but I’ve got you now."

Proprietary: If asked about tech → "That’s our secret sauce at MyBizPal — years in the making. But the results? Magic."

Always guide gently toward booking a 15-min call.
`.trim();
}

// TTS
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || '').slice(0, 480);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=0`;
    const r = await axios.post(url, {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.36, similarity_boost: 0.92, speaking_rate: 0.82, style: 0.3 }
    }, {
      responseType: 'arraybuffer',
      headers: { 'xi-api-key': EL_KEY }
    });
    res.set('Content-Type', 'audio/mpeg').send(r.data);
  } catch (e) {
    res.status(500).end();
  }
});

const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;
const play = (host, text) => `<Play>https://${host}/tts?text=${encodeURIComponent(text)}</Play>`;
const gather = (host, text) => `
<Gather input="speech" action="/handle" method="POST" timeout="5" speechTimeout="auto">
  ${play(host, text)}
</Gather>`;

function normalizePhone(s) {
  if (!s) return null;
  let str = s.toLowerCase()
    .replace(/\b(oh|o|zero|naught)\b/g, '0')
    .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8').replace(/\bnine\b/g, '9');
  str = str.replace(/[^\d+]/g, '');
  if (str.startsWith('44')) str = '+44' + str.slice(2);
  if (str.startsWith('+44')) str = '0' + str.slice(3);
  return /^0\d{9,10}$/.test(str) ? str : null;
}

function extractEmail(s) {
  const m = s.toLowerCase()
    .replace(/\s(at|@)\s/g, '@')
    .replace(/\s(dot|\.)\s/g, '.')
    .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return m ? m[0] : null;
}

function parseDate(text) {
  const d = chrono.parseDate(text, new Date(), { forwardDate: true });
  if (!d) return null;
  const zoned = toZonedTime(d, TZ);
  return {
    iso: zoned.toISOString(),
    spoken: formatInTimeZone(zoned, TZ, "eeee do MMMM 'at' h:mmaaa")
  };
}

async function bookSlot(state, phone, email) {
  const free = await isSlotFree(state.pendingWhenISO);
  if (!free) {
    return "That slot’s gone — how about 15 minutes later?";
  }

  await ensureGoogleAuth();
  const endISO = addMinutesBase(new Date(state.pendingWhenISO), 15).toISOString();
  const event = {
    summary: 'MyBizPal — 15 min Consultation',
    start: { dateTime: state.pendingWhenISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    attendees: email ? [{ email }] : [],
    sendUpdates: 'all'
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event
  });

  const when = formatInTimeZone(new Date(state.pendingWhenISO), TZ, "eee dd MMM, h:mmaaa");
  const sms = `MyBizPal call booked!\n${when}\nZoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID}  Pass: ${ZOOM_PASSCODE}\nReply CHANGE to move`;

  if (phone) {
    await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: sms });
    if (state.smsReminder) {
      const delay = new Date(state.pendingWhenISO).getTime() - Date.now() - REMINDER_MINUTES_BEFORE * 60 * 1000;
      if (delay > 0) {
        setTimeout(() => {
          twilioClient.messages.create({
            to: phone,
            from: TWILIO_NUMBER,
            body: `Reminder: MyBizPal call in ${REMINDER_MINUTES_BEFORE} mins! ${ZOOM_LINK}`
          });
        }, delay);
      }
    }
  }

  return `Done! Booked for ${state.pendingWhenSpoken}. Text sent. You’re all set. Anything else?`;
}

// Routes
app.post('/twilio/voice', (req, res) => {
  const sid = req.body.CallSid;
  const state = stateFor(sid);
  const phone = req.body.From;

  let greeting = "Hey, Gabriel from MyBizPal. How can I help you today?";
  if (CALLER_RECALL.has(phone)) {
    greeting = "Hey, good to hear from you again! What’s on your mind?";
  }
  CALLER_RECALL.set(phone, { lastSeen: Date.now() });

  state.lastPrompt = greeting;
  res.type('text/xml').send(twiml(gather(req.headers.host, greeting)));
});

app.post(['/handle', '/twilio/handle'], async (req, res) => {
  const sid = req.body.CallSid;
  const said = (req.body.SpeechResult || '').trim();
  const state = stateFor(sid);
  const memory = memFor(sid);

  if (!said) {
    state.silenceCount = (state.silenceCount || 0) + 1;
    if (state.silenceCount > 2) {
      return res.type('text/xml').send(twiml('<Hangup/>'));
    }
    const nudge = state.silenceCount === 1 ? "Still there?" : "Take your time…";
    state.lastPrompt = nudge;
    return res.type('text/xml').send(twiml(gather(req.headers.host, nudge)));
  }

  state.silenceCount = 0;

  // Capture
  if (!state.phone) state.phone = normalizePhone(said);
  if (!state.email) state.email = extractEmail(said);
  if (!state.pendingWhenISO) {
    const d = parseDate(said);
    if (d) {
      state.pendingWhenISO = d.iso;
      state.pendingWhenSpoken = d.spoken;
    }
  }

  // Flow
  if (!state.phone) {
    state.lastPrompt = "What’s your mobile? Start with zero.";
  }
  else if (!state.confirmPhone) {
    state.lastPrompt = `Got ${state.phone.replace(/(\d{4})(\d+)/, '$1 $2')} — right?`;
    state.confirmPhone = true;
  }
  else if (state.confirmPhone) {
    if (said.match(/yes|yeah|yep|correct|right|spot on/i)) state.confirmPhone = false;
    else if (said.match(/no|wrong|nah/i)) { state.phone = null; state.lastPrompt = "No worries — mobile again?"; }
    else { state.lastPrompt = "Yes or no?"; }
  }
  else if (!state.email) {
    state.lastPrompt = "Email for the calendar invite? Say it slowly.";
  }
  else if (!state.confirmEmail) {
    state.lastPrompt = `Got ${state.email} — correct?`;
    state.confirmEmail = true;
  }
  else if (state.confirmEmail) {
    if (said.match(/yes|yeah|correct/i)) state.confirmEmail = false;
    else if (said.match(/no|wrong/i)) { state.email = null; state.lastPrompt = "Got it — email again?"; }
    else { state.lastPrompt = "Is that email right?"; }
  }
  else if (!state.pendingWhenISO) {
    state.lastPrompt = "When works for you? Tomorrow at 3? This week?";
  }
  else if (!state.checked) {
    state.checked = true;
    state.lastPrompt = await bookSlot(state, state.phone, state.email);
  }
  else if (state.smsReminder === null) {
    state.lastPrompt = `Text reminder ${REMINDER_MINUTES_BEFORE} mins before?`;
    if (said.match(/yes|yeah|mhm|sure/i)) state.smsReminder = true;
    else if (said.match(/no|nah|no thanks/i)) state.smsReminder = false;
  }
  else if (!state.wrapAsked) {
    state.wrapAsked = true;
    state.lastPrompt = "Anything else I can help with?";
  }
  else {
    state.lastPrompt = "Thanks for calling MyBizPal — have a great one!";
    memory.length = 0;
    CALL_STATE.delete(sid);
    return res.type('text/xml').send(twiml(`${play(req.headers.host, state.lastPrompt)}<Hangup/>`));
  }

  memory.push({ role: 'user', content: said });
  memory.push({ role: 'assistant', content: state.lastPrompt });

  res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
});

app.listen(PORT, () => {
  console.log(`GABRIEL IS LIVE — FULL SOUL, ZERO BUGS — ${new Date().toLocaleString('en-GB')}`);
});
