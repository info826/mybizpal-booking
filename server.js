// server.js — MyBizPal.ai "Gabriel" — FULLY HUMAN + AVAILABILITY CHECK + BOOKING + SMS
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { google } from 'googleapis';
import { formatInTimeZone, toZonedTime, addMinutes } from 'date-fns-tz';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;
const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);
const ZOOM_LINK = process.env.ZOOM_LINK || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE || 'jcJx8M';

// Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SMS_FROM_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

// OpenAI
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// GOOGLE CALENDAR — BULLETPROOF
let googleReady = false;
const googleAuth = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n').replace(/"/g, '').trim(),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: googleAuth });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';

async function ensureGoogleAuth() {
  if (!googleReady) {
    await googleAuth.authorize();
    googleReady = true;
    console.log('Google Calendar CONNECTED');
  }
}

// CALL STATE
const CALL_STATE = new Map();
function stateFor(sid) {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    name: null, email: null, phone: null,
    pendingWhenISO: null, pendingWhenSpoken: null,
    smsReminder: null,
    pendingConfirmEmail: false,
    pendingConfirmPhone: false,
    smsConfirmSent: false,
    lastPrompt: '',
    silenceNudges: 0
  });
  return CALL_STATE.get(sid);
}

// HUMAN YES/NO — EVERY GRUNT COVERED
const YES = /^(yep|yup|yeah|yes|sure|okay|ok|uhhu|uh-huh|uh huh|aha|ah'a|ahaa|mhm|mmhm|mm-hmm|hum|go ahead|please|definitely|absolutely|totally|of course|correct|right|spot on|that's it|exactly|perfect|got it|brilliant|lovely|cheers|aye|oui|sí|sim)$/i;
const NO  = /^(no|nah|nope|nn|nup|nahh|don't|dont|no thanks|nah thanks|negative|pass|skip|wrong|nah mate|no way|not really)$/i;

// HELPERS
function normalizeUkPhone(s) {
  if (!s) return null;
  let str = s.toLowerCase();
  const words = { zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9 };
  Object.keys(words).forEach(w => str = str.replace(new RegExp('\\b'+w+'\\b','g'), words[w]));
  str = str.replace(/[^\d+]/g, '');
  if (str.startsWith('44') && !str.startsWith('+')) str = '+' + str;
  if (str.startsWith('+44')) str = '0' + str.slice(3);
  if (!str.startsWith('0') && str.length === 10) str = '0' + str;
  return /^0\d{9,10}$/.test(str) ? str : null;
}

function extractEmail(s) {
  const m = s.toLowerCase()
    .replace(/\s(at|@)\s/g, '@')
    .replace(/\s(dot|\.)\s/g, '.')
    .match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

function parseNaturalDate(text) {
  const d = chrono.parseDate(text, new Date(), { forwardDate: true });
  if (!d) return null;
  const zoned = toZonedTime(d, TZ);
  return {
    iso: zoned.toISOString(),
    spoken: formatInTimeZone(zoned, TZ, "eeee do MMMM 'at' h:mmaaa")
  };
}

// AVAILABILITY CHECK — THE NEW STAR
async function isSlotFree(startISO) {
  await ensureGoogleAuth();
  const endISO = addMinutes(new Date(startISO), 30).toISOString();

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
    orderBy: 'startTime'
  });

  const events = res.data.items || [];
  return events.length === 0;
}

// TTS
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || '').slice(0, 480);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`;
    const r = await axios.post(url, {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.4, similarity_boost: 0.9, speaking_rate: 0.78 }
    }, {
      responseType: 'arraybuffer',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }
    });
    res.set('Content-Type', 'audio/mpeg').send(r.data);
  } catch (e) { res.status(500).end(); }
});

// TwiML
const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;
const gather = (host, text) => `
<Gather input="speech" action="/twilio/handle" method="POST" timeout="6" speechTimeout="auto">
  <Play>https://${host}/tts?text=${encodeURIComponent(text)}</Play>
</Gather>`;

// SMS
async function sendSms(to, body) {
  if (!SMS_FROM_NUMBER || !to) return;
  await twilioClient.messages.create({ to, from: SMS_FROM_NUMBER, body });
}

function smsConfirm(iso) {
  const when = formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa (zzzz)");
  return `MyBizPal Consultation BOOKED\nWhen: ${when}\nZoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID}  Pass: ${ZOOM_PASSCODE}\nReply CHANGE to reschedule`;
}

// BOOK EVENT
async function bookEvent({ startISO, email, name }) {
  await ensureGoogleAuth();
  const endISO = addMinutes(new Date(startISO), 30).toISOString();
  const event = {
    summary: 'MyBizPal — Business Consultation (30 min)',
    start: { dateTime: startISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    description: 'Booked by Gabriel (MyBizPal AI)',
    attendees: email ? [{ email, displayName: name || 'Guest' }] : [],
    sendUpdates: 'all'
  };
  const res = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    resource: event
  });
  return res.data;
}

// ROUTES
app.post('/twilio/voice', (req, res) => {
  const sid = req.body.CallSid;
  const state = stateFor(sid);
  state.lastPrompt = "Hey, Gabriel from MyBizPal. We build AI agents that actually work. How can I help today?";
  res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
});

app.post('/twilio/handle', async (req, res) => {
  const sid = req.body.CallSid;
  const said = (req.body.SpeechResult || '').trim();
  const state = stateFor(sid);

  if (!said) {
    state.silenceNudges = (state.silenceNudges || 0) + 1;
    if (state.silenceNudges > 2) return res.type('text/xml').send(twiml('<Hangup/>'));
    state.lastPrompt = state.silenceNudges === 1 ? "Still there?" : "Take your time…";
    return res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
  }
  state.silenceNudges = 0;

  // Capture
  if (!state.name && /[A-Z][a-z]+/.test(said)) state.name = said.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/)?.[0];
  if (!state.email) state.email = extractEmail(said);
  if (!state.phone) state.phone = normalizeUkPhone(said);
  if (!state.pendingWhenISO) {
    const d = parseNaturalDate(said);
    if (d) { state.pendingWhenISO = d.iso; state.pendingWhenSpoken = d.spoken; }
  }

  // FLOW
  if (!state.name) {
    state.lastPrompt = "Great — what’s your name?";
  }
  else if (!state.email) {
    state.lastPrompt = "Email for the Zoom invite? Say it slowly.";
  }
  else if (state.email && !state.pendingConfirmEmail) {
    state.lastPrompt = `Got ${state.email} — correct?`;
    state.pendingConfirmEmail = true;
  }
  else if (state.pendingConfirmEmail) {
    if (YES.test(said)) state.pendingConfirmEmail = false;
    else if (NO.test(said)) { state.email = null; state.lastPrompt = "No worries — email again?"; }
    else { state.lastPrompt = "Is that email right?"; }
  }
  else if (!state.phone) {
    state.lastPrompt = "UK mobile for text confirmation? Start with zero.";
  }
  else if (state.phone && !state.pendingConfirmPhone) {
    state.lastPrompt = `Your number ${state.phone.replace(/(\d{4})(\d+)/, '$1 $2')} — right?`;
    state.pendingConfirmPhone = true;
  }
  else if (state.pendingConfirmPhone) {
    if (YES.test(said)) state.pendingConfirmPhone = false;
    else if (NO.test(said)) { state.phone = null; state.lastPrompt = "Got it — mobile again?"; }
    else { state.lastPrompt = "Is that number correct?"; }
  }
  else if (!state.pendingWhenISO) {
    state.lastPrompt = "When works? Tomorrow morning? This week?";
  }
  else if (state.smsReminder === null) {
    state.lastPrompt = `Want a text reminder ${REMINDER_MINUTES_BEFORE} minutes before?`;
    if (YES.test(said)) state.smsReminder = true;
    else if (NO.test(said)) state.smsReminder = false;
    else if (/mhm|uhhu|hum|aha/i.test(said)) state.smsReminder = true;
  }
  else {
    // CHECK AVAILABILITY FIRST
    const free = await isSlotFree(state.pendingWhenISO);
    if (!free) {
      state.pendingWhenISO = null;
      state.pendingWhenSpoken = null;
      state.lastPrompt = "That slot just got taken — sorry! When else works?";
    } else {
      // BOOK IT
      try {
        const event = await bookEvent({
          startISO: state.pendingWhenISO,
          email: state.email,
          name: state.name
        });

        if (state.phone) {
          await sendSms(state.phone, smsConfirm(event.start.dateTime));
          state.smsConfirmSent = true;
        }

        if (state.smsReminder && state.phone) {
          const delay = new Date(event.start.dateTime).getTime() - Date.now() - REMINDER_MINUTES_BEFORE * 60 * 1000;
          if (delay > 0) {
            setTimeout(() => {
              sendSms(state.phone, `Reminder: MyBizPal call in ${REMINDER_MINUTES_BEFORE} mins!\n${ZOOM_LINK}`);
            }, delay);
          }
        }

        state.lastPrompt = `Booked! ${state.pendingWhenSpoken}. Text sent. Anything else?`;
      } catch (e) {
        console.error('BOOKING ERROR:', e.message);
        state.lastPrompt = "Tiny glitch — I’ll email you manually. Thanks!";
      }
    }
  }

  res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
});

app.listen(PORT, () => console.log(`Gabriel LIVE — with REAL-TIME AVAILABILITY CHECK`));
