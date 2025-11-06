// server.js  — MyBizPal.ai (Gabriel) — 2025-11-06
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
   BASIC APP / BODY PARSER
================================ */
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const TZ   = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const REMINDER_MINUTES_BEFORE = Number(process.env.REMINDER_MINUTES_BEFORE || 60);

/* ================================
   TWILIO
================================ */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM;

/* ================================
   OPENAI (fast/concise)
================================ */
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

/* ================================
   ELEVENLABS TTS
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
const calendar    = google.calendar({ version: 'v3', auth: jwt });
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID || 'primary';

let googleReady = false;
async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
    console.log('✅ Google service account authorized');
  }
}

/* ================================
   ZOOM DETAILS
================================ */
const ZOOM_LINK       = process.env.ZOOM_LINK || 'https://us05web.zoom.us/j/4708110348?pwd=rAU8aqWDKK2COXKHXzEhYwiDmhPSsc.1&omn=88292946669';
const ZOOM_MEETING_ID = process.env.ZOOM_MEETING_ID || '470 811 0348';
const ZOOM_PASSCODE   = process.env.ZOOM_PASSCODE   || 'jcJx8M';

/* ================================
   UTILS — phrasing / SMS text
================================ */
function formatDateForSms(iso) {
  return formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
}
function buildConfirmationSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    'MyBizPal — Business Consultation (15 min)',
    `Date: ${when}`,
    'Please be on time and bring any questions.',
    `Zoom: ${ZOOM_LINK}`,
    `Meeting ID  ${ZOOM_MEETING_ID}`,
    `Passcode    ${ZOOM_PASSCODE}`,
    'To reschedule, reply CHANGE.'
  ].join('\n');
}
function buildReminderSms({ startISO }) {
  const when = formatDateForSms(startISO);
  return [
    `⏰ Reminder: Business Consultation in ${REMINDER_MINUTES_BEFORE} min`,
    `Start: ${when}`,
    `Zoom: ${ZOOM_LINK}`,
    `ID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`
  ].join('\n');
}
function partOfDay() {
  const now = toZonedTime(new Date(), TZ);
  const h = +formatInTimeZone(now, TZ, 'H');
  if (h < 12) return 'day';
  if (h < 18) return 'afternoon';
  return 'evening';
}

/* ================================
   SPEAK HELPERS (natural & slow)
================================ */
// Phone: speak digits spaced-out: "0 7 9 1 …"
function slowPhoneSpeak(num) {
  if (!num) return '';
  const cleaned = (num.startsWith('+44') ? '0' + num.slice(3) : num).replace(/[^\d]/g, '');
  return cleaned.split('').join(' ');
}
// Email: “name at domain dot com”
function slowEmailSpeak(email) {
  if (!email) return '';
  const [name, rest] = email.split('@');
  const parts = rest ? rest.split('.') : [];
  const tail  = parts.length ? parts.join(' dot ') : '';
  return `${name} at ${tail}`;
}

/* ================================
   TTS (slower, friendly pacing)
================================ */
app.get('/tts', async (req, res) => {
  try {
    const text = (req.query.text || 'Hello').toString().slice(0, 500);
    const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/stream?optimize_streaming_latency=1`;
    const payload = {
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.36,
        similarity_boost: 0.9,
        speaking_rate: 0.78 // calm, human-ish
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
    console.error('TTS error:', e?.response?.status, e?.message);
    res.status(500).end();
  }
});

/* ================================
   TWIML HELPERS
================================ */
const twiml = inner => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
function gatherWithPlay({ host, text, action = '/twilio/handle' }) {
  const enc = encodeURIComponent(text || '');
  const url = `https://${host}/tts?text=${enc}`;
  return `
<Gather input="speech dtmf"
        language="en-GB"
        bargeIn="true"
        actionOnEmptyResult="true"
        action="${action}"
        method="POST"
        timeout="7"
        speechTimeout="auto">
  <Play>${url}</Play>
</Gather>`;
}
function playOnly({ host, text }) {
  const enc = encodeURIComponent(text || '');
  return `<Play>https://${host}/tts?text=${enc}</Play>`;
}

/* ================================
   MEMORY / STATE
================================ */
const CALL_MEMORY = new Map(); // CallSid -> [{role,content}]
const CALL_STATE  = new Map(); // CallSid -> state

function memFor(sid) {
  if (!CALL_MEMORY.has(sid)) CALL_MEMORY.set(sid, []);
  return CALL_MEMORY.get(sid);
}
function stateFor(sid) {
  if (!CALL_STATE.has(sid)) CALL_STATE.set(sid, {
    lang: 'en',
    speaking: false,
    lastPrompt: '',
    // silence logic
    silenceNudges: 0,
    awaitingUser: false,  // true if WE asked them to wait; disables “take your time” echo
    // contact
    phone: null,
    email: null,
    pendingPhone: false,
    pendingEmail: false,
    // booking
    pendingISO: null,
    pendingSpoken: null,
    smsReminder: null,
    pendingReminder: false,
    // sms confirm
    smsSent: false,
    awaitingSmsReceipt: false
  });
  return CALL_STATE.get(sid);
}

/* ================================
   LANGUAGE & INTENT (light)
================================ */
function detectLanguage(t='') {
  const txt = t.toLowerCase();
  if (/(hola|gracias|por favor|buen[oa]s|mañana)/i.test(txt)) return 'es';
  if (/(olá|ola|obrigad[oa]|amanhã|preciso)/i.test(txt)) return 'pt';
  if (/(bonjour|merci|svp|s\'il vous plaît|demain)/i.test(txt)) return 'fr';
  return 'en';
}
function yesAny(t='')  { return /\b(yes|yeah|yep|ok|okay|sure|si|sí|sim|oui)\b/i.test(t); }
function noAny(t='')   { return /\b(no|nope|nah|not now|pas maintenant|não|nao)\b/i.test(t); }
function endAny(t='')  {
  const x = t.toLowerCase();
  return [
    'no thanks','nothing else','that’s all','thats all','all good','we’re good',
    'were good','i’m good','im good','no thank you','that will be all','that would be all'
  ].some(p => x.includes(p));
}

/* ================================
   SYSTEM PROMPT — persona
================================ */
function persona(state) {
  const now = formatInTimeZone(new Date(), TZ, "eeee dd MMMM yyyy, h:mmaaa '('zzzz')'");
  return `
You are **Gabriel**, a calm, friendly American male tech consultant for MyBizPal.ai.
Speak slowly and naturally; no robotic fillers. Use short, spoken sentences with relaxed pauses.
Use light humor only when appropriate (e.g., “heh,” “haha, fair enough”). Never say stage directions.

Rapport (use sparingly): born in Venezuela, Portuguese family from Madeira; live in High Wycombe (UK).
Married to Raquel (from Barcelona). Use at most one quick line to relate if it helps.

Goal: help, qualify gently, and guide to a booking when relevant.
Default meeting type = “MyBizPal 30-minute consultation with a specialist”.

Phone & email handling:
- UK numbers: understand “oh / o / zero / naught”=0, +44 → 0, and read back slowly.
- Emails: understand “at / at sign / arroba”→@, “dot / punto / ponto / point”→.  Read back slowly (“name at domain dot com”).

Ending rules:
- Only end after *you ask* “Is there anything else I can help you with?” and the caller declines.
- If the caller says “thanks/ok” mid-conversation, never end.
Silence:
- Nudge only after a long pause; if two nudges ~8s apart with no reply, hang up politely.

Local time: ${now}.
Language default: English (switch to ES/PT/FR only if caller prefers, ask first).
`;
}

/* ================================
   OPENAI CHAT (short answers)
================================ */
async function llm({ history, latestText, state }) {
  const msgs = [{ role: 'system', content: persona(state) }];
  for (const h of history.slice(-14)) if (h.role !== 'system') msgs.push(h);
  msgs.push({ role: 'user', content: latestText });

  const r = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.4,
    max_tokens: 120,
    messages: msgs
  });
  return r.choices?.[0]?.message?.content?.trim() || 'Alright—how can I help?';
}

/* ================================
   NORMALIZERS
================================ */
function normalizeUkPhone(spoken='') {
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0')
       .replace(/\bone\b/g,'1').replace(/\btwo\b/g,'2').replace(/\bthree\b/g,'3')
       .replace(/\bfour\b/g,'4').replace(/\bfive\b/g,'5').replace(/\bsix\b/g,'6')
       .replace(/\bseven\b/g,'7').replace(/\beight\b/g,'8').replace(/\bnine\b/g,'9');
  s = s.replace(/[^\d+]/g, '');
  if (s.startsWith('+44')) s = '0' + s.slice(3);
  if (!s.startsWith('0') && s.length === 10) s = '0' + s;
  return s.trim();
}
function isLikelyUk(n='') {
  return /^0\d{10}$/.test(n) || /^0\d{9}$/.test(n) || /^\+44\d{10}$/.test(n);
}
function extractEmail(spoken='') {
  let s = ` ${spoken.toLowerCase()} `;
  s = s.replace(/\barroba\b/g,'@')
       .replace(/\bat sign\b/g,'@').replace(/\bat symbol\b/g,'@').replace(/\bat\b/g,'@')
       .replace(/\bdot\b/g,'.').replace(/\bponto\b/g,'.').replace(/\bpunto\b/g,'.').replace(/\bpoint\b/g,'.');
  s = s.replace(/\s*@\s*/g,'@').replace(/\s*\.\s*/g,'.').replace(/\s+/g,' ').trim();
  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}
function parseNaturalDate(utterance) {
  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;
  const zoned  = toZonedTime(parsed, TZ);
  const iso    = fromZonedTime(zoned, TZ).toISOString();
  const spoken = formatInTimeZone(zoned, TZ, "eeee do MMMM 'at' h:mmaaa");
  return { iso, spoken };
}

/* ================================
   CALENDAR + SMS
================================ */
async function bookAppointment({ whenISO, email, phone }) {
  await ensureGoogleAuth();

  // 30-minute window (we market 30 mins); SMS header says 15 — keep as requested
  const startISO = whenISO;
  const endISO   = new Date(new Date(startISO).getTime() + 30*60000).toISOString();

  const event = {
    summary: 'MyBizPal — 30-minute consultation with a specialist',
    description: 'Booked by Gabriel (MyBizPal receptionist).',
    start: { dateTime: startISO, timeZone: TZ },
    end:   { dateTime: endISO,   timeZone: TZ },
    attendees: email ? [{ email }] : []
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'all'
  });

  if (phone && TWILIO_NUMBER) {
    const sms = buildConfirmationSms({ startISO });
    await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: sms });
  }

  return created.data;
}
function scheduleReminder({ event, phone }) {
  if (!phone || !event?.start?.dateTime || !TWILIO_NUMBER) return;
  const fireAt = new Date(event.start.dateTime).getTime() - REMINDER_MINUTES_BEFORE*60000;
  const delay  = fireAt - Date.now();
  if (delay <= 0 || delay > 7*24*3600*1000) return; // safety
  setTimeout(async () => {
    try {
      const sms = buildReminderSms({ startISO: event.start.dateTime });
      await twilioClient.messages.create({ to: phone, from: TWILIO_NUMBER, body: sms });
    } catch (e) { console.error('Reminder SMS error:', e?.message || e); }
  }, delay);
}

/* ================================
   GREETING
================================ */
app.post('/twilio/voice', (req, res) => {
  const sid = req.body.CallSid || 'unknown';
  const m   = memFor(sid);
  const st  = stateFor(sid);

  m.length = 0; // new call
  st.silenceNudges = 0;
  st.awaitingUser  = false;

  const greet = 'Hey—this is Gabriel with MyBizPal. How can I help today?';
  st.lastPrompt = greet;
  const xml = twiml(gatherWithPlay({ host: req.headers.host, text: greet, action: '/twilio/handle' }));
  res.type('text/xml').send(xml);
});

/* ================================
   PARTIAL LOGGING
================================ */
app.post('/twilio/partial', bodyParser.urlencoded({ extended: true }), (req, res) => {
  const p = req.body.UnstableSpeechResult || req.body.SpeechResult || '';
  if (p) console.log('PARTIAL:', p);
  res.sendStatus(200);
});

/* ================================
   MAIN HANDLER
================================ */
app.post('/twilio/handle', async (req, res) => {
  try {
    const sid   = req.body.CallSid || 'unknown';
    const said  = (req.body.SpeechResult || '').trim();
    const from  = req.body.From;
    const m     = memFor(sid);
    const st    = stateFor(sid);
    const host  = req.headers.host;

    // SILENCE handling — two nudges ~8s apart then hangup
    if (!said) {
      if (st.awaitingUser) {
        // We asked them to wait (e.g., while booking) → no “take your time” loop.
        const txt = 'One moment—still working on that.';
        st.lastPrompt = txt;
        return res.type('text/xml').send(twiml(playOnly({ host, text: txt })));
      }
      st.silenceNudges++;
      if (st.silenceNudges === 1) {
        const n = 'Take your time—whenever you’re ready.';
        st.lastPrompt = n;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: n })));
      }
      if (st.silenceNudges === 2) {
        const n = 'Are you still there?';
        st.lastPrompt = n;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: n })));
      }
      const bye = `Thanks for calling MyBizPal—have a great ${partOfDay()}.`;
      return res.type('text/xml').send(twiml(`${playOnly({ host, text: bye })}<Hangup/>`));
    }

    st.silenceNudges = 0;

    /* LANGUAGE light-switch (ask once only) */
    if (!st.langConfirmed) {
      const detected = detectLanguage(said);
      if (detected !== 'en' && !st.pendingLang) {
        st.pendingLang = detected;
        const ask = detected === 'es' ? '¿Prefieres que sigamos en español?'
          : detected === 'pt' ? 'Prefere continuar em português?'
          : detected === 'fr' ? 'Préférez-vous continuer en français?'
          : 'Would you like to continue in your language?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      } else if (st.pendingLang) {
        if (yesAny(said)) { st.lang = st.pendingLang; st.langConfirmed = true; st.pendingLang = null; }
        else if (noAny(said)) { st.pendingLang = null; st.lang = 'en'; }
        const ok = st.lang === 'es' ? 'Perfecto—¿en qué te ayudo?'
          : st.lang === 'pt' ? 'Perfeito—como posso ajudar?'
          : st.lang === 'fr' ? 'Parfait—comment puis-je vous aider ?'
          : 'Great—how can I help?';
        st.lastPrompt = ok;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ok })));
      }
    }

    /* PHONE capture path */
    if (st.pendingPhone) {
      const n = normalizeUkPhone(said);
      if (n && isLikelyUk(n)) {
        st.phone = n;
        st.pendingPhone = false;
        const repeat = `Got it — ${slowPhoneSpeak(n)}.`;
        st.lastPrompt = repeat;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: repeat })));
      } else {
        const ask = 'What’s the best mobile number for a quick text confirmation?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
    }

    /* EMAIL capture path */
    if (st.pendingEmail) {
      const e = extractEmail(said);
      if (e) {
        st.email = e;
        st.pendingEmail = false;
        const repeat = `Perfect — I’ll send it to ${slowEmailSpeak(e)}.`;
        st.lastPrompt = repeat;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: repeat })));
      } else {
        const ask = 'What email should I send the calendar invite to?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
    }

    /* SMS receipt confirmation path */
    if (st.awaitingSmsReceipt) {
      if (yesAny(said)) {
        st.awaitingSmsReceipt = false;
        const ask = 'Would you like a text reminder before the meeting, or no reminder?';
        st.pendingReminder = true;
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
      if (noAny(said)) {
        const p = st.phone || from;
        if (p && TWILIO_NUMBER) {
          const sms = 'Re-sent: your MyBizPal confirmation.\n' +
                      `Zoom: ${ZOOM_LINK}\nID: ${ZOOM_MEETING_ID} | Passcode: ${ZOOM_PASSCODE}`;
          await twilioClient.messages.create({ to: p, from: TWILIO_NUMBER, body: sms });
        }
        const msg = 'No problem—just re-sent it now.';
        st.lastPrompt = msg;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: msg })));
      }
      // else keep waiting for a simple yes/no
      const rep = 'Did you receive the text?';
      st.lastPrompt = rep;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: rep })));
    }

    /* Reminder preference */
    if (st.pendingReminder) {
      if (yesAny(said)) { st.smsReminder = true; st.pendingReminder = false; }
      else if (noAny(said)) { st.smsReminder = false; st.pendingReminder = false; }
      else {
        const ask = 'Would you like a text reminder before the meeting, or no reminder?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
      const ok = st.smsReminder ? 'Alright — I’ll text a reminder before we start.' : 'No problem — I won’t send a reminder.';
      st.lastPrompt = ok;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ok })));
    }

    /* Opportunistic phone */
    const maybePhone = normalizeUkPhone(said);
    if (!st.phone && maybePhone && isLikelyUk(maybePhone)) {
      st.phone = maybePhone;
      const rep = `Got it — ${slowPhoneSpeak(maybePhone)}.`;
      st.lastPrompt = rep;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: rep })));
    }

    /* BOOKING INTENT & DATE */
    const nat   = parseNaturalDate(said);
    const wants = /\b(book|schedule|set (up )?(a )?(call|meeting|appointment)|reserve|tomorrow|today|next week)\b/i.test(said);

    if (wants && nat?.iso) {
      st.pendingISO    = nat.iso;
      st.pendingSpoken = nat.spoken;

      // ensure we have phone and email first
      if (!st.phone) {
        st.pendingPhone = true;
        const ask = 'What’s the best mobile number for a quick text confirmation?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }
      if (!st.email) {
        st.pendingEmail = true;
        const ask = 'What email should I send the calendar invite to?';
        st.lastPrompt = ask;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: ask })));
      }

      // BOOK NOW
      st.awaitingUser = true;
      const hold = `Great — locking a MyBizPal 30-minute consultation for ${st.pendingSpoken}. One moment.`;
      const pre = twiml(playOnly({ host, text: hold }));
      // send immediate “please wait” (Twilio requires a response). Then continue by redirecting back to /twilio/handle.
      // Simple approach: return Gather asking nothing but giving time; next user utterance continues flow
      // But we want to continue automatically—so we’ll do the booking before next Gather by inlining:
      let event;
      try {
        const p = isLikelyUk(st.phone) ? st.phone : from;
        event = await bookAppointment({ whenISO: st.pendingISO, email: st.email, phone: p });
        if (st.smsReminder) scheduleReminder({ event, phone: p });
      } catch (e) {
        console.error('Calendar insert failed:', e?.message || e);
        st.awaitingUser = false;
        const fail = 'Hmm—couldn’t book that just now. I’ll note your details and follow up.';
        st.lastPrompt = fail;
        return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: fail })));
      }

      // Ask for SMS receipt
      st.awaitingUser = false;
      st.pendingISO = null; st.pendingSpoken = null;
      st.smsSent = true; st.awaitingSmsReceipt = true;

      const askReceipt = 'I’ve just sent the text—did you receive it?';
      st.lastPrompt = askReceipt;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: askReceipt })));
    }

    // NORMAL CHAT (with subtle steer)
    let hint = '';
    if (/\b(price|cost|how much|fee|quote)\b/i.test(said)) hint = '(INTENT: pricing/enquiry)';
    else if (/\bbook|schedule|appointment|reserve|call\b/i.test(said)) hint = '(INTENT: booking)';

    const saidAug = hint ? `${said}\n\n${hint}` : said;
    const reply   = await llm({ history: m, latestText: saidAug, state: st });
    let voiceReply = reply;

    // Gentle steer if they’re circling a booking topic
    if (/\b(price|cost|how much|timeline|time|demo|consult|book|schedule)\b/i.test(said)) {
      voiceReply = `${reply} If you like, I can secure a quick slot and sort it properly.`;
    }

    // Wrap logic
    if (endAny(said)) {
      const wrap = 'Is there anything else I can help you with?';
      st.lastPrompt = wrap;
      return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: wrap })));
    }

    // Provide response
    st.lastPrompt = voiceReply;
    m.push({ role: 'user', content: said });
    m.push({ role: 'assistant', content: voiceReply });

    return res.type('text/xml').send(twiml(gatherWithPlay({ host, text: voiceReply })));

  } catch (e) {
    console.error('handle error', e);
    return res.type('text/xml').send(twiml('<Hangup/>'));
  }
});

/* ================================
   HANGUP CLEAN
================================ */
app.post('/hangup', (req, res) => {
  const sid = req.body.CallSid;
  if (sid) { CALL_MEMORY.delete(sid); CALL_STATE.delete(sid); }
  res.type('text/xml').send(twiml('<Hangup/>'));
});

/* ================================
   DEBUG ROUTES (safe to keep)
   - GET /debug/env
   - GET /debug/google
   - GET/POST /debug/sms
================================ */
app.get('/debug/env', (req, res) => {
  const essentials = {
    TZ, PORT,
    TWILIO_NUMBER_SET: !!TWILIO_NUMBER,
    GOOGLE_CLIENT_EMAIL_SET: !!process.env.GOOGLE_CLIENT_EMAIL,
    GOOGLE_PRIVATE_KEY_SET: !!process.env.GOOGLE_PRIVATE_KEY,
    CALENDAR_ID: CALENDAR_ID
  };
  res.json({ ok: true, env: essentials });
});

app.get('/debug/google', async (req, res) => {
  try {
    await ensureGoogleAuth();
    const startISO = new Date(Date.now() + 10*60000).toISOString();
    const endISO   = new Date(Date.now() + 25*60000).toISOString();
    const ev = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary: 'MyBizPal DEBUG event',
        start: { dateTime: startISO, timeZone: TZ },
        end:   { dateTime: endISO,   timeZone: TZ }
      },
      sendUpdates: 'none'
    });
    res.json({ ok: true, id: ev.data.id, calendarId: CALENDAR_ID });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});

// quick GET from browser: /debug/sms?to=+447...
app.get('/debug/sms', async (req, res) => {
  try {
    const to = req.query.to;
    if (!to) return res.status(400).json({ ok: false, error: 'Missing ?to=' });
    const r = await twilioClient.messages.create({
      to, from: TWILIO_NUMBER, body: 'MyBizPal debug SMS ✅'
    });
    res.json({ ok: true, sid: r.sid, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});
// POST JSON { "to": "+44..." }
app.post('/debug/sms', async (req, res) => {
  try {
    const to = req.body.to;
    if (!to) return res.status(400).json({ ok: false, error: 'Missing to' });
    const r = await twilioClient.messages.create({
      to, from: TWILIO_NUMBER, body: 'MyBizPal debug SMS ✅'
    });
    res.json({ ok: true, sid: r.sid, to });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || e });
  }
});

/* ================================
   START
================================ */
app.listen(PORT, () => console.log(`✅ IVR running on ${PORT}`));
