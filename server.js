// server.js  — MyBizPal.ai booking IVR (UK)
// Drop-in replacement. Focused on: stable booking, slow/clear email+phone capture,
// no “what type of appointment” loops, calm pacing, SMS confirm, reminder prompt,
// and graceful hang-up after long silence.

// ============================ BOOTSTRAP ============================
import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { google } from 'googleapis';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

// -------------------- App --------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
const PORT = process.env.PORT || 3000;

// -------------------- Time/brand --------------------
const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const BRAND = 'MyBizPal';
const DEFAULT_MEETING_TITLE = `${BRAND} — Business Consultation (30 min)`;
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

// -------------------- Twilio --------------------
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing Twilio creds');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = (process.env.TWILIO_NUMBER || process.env.SMS_FROM || '').trim();

// -------------------- OpenAI (fast/light) --------------------
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

// -------------------- ElevenLabs TTS --------------------
const EL_KEY   = process.env.ELEVENLABS_API_KEY;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

// -------------------- Google Calendar --------------------
const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);
const calendar = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID || 'primary';

let googleReady = false;
async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
  }
}

// -------------------- Memory --------------------
const CALL_MEMORY = new Map(); // CallSid -> [{role, content}]
const CALL_STATE  = new Map(); // CallSid -> state
const memFor = sid => (CALL_MEMORY.has(sid) ? CALL_MEMORY : CALL_MEMORY.set(sid, []), CALL_MEMORY.get(sid));
const stateFor = sid => {
  if (!CALL_STATE.has(sid)) {
    CALL_STATE.set(sid, {
      // language
      lang: 'en', langConfirmed: true,
      // data
      name: null, askedName: false,
      phone: null, askedPhone: false, pendingPhone: false,
      email: null, askedEmail: false, pendingEmail: false,
      // booking
      pendingWhenISO: null, pendingWhenSpoken: null,
      // pacing
      speaking: false, silenceTicks: 0, userSaidHold: false, takeYourTimeShown: false,
      // wrap-up
      wrapOffered: false, lastPrompt: '',
      // sms
      smsConfirmSent: false, awaitingSmsReceipt: false, smsReminder: null, pendingReminder: false,
      // hang-up logic
      nudgesCount: 0
    });
  }
  return CALL_STATE.get(sid);
};

// ============================ Helpers ============================

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}
function gatherWithPlay({ host, text, action = '/twilio/handle', timeout = 7 }) {
  const enc = encodeURIComponent((text || '').slice(0, 500));
  const tts = `https://${host}/tts?text=${enc}`;
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        actionOnEmptyResult="true"
        action="${action}"
        method="POST"
        partialResultCallback="/twilio/partial"
        partialResultCallbackMethod="POST"
        timeout="${timeout}"
        speechTimeout="auto">
  <Play>${tts}</Play>
</Gather>`;
}
function playOnly({ host, text }) {
  const enc = encodeURIComponent((text || '').slice(0, 500));
  return `<Play>https://${host}/tts?text=${enc}</Play>`;
}

// Slow/clear phone read-back: “0 7 9 3 4 …”
function slowPhoneSpeak(n) {
  return (n || '').split('').join(' ');
}
// Slow/clear email read-back: “name at gmail dot com”
function slowEmailSpeak(email) {
  if (!email) return '';
  const [name, domain] = email.split('@');
  return `${name.split('').join(' ')} at ${domain.replace(/\./g, ' dot ')}`;
}

function normalizeUkPhone(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0')
       .replace(/\bone\b/g, '1').replace(/\btwo\b/g, '2').replace(/\bthree\b/g, '3')
       .replace(/\bfour\b/g, '4').replace(/\bfive\b/g, '5').replace(/\bsix\b/g, '6')
       .replace(/\bseven\b/g, '7').replace(/\beight\b/g, '8').replace(/\bnine\b/g, '9');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) s = '0' + s.slice(3);
  if (!s.startsWith('0') && s.length === 10) s = '0' + s;
  return s;
}
function isLikelyUkNumber(n) {
  return !!n && (/^0\d{10}$/.test(n) || /^0\d{9}$/.test(n));
}
function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;
  // turn "at" forms to '@'
  s = s.replace(/\barroba\b/g, '@')
       .replace(/\bat sign\b/g, '@')
       .replace(/\bat symbol\b/g, '@')
       .replace(/\bat\b/g, '@');
  // turn dot words to '.'
  s = s.replace(/\bdot\b/g, '.').replace(/\bpunto\b/g, '.').replace(/\bponto\b/g, '.').replace(/\bpoint\b/g, '.');
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.').replace(/\s+/g, '');
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
function parseNaturalDate(utterance, tz = TZ) {
  if (!utterance) return null;
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;
  const zoned = toZonedTime(parsed, tz);
  const iso   = fromZonedTime(zoned, tz).toISOString();
  const spoken = formatInTimeZone(zoned, tz, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}
const partOfDay = () => {
  const h = Number(formatInTimeZone(new Date(), TZ, 'H'));
  return h < 12 ? 'day' : h < 18 ? 'afternoon' : 'evening';
};

// ============================ TTS (slow, natural) ============================
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 500);
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
  } catch (e) { res.status(500).end(); }
});

// ============================ Debug utilities ============================
app.get('/debug/google', async (req, res) => {
  try {
    await ensureGoogleAuth();
    const start = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const end   = new Date(Date.now() + 33 * 60 * 1000).toISOString();
    const evt = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: `${BRAND} DEBUG event`,
        start: { dateTime: start, timeZone: TZ },
        end:   { dateTime: end,   timeZone: TZ },
      }, sendUpdates: 'none'
    });
    return res.json({ ok: true, id: evt.data.id, calendarId: evt.data.organizer?.email || CALENDAR_ID });
  } catch (e) {
    return res.json({ ok: false, error: e?.message || String(e) });
  }
});
app.get('/debug/sms', async (req, res) => {
  const to = (req.query.to || '').toString();
  try {
    if (!to) throw new Error('Missing ?to=+447…');
    if (!TWILIO_NUMBER) throw new Error('TWILIO_NUMBER not set');
    if (to.replace(/\s/g, '') === TWILIO_NUMBER.replace(/\s/g, '')) throw new Error(`'To' and 'From' cannot match`);
    const r = await twilioClient.messages.create({
      to, from: TWILIO_NUMBER, body: `${BRAND} debug SMS ✅`
    });
    res.json({ ok: true, sid: r.sid, to, from: TWILIO_NUMBER });
  } catch (e) { res.json({ ok: false, error: e?.message || String(e) }); }
});
app.get('/debug/env', (req, res) => {
  res.json({
    CALENDAR_ID: !!CALENDAR_ID ? '[set]' : '[missing]',
    GOOGLE_CLIENT_EMAIL: !!process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY: !!process.env.GOOGLE_PRIVATE_KEY,
    TWILIO_NUMBER: TWILIO_NUMBER || '[missing]',
    OPENAI_MODEL
  });
});

// ============================ LLM (short, calm) ============================
async function llm({ history, latestText }) {
  const messages = [
    {
      role: 'system',
      content:
`You are Gabriel, a calm, friendly, helpful consultant for MyBizPal. 
Keep sentences short, natural, and human. No filler. 
Do not ask what type of appointment; it is always “MyBizPal — Business Consultation (30 min)”.
If the caller asks you to wait, acknowledge once and pause; do not repeat “take your time”. 
Never say literal stage directions (no *soft chuckle* text).`
    }
  ];
  for (const h of history.slice(-12)) if (h.role !== 'system') messages.push(h);
  messages.push({ role: 'user', content: latestText });

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL, temperature: 0.4, max_tokens: 120, messages
  });
  return r.choices?.[0]?.message?.content?.trim() || 'Alright. How can I help?';
}

// ============================ Voice entry ============================
app.post('/twilio/voice', async (req, res) => {
  const sid = req.body.CallSid || '';
  memFor(sid).length = 0;
  const state = stateFor(sid);

  const greet = `Hi, this is Gabriel with ${BRAND}. How can I help today?`;
  state.lastPrompt = greet;
  state.speaking = true;
  return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text: greet })));
});

app.post('/twilio/partial', (req, res) => res.sendStatus(200));

// ============================ Main handler ============================
app.post('/twilio/handle', async (req, res) => {
  try {
    const sid    = req.body.CallSid || 'unknown';
    const said   = (req.body.SpeechResult || '').trim();
    const state  = stateFor(sid);
    const memory = memFor(sid);
    const host   = req.headers.host;

    // Silence handling (with long nudge + hangup)
    if (!said) {
      state.silenceTicks++;
      if (state.silenceTicks === 1) {
        state.lastPrompt = 'Take your time—whenever you’re ready.';
        state.speaking = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
      }
      if (state.silenceTicks === 2) {
        state.lastPrompt = 'Are you still there?';
        state.nudgesCount++;
        state.speaking = true;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt, timeout: 8 })));
      }
      if (state.silenceTicks >= 3) {
        const bye = `Thanks for calling ${BRAND}. Have a great ${partOfDay()}.`;
        return res.type('text/xml').send(twiml(`${playOnly({ host, text: bye })}<Hangup/>`));
      }
    } else {
      state.silenceTicks = 0;
    }

    // Detect user asks to wait (“one sec / let me check / hold on”)
    if (/\b(wait|one sec|one second|hold on|let me check|gimme a sec)\b/i.test(said)) {
      state.userSaidHold = true;
      state.lastPrompt = 'Sure—no rush.';
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt, timeout: 10 })));
    }

    // Collect name (once)
    if (!state.name && !state.askedName && /\b(my name is|i am|this is)\b/i.test(said)) {
      const m = said.match(/(?:my name is|i am|this is)\s+([a-z' -]{2,30})/i);
      if (m) state.name = m[1].trim();
    }
    if (!state.name && !state.askedName) {
      state.askedName = true;
      state.lastPrompt = 'What name should I note for the booking?';
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }

    // Opportunistic phone capture
    const phoneCandidate = normalizeUkPhone(said);
    if (!state.phone && phoneCandidate && isLikelyUkNumber(phoneCandidate)) {
      state.phone = phoneCandidate;
      state.lastPrompt = `Got it. ${slowPhoneSpeak(state.phone)}.`;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }
    // Request phone if missing
    if (!state.phone && !state.pendingPhone) {
      state.pendingPhone = true;
      state.lastPrompt = 'What’s the best mobile for a quick text confirmation?';
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }
    if (state.pendingPhone) {
      const p = normalizeUkPhone(said);
      if (p && isLikelyUkNumber(p)) {
        state.phone = p; state.pendingPhone = false;
        state.lastPrompt = `Thanks. ${slowPhoneSpeak(state.phone)}.`;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
      } else {
        state.lastPrompt = 'Sorry—could you repeat the number slowly?';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
      }
    }

    // Opportunistic email capture
    const emailCandidate = extractEmail(said);
    if (!state.email && emailCandidate) {
      state.email = emailCandidate;
      state.lastPrompt = `Perfect—${slowEmailSpeak(state.email)}. Is that right?`;
      state.pendingEmail = true;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }
    if (!state.email && !state.askedEmail) {
      state.askedEmail = true; state.pendingEmail = true;
      state.lastPrompt = 'What email should I send the calendar invite to?';
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }
    if (state.pendingEmail) {
      const e = extractEmail(said);
      if (/\b(yes|correct|that\'s right|right|yep|yeah)\b/i.test(said) && state.email) {
        state.pendingEmail = false;
      } else if (e) {
        state.email = e; state.pendingEmail = false;
      } else {
        state.lastPrompt = 'I didn’t catch the email. Please say it like “name at gmail dot com”.';
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
      }
    }

    // Parse a time
    const timeIntent = parseNaturalDate(said, TZ);
    if (timeIntent) {
      state.pendingWhenISO = timeIntent.iso;
      state.pendingWhenSpoken = timeIntent.spoken;
    }
    if (!state.pendingWhenISO) {
      // If no time was provided yet, ask calmly
      state.lastPrompt = 'When would you like the consultation? You can say “tomorrow at 3pm”.';
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));
    }

    // Book (we have time + phone + email)
    await ensureGoogleAuth();
    let event;
    try {
      const startISO = state.pendingWhenISO;
      const endISO   = new Date(new Date(startISO).getTime() + 30 * 60000).toISOString();
      event = await calendar.events.insert({
        calendarId: CALENDAR_ID,
        requestBody: {
          summary: DEFAULT_MEETING_TITLE,
          description: `Booked by Gabriel (IVR) for ${state.name || 'Prospect'}.`,
          start: { dateTime: startISO, timeZone: TZ },
          end:   { dateTime: endISO,   timeZone: TZ },
          attendees: state.email ? [{ email: state.email }] : []
        },
        sendUpdates: state.email ? 'all' : 'none'
      });
    } catch (e) {
      state.lastPrompt = `Hmm—I couldn’t book that just now. I’ve saved your details and I’ll follow up shortly.`;
      return res.type('text/xml').send(twiml(`${playOnly({ host, text: state.lastPrompt })}<Hangup/>`));
    }

    // SMS confirmation (avoid To/From same)
    if (state.phone && TWILIO_NUMBER && state.phone.replace(/\s/g, '') !== TWILIO_NUMBER.replace(/\s/g, '')) {
      const when = formatInTimeZone(new Date(state.pendingWhenISO), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
      const sms = [
        `✅ Booked: ${DEFAULT_MEETING_TITLE}`,
        `When: ${when}`,
        `Join: https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1`,
        `ID: 470 811 0348  |  Passcode: jcJx8M`,
        `Need to reschedule? Reply CHANGE.`
      ].join('\n');
      try {
        await twilioClient.messages.create({ to: state.phone, from: TWILIO_NUMBER, body: sms });
        state.smsConfirmSent = true;
        state.awaitingSmsReceipt = true;
      } catch (_) { /* ignore SMS failure in-call */ }
    }

    // Ask if they got the SMS
    state.lastPrompt = 'I’ve sent you a text with the details—did you receive it?';
    state.pendingWhenISO = null; state.pendingWhenSpoken = null;
    state.wrapOffered = false;
    return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: state.lastPrompt })));

  } catch (err) {
    return res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

// ============================ Reprompt & Hangup ============================
app.post('/twilio/reprompt', (req, res) => {
  const s = stateFor(req.body.CallSid || 'unknown');
  const text = s.lastPrompt || 'How can I help?';
  return res.type('text/xml').send(twiml(gatherWithPlay({ host: req.headers.host, text })));
});
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  CALL_MEMORY.delete(sid);
  CALL_STATE.delete(sid);
  return res.type('text/xml').send(twiml('<Hangup/>'));
});

// ============================ Start ============================
app.listen(PORT, () => console.log(`✅ IVR running on ${PORT}`));
