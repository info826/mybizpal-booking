// server.js
// MyBizPal booking voice server – Twilio <-> WebSocket <-> Deepgram

import express from 'express';
import http from 'http';
import { urlencoded } from 'body-parser';
import { WebSocketServer } from 'ws';
import Twilio from 'twilio';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

dotenv.config();

// ===== ENV =====
const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  TWILIO_AUTH_TOKEN,
  DEEPGRAM_API_KEY,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️ PUBLIC_BASE_URL is not set – Twilio <Stream> URL may be wrong.');
}
if (!DEEPGRAM_API_KEY) {
  console.warn('⚠️ DEEPGRAM_API_KEY is not set – Deepgram streaming will be disabled.');
}

// ===== APP / SERVER SETUP =====
const app = express();
app.use(urlencoded({ extended: false }));

const server = http.createServer(app);

// Twilio helper (only for webhook signature if we enable it)
const twilio = Twilio('', TWILIO_AUTH_TOKEN);
const { VoiceResponse } = Twilio.twiml;

// ===== SIMPLE HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ===== (OPTIONAL) CRON STUB – so existing Render cron URL keeps working =====
app.post('/cron/reminders', (req, res) => {
  console.log('⏰ /cron/reminders called');
  res.json({ ok: true });
});

// ===== TWILIO VOICE WEBHOOK =====
//
// This answers the call, plays your intro, then opens a media stream to /media-stream.
// NO hangup here – Twilio keeps the stream open until the caller or your code closes it.
app.post('/twilio/voice', (req, res) => {
  try {
    const twiml = new VoiceResponse();

    twiml.say(
      {
        voice: 'Polly.Brian', // UK-ish male; change if you like
      },
      "Hi, you're speaking with Gabriel from MyBizPal. One moment while I get set up."
    );

    const baseUrl = PUBLIC_BASE_URL?.replace(/\/$/, '') || `https://${req.headers.host}`;

    twiml.connect().stream({
      url: `${baseUrl.replace('http://', 'wss://').replace('https://', 'wss://')}/media-stream`,
      track: 'inbound_track',
    });

    console.log('📞 /twilio/voice answering call, streaming to /media-stream');

    res.type('text/xml').send(twiml.toString());
  } catch (err) {
    console.error('Error in /twilio/voice handler', err);
    const twiml = new VoiceResponse();
    twiml.say(
      {
        voice: 'Polly.Brian',
      },
      'Sorry, something went wrong setting up the assistant. Please try again later.'
    );
    twiml.hangup();
    res.type('text/xml').send(twiml.toString());
  }
});

// ===== MEDIA STREAM <-> DEEPGRAM BRIDGE =====

/**
 * For each Twilio media WebSocket we maintain a single Deepgram WS.
 * We avoid the 429 storm by:
 *  - creating at most 1 DG connection per Twilio connection
 *  - never reconnecting in a tight loop
 */

const calls = new Map(); // key: streamSid, value: { callSid, twilioWs, dgWs, createdAt }

function openDeepgramStream(streamSid) {
  if (!DEEPGRAM_API_KEY) {
    console.warn('🚫 No DEEPGRAM_API_KEY – skipping Deepgram connection');
    return null;
  }

  const dgUrl =
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&vad_events=true';

  const headers = {
    Authorization: `Token ${DEEPGRAM_API_KEY}`,
  };

  const ws = new WebSocket(dgUrl, { headers });

  ws.on('open', () => {
    console.log(`🎧 Deepgram stream opened for streamSid=${streamSid}`);
  });

  ws.on('close', () => {
    console.log(`🔒 Deepgram stream closed for streamSid=${streamSid}`);
  });

  ws.on('error', (err) => {
    console.error('Deepgram WS error', err?.message || err);
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      const transcript =
        msg.channel?.alternatives?.[0]?.transcript || msg.alt?.[0]?.transcript;
      const isFinal = msg.is_final || msg.type === 'final';

      if (transcript && transcript.trim()) {
        console.log(
          `🗣️  Deepgram transcript (${isFinal ? 'final' : 'partial'}):`,
          transcript
        );
        // TODO: here is where you can call your logic.js -> handleTurn()
        // to drive AI responses + calendar + SMS.
      }
    } catch (err) {
      console.error('Error parsing Deepgram message', err);
    }
  });

  return ws;
}

// WebSocket server bound to HTTP server
const wss = new WebSocketServer({ server, path: '/media-stream' });

wss.on('connection', (ws) => {
  console.log('🔌 Twilio media WebSocket connected');

  let streamSid = null;
  let callSid = null;
  let dgWs = null;

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg.toString());
      const event = data.event;

      if (event === 'start') {
        streamSid = data.start.streamSid;
        callSid = data.start.callSid;
        console.log(
          `▶️  Media stream started: callSid=${callSid}, streamSid=${streamSid}`
        );

        // Create & store Deepgram WS (single instance per Twilio stream)
        dgWs = openDeepgramStream(streamSid);
        calls.set(streamSid, { callSid, twilioWs: ws, dgWs, createdAt: Date.now() });

        return;
      }

      if (event === 'media') {
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          const payload = data.media.payload;
          if (payload) {
            const audio = Buffer.from(payload, 'base64');
            dgWs.send(audio);
          }
        }
        return;
      }

      if (event === 'stop') {
        console.log(`⏹️  Media stream stopped: streamSid=${streamSid}`);
        if (dgWs && dgWs.readyState === WebSocket.OPEN) {
          dgWs.close();
        }
        calls.delete(streamSid);
        return;
      }
    } catch (err) {
      console.error('Error handling Twilio media message', err);
    }
  });

  ws.on('close', () => {
    console.log('🧹 WS closed');
    if (streamSid && calls.has(streamSid)) {
      const info = calls.get(streamSid);
      if (info.dgWs && info.dgWs.readyState === WebSocket.OPEN) {
        info.dgWs.close();
      }
      calls.delete(streamSid);
    }
  });

  ws.on('error', (err) => {
    console.error('Twilio WS error', err?.message || err);
  });
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log('▶️  Running `node server.js`');
  console.log(`📞 Voice server listening on port ${PORT}`);
  console.log('✅ Your service is live 🎉');
  console.log(
    `==> Available at your primary URL ${PUBLIC_BASE_URL || 'http://localhost:' + PORT}`
  );
});
