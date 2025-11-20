// server.js
// MyBizPal voice agent – Twilio <-> Deepgram <-> OpenAI <-> ElevenLabs

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';

// ---------- CONFIG ----------

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4o-mini',
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️  PUBLIC_BASE_URL not set – falling back to request Host header.');
}
if (!DEEPGRAM_API_KEY) console.warn('⚠️  DEEPGRAM_API_KEY is not set.');
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY is not set.');
if (!ELEVENLABS_API_KEY) console.warn('⚠️  ELEVENLABS_API_KEY is not set.');
if (!ELEVENLABS_VOICE_ID) console.warn('⚠️  ELEVENLABS_VOICE_ID is not set.');

const SYSTEM_PROMPT = `
You are "Gabriel", the friendly AI assistant for MyBizPal.ai.

Tone:
- Calm, confident, helpful.
- Short, natural sentences like a real person on the phone.
- British-English spelling but neutral accent.

Role:
- Answer questions about MyBizPal.ai and AI automations for small businesses.
- Book demo calls when the caller is interested (just talk about booking; the calendar logic is handled elsewhere).
- Always keep answers concise: 1–3 sentences max.
- If you need information you don't have, say you'll check with the team and follow up by email or text.
`.trim();

// ---------- EXPRESS APP ----------

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Twilio <Say> + <Connect><Stream> webhook
app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Greeting BEFORE streaming starts (Twilio TTS)
  twiml.say(
    {
      voice: 'Polly.Joanna', // or 'alice' etc – Twilio voice
      language: 'en-GB',
    },
    "Hi, you're speaking with Gabriel from MyBizPal. One moment while I get set up."
  );

  const baseUrl =
    PUBLIC_BASE_URL ||
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/media-stream';

  const connect = twiml.connect();
  connect.stream({ url: wsUrl });

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

  // Per-call conversation state
  const state = {
    lastUserTranscript: '',
    isSpeaking: false,
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
      if (transcript === state.lastUserTranscript) return;
      state.lastUserTranscript = transcript;

      if (state.isSpeaking) {
        console.log('🤐 Ignoring because agent is currently speaking');
        return;
      }

      // Get agent reply from OpenAI and speak it
      const reply = await generateAssistantReply(transcript);
      console.log(`🤖 Agent reply: "${reply}"`);

      state.isSpeaking = true;
      try {
        const audioBuffer = await synthesizeWithElevenLabs(reply);
        await sendAudioToTwilio(ws, streamSid, audioBuffer);
      } catch (err) {
        console.error('Error during TTS or sendAudio:', err);
      } finally {
        state.isSpeaking = false;
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
      console.log('▶️  Twilio stream started', { streamSid, callSid });
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

// ---------- AI + TTS HELPERS ----------

async function generateAssistantReply(userText) {
  if (!OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY missing, returning fallback text');
    return "I'm having trouble accessing my brain right now, but normally I'd help you with MyBizPal and AI automations.";
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
      temperature: 0.5,
      max_tokens: 200,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('OpenAI error:', response.status, errText);
    return "I'm sorry, something went wrong when I tried to think about that.";
  }

  const json = await response.json();
  const choice = json.choices?.[0]?.message?.content?.trim();
  return choice || "I'm not sure, but I can connect you with a human from the MyBizPal team.";
}

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
  console.log(
    `==> Healthcheck: http://localhost:${PORT}/health`
  );
  const base = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.log(`==> Twilio WS endpoint: ${base.replace(/^http/, 'ws')}/media-stream`);
  console.log('==> Your service is live 🎉');
  console.log('==> ///////////////////////////////////////////////////////////');
});
