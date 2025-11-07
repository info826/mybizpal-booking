// server.js — MyBizPal: booking + SMS + no double-book + human yes/no + UK phone E.164
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
   APP
================================ */
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

/* ================================
   TWILIO (SMS)
================================ */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM; // E.164 +447...

/* ================================
   OPENAI
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ================================
   ELEVENLABS (TTS)
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

function formatDateForSms(iso) {
  return formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
}
function buildConfirmationSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    '✅ MyBizPal — Business Consultation (15–30 min)',
    `Date: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID}  Passcode: ${ZOOM_PASSCODE}`,
    'Reply CHANGE to reschedule.'
  ].join('\n');
}
function buildReminderSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    `⏰ Reminder: your MyBizPal consultation in ${REMINDER_MINUTES_BEFORE} min`,
    `Starts: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
  ].join('\n');
}

/* ================================
   PERSONA
================================ */
function buildSystemPreamble(state) {
  const niceNow = formatInTimeZone(new Date(), TZ, "eeee dd MMMM yyyy, h:mmaaa");
  return `
You are Gabriel — calm, friendly, confident tech consultant for MyBizPal.ai.
Keep it natural, warm, persuasive. Short spoken-style sentences. Slow email/phone read-backs.

Default meeting is “MyBizPal — Business Consultation (15–30 min)”.
Timezone: ${TZ}. Now: ${niceNow}.
Language: ${state.lang || 'en'} (ask once to switch if caller clearly uses ES/PT/FR).

End only after: “Is there anything else I can help you with?” and caller declines.
If silence: gentle two nudges ~7–8s apart, then hang up.
Our code is proprietary — say that if asked about internal details.
`;}

/* ================================
   TWIML HELPERS
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
   TTS
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 480);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=1`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: { stability: 0.38, similarity_boost: 0.9, speaking_rate: 0.78 }
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
   STATE
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> detailed state

const memFor = (sid) => {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
};
const stateFor = (sid) => {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    speaking: false,

    // silence/nudges
    silenceStartAt: null,
    nudgeCount: 0,
    lastNudgeAt: null,
    agentWaitUntil: 0,
    userRequestedPause: false,
    takeYourTimeSaid: false,

    wrapPrompted: false,
    lang: 'en',
    pendingLang: null,
    langConfirmed: false,
    lastPrompt: '',

    // Contact capture (store NATIONAL + E.164; don’t reset once confirmed)
    phone_nat: null,   // "07XXXXXXXXX" (spoken back)
    phone_e164: null,  // "+447XXXXXXXXX" (SMS)
    pendingPhone: false,
    confirmingPhone: false,

    email: null,
    pendingEmail: false,
    confirmingEmail: false,

    // Reminder pref
    smsReminder: null,
    pendingReminder: false,

    // SMS delivery check
    smsConfirmSent: false,
    awaitingSmsReceipt: false,

    // Booking time
    pendingBookingISO: null,
    pendingBookingSpoken: null,
    awaitingTimeConfirm: false
  });
  return CALL_STATE.get(sid);
};

/* ================================
   HELPERS — UK phone handling & email
================================ */
// Parse any UK-ish spoken number into national+E.164 pair
function parseUkPhone(spoken) {
  if (!spoken) return null;

  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(uh|uhh|uhm|um|umm|erm)\b/g, '');    // filler noise
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
  return !!(p && p.national && /^0\d{10}$/.test(p.national) && p.e164 && /^\+44\d{10}$/.test(p.e164));
}
function slowPhoneSpeakNational(num07) {
  if (!num07) return '';
  return num07.split('').join(', ');
}

function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\bat sign\b/g, '@')
       .replace(/\bat symbol\b/g, '@')
       .replace(/\bat-?sign\b/g, '@')
       .replace(/\barroba\b/g, '@')
       .replace(/\bat\b/g, '@');
  s = s.replace(/\bdot\b/g, '.')
       .replace(/\bpunto\b/g, '.')
       .replace(/\bponto\b/g, '.')
       .replace(/\bpoint\b/g, '.');
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, ' ').trim();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
function slowEmailSpeak(email) {
  if (!email) return '';
  return email.replace(/@/g, ' at ').replace(/\./g, ' dot ');
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
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}
function partOfDay() {
  const h = Number(formatInTimeZone(new Date(), TZ, 'H'));
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/* Human back-channels → YES/NO */
function yesInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(yes|yeah|yep|sure|ok|okay|si|sí|sim|oui|d'accord|yeppers)\b/.test(t)
      || /^(mm+|mhm+|uh-?huh|uhu|ah['’]?a|uhhu)$/i.test(t);
}
function noInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return /\b(no|nope|nah|pas maintenant|não|nao)\b/.test(t)
      || /^(nn)$/i.test(t);
}

/* ================================
   CALENDAR: conflict check + insert
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
async function insertEvent({ startISO, durationMin = 30, email }) {
  await ensureGoogleAuth();
  const endISO = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();

  const event = {
    summary: 'MyBizPal — Business Consultation (15–30 min)',
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    description: 'Booked by MyBizPal (Gabriel).',
    attendees: email ? [{ email }] : []
  };
  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all'
  });
  return created.data;
}

/* ================================
   LLM
================================ */
async function llm({ history, latestText, state }) {
  const messages = [];
  messages.push({ role: 'system', content: buildSystemPreamble(state) });
  for (const h of history.slice(-14)) if (h.role !== 'system') messages.push(h);
  messages.push({
    role: 'system',
    content: state.lang !== 'en'
      ? `Caller prefers language: ${state.lang}. Respond in that language.`
      : 'Caller language: English.'
  });
  messages.push({ role: 'user', content: latestText });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 120,
    messages
  });
  return resp.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ================================
   Continue if ready (books + SMS)
================================ */
async function continueBookingIfReady({ req, res, state }) {
  if (state.pendingBookingISO && state.phone_e164 && state.email && state.smsReminder !== null) {
    try {
      // No double-booking
      const conflict = await hasConflict({ startISO: state.pendingBookingISO, durationMin: 30 });
      if (conflict) {
        const msg = 'That time just got taken. Want me to look for the next available slot around that time?';
        state.lastPrompt = msg;
        res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: msg })));
        return true;
      }

      // Create event
      const event = await insertEvent({
        startISO: state.pendingBookingISO,
        durationMin: 30,
        email: state.email
      });

      // One SMS confirmation (only here)
      const to = state.phone_e164 || req.body.From || null;
      if (to && TWILIO_NUMBER && to !== TWILIO_NUMBER) {
        await twilioClient.messages.create({
          to, from: TWILIO_NUMBER, body: buildConfirmationSms({ startISO: event.start.dateTime })
        });
        state.smsConfirmSent = true;
        state.awaitingSmsReceipt = true;
      }

      // Optional reminder
      if (state.smsReminder && to && TWILIO_NUMBER) {
        const startMs = new Date(event.start.dateTime).getTime();
        const fireAt  = startMs - REMINDER_MINUTES_BEFORE * 60000;
        const delay   = fireAt - Date.now();
        if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
          setTimeout(async () => {
            try {
              await twilioClient.messages.create({
                to, from: TWILIO_NUMBER,
                body: buildReminderSms({ startISO: event.start.dateTime })
              });
            } catch (e) { console.error('Reminder SMS error:', e?.message || e); }
          }, delay);
        }
      }

      // clear pending time
      state.pendingBookingISO = null;
      state.pendingBookingSpoken = null;

      const askReceipt = 'I’ve just sent the text—did you receive it?';
      state.lastPrompt = askReceipt;
      res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: askReceipt })));
      return true;
    } catch (e) {
      console.error('Booking failed:', e?.message || e);
      const fail = 'Hmm — I couldn’t finalize that right now. I’ll note your details and follow up.';
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
  state.userRequestedPause = false; state.takeYourTimeSaid = false;

  memory.push({ role: 'system', content: buildSystemPreamble(state) });

  const greet = 'Hey—this is Gabriel with MyBizPal. How can I help today?';
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
    const lang    = state.lang || 'en';
    const now     = Date.now();

    /* Silence rules */
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
        const bye = `Thanks for calling MyBizPal—have a great ${partOfDay()}.`;
        return res.type('text/xml').send(twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`));
      }
      return res.type('text/xml').send(twiml(silentGather({})));
    } else {
      // reset silence streak
      state.silenceStartAt = null; state.nudgeCount = 0; state.lastNudgeAt = null;
      state.userRequestedPause = false; state.takeYourTimeSaid = false;
    }

    // User asked us to wait
    if (userAskedToWait(said)) {
      if (!state.takeYourTimeSaid) {
        state.takeYourTimeSaid = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: 'Take your time—whenever you’re ready.' })));
      }
      return res.type('text/xml').send(twiml(silentGather({})));
    }

    // Opportunistic captures — ONLY if not already set
    if (!state.phone_e164) {
      const pair = parseUkPhone(said);
      if (isLikelyUkNumberPair(pair)) {
        state.phone_e164 = pair.e164;
        state.phone_nat  = pair.national;
        state.pendingPhone = false;
        state.confirmingPhone = false;
      }
    }
     if (state.phone) console.log('[FLOW] phone set:', state.phone);
    if (!state.email) {
      const e = extractEmail(said);
      if (e) {
        state.email = e; state.pendingEmail = false; state.confirmingEmail = false;
      }
    }
   if (state.email) console.log('[FLOW] email set:', state.email);
   

    // Natural date detection (no keyword needed)
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
        // reset and ask for another time
        state.awaitingTimeConfirm = false;
        state.pendingBookingISO = null; state.pendingBookingSpoken = null;
        const ask = 'No problem—what time works better?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    // If we have time, gather missing pieces in order: phone → email → reminder → book
    if (state.pendingBookingISO) {
      if (!state.phone_e164) {
        state.pendingPhone = true;
        const ask = 'What’s the best mobile number for a quick text confirmation? Please say: zero seven, then the rest, digit by digit.';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      if (!state.email) {
        state.pendingEmail = true;
        const ask = 'What email should I send the calendar invite to?';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      if (state.smsReminder === null) {
        state.pendingReminder = true;
        const ask = `Would you like a text reminder ${REMINDER_MINUTES_BEFORE} minutes before, or prefer no reminder?`;
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
      console.log(
  '[FLOW] continueBookingIfReady? time:', state.pendingBookingISO,
  'phone:', state.phone,
  'email:', state.email,
  'rem:', state.smsReminder
);
       const handled = await continueBookingIfReady({ req, res, state });
      if (handled) return;
    }

    // Handle pending phone/email/reminder steps
    if (state.pendingPhone) {
      const pair = parseUkPhone(said);
      if (isLikelyUkNumberPair(pair)) {
        state.phone_e164 = pair.e164;
        state.phone_nat  = pair.national;
        state.pendingPhone = false;
        const rb = `Thanks — let me repeat it slowly: ${slowPhoneSpeakNational(state.phone_nat)}. Is that correct?`;
        state.confirmingPhone = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
      } else {
        const ask = 'I didn’t catch that — please say each digit starting with zero.';
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }
    if (state.confirmingPhone) {
      if (yesInAnyLang(said)) {
        state.confirmingPhone = false;
      } else if (noInAnyLang(said)) {
        state.phone_e164 = null; state.phone_nat = null; state.confirmingPhone = false; state.pendingPhone = true;
        const ask = 'Okay — what’s the correct mobile number?';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    if (state.pendingEmail) {
      const e = extractEmail(said);
      if (e) {
        state.email = e; state.pendingEmail = false;
        const rb = `Perfect — here’s how I heard it: ${slowEmailSpeak(e)}. Is that right?`;
        state.confirmingEmail = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: rb })));
      } else {
        const ask = "Could you say the email slowly — like 'name at domain dot com'?";
        state.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }
    if (state.confirmingEmail) {
      if (yesInAnyLang(said)) {
        state.confirmingEmail = false;
      } else if (noInAnyLang(said)) {
        state.email = null; state.confirmingEmail = false; state.pendingEmail = true;
        const ask = 'No problem — what email should I send it to?';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: ask })));
      }
    }

    if (state.pendingReminder) {
       console.log('[FLOW] awaiting reminder...');
      if (yesInAnyLang(said)) { console.log('[FLOW] reminder YES'); state.smsReminder = true;  state.pendingReminder = false; }
      else if (noInAnyLang(said)) {console.log('[FLOW] reminder NO'); state.smsReminder = false; state.pendingReminder = false; }
      const handled = await continueBookingIfReady({ req, res, state });
      if (handled) return;

      // If user said something else (not yes/no), simply re-ask once more, then move on.
      if (state.smsReminder === null) {
        state.pendingReminder = true;
        const ask = `Would you like a text reminder ${REMINDER_MINUTES_BEFORE} minutes before, or prefer no reminder?`;
        state.lastPrompt = ask;
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
        const to = state.phone_e164 || req.body.From;
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

    // Normal conversation via LLM
    const reply = await llm({ history: memory, latestText: said, state });
    let final = reply;

    // Close if they decline more help
    if (state.wrapPrompted && (noInAnyLang(said) || /\b(that's all|thats all|all good)\b/i.test(said))) {
      const bye = `Thanks for calling MyBizPal—have a great ${partOfDay()}.`;
      return res.type('text/xml').send(twiml(`${playOnly({ host: req.headers.host, text: bye })}<Hangup/>`));
    }

    // If our reply asks them to wait, stop nudges for ~12s
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
  res.type('text/xml').send(twiml('<Hangup/>'));
});

/* ================================
   DEBUG ROUTES
================================ */
app.get('/debug/google', async (req, res) => {
  try {
    await ensureGoogleAuth();
    const startISO = new Date(Date.now() + 10 * 60000).toISOString();
    const ev = await insertEvent({ startISO, durationMin: 15, email: null });
    res.json({ ok: true, id: ev.id, calendarId: CALENDAR_ID });
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
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY
  });
});

/* ================================
   START
================================ */
app.listen(PORT, () => console.log(`✅ IVR running on ${PORT}`));
