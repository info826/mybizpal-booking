// server.js — MyBizPal v2.1: early name + end-intent goodbye + ICS link + faster TTS + safer email parse
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import crypto from 'crypto';

import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

import twilio from 'twilio';
import { google } from 'googleapis';

/* ================================
   APP
================================ */
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// Attendee invites stay OFF unless you enable DWD + set the env
const CALENDAR_ALLOW_ATTENDEE_INVITES =
  String(process.env.CALENDAR_ALLOW_ATTENDEE_INVITES || 'false').toLowerCase() === 'true';

/* ================================
   TWILIO (SMS)
================================ */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM; // +447...

/* ================================
   OPENAI
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ================================
   ELEVENLABS (TTS) — a touch faster & livelier
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
   ZOOM
================================ */
const ZOOM_LINK       = process.env.ZOOM_LINK
  || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1&omn=88292946669';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE   = process.env.ZOOM_PASSCODE   || 'jcJx8M';

/* ================================
   Formatting
================================ */
function formatDateForSms(iso) {
  return formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
}
function formatSpokenDateTime(iso) {
  const d = new Date(iso);
  const day  = formatInTimeZone(d, TZ, 'eeee');
  const date = formatInTimeZone(d, TZ, 'd');
  const month= formatInTimeZone(d, TZ, 'LLLL');
  const mins = formatInTimeZone(d, TZ, 'mm');
  const hour = formatInTimeZone(d, TZ, 'h');
  const mer  = formatInTimeZone(d, TZ, 'a').toLowerCase();
  const time = mins === '00' ? `${hour} ${mer}` : `${hour}:${mins} ${mer}`;
  return `${day} ${date} ${month} at ${time}`;
}
function timeOfDay() {
  const h = Number(formatInTimeZone(new Date(), TZ, 'H'));
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/* Dynamic closings */
const CLOSERS = {
  morning: [
    "Have a great morning!",
    "Wishing you a smooth morning ahead.",
    "Enjoy the rest of your morning!"
  ],
  afternoon: [
    "Have a great afternoon!",
    "Enjoy the rest of your afternoon.",
    "Hope your afternoon goes brilliantly."
  ],
  evening: [
    "Have a great evening!",
    "Enjoy the rest of your evening.",
    "Wishing you a relaxing evening."
  ]
};
function randomCloser() {
  const tod = timeOfDay();
  const list = CLOSERS[tod] || CLOSERS.afternoon;
  return list[Math.floor(Math.random() * list.length)];
}

/* ================================
   End intent + finishing helper
================================ */
function endIntent(text = '') {
  const t = text.toLowerCase().trim();
  return (
    /\b(no|nope|nah|i'?m good|im good|all good|we('re| are) good|that('?s)? (all|it)|that('?ll)? do|nothing else|no thanks?|no thank you|i('m| am) done|done for now)\b/.test(t) ||
    /\b(we'?re done|we are done|that will be all|bye|goodbye)\b/.test(t)
  );
}
function friendlyGoodbye() {
  return `${randomCloser()} Thanks for calling MyBizPal.`;
}

/* ================================
   SMS builders
================================ */
function buildConfirmationSms({ startISO, name }) {
  const when = formatDateForSms(startISO);
  const who  = name ? `(${name}) ` : '';
  return [
    `✅ ${who}MyBizPal — Business Consultation (15–30 min)`,
    `Date: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID}  Passcode: ${ZOOM_PASSCODE}`,
    'Reply CHANGE to reschedule.'
  ].join('\n');
}
function buildReminderSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    '⏰ Reminder: your MyBizPal consultation',
    `Starts: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
  ].join('\n');
}
function buildCancellationSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    '❌ Your previous MyBizPal consultation has been cancelled',
    `Was: ${when}`,
    'We’ll send a new confirmation with the updated time.'
  ].join('\n');
}

/* ================================
   Persona
================================ */
function buildSystemPreamble(state) {
  const niceNow = formatInTimeZone(new Date(), TZ, "eeee dd MMMM yyyy, h:mmaaa");
  return `
You are Gabriel — calm, friendly, confident consultant for MyBizPal.ai.
Sound human: natural pace, warm energy, light humour, brief pauses. Add tiny affirmations like “got it,” “perfect,” “no worries.”
Use the caller’s first name once you know it (sparingly, naturally).
Short spoken sentences. Slow read-backs for numbers/emails.
Do NOT suggest third-party tools. Qualify lightly and steer to a Zoom with our team.
Timezone: ${TZ}. Now: ${niceNow}. Language: ${state.lang || 'en'}.

Close with a time-appropriate, friendly sign-off (randomized). No re-greeting loops.
Our code is proprietary — say that if asked about internal details.
`;}
/* ================================
   TWIML helpers
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
function silentGather({ action = '/twilio/handle' }) {
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        actionOnEmptyResult="true"
        action="${action}"
        method="POST"
        timeout="8"
        speechTimeout="auto">
</Gather>`;
}
function playOnly({ host, text }) {
  const enc    = encodeURIComponent((text || '').trim());
  const ttsUrl = `https://${host}/tts?text=${enc}`;
  return `<Play>${ttsUrl}</Play>`;
}

/* ================================
   TTS — faster & friendlier
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 480);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=1`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.28,
        similarity_boost: 0.94,
        speaking_rate: 1.02,  // slightly faster
        style: 0.4,
        use_speaker_boost: true
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
   State
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> state
const ICS_STORE   = new Map();  // id -> { filename, content, createdAt }

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    silenceStartAt: null,
    nudgeCount: 0, lastNudgeAt: null, agentWaitUntil: 0,
    takeYourTimeSaid: false, wrapPrompted: false,

    lang: 'en', lastPrompt: '',

    // Contact + identity
    name: null, pendingName: false, confirmingName: false,
    phone_nat: null, phone_e164: null, phone: null,
    pendingPhone: false, confirmingPhone: false,
    email: null, pendingEmail: false, confirmingEmail: false, askingToSpellEmail: false,

    // Booking time
    pendingBookingISO: null, pendingBookingSpoken: null, awaitingTimeConfirm: false,

    // SMS status
    smsConfirmSent: false, awaitingSmsReceipt: false
  });
  return CALL_STATE.get(sid);
};

/* ================================
   Helpers — name, phone, email, dates
================================ */
function extractName(text) {
  const t = (text || '').trim();
  // Ignore common greetings as names
  const bad = /^(hi|hello|hey|thanks|thank you|okay|ok|good (morning|afternoon|evening))$/i;
  if (bad.test(t)) return null;

  // “I’m X”, “This is X”, “My name is X”
  let m = t.match(/\b(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z '-]{1,30})\b/i);
  if (m) {
    const first = m[1].trim().split(/\s+/)[0];
    if (!bad.test(first)) return first;
  }
  // Fallback: single token that looks like a first name, avoiding “hi/hello…”
  m = t.match(/\b([A-Za-z][A-Za-z'-]{1,30})\b/);
  if (m && !bad.test(m[1])) return m[1];
  return null;
}

function parseUkPhone(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(uh|uhh|uhm|um|umm|erm)\b/g, '');
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0');
  s = s.replace(/\bone\b/g, '1').replace(/\btwo\b/g,'2').replace(/\bthree\b/g,'3')
       .replace(/\bfour\b/g,'4').replace(/\bfive\b/g,'5').replace(/\bsix\b/g,'6')
       .replace(/\bseven\b/g,'7').replace(/\beight\b/g,'8').replace(/\bnine\b/g,'9');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) {
    const rest = s.slice(3);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('44')) {
    const rest = s.slice(2);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('0') && /^\d{11}$/.test(s)) {
    return { e164: `+44${s.slice(1)}`, national: s };
  } else if (/^\d{10}$/.test(s)) {
    return { e164: `+44${s}`, national: `0${s}` };
  }
  return null;
}
function isLikelyUkNumberPair(p) {
  return !!(p && /^0\d{10}$/.test(p.national) && /^\+44\d{10}$/.test(p.e164));
}
function slowPhoneSpeak(nat07) { return nat07 ? nat07.split('').join(', ') : ''; }

function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\bat(-|\s)?sign\b/g, '@').replace(/\bat symbol\b/g, '@')
       .replace(/\barroba\b/g, '@').replace(/\bat\b/g, '@');
  s = s.replace(/\bdot\b/g, '.').replace(/\bpunto\b/g, '.')
       .replace(/\bponto\b/g, '.').replace(/\bpoint\b/g, '.');
  // normalize common ASR variants for gmail
  s = s.replace(/\bg mail\b/g, 'gmail').replace(/\bg\-?mail\b/g, 'gmail');
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, ' ').trim();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
function userAskedToWait(text) {
  const t = (text || '').toLowerCase();
  return /(one (sec|second|moment)|just a sec|give me a (sec|second)|wait|hold on|let me check)/i.test(t);
}
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;
  const zoned  = toZonedTime(parsed, tz);
  const iso    = fromZonedTime(zoned, tz).toISOString();
  const spoken = formatSpokenDateTime(iso);
  return { iso, spoken };
}

/* YES/NO */
function yesInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(yes|yeah|yep|sure|ok|okay|si|sí|sim|oui)\b/.test(t)
      || /^(mm+|mhm+|uh-?huh|uhu|ah['’]?a|uhhu)$/i.test(t);
}
function noInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(no|nope|nah|pas maintenant|não|nao)\b/.test(t) || /^(nn)$/i.test(t);
}

/* ================================
   ICS helpers
================================ */
function buildICS({ startISO, endISO, summary, description, location = 'Zoom', uid }) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const fmt = (iso) => iso.replace(/[-:]/g, '').split('.')[0] + 'Z';

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//MyBizPal.ai//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${fmt(startISO)}`,
    `DTEND:${fmt(endISO)}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${(description || '').replace(/\n/g, '\\n')}`,
    `LOCATION:${location}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}

/* ================================
   Calendar helpers: find/cancel prev booking; conflict; insert
================================ */
async function hasConflict({ startISO, durationMin = 30 }) {
  await ensureGoogleAuth();
  const start = new Date(startISO).toISOString();
  const end   = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();

  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start,
    timeMax: end,
    maxResults: 1,
    singleEvents: true,
    orderBy: 'startTime'
  });
  return (r.data.items || []).length > 0;
}

async function findExistingBooking({ phone, email }) {
  await ensureGoogleAuth();
  const nowISO = new Date().toISOString();
  const untilISO = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(); // next 60 days
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: nowISO,
    timeMax: untilISO,
    singleEvents: true,
    maxResults: 50,
    orderBy: 'startTime'
  });
  const items = r.data.items || [];
  return items.find(ev => {
    const desc = (ev.description || '').toLowerCase();
    const sum  = (ev.summary || '').toLowerCase();
    const tag  = 'booked by mybizpal (gabriel)';
    const hasTag = desc.includes(tag);
    const hasContact = (phone && desc.includes(phone.replace('+', ''))) || (email && desc.includes((email||'').toLowerCase()));
    const isOurMeeting = sum.includes('mybizpal');
    return hasTag && isOurMeeting && hasContact;
  }) || null;
}

async function cancelEventById(id) {
  await ensureGoogleAuth();
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
}

async function insertEvent({ startISO, durationMin = 30, email, name, phone }) {
  await ensureGoogleAuth();
  const endISO = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();
  const who  = name ? `(${name}) ` : '';
  const wantAttendee = CALENDAR_ALLOW_ATTENDEE_INVITES && !!email;

  const eventBody = {
    summary: `${who}MyBizPal — Business Consultation (15–30 min)`,
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description:
`Booked by MyBizPal (Gabriel).
Caller name: ${name || 'Prospect'}
Caller phone: ${phone || 'n/a'}
Caller email: ${email || 'n/a'}`
  };
  if (wantAttendee && email) eventBody.attendees = [{ email }];

  let created;
  try {
    created = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: eventBody,
      sendUpdates: wantAttendee ? 'all' : 'none'
    });
  } catch (e) {
    const msg = String(e?.message || '');
    const isDwdError =
      msg.includes('Service accounts cannot invite attendees') ||
      msg.includes('Forbidden') || e?.code === 403;
    if (wantAttendee && isDwdError) {
      console.warn('⚠️ Attendee invite blocked — retrying without attendees…');
      delete eventBody.attendees;
      created = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: eventBody,
        sendUpdates: 'none'
      });
    } else {
      throw e;
    }
  }

  // Build an ICS and store it for SMS download link
  const uid = crypto.randomUUID() + '@mybizpal.ai';
  const ics = buildICS({
    startISO,
    endISO,
    summary: eventBody.summary,
    description: eventBody.description + `\\nZoom: ${ZOOM_LINK}\\nID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`,
    location: 'Zoom',
    uid
  });
  const icsId = crypto.randomUUID();
  ICS_STORE.set(icsId, { filename: 'MyBizPal-Consultation.ics', content: ics, createdAt: Date.now() });

  return { event: created.data, icsLink: `/ics/${icsId}` };
}

/* ================================
   LLM (for small talk/qualifying, not tools)
================================ */
async function llm({ history, latestText, state }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state) });
  for (const h of history.slice(-14)) if (h.role !== 'system') messages.push(h);
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.45,
    max_tokens: 130,
    messages
  });
  return resp.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ================================
   Booking continuation: cancel old, book new, SMS flows
================================ */
async function continueBookingIfReady({ req, res, state }) {
  if (state.pendingBookingISO && state.phone && state.email) {
    try {
      // If user already has a booked slot with us, cancel it and notify
      const existing = await findExistingBooking({ phone: state.phone, email: state.email });
      const to = state.phone || state.phone_e164 || req.body.From || null;

      if (existing) {
        try {
          await cancelEventById(existing.id);
          if (to && TWILIO_NUMBER && to !== TWILIO_NUMBER) {
            await twilioClient.messages.create({
              to, from: TWILIO_NUMBER, body: buildCancellationSms({ startISO: existing.start.dateTime })
            });
          }
        } catch (ce) {
          console.warn('Cancel previous failed:', ce?.message || ce);
        }
      }

      // Avoid overlap
      const conflict = await hasConflict({ startISO: state.pendingBookingISO, durationMin: 30 });
      if (conflict) {
        const msg = 'That time just got taken. Want me to check the next closest slot?';
        state.lastPrompt = msg;
        res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: msg })));
        return true;
      }

      // Create event
      const { event, icsLink } = await insertEvent({
        startISO: state.pendingBookingISO,
        durationMin: 30,
        email: state.email,
        name: state.name,
        phone: (state.phone || '').replace('+', '')
      });

      // Confirmation SMS (+ ICS add-to-calendar link)
      if (to && TWILIO_NUMBER && to !== TWILIO_NUMBER) {
        const body = buildConfirmationSms({ startISO: event.start.dateTime, name: state.name })
                   + `\nAdd to your calendar: https://${req.headers.host}${icsLink}`;
        await twilioClient.messages.create({ to, from: TWILIO_NUMBER, body });
        state.smsConfirmSent = true;
        state.awaitingSmsReceipt = true;
      }

      // Auto reminders: 24h & 60m
      const startMs = new Date(event.start.dateTime).getTime();
      const nowMs   = Date.now();
      for (const fireAt of [ startMs - 24*60*60*1000, startMs - 60*60*1000 ]) {
        const delay = fireAt - nowMs;
        if (to && TWILIO_NUMBER && delay > 0 && delay < 7*24*60*60*1000) {
          setTimeout(async () => {
            try {
              await twilioClient.messages.create({
                to, from: TWILIO_NUMBER, body: buildReminderSms({ startISO: event.start.dateTime })
              });
            } catch (e) { console.error('Reminder SMS error:', e?.message || e); }
          }, delay);
        }
      }

      // clear pending time
      state.pendingBookingISO = null;
      state.pendingBookingSpoken = null;

      const askReceipt = 'I’ve sent your text confirmation—did you receive it?';
      state.lastPrompt = askReceipt;
      res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: askReceipt })));
      return true;
    } catch (e) {
      console.error('Booking failed:', e?.message || e);
      const fail = 'Hmm — I couldn’t finalize that just now. I’ll note your details and follow up.';
      state.lastPrompt = fail;
      res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: fail })));
      return true;
    }
  }
  return false;
}

/* ================================
   ENTRY
================================ */
app.post('/twilio/voice', (req, res) => {
  const sid = req.body.CallSid || '';
  const memory = memFor(sid); memory.length = 0;
  const state = stateFor(sid);

  state.silenceStartAt = null; state.nudgeCount = 0; state.lastNudgeAt = null;
  state.takeYourTimeSaid = false;

  memory.push({ role: 'system', content: buildSystemPreamble(state) });

  // Ask name early so we can use it everywhere
  const greet = `Good ${timeOfDay()}, you’re speaking with Gabriel from MyBizPal. What’s your first name?`;
  state.pendingName = true;
  state.lastPrompt = greet;
  res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: greet })));
});

/* ================================
   PARTIAL (debug)
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
    const saidRaw = (req.body.SpeechResult || '');
    const said    = saidRaw.trim();
    const sid     = req.body.CallSid || 'unknown';
    const memory  = memFor(sid);
    const state   = stateFor(sid);
    const now     = Date.now();

    // Silence handling (no re-greeting loops)
    if (!said) {
      if (state.silenceStartAt == null) state.silenceStartAt = now;
      if (state.agentWaitUntil && now < state.agentWaitUntil) {
        return res.type('text/xml').send(twiml(silentGather({})));
      }
      const ms = now - state.silenceStartAt;
      if (ms < 30000) return res.type('text/xml').send(twiml(silentGather({})));

      if (state.nudgeCount === 0) {
        state.nudgeCount = 1; state.lastNudgeAt = now;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: 'Are you still there?' })));
      }
      if (state.nudgeCount === 1 && (now - state.lastNudgeAt) >= 7000) {
        state.nudgeCount = 2; state.lastNudgeAt = now;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: 'Are you still there?' })));
      }
      if (state.nudgeCount >= 2 && (now - state.lastNudgeAt) >= 7000) {
        const bye = friendlyGoodbye();
        return res.type('text/xml').send(twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`));
      }
      return res.type('text/xml').send(twiml(silentGather({})));
    } else {
      state.silenceStartAt = null; state.nudgeCount = 0; state.lastNudgeAt = null;
      state.takeYourTimeSaid = false;
    }

    // Wait request
    if (userAskedToWait(said)) {
      if (!state.takeYourTimeSaid) {
        state.takeYourTimeSaid = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: 'No rush — take your time.' })));
      }
      return res.type('text/xml').send(twiml(silentGather({})));
    }

    // Opportunistic captures (but avoid capturing “Hi” as a name)
    if (!state.name) {
      const n = extractName(said);
      if (n && /^[A-Za-z][A-Za-z '-]{1,30}$/.test(n)) state.name = n;
    }
    if (!state.phone) {
      const pair = parseUkPhone(said);
      if (isLikelyUkNumberPair(pair)) {
        state.phone_e164 = pair.e164;
        state.phone_nat  = pair.national;
        state.phone      = pair.e164;
        state.pendingPhone = false; state.confirmingPhone = false;
        console.log('[FLOW] phone set:', state.phone, '(nat:', state.phone_nat, ')');
      }
    }
    if (!state.email) {
      const e = extractEmail(said);
      if (e) {
        state.email = e; state.pendingEmail = false; state.confirmingEmail = false;
        console.log('[FLOW] email set:', state.email);
      }
    }

    // Natural date
    const nat = parseNaturalDate(said, TZ);
    if (nat && !state.pendingBookingISO && !state.awaitingTimeConfirm) {
      state.pendingBookingISO    = nat.iso;
      state.pendingBookingSpoken = nat.spoken;
      state.awaitingTimeConfirm  = true;
      const ask = `Great — shall I book ${nat.spoken}?`;
      state.lastPrompt = ask;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
    }
    if (state.awaitingTimeConfirm) {
      if (yesInAnyLang(said)) {
        state.awaitingTimeConfirm = false;
      } else if (noInAnyLang(said)) {
        state.awaitingTimeConfirm = false;
        state.pendingBookingISO = null; state.pendingBookingSpoken = null;
        const ask = 'No problem — what time works better?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    // Ask name early if we still don't have it and not in the middle of time picking
    if (!state.name && !state.pendingName && !state.awaitingTimeConfirm && !state.pendingBookingISO) {
      state.pendingName = true;
      const ask = 'What’s your first name?';
      state.lastPrompt = ask;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
    }

    // If we have a time, gather: name → phone → email → book
    if (state.pendingBookingISO) {
      if (!state.name) {
        state.pendingName = true;
        const ask = 'What’s your first name?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      if (!state.phone) {
        state.pendingPhone = true;
        const ask = 'What’s the best mobile number for the confirmation text?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      if (!state.email) {
        state.pendingEmail = true;
        state.askingToSpellEmail = false;
        const ask = 'What email should I send the calendar invite to?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      // once email captured, ask to spell clearly one time
      if (!state.askingToSpellEmail && state.email) {
        state.askingToSpellEmail = true;
        const ask = 'Could you spell that email clearly to make sure I’ve got it right?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      console.log('[FLOW] continueBookingIfReady? time:', state.pendingBookingISO, 'phone:', state.phone, 'email:', state.email, 'name:', state.name);
      const handled = await continueBookingIfReady({ req, res, state });
      if (handled) return;
    }

    // Handle pending captures
    if (state.pendingName) {
      const n = extractName(said);
      if (n && /^[A-Za-z][A-Za-z '-]{1,30}$/.test(n)) {
        state.name = n; state.pendingName = false;
        const rb = `Thanks, ${n}.`;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
      } else {
        const ask = 'Sorry — what’s your first name?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    if (state.pendingPhone) {
      const pair = parseUkPhone(said);
      if (isLikelyUkNumberPair(pair)) {
        state.phone_e164 = pair.e164;
        state.phone_nat  = pair.national;
        state.phone      = pair.e164;
        state.pendingPhone = false;
        const rb = `Let me read that back: ${slowPhoneSpeak(state.phone_nat)}. Is that correct?`;
        state.confirmingPhone = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
      } else {
        const ask = 'I didn’t catch that — could you say the full mobile number again?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }
    if (state.confirmingPhone) {
      if (yesInAnyLang(said)) {
        state.confirmingPhone = false;
      } else if (noInAnyLang(said)) {
        state.phone_e164 = null; state.phone_nat = null; state.phone = null;
        state.confirmingPhone = false; state.pendingPhone = true;
        const ask = 'Okay — what’s the correct mobile number?';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    if (state.pendingEmail) {
      const e = extractEmail(said);
      if (e) {
        state.email = e; state.pendingEmail = false;
        const rb = `Perfect — here’s how I heard it: ${e}. We’ll double-check the spelling next.`;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
      } else {
        const ask = "Could you share the email address?";
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    if (state.askingToSpellEmail && !state.confirmingEmail) {
      const spelled = extractEmail(said) || state.email;
      state.email = spelled;
      const rb = `Thanks — just to confirm: ${state.email}. Is that right?`;
      state.confirmingEmail = true;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
    }
    if (state.confirmingEmail) {
      if (yesInAnyLang(said)) {
        state.confirmingEmail = false;
      } else if (noInAnyLang(said)) {
        state.email = null; state.confirmingEmail = false; state.pendingEmail = true; state.askingToSpellEmail = false;
        const ask = 'No worries — what’s the correct email?';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    // Awaiting SMS receipt
    if (state.awaitingSmsReceipt) {
      if (yesInAnyLang(said)) {
        state.awaitingSmsReceipt = false;
        const wrap = 'Is there anything else I can help you with?';
        state.wrapPrompted = true;
        state.lastPrompt = wrap;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: wrap })));
      } else if (noInAnyLang(said)) {
        const to = state.phone || req.body.From;
        if (to && TWILIO_NUMBER && to !== TWILIO_NUMBER) {
          const body = `Re-sent: your MyBizPal confirmation.\nZoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`;
          await twilioClient.messages.create({ to, from: TWILIO_NUMBER, body });
        }
        const msg = 'Done — I’ve resent it. Anything else I can help with?';
        state.wrapPrompted = true;
        state.lastPrompt = msg;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: msg })));
      }
    }

    // If caller indicates we're done (especially after booking/SMS), end cleanly.
    if (endIntent(said) && (state.wrapPrompted || state.smsConfirmSent || !state.pendingBookingISO)) {
      const bye = friendlyGoodbye();
      return res.type('text/xml').send(twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`));
    }

    // Small talk / qualifying via LLM (kept human & brief)
    const reply = await llm({ history: memory, latestText: said, state });
    let final = reply;
    if (/(one moment|just a sec|give me a (sec|second)|let me check|hang on)/i.test(final)) {
      state.agentWaitUntil = Date.now() + 12000;
    }

    state.lastPrompt = final;
    res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: final })));

    memory.push({ role: 'user', content: said });
    memory.push({ role: 'assistant', content: final });

  } catch (err) {
    console.error('handle error', err);
    res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

/* ================================
   ICS route (download)
================================ */
app.get('/ics/:id', (req, res) => {
  const item = ICS_STORE.get(req.params.id);
  if (!item) return res.status(404).send('Not found');
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${item.filename}"`);
  res.send(item.content);
});

/* ================================
   REPROMPT
================================ */
app.post('/twilio/reprompt', (req, res) => {
  const state = stateFor(req.body.CallSid || 'unknown');
  const text  = state.lastPrompt || 'I didn’t catch that—how can I help?';
  const xml   = twiml(gatherWithPlay({ host: req.headers.host, text }));
  res.type('text/xml').send(xml);
});

/* ================================
   CLEANUP
================================ */
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) { CALL_MEMORY.delete(sid); CALL_STATE.delete(sid); }
  const bye = friendlyGoodbye();
  res.type('text/xml').send(twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`));
});

/* ================================
   DEBUG
================================ */
app.get('/debug/google', async (req, res) => {
  try {
    await ensureGoogleAuth();
    const startISO = new Date(Date.now() + 10 * 60000).toISOString();
    const { event } = await insertEvent({ startISO, durationMin: 15, email: null, name: 'Test', phone: '000' });
    res.json({ ok: true, id: event.id, calendarId: CALENDAR_ID });
  } catch (e) { res.json({ ok: false, error: e?.message || e }); }
});
app.get('/debug/sms', async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.json({ ok: false, error: 'Missing to' });
    if (!TWILIO_NUMBER) return res.json({ ok: false, error: 'No TWILIO_NUMBER' });
    if (to === TWILIO_NUMBER) return res.json({ ok: false, error: "'To' and 'From' cannot be the same" });
    await twilioClient.messages.create({ to, from: TWILIO_NUMBER, body: 'MyBizPal debug SMS ✅' });
    res.json({ ok: true, to, from: TWILIO_NUMBER });
  } catch (e) { res.json({ ok: false, error: e?.message || e }); }
});
app.get('/debug/env', (req, res) => {
  res.json({
    TZ, CALENDAR_ID,
    TWILIO_NUMBER,
    GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    CALENDAR_ALLOW_ATTENDEE_INVITES
  });
});

/* ================================
   START
================================ */
app.listen(PORT, () => console.log(`✅ IVR running on ${PORT}`));
