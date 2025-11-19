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

// ───────────────────────────────────────────────────────────
//  Health check – use this for keep-alive pings
// ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, time: new Date().toISOString() });
});

// ───────────────────────────────────────────────────────────
//  Twilio entrypoint – keep this EXTREMELY light
// ───────────────────────────────────────────────────────────
app.post('/twilio/voice', (req, res) => {
  const twiml = new VoiceResponse();

  // Start media stream FIRST so Twilio connects WebSocket immediately
  const start = twiml.start();
  start.stream({
    url: `${PUBLIC_BASE_URL.replace(/\/$/, '')}/media-stream`,
  });

  // Short, cached greeting – doesn't block anything
  twiml.say(
    {
      voice: 'alice',
      language: 'en-GB',
    },
    "Hi, this is your MyBizPal AI concierge. One moment while I get set up."
  );

  res.type('text/xml');
  res.send(twiml.toString());
});

// ───────────────────────────────────────────────────────────
//  HTTP server + WebSocket server
// ───────────────────────────────────────────────────────────
const server = http.createServer(app);

// Twilio will connect here as a media stream
const wss = new WebSocketServer({ noServer: true });

// Map callSid -> per-call state
const calls = new Map();

/**
 * Helper: safe send via WS (Twilio side)
 */
function wsSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Handle upgrade for WebSocket endpoint
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

// ───────────────────────────────────────────────────────────
//  WebSocket connection for a single call
// ───────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let callSid = null;

  // Per-call state – kept minimal for speed
  const state = {
    lastUserText: '',
    partialUserText: '',
    isTalking: false, // Is bot currently speaking
    lastBotUtteranceId: 0, // For cancelling TTS on barge-in

    // STT / TTS streams
    deepgramWs: null,
    ttsWs: null,
    sttReady: false,
  };

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('Invalid WS message', err);
      return;
    }

    // Twilio media stream events
    switch (data.event) {
      case 'connected':
        // nothing heavy here
        break;

      case 'start':
        callSid = data.start.callSid;
        calls.set(callSid, { ws, state });
        console.log('🔗 Media stream started for call', callSid);
        break;

      case 'media':
        // Here you receive base64-encoded audio chunks (8kHz μ-law).
        // Feed into streaming STT.
        handleIncomingAudio(data.media, state).catch((err) =>
          console.error('handleIncomingAudio error', err)
        );
        break;

      case 'stop':
        console.log('⛔ Media stream stopped for call', callSid);
        if (callSid && calls.has(callSid)) {
          calls.delete(callSid);
        }
        // Clean up external websockets
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
    console.error('WebSocket error', err);
  });
});

// ───────────────────────────────────────────────────────────
//  STT + Conversation handling
// ───────────────────────────────────────────────────────────

/**
 * Ensure we have a live Deepgram WebSocket for this call.
 * Twilio sends 8kHz μ-law, so we set encoding/sample_rate to match.
 */
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
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
    },
    protocol: `token, ${DEEPGRAM_API_KEY}`,
  });

  dgWs.on('open', () => {
    console.log('🎧 Deepgram stream opened');
    state.sttReady = true;
  });

  dgWs.on('message', (msg) => {
    try {
      const dgData = JSON.parse(msg.toString('utf8'));

      // We care about transcription Results
      if (dgData.type === 'Results' && dgData.channel?.alternatives?.length) {
        const alt = dgData.channel.alternatives[0];
        const transcript = (alt.transcript || '').trim();
        const isFinal = !!dgData.is_final;

        if (!transcript) return;

        if (!isFinal) {
          // partial – handy if you ever want to stream partials back
          state.partialUserText = transcript;
        } else {
          // final utterance – this is one "turn"
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

/**
 * This function is called with audio frames from Twilio.
 *  - We forward μ-law audio frames to Deepgram over WS
 */
async function handleIncomingAudio(media, state) {
  const payload = media?.payload;
  if (!payload) return;

  const dgWs = ensureDeepgram(state);
  if (!dgWs) return;

  // Twilio sends base64-encoded μ-law 8kHz audio; Deepgram accepts raw bytes.
  const audioBuffer = Buffer.from(payload, 'base64');

  if (dgWs.readyState === WebSocket.OPEN) {
    dgWs.send(audioBuffer);
  } else if (dgWs.readyState === WebSocket.CONNECTING) {
    // 'ws' will buffer sends during CONNECTING, so this is okay
    dgWs.send(audioBuffer);
  }
}

/**
 * Called once STT has produced a final transcription for the user utterance.
 *  - stop any ongoing TTS (barge-in)
 *  - pass text to LLM logic
 *  - stream TTS back to Twilio
 */
async function handleUserText(text, state) {
  if (!text || !text.trim()) return;

  // Barge-in: stop current TTS stream, if any
  state.isTalking = false;
  if (state.ttsWs && state.ttsWs.readyState === WebSocket.OPEN) {
    try {
      state.ttsWs.close();
    } catch (e) {}
  }
  state.ttsWs = null;

  state.lastUserText = text;

  // Ask your logic/LLM what to say next.
  // handleTurn is imported from logic.js and MUST be fast + streaming-friendly.
  const reply = await handleTurn({
    userText: text,
    callState: state,
  });

  // reply: { text, ssml?, endCall? }
  if (reply && reply.text) {
    await speakToCaller(reply.text, state);
  }
}

// ───────────────────────────────────────────────────────────
//  TTS: ElevenLabs WebSocket → Twilio media stream
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

  // Get the Twilio WS for this call from `calls` map
  const entry = [...calls.values()].find((e) => e.state === state);
  if (!entry) return;
  const { ws } = entry;

  const uri = `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?model_id=${ELEVEN_MODEL}&output_format=ulaw_8000`;

  const ttsWs = new WebSocket(uri);

  state.ttsWs = ttsWs;

  ttsWs.on('open', () => {
    // Initial settings + auth message
    const initMsg = {
      text: ' ', // keep connection alive
      voice_settings: {
        stability: 0.3,
        similarity_boost: 0.9,
        use_speaker_boost: true,
      },
      generation_config: {
        // shorter chunks = lower latency
        chunk_length_schedule: [50, 120, 200],
      },
      xi_api_key: ELEVENLABS_API_KEY,
    };
    ttsWs.send(JSON.stringify(initMsg));

    // Actual text, flushed so it speaks immediately
    ttsWs.send(
      JSON.stringify({
        text,
        flush: true,
      })
    );

    // Empty text closes out the generation when done
    ttsWs.send(JSON.stringify({ text: '' }));
  });

  ttsWs.on('message', (msg) => {
    // If user barged in and a newer utterance started, drop this audio
    if (!state.isTalking || utteranceId !== state.lastBotUtteranceId) {
      return;
    }

    try {
      const data = JSON.parse(msg.toString('utf8'));

      if (data.audio) {
        // ElevenLabs sends base64-encoded audio (ulaw_8000 now) – perfect for Twilio.
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
    if (state.ttsWs === ttsWs) {
      state.ttsWs = null;
    }
    state.isTalking = false;
  });

  ttsWs.on('error', (err) => {
    console.error('ElevenLabs WS error', err);
    if (state.ttsWs === ttsWs) {
      state.ttsWs = null;
    }
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
