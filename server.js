// server.js
// MyBizPal voice agent – Twilio <-> Deepgram <-> OpenAI <-> ElevenLabs

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import OpenAI from "openai";

// ---------- CONFIG ----------

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  OPENAI_MODEL = 'gpt-4.1-mini',
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️ PUBLIC_BASE_URL not set – falling back to Host header');
}
if (!DEEPGRAM_API_KEY) console.warn('⚠️ DEEPGRAM_API_KEY missing');
if (!OPENAI_API_KEY) console.warn('⚠️ OPENAI_API_KEY missing');
if (!ELEVENLABS_API_KEY) console.warn('⚠️ ELEVENLABS_API_KEY missing');
if (!ELEVENLABS_VOICE_ID) console.warn('⚠️ ELEVENLABS_VOICE_ID missing');

// OpenAI SDK client
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// ---------- SYSTEM PROMPT ----------

const SYSTEM_PROMPT = `
You are "Gabriel", the friendly AI assistant for MyBizPal.ai.

Tone:
- Calm, confident, helpful.
- Short, natural sentences like a real person on the phone.
- British-English spelling but neutral accent.

Role:
- Answer questions about MyBizPal.ai and AI automations for small businesses.
- Book demo calls when caller is interested (the calendar logic is handled separately).
- Be concise: 1–3 sentences max.
- If unsure, say you'll check with the team and follow up.
`.trim();

// ---------- EXPRESS ----------

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// ======================================================
// REMOVE TWILIO LADY — STREAM STARTS IMMEDIATELY
// ======================================================

app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // NO SAY(), NO GREETING — AI STARTS FIRST
  const baseUrl =
    PUBLIC_BASE_URL ||
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/media-stream';

  const connect = twiml.connect();
  connect.stream({ url: wsUrl });

  res.type('text/xml').send(twiml.toString());
});

// Root
app.get('/', (req, res) => {
  res.send('MyBizPal voice agent is running.');
});

// ---------- HTTP + WS SERVER ----------

const server = http.createServer(app);

const wss = new WebSocketServer({
  server,
  path: '/media-stream',
});

console.log("🎧 WebSocket /media-stream ready");

wss.on('connection', (ws, req) => {
  console.log("🔔 New Twilio media stream");

  let streamSid = null;

  // Per-call state
  const state = {
    lastUserTranscript: '',
    isSpeaking: false,
  };

  // ---------- Deepgram STT ----------
  const dgSocket = new WebSocket(
    'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&vad_events=true',
    {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    }
  );

  dgSocket.on('open', () => console.log("🎧 Deepgram connected"));
  dgSocket.on('close', () => console.log("🔒 Deepgram closed"));
  dgSocket.on('error', (err) => console.error("Deepgram error:", err));

  dgSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.channel?.alternatives) return;

      const transcript = msg.channel.alternatives[0]?.transcript?.trim();
      const isFinal = msg.is_final;

      if (!transcript || !isFinal) return;

      console.log(`👤 Caller said: "${transcript}"`);

      // Prevent duplicates
      if (transcript === state.lastUserTranscript) return;
      state.lastUserTranscript = transcript;

      if (state.isSpeaking) return;

      const reply = await generateReply(transcript);
      console.log(`🤖 Agent reply: "${reply}"`);

      state.isSpeaking = true;

      try {
        const audio = await speakElevenLabs(reply);
        await sendAudio(ws, streamSid, audio);
      } catch (e) {
        console.error("TTS/send error:", e);
      }

      state.isSpeaking = false;
    } catch (e) {
      console.error("DG msg error:", e);
    }
  });

  // ---------- Twilio Media Messages ----------
  ws.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch (e) {
      return console.error("Twilio parse error:", e);
    }

    const event = msg.event;

    if (event === 'start') {
      streamSid = msg.start.streamSid;
      console.log("▶️ Stream started", streamSid);
      return;
    }

    if (event === 'media') {
      if (dgSocket.readyState === WebSocket.OPEN) {
        const audio = Buffer.from(msg.media.payload, 'base64');
        dgSocket.send(audio);
      }
      return;
    }

    if (event === 'stop') {
      console.log("⏹️ Stream stopped");
      try { dgSocket.close(); } catch {}
      ws.close();
      return;
    }
  });

  ws.on('close', () => {
    console.log("❌ WS closed");
    try { dgSocket.close(); } catch {}
  });
});

// ======================================================
// AI + TTS HELPERS
// ======================================================

async function generateReply(userText) {
  try {
    const completion = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      temperature: 0.6,
      max_tokens: 150,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userText }
      ]
    });

    return completion.choices[0].message.content.trim();
  } catch (e) {
    console.error("OpenAI error:", e);
    return "I'm sorry — I'm having a bit of trouble thinking right now.";
  }
}

async function speakElevenLabs(text) {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=4&output_format=ulaw_8000`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      "xi-api-key": ELEVENLABS_API_KEY,
      "Content-Type": "application/json",
      "Accept": "audio/ulaw;rate=8000"
    },
    body: JSON.stringify({
      text,
      voice_settings: { stability: 0.4, similarity_boost: 0.85 }
    })
  });

  if (!res.ok) {
    console.error("ElevenLabs error:", await res.text());
    return Buffer.alloc(0);
  }

  const chunks = [];
  for await (const c of res.body) chunks.push(c);
  return Buffer.concat(chunks);
}

function sendAudio(ws, streamSid, audioBuffer) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return resolve();
    if (!streamSid) return resolve();

    const chunkSize = 160;
    let offset = 0;

    const sendChunk = () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return resolve();
      if (offset >= audioBuffer.length) return resolve();

      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      offset += chunkSize;

      ws.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: chunk.toString('base64') }
        }),
        () => setTimeout(sendChunk, 20)
      );
    };

    sendChunk();
  });
}

// ---------- START SERVER ----------
server.listen(PORT, () => {
  console.log(`🚀 MyBizPal voice agent live on port ${PORT}`);
});
