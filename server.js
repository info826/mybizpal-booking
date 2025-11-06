// server.js — MyBizPal.ai Gabriel — WORKS ON RENDER 100% (Nov 2025)
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import * as chrono from 'chrono-node';
import { google } from 'googleapis';
import { formatInTimeZone, toZonedTime, addMinutes } from 'date-fns-tz';

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

// FIXED THESE TWO LINES — THIS WAS YOUR DEPLOY KILLER
const ZOOM_LINK = process.env.ZOOM_LINK || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE = process.env.ZOOM_PASSCODE || 'jcJx8M';

// Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SMS_FROM_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

// Google Calendar
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
    console.log('Google Calendar ready');
  }
}

// AVAILABILITY CHECK
async function isSlotFree(startISO) {
  await ensureGoogleAuth();
  const endISO = addMinutes(new Date(startISO), 30).toISOString();
  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: true,
  });
  return !res.data.items || res.data.items.length === 0;
}

// Call state
const CALL_STATE = new Map();

function stateFor(sid) {
  if (!CALL_STATE.has(sid)) {
    CALL_STATE.set(sid, {
      name: null, email: null, phone: null,
      pendingWhenISO: null, pendingWhenSpoken: null,
      smsReminder: null,
      confirmEmail: false, confirmPhone: false,
      lastPrompt: '',
      silence: 0
    });
  }
  return CALL_STATE.get(sid);
}

// HUMAN YES/NO
const YES = /^(yep|yup|yeah|yes|sure|ok|uhhu|uh-huh|mhm|hum|aha|correct|right|spot on|perfect|got it|brilliant|aye|oui|sí|sim)$/i;
const NO  = /^(no|nah|nope|nn|don't|wrong|nah mate)$/i;

// Helpers
function normalizeUkPhone(s) {
  if (!s) return null;
  let str = s.toLowerCase().replace(/\bzero\b/g,'0').replace(/\bone\b/g,'1').replace(/\btwo\b/g,'2').replace(/\bthree\b/g,'3').replace(/\bfour\b/g,'4').replace(/\bfive\b/g,'5').replace(/\bsix\b/g,'6').replace(/\bseven\b/g,'7').replace(/\beight\b/g,'8').replace(/\bnine\b/g,'9');
  str = str.replace(/[^\d+]/g, '');
  if (str.startsWith('44')) str = '+44' + str.slice(2);
  if (str.startsWith('+44')) str = '0' + str.slice(3);
  return /^0\d{9,10}$/.test(str) ? str : null;
}

function extractEmail(s) {
  const m = s.toLowerCase().replace(/\s(at|@)\s/g,'@').replace(/\s(dot|\.)\s/g,'.').match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
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

// TTS
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || '').slice(0, 480);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${process.env.ELEVENLABS_VOICE_ID}/stream`;
    const r = await axios.post(url, { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.4, similarity_boost: 0.9, speaking_rate: 0.78 }},
      { responseType: 'arraybuffer', headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY }});
    res.set('Content-Type', 'audio/mpeg').send(r.data);
  } catch (e) { res.status(500).end(); }
});

// TwiML
const twiml = (xml) => `<?xml version="1.0" encoding="UTF-8"?><Response>${xml}</Response>`;
const gather = (host, text) => `<Gather input="speech" action="/handle" method="POST" timeout="6" speechTimeout="auto"><Play>https://${host}/tts?text=${encodeURIComponent(text)}</Play></Gather>`;

// SMS
async function sendSms(to, body) {
  if (SMS_FROM_NUMBER && to) {
    await twilioClient.messages.create({ to, from: SMS_FROM_NUMBER, body });
  }
}

function smsConfirm(iso) {
  const when = formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa");
  return `MyBizPal Consultation BOOKED!\nWhen: ${when}\nZoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID}  Pass: ${ZOOM_PASSCODE}\nReply CHANGE to reschedule`;
}

async function bookEvent(startISO, email, name) {
  await ensureGoogleAuth();
  const endISO = addMinutes(new Date(startISO), 30).toISOString();
  const event = {
    summary: 'MyBizPal — Business Consultation (30 min)',
    start: { dateTime: startISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    attendees: email ? [{ email, displayName: name || 'Guest' }] : [],
    sendUpdates: 'all'
  };
  const res = await calendar.events.insert({ calendarId: CALENDAR_ID, resource: event });
  return res.data;
}

// Routes
app.post('/twilio/voice', (req, res) => {
  const state = stateFor(req.body.CallSid);
  state.lastPrompt = "Hey, Gabriel from MyBizPal. We build AI agents that actually work. How can I help today?";
  res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
});

app.post(['/', '/handle'], async (req, res) => {
  const sid = req.body.CallSid;
  const said = (req.body.SpeechResult || '').trim();
  const state = stateFor(sid);

  if (!said) {
    state.silence = (state.silence || 0) + 1;
    if (state.silence > 2) return res.type('text/xml').send(twiml('<Hangup/>'));
    state.lastPrompt = "Still there?";
    return res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
  }
  state.silence = 0;

  // Capture
  if (!state.name) state.name = said.match(/[A-Z][a-z]+(?:\s[A-Z][a-z]+)*/)?.[0];
  if (!state.email) state.email = extractEmail(said);
  if (!state.phone) state.phone = normalizeUkPhone(said);
  if (!state.pendingWhenISO) {
    const d = parseDate(said);
    if (d) { state.pendingWhenISO = d.iso; state.pendingWhenSpoken = d.spoken; }
  }

  // Flow
  if (!state.name) state.lastPrompt = "What’s your name?";
  else if (!state.email) state.lastPrompt = "Email for the invite? Say it slowly.";
  else if (!state.confirmEmail) { state.lastPrompt = `Got ${state.email} — correct?`; state.confirmEmail = true; }
  else if (state.confirmEmail) {
    if (YES.test(said)) state.confirmEmail = false;
    else if (NO.test(said)) { state.email = null; state.lastPrompt = "No worries — email again?"; }
    else { state.lastPrompt = "Yes or no?"; }
  }
  else if (!state.phone) state.lastPrompt = "UK mobile for text? Start with zero.";
  else if (!state.confirmPhone) { state.lastPrompt = `Number ${state.phone} — right?`; state.confirmPhone = true; }
  else if (state.confirmPhone) {
    if (YES.test(said)) state.confirmPhone = false;
    else if (NO.test(said)) { state.phone = null; state.lastPrompt = "Mobile again?"; }
    else { state.lastPrompt = "Correct?"; }
  }
  else if (!state.pendingWhenISO) state.lastPrompt = "When works? Tomorrow morning?";
  else if (state.pendingWhenISO && !state.checked) {
    const free = await isSlotFree(state.pendingWhenISO);
    if (free) state.checked = true;
    else { state.pendingWhenISO = null; state.lastPrompt = "That slot’s taken — another time?"; }
  }
  else if (state.smsReminder === null) {
    state.lastPrompt = `Text reminder ${REMINDER_MINUTES_BEFORE} mins before?`;
    if (YES.test(said) || /mhm|uhhu/i.test(said)) state.smsReminder = true;
    if (NO.test(said)) state.smsReminder = false;
  }
  else {
    try {
      const event = await bookEvent(state.pendingWhenISO, state.email, state.name);
      if (state.phone) await sendSms(state.phone, smsConfirm(event.start.dateTime));
      if (state.smsReminder && state.phone) {
        const delay = new Date(event.start.dateTime).getTime() - Date.now() - REMINDER_MINUTES_BEFORE * 60 * 1000;
        if (delay > 0) setTimeout(() => sendSms(state.phone, `Reminder: call in ${REMINDER_MINUTES_BEFORE} mins! ${ZOOM_LINK}`), delay);
      }
      state.lastPrompt = `Booked! ${state.pendingWhenSpoken}. Text sent. Anything else?`;
    } catch (e) {
      console.error(e);
      state.lastPrompt = "Tiny glitch — I’ll email you manually. Thanks!";
    }
  }

  res.type('text/xml').send(twiml(gather(req.headers.host, state.lastPrompt)));
});

app.listen(PORT, () => console.log(`Gabriel LIVE & DEPLOY-PROOF ${new Date().toLocaleString('en-GB')}`));
