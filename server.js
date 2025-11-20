// server.js
// Low-latency Twilio voice server with pre-greeting, barge-in & streaming STT/TTS.

import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import dotenv from 'dotenv';
import { handleTurn } from './logic.js';

dotenv.config();

const {
  TWILIO_AUTH_TOKEN,
  TWILIO_ACCOUNT_SID,
  PUBLIC_BASE_URL, // e.g. "https://mybizpal-booking.onrender.com"
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  ELEVENLABS_MODEL_ID,
} = process.env;

if (!TWILIO_AUTH_TOKEN || !TWILIO_ACCOUNT_SID || !PUBLIC_BASE_URL) {
  console.error(
    'Missing required env vars. Check TWILIO_AUTH_TOKEN, TWILIO_ACCOUNT_SID, PUBLIC_BASE_URL'
  );
  process.exit(1);
}

if (!DEEPGRAM_API_KEY) {
  console.warn('⚠️ No DEEPGRAM_API_KEY set – STT will NOT work.');
}
if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.warn('⚠️ ELEVENLABS_API_KEY or ELEVENLABS_VOICE_ID missing – TTS will NOT work.');
}

const ELEVEN_MODEL = ELEVENLABS_MODEL_ID || 'eleven_flash_v2_5';

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const VoiceResponse = twilio.twiml.VoiceResponse;

// Helper: build ws URL from PUBLIC_BASE_URL
function buildWsUrl() {
  const base = (PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const wsBase = base.replace(/^http/, 'ws'); // http→ws, https→wss
  return `${wsBase}/media-stream`;
}

// ───────────────────────────────────────────────────────────
//  Health
// ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

// ───────────────────────────────────────────────────────────
//  Twilio entrypoint – REALTIME
// ───────────────────────────────────────────────────────────
app.post('/twilio/voice', (req, res) => {
  const twiml = new VoiceResponse();

  const wsUrl = buildWsUrl();
  console.log('📡 Twilio streaming to:', wsUrl);

  const start = twiml.start();
  start.stream({ url: wsUrl });

  // 👇 This is the audible greeting so the caller hears *something* immediately
  twiml.say(
    {
      voice: 'alice',
      language: 'en-GB',
    },
    "Hi, you’re speaking with Gabriel at MyBizPal. One moment while I get set up."
  );

  // Keep the call open while the WebSocket media stream runs
  twiml.pause({ length: 600 });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ───────────────────────────────────────────────────────────
//  HTTP server + WebSocket server
// ───────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const calls = new Map();

function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

server.on('upgrade', (request, socket, head) => {
  const url = request.url || '';
  if (url.startsWith('/media-stream')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// ───────────────────────────────────────────────────────────
//  WebSocket connection for one call
// ───────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let callSid = null;

  const state = {
    lastUserText: '',
    partialUserText: '',
    isTalking: false,
    lastBotUtteranceId: 0,
    deepgramWs: null,
    ttsWs: null,
    sttReady: false,
  };

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('Invalid WS message from Twilio', err);
      return;
    }

    switch (data.event) {
      case 'connected':
        console.log('🔌 Twilio WS connected');
        break;

      case 'start':
        callSid = data.start.callSid;
        calls.set(callSid, { ws, state });
        console.log('🔗 Media stream started for call', callSid);

        // Initial greeting from Gabriel
        speakToCaller(
          "Hi, you’re speaking with Gabriel at MyBizPal. How can I help you today?",
          state
        ).catch((err) => console.error('Initial greeting error', err));
        break;

      case 'media':
        handleIncomingAudio(data.media, state).catch((err) =>
          console.error('handleIncomingAudio error', err)
        );
        break;

      case 'stop':
        console.log('⛔ Media stream stopped for call', callSid);
        if (callSid && calls.has(callSid)) {
          calls.delete(callSid);
        }
        try {
          if (state.deepgramWs) state.deepgramWs.close();
        } catch (e) {}
        try {
          if (state.ttsWs) state.ttsWs.close();
        } catch (e) {}
        ws.close();
        break;
    }
  });

  ws.on('close', () => {
    console.log('🧹 WS closed');
    if (callSid && calls.has(callSid)) {
      calls.delete(callSid);
    }
    try {
      if (state.deepgramWs) state.deepgramWs.close();
    } catch (e) {}
    try {
      if (state.ttsWs) state.ttsWs.close();
    } catch (e) {}
  });

  ws.on('error', (err) => {
    console.error('WebSocket error (Twilio <-> server)', err);
  });
});

// ───────────────────────────────────────────────────────────
//  STT (Deepgram) + Conversation
// ───────────────────────────────────────────────────────────
function ensureDeepgram(state) {
  if (!DEEPGRAM_API_KEY) return null;

  if (state.deepgramWs && state.deepgramWs.readyState === WebSocket.OPEN) {
    return state.deepgramWs;
  }

  const params = new URLSearchParams({
    encoding: 'mulaw',
    sample_rate: '8000',
    channels: '1',
    interim_results: 'true',
    vad_events: 'true',
    smart_format: 'true',
  });

  const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

  const dgWs = new WebSocket(url, {
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    protocol: `token, ${DEEPGRAM_API_KEY}`,
  });

  dgWs.on('open', () => {
    console.log('🎧 Deepgram stream opened');
    state.sttReady = true;
  });

  dgWs.on('message', (msg) => {
    try {
      const dgData = JSON.parse(msg.toString('utf8'));
      if (dgData.type === 'Results' && dgData.channel?.alternatives?.length) {
        const alt = dgData.channel.alternatives[0];
        const transcript = (alt.transcript || '').trim();
        const isFinal = !!dgData.is_final;

        if (!transcript) return;

        if (!isFinal) {
          state.partialUserText = transcript;
        } else {
          state.partialUserText = '';
          console.log('👂 Final user text:', transcript);
          handleUserText(transcript, state).catch((err) =>
            console.error('handleUserText error', err)
          );
        }
      }
    } catch (err) {
      console.error('Deepgram message parse error', err);
    }
  });

  dgWs.on('error', (err) => {
    console.error('Deepgram WS error', err);
    state.sttReady = false;
  });

  dgWs.on('close', () => {
    console.log('🔒 Deepgram stream closed');
    state.deepgramWs = null;
    state.sttReady = false;
  });

  state.deepgramWs = dgWs;
  return dgWs;
}

async function handleIncomingAudio(media, state) {
  const payload = media?.payload;
  if (!payload) return;

  const dgWs = ensureDeepgram(state);
  if (!dgWs) return;

  const audioBuffer = Buffer.from(payload, 'base64');

  if (dgWs.readyState === WebSocket.OPEN) {
    dgWs.send(audioBuffer);
  } else if (dgWs.readyState === WebSocket.CONNECTING) {
    dgWs.send(audioBuffer);
  }
}

async function handleUserText(text, state) {
  if (!text || !text.trim()) return;

  // Barge-in: stop any ongoing TTS
  state.isTalking = false;
  if (state.ttsWs && state.ttsWs.readyState === WebSocket.OPEN) {
    try {
      state.ttsWs.close();
    } catch (e) {}
  }
  state.ttsWs = null;

  state.lastUserText = text;

  const reply = await handleTurn({
    userText: text,
    callState: state,
  });

  if (reply && reply.text) {
    await speakToCaller(reply.text, state);
  }
}

// ───────────────────────────────────────────────────────────
//  TTS: ElevenLabs → Twilio
// ───────────────────────────────────────────────────────────
async function speakToCaller(text, state) {
  if (!text) return;
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('No ElevenLabs API key or voice ID – cannot speak.');
    return;
  }

  state.isTalking = true;
  state.lastBotUtteranceId += 1;
  const utteranceId = state.lastBotUtteranceId;

  const entry = [...calls.values()].find((e) => e.state === state);
  if (!entry) {
    console.warn('No WS entry found for state, cannot send audio');
    return;
  }
  const { ws } = entry;

  const uri = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=${ELEVEN_MODEL}&output_format=ulaw_8000`;

  // ✅ IMPORTANT: send API key as header so ElevenLabs accepts the connection
  const ttsWs = new WebSocket(uri, {
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
    },
  });

  state.ttsWs = ttsWs;

  ttsWs.on('open', () => {
    console.log('🔊 ElevenLabs WS opened');

    // initial settings
    const initMsg = {
      text: ' ', // keep connection alive
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.9,
        use_speaker_boost: true,
      },
      generation_config: {
        chunk_length_schedule: [50, 120, 200],
      },
    };
    ttsWs.send(JSON.stringify(initMsg));

    // actual text
    ttsWs.send(JSON.stringify({ text, flush: true }));
    ttsWs.send(JSON.stringify({ text: '' }));
  });

  ttsWs.on('message', (msg) => {
    if (!state.isTalking || utteranceId !== state.lastBotUtteranceId) return;

    try {
      const data = JSON.parse(msg.toString('utf8'));
      if (data.audio) {
        wsSend(ws, {
          event: 'media',
          media: { payload: data.audio },
        });
      }
      if (data.isFinal) {
        state.isTalking = false;
      }
    } catch (err) {
      console.error('ElevenLabs message error', err);
    }
  });

  ttsWs.on('close', () => {
    console.log('🔕 ElevenLabs WS closed');
    if (state.ttsWs === ttsWs) state.ttsWs = null;
    state.isTalking = false;
  });

  ttsWs.on('error', (err) => {
    console.error('ElevenLabs WS error', err);
    if (state.ttsWs === ttsWs) state.ttsWs = null;
    state.isTalking = false;
  });
}

// ───────────────────────────────────────────────────────────
//  Start server
// ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Voice server listening on port ${PORT}`);
});
