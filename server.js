// server.js
// MyBizPal voice agent – Twilio <-> Deepgram <-> OpenAI (logic.js) <-> ElevenLabs

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { handleTurn } from './logic.js';

// ---------- CONFIG ----------

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️  PUBLIC_BASE_URL not set – falling back to request Host header.');
}
if (!DEEPGRAM_API_KEY) console.warn('⚠️  DEEPGRAM_API_KEY is not set.');
if (!ELEVENLABS_API_KEY) console.warn('⚠️  ELEVENLABS_API_KEY is not set.');
if (!ELEVENLABS_VOICE_ID) console.warn('⚠️  ELEVENLABS_VOICE_ID is not set.');

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️  TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — hangup control disabled.');
}

// ---------- EXPRESS APP ----------

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Twilio <Connect><Stream> webhook
app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const baseUrl =
    PUBLIC_BASE_URL ||
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/media-stream';

  const fromNumber = req.body?.From || '';

  const connect = twiml.connect();
  // Pass caller number into the media stream as a custom parameter
  connect.stream({
    url: wsUrl,
    parameters: {
      caller: fromNumber,
    },
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// (optional) simple root
app.get('/', (_req, res) => {
  res.send('MyBizPal voice agent is running.');
});

// ---------- HTTP + WS SERVER ----------

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/media-stream',
});

console.log('🎧 Setting up WebSocket /media-stream');

wss.on('connection', (ws, req) => {
  console.log('🔔 New Twilio media WebSocket connection from', req.socket.remoteAddress);

  let streamSid = null;
  let callSid = null;

  // Per-call state
  const callState = {
    lastUserTranscript: '',
    isSpeaking: false,
    callerNumber: null,
    booking: null,
    history: [],
  };

  // ---- Deepgram connection (STT) ----
  const dgUrl =
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&vad_events=true';

  const dgSocket = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
    },
  });

  dgSocket.on('open', () => {
    console.log('🎧 Deepgram stream opened');
  });

  dgSocket.on('close', () => {
    console.log('🔒 Deepgram stream closed');
  });

  dgSocket.on('error', (err) => {
    console.error('Deepgram WS error', err);
  });

  dgSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.channel || !msg.channel.alternatives) return;

      const alt = msg.channel.alternatives[0];
      const transcript = alt.transcript?.trim();
      if (!transcript) return;

      const isFinal = msg.is_final;
      if (!isFinal) return; // only react to final segments

      console.log(`👤 Caller said: "${transcript}"`);

      // Avoid reacting twice to the same text
      if (transcript === callState.lastUserTranscript) return;
      callState.lastUserTranscript = transcript;

      if (callState.isSpeaking) {
        console.log('🤐 Ignoring because agent is currently speaking');
        return;
      }

      // Get agent reply from our "brain" (logic.js)
      const { text: reply, shouldHangup } = await handleTurn({
        userText: transcript,
        callState,
      });
      console.log(`🤖 Agent reply: "${reply}"`);

      callState.isSpeaking = true;
      try {
        const audioBuffer = await synthesizeWithElevenLabs(reply);
        await sendAudioToTwilio(ws, streamSid, audioBuffer);

        if (shouldHangup && twilioClient && callSid) {
          console.log('☎️  Scheduling hangup for call', callSid);
          // Small delay so last audio finishes playing before hangup
          setTimeout(async () => {
            try {
              await twilioClient
                .calls(callSid)
                .update({ status: 'completed' });
              console.log('☎️  Call hangup requested for', callSid);
            } catch (err) {
              console.error('Error hanging up call:', err);
            }
          }, 500);
        }
      } catch (err) {
        console.error('Error during TTS or sendAudio:', err);
      } finally {
        callState.isSpeaking = false;
      }
    } catch (err) {
      console.error('Error handling Deepgram message:', err);
    }
  });

  // ---- Twilio media messages ----
  ws.on('message', (msgBuf) => {
    let msg;
    try {
      msg = JSON.parse(msgBuf.toString());
    } catch (err) {
      console.error('Failed to parse Twilio WS message:', err);
      return;
    }

    const { event } = msg;

    if (event === 'start') {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      const caller = msg.start.customParameters?.caller || null;
      callState.callerNumber = caller;
      console.log('▶️  Twilio stream started', { streamSid, callSid, caller });
      return;
    }

    if (event === 'media') {
      if (dgSocket.readyState === WebSocket.OPEN) {
        try {
          const payload = msg.media.payload;
          const audio = Buffer.from(payload, 'base64');
          dgSocket.send(audio);
        } catch (err) {
          console.error('handleIncomingAudio error', err);
        }
      }
      return;
    }

    if (event === 'stop') {
      console.log('⏹️  Twilio stream stopped', { streamSid, callSid });
      try {
        dgSocket.close();
      } catch (e) {
        // ignore
      }
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    console.log('❌ Twilio WS closed');
    try {
      dgSocket.close();
    } catch {}
  });

  ws.on('error', (err) => {
    console.error('Twilio WS error', err);
    try {
      dgSocket.close();
    } catch {}
  });
});

// ---------- ElevenLabs TTS ----------

async function synthesizeWithElevenLabs(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('ElevenLabs config missing – returning empty Buffer');
    return Buffer.alloc(0);
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'audio/ulaw;rate=8000',
    },
    body: JSON.stringify({
      text,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('ElevenLabs error:', res.status, errText);
    throw new Error(`ElevenLabs TTS failed: ${res.status}`);
  }

  const chunks = [];
  for await (const chunk of res.body) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Send mulaw 8k audio back to Twilio over the media stream.
 * Twilio expects 20ms frames of 160 bytes each (PCMU).
 */
function sendAudioToTwilio(ws, streamSid, audioBuffer) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WS not open – cannot send audio');
      return resolve();
    }

    if (!streamSid) {
      console.warn('No streamSid yet – cannot send audio');
      return resolve();
    }

    const chunkSize = 160; // 20ms of 8kHz μ-law
    let offset = 0;

    const sendChunk = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return resolve();
      }

      if (offset >= audioBuffer.length) {
        return resolve();
      }

      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      offset += chunkSize;

      const payload = chunk.toString('base64');
      const msg = {
        event: 'media',
        streamSid,
        media: { payload },
      };

      ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          console.error('Error sending audio chunk to Twilio:', err);
          return resolve();
        }
        setTimeout(sendChunk, 20); // 20ms per frame
      });
    };

    sendChunk();
  });
}

// ---------- START SERVER ----------

server.listen(PORT, () => {
  console.log('==> ///////////////////////////////////////////////////////////');
  console.log(`==> MyBizPal voice server listening on port ${PORT}`);
  console.log(`==> Healthcheck: http://localhost:${PORT}/health`);
  const base = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.log(`==> Twilio WS endpoint: ${base.replace(/^http/, 'ws')}/media-stream`);
  console.log('==> Your service is live 🎉');
  console.log('==> ///////////////////////////////////////////////////////////');
});
