// server.js — MyBizPal v2 + Realtime Media Streams
// Name in title + single active booking + warmer UX + faster TTS + low-latency WS pipeline

import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';

import OpenAI from 'openai';
import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

import twilio from 'twilio';
import { google } from 'googleapis';

import { handleTurn } from './logic.js';

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
   TWILIO (SMS / TWIML)
================================ */
const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  throw new Error('Missing TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN');
}
const twilioClient  = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const TWILIO_NUMBER = process.env.TWILIO_NUMBER || process.env.SMS_FROM; // +447...
const VoiceResponse = twilio.twiml.VoiceResponse;

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
        stability: 0.3,
        similarity_boost: 0.92,
        speaking_rate: 0.92,
        style: 0.35,
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
   SIMPLE HEALTH CHECK (for pings / uptime)
================================ */
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

/* ================================
   STATE
================================ */
const CALL_MEMORY = new Map();  // CallSid -> [{role, content}]
const CALL_STATE  = new Map();  // CallSid -> state

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
// [.. all your existing helper functions here unchanged ..]
// (I’m not repeating them for brevity, but in your file keep everything from
// extractName, parseUkPhone, isLikelyUkNumberPair, slowPhoneSpeak, extractEmail,
// userAskedToWait, parseNaturalDate, yesInAnyLang, noInAnyLang, calendar helpers,
// llm(), continueBookingIfReady(), etc. EXACTLY as you have them.)

//  ──────────────────────────────────────────────────────────
//  *** keep your entire middle section exactly as-is ***
//  from extractName(...) all the way down to /start-call
//  ──────────────────────────────────────────────────────────

/*  ▸▸▸  I won't re-paste that huge block to save space here,
    but you should keep it unchanged in your file.  */
/*  The only *new* bits start again below with REALTIME ENTRY
    and the START section with http + WebSocket.              */


/* ================================
   REALTIME VOICE ENTRY (Media Streams)
   Use this URL on a Twilio number for low-latency streaming:
   https://your-domain/twilio/voice-stream
================================ */
app.post('/twilio/voice-stream', (req, res) => {
  const vr = new VoiceResponse();

  const base =
    process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') ||
    `https://${req.headers.host}`;

  // Start media stream FIRST so Twilio connects WebSocket immediately
  const start = vr.start();
  start.stream({ url: `${base}/media-stream` });

  vr.say(
    { voice: 'alice', language: 'en-GB' },
    "Hi, this is your MyBizPal AI concierge. One moment while I get set up."
  );

  res.type('text/xml').send(vr.toString());
});

/* ================================
   EXISTING GATHER-BASED FLOW
   (everything from /twilio/voice, /twilio/handle,
    /twilio/reprompt, /hangup, /debug, /start-call)
   stays EXACTLY as you already have it.
================================ */

// ... keep your existing /twilio/voice, /twilio/partial, /twilio/handle,
// /twilio/reprompt, /hangup, /debug/google, /debug/sms, /debug/env,
// and /start-call routes here unchanged ...

/* ================================
   REALTIME MEDIA STREAM WS PIPELINE
   (separate from your Gather IVR)
================================ */
const server = http.createServer(app);

// Twilio will connect here as a media stream
const wss = new WebSocketServer({ noServer: true });

// Map callSid -> per-call realtime state
const REALTIME_CALLS = new Map();

/** Helper: safe send via WS */
function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Upgrade handler for WebSocket endpoint
server.on('upgrade', (request, socket, head) => {
  const { url } = request;
  if (url === '/media-stream') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

/* WebSocket connection for a single realtime call */
wss.on('connection', (ws) => {
  let callSid = null;

  const state = {
    lastUserText: '',
    partialUserText: '',
    isTalking: false,
    lastBotUtteranceId: 0,
    history: [],
    summary: '',
    _callSid: null,
  };

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('Invalid WS message', err);
      return;
    }

    switch (data.event) {
      case 'connected':
        break;

      case 'start':
        callSid = data.start.callSid;
        state._callSid = callSid;
        REALTIME_CALLS.set(callSid, { ws, state });
        break;

      case 'media':
        // base64 μ-law 8kHz audio frame → STT
        handleIncomingAudio(data.media, state).catch(console.error);
        break;

      case 'stop':
        if (callSid && REALTIME_CALLS.has(callSid)) {
          REALTIME_CALLS.delete(callSid);
        }
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    if (callSid && REALTIME_CALLS.has(callSid)) {
      REALTIME_CALLS.delete(callSid);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error', err);
  });
});

/**
 * STT hook – implement your streaming STT here.
 * For now it's a no-op; when you wire STT, call handleUserText()
 * once you have a final transcription.
 */
async function handleIncomingAudio(media, state) {
  // media.payload is base64 μ-law audio.
  // Decode + feed to your STT stream.
  // On final text:
  //   await handleUserText(finalText, state);
}

/** Called when STT has a final user utterance */
async function handleUserText(text, state) {
  if (!text || !text.trim()) return;

  state.isTalking = false;
  state.lastUserText = text;

  const reply = await handleTurn({ userText: text, callState: state });

  if (reply && reply.text) {
    await speakToCaller(reply.text, state);
  }
}

/** Stream bot speech back to Twilio via WS */
async function speakToCaller(text, state) {
  if (!text) return;

  state.isTalking = true;
  state.lastBotUtteranceId += 1;
  const utteranceId = state.lastBotUtteranceId;

  const entry = REALTIME_CALLS.get(state._callSid);
  if (!entry) return;
  const { ws } = entry;

  // Here you plug in your streaming TTS (e.g. ElevenLabs/RT)
  // and send audio chunks as Twilio "media" events.
  //
  // Example pseudo-code:
  //
  // const ttsStream = yourTtsClient.stream({ text });
  // for await (const chunk of ttsStream) {
  //   if (!state.isTalking || utteranceId !== state.lastBotUtteranceId) break;
  //   const base64Audio = chunk.toString('base64');
  //   wsSend(ws, { event: 'media', media: { payload: base64Audio } });
  // }
  //
  state.isTalking = false;
}

/* ================================
   START
================================ */
server.listen(PORT, () => {
  console.log(`✅ IVR + realtime server running on ${PORT}`);
});
