// server.js
// Clean, ESM-based Twilio <> Deepgram <> OpenAI voice agent
// No cors, no body-parser – only Express' built-in parsers.

import 'dotenv/config';
import http from 'http';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import OpenAI from 'openai';

// ----- ENV & BASIC SETUP ----------------------------------------------------

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
} = process.env;

if (!DEEPGRAM_API_KEY) {
  console.warn('⚠️  DEEPGRAM_API_KEY is not set – streaming ASR will fail.');
}
if (!OPENAI_API_KEY) {
  console.warn('⚠️  OPENAI_API_KEY is not set – agent replies will fail.');
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const { VoiceResponse } = twilio.twiml;

const app = express();

// Use ONLY Express parsers – no body-parser.
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ----- HEALTHCHECK ----------------------------------------------------------

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// ----- TWILIO VOICE WEBHOOK -------------------------------------------------

// Twilio hits this when someone calls your number
app.post('/twilio/voice', (req, res) => {
  const twiml = new VoiceResponse();

  // Short intro so you hear *something* even if streaming is slow
  twiml.say(
    { voice: 'alice', language: 'en-GB' },
    'Hi, you are speaking with Gabriel from My Biz Pal. One moment while I get set up.'
  );

  const connect = twiml.connect();

  // IMPORTANT: this must match the WS endpoint we expose below.
  // Use your Render hostname with wss://
  const streamUrl =
    process.env.STREAM_URL ||
    'wss://mybizpal-booking.onrender.com/media-stream';

  connect.stream({ url: streamUrl });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ----- HTTP + WEBSOCKET SERVER ----------------------------------------------

const server = http.createServer(app);

// All Twilio media streams connect here via WebSocket
const wss = new WebSocketServer({ server, path: '/media-stream' });

// Small helper
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ----- CALL SESSION OBJECT ---------------------------------------------------

function createCallSession(ws) {
  return {
    ws,
    streamSid: null,
    deepgramWs: null,
    deepgramReady: false,
    deepgramQueue: [], // audio chunks waiting for DG socket to open
    closed: false,
    processing: false, // avoid overlapping LLM turns
    history: [
      {
        role: 'system',
        content:
          "You are Gabriel, a friendly, concise AI phone concierge for MyBizPal. " +
          "You help callers understand the services, answer basic questions, and book a discovery call. " +
          "Be short, natural, and sound like a human British customer service agent.",
      },
    ],
  };
}

// ----- DEEPGRAM CONNECTION PER CALL -----------------------------------------

function attachDeepgram(session) {
  if (!DEEPGRAM_API_KEY) return;

  const dgUrl =
    'wss://api.deepgram.com/v1/listen' +
    '?encoding=mulaw&sample_rate=8000&channels=1' +
    '&interim_results=true&vad_events=true';

  const dgWs = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${DEEPGRAM_API_KEY}`,
    },
  });

  session.deepgramWs = dgWs;

  dgWs.on('open', () => {
    console.log('🎧 Deepgram stream opened');
    session.deepgramReady = true;

    // Flush any queued audio that arrived before DG opened
    for (const buf of session.deepgramQueue) {
      dgWs.send(buf);
    }
    session.deepgramQueue = [];
  });

  dgWs.on('error', (err) => {
    console.error('Deepgram WS error', err);
  });

  dgWs.on('close', () => {
    console.log('🔒 Deepgram stream closed');
    session.deepgramReady = false;
  });

  dgWs.on('message', async (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (!data || data.type !== 'results') return;
      const result = data.channel?.alternatives?.[0];
      if (!result) return;

      const transcript = result.transcript?.trim();
      const isFinal = data.is_final;

      if (!transcript || !isFinal) return;

      console.log('👂 User said:', transcript);

      // process user message with OpenAI and stream back to Twilio
      await handleUserTurn(session, transcript);
    } catch (err) {
      console.error('Error parsing Deepgram message', err);
    }
  });
}

// ----- HANDLE A COMPLETE USER UTTERANCE -------------------------------------

async function handleUserTurn(session, userText) {
  if (session.processing) {
    console.log('⚠️  Still processing previous turn, ignoring for now.');
    return;
  }

  session.processing = true;
  try {
    session.history.push({ role: 'user', content: userText });

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: session.history,
      temperature: 0.6,
      max_tokens: 300,
    });

    const assistantText =
      completion.choices[0]?.message?.content?.trim() ||
      "I'm sorry, something went wrong on my side.";

    console.log('🧠 Assistant:', assistantText);
    session.history.push({ role: 'assistant', content: assistantText });

    // Turn the assistant text into 8k mulaw audio
    const tts = await openai.audio.speech.create({
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      format: 'mulaw',
      sample_rate: 8000,
      input: assistantText,
    });

    const audioBuffer = Buffer.from(await tts.arrayBuffer());

    await streamAudioToTwilio(session, audioBuffer);
  } catch (err) {
    console.error('Error in handleUserTurn:', err);
  } finally {
    session.processing = false;
  }
}

// ----- STREAM AUDIO BACK TO TWILIO -----------------------------------------

async function streamAudioToTwilio(session, audioBuffer) {
  const { ws, streamSid } = session;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn('⚠️  Twilio WS not open, cannot stream audio.');
    return;
  }
  if (!streamSid) {
    console.warn('⚠️  No streamSid yet, cannot stream audio.');
    return;
  }

  // 8000 samples/sec, 1 byte per sample μ-law.
  // 20ms per frame -> 160 bytes.
  const frameSize = 160;

  for (let offset = 0; offset < audioBuffer.length; offset += frameSize) {
    if (ws.readyState !== WebSocket.OPEN) break;

    const chunk = audioBuffer.subarray(offset, offset + frameSize);
    const payload = chunk.toString('base64');

    ws.send(
      JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload },
      })
    );

    // keep pace with real time
    await sleep(20);
  }

  // optional mark – useful for debugging
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(
      JSON.stringify({
        event: 'mark',
        streamSid,
        mark: { name: 'assistant_segment_end' },
      })
    );
  }
}

// ----- HANDLE TWILIO MEDIA STREAM MESSAGES ----------------------------------

function handleTwilioMessage(session, rawMessage) {
  let data;
  try {
    data = JSON.parse(rawMessage.toString());
  } catch (err) {
    console.error('Error parsing Twilio WS message', err);
    return;
  }

  const { event } = data;

  switch (event) {
    case 'connected':
      console.log('📞 Twilio WS connected');
      break;

    case 'start':
      session.streamSid = data.start.streamSid;
      console.log('🚀 Stream started:', session.streamSid);
      // Create exactly ONE Deepgram WS per call
      if (!session.deepgramWs) {
        attachDeepgram(session);
      }
      break;

    case 'media': {
      const payload = data.media?.payload;
      if (!payload || !session.deepgramWs) return;

      const audio = Buffer.from(payload, 'base64');

      if (session.deepgramReady) {
        session.deepgramWs.send(audio);
      } else {
        // queue until Deepgram socket opens
        session.deepgramQueue.push(audio);
      }
      break;
    }

    case 'stop':
      console.log('🛑 Stream stopped');
      closeSession(session);
      break;

    default:
      // ignore other events: mark, dtmf, etc.
      break;
  }
}

// ----- SESSION CLEANUP ------------------------------------------------------

function closeSession(session) {
  if (session.closed) return;
  session.closed = true;

  if (session.deepgramWs && session.deepgramWs.readyState === WebSocket.OPEN) {
    session.deepgramWs.close();
  }

  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.close();
  }
}

// ----- WEBSOCKET SERVER EVENTS ----------------------------------------------

wss.on('connection', (ws) => {
  console.log('🌐 New Twilio media WebSocket connection');
  const session = createCallSession(ws);

  ws.on('message', (msg) => handleTwilioMessage(session, msg));

  ws.on('close', () => {
    console.log('❌ Twilio WS closed');
    closeSession(session);
  });

  ws.on('error', (err) => {
    console.error('Twilio WS error', err);
    closeSession(session);
  });
});

// ----- START SERVER ---------------------------------------------------------

server.listen(PORT, () => {
  console.log(`✅ Voice server listening on port ${PORT}`);
  console.log(`   Healthcheck:   http://localhost:${PORT}/health`);
  console.log(`   WS endpoint:   wss://<your-host>/media-stream`);
});
