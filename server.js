// server.js
// MyBizPal voice agent – Twilio <-> Deepgram <-> OpenAI <-> ElevenLabs

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import WebSocket, { WebSocketServer } from 'ws';
import OpenAI from 'openai';

const { VoiceResponse } = twilio.twiml;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Simple health check
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Helper: build WSS URL for Twilio <Stream>
function getWsUrl() {
  const base = process.env.PUBLIC_BASE_URL;
  if (!base) {
    throw new Error(
      'PUBLIC_BASE_URL env var is required, e.g. https://mybizpal-booking.onrender.com'
    );
  }
  // https:// -> wss://   http:// -> ws://
  return base.replace(/^http/, 'ws') + '/media-stream';
}

// Twilio Voice webhook – NO Twilio lady, just connect the media stream
app.post('/twilio/voice', (req, res) => {
  const response = new VoiceResponse();

  // Immediately connect to our media WebSocket
  const connect = response.connect();
  connect.stream({ url: getWsUrl() });

  res.type('text/xml');
  res.send(response.toString());
});

// Start HTTP server
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => {
  console.log(`🚀 MyBizPal voice server listening on port ${PORT}`);
});

// WebSocket server for Twilio media streams
const wss = new WebSocketServer({ server, path: '/media-stream' });

// Per-call context
const calls = new Map(); // streamSid -> ctx

wss.on('connection', (ws) => {
  console.log('🔔 New Twilio media WebSocket connection');

  const ctx = {
    ws,
    streamSid: null,
    deepgramSocket: null,
    conversation: [],
    isSpeaking: false,
  };

  ws.on('message', async (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch (err) {
      console.error('⚠️ Bad JSON from Twilio:', err);
      return;
    }

    const event = data.event;

    if (event === 'start') {
      ctx.streamSid = data.start.streamSid;
      console.log(`▶️ Stream started: ${ctx.streamSid}`);

      calls.set(ctx.streamSid, ctx);

      // System prompt for the agent
      ctx.conversation = [
        {
          role: 'system',
          content:
            "You are Gabriel, a warm, confident AI receptionist for MyBizPal.ai in the UK. " +
            "You answer the phone, explain briefly that you're an AI assistant, qualify the caller, " +
            "and book them into Gabriel's calendar. Be concise, natural and friendly.",
        },
      ];

      // One Deepgram stream per call
      ctx.deepgramSocket = createDeepgramStream(ctx);
    } else if (event === 'media') {
      // Incoming audio from caller -> Deepgram
      if (ctx.deepgramSocket && ctx.deepgramSocket.readyState === WebSocket.OPEN) {
        const payload = data.media.payload; // base64 µ-law 8k
        const audioBuffer = Buffer.from(payload, 'base64');
        ctx.deepgramSocket.send(audioBuffer);
      }
    } else if (event === 'stop') {
      console.log(`⏹️ Stream stopped: ${ctx.streamSid}`);
      cleanupCall(ctx.streamSid);
    }
  });

  ws.on('close', () => {
    console.log('🔚 Twilio WebSocket closed');
    if (ctx.streamSid) cleanupCall(ctx.streamSid);
  });

  ws.on('error', (err) => {
    console.error('❌ Twilio WS error:', err);
    if (ctx.streamSid) cleanupCall(ctx.streamSid);
  });
});

// ---------- Deepgram streaming ----------

function createDeepgramStream(ctx) {
  const dgUrl =
    'wss://api.deepgram.com/v1/listen?' +
    [
      'encoding=mulaw',
      'sample_rate=8000',
      'channels=1',
      'interim_results=true',
      'vad_events=true',
    ].join('&');

  const dgSocket = new WebSocket(dgUrl, {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  });

  dgSocket.on('open', () => {
    console.log('🎧 Deepgram stream opened');
  });

  dgSocket.on('message', async (msg) => {
    let dg;
    try {
      dg = JSON.parse(msg.toString());
    } catch {
      return;
    }

    if (dg.type !== 'Results') return;
    if (!dg.channel?.alternatives?.length) return;

    const alt = dg.channel.alternatives[0];
    const transcript = (alt.transcript || '').trim();
    if (!transcript) return;

    const isFinal = dg.is_final || dg.speech_final;
    if (!isFinal) return;

    console.log(`👂 Caller: ${transcript}`);

    // Avoid echo: ignore user speech while the bot is talking
    if (ctx.isSpeaking) {
      console.log('… ignoring transcript while agent is speaking');
      return;
    }

    try {
      await handleUserText(ctx, transcript);
    } catch (err) {
      console.error('Error handling user text:', err);
    }
  });

  dgSocket.on('close', () => {
    console.log('🔒 Deepgram stream closed');
  });

  dgSocket.on('error', (err) => {
    console.error('❌ Deepgram WS error:', err);
  });

  return dgSocket;
}

// ---------- OpenAI + ElevenLabs logic ----------

async function handleUserText(ctx, text) {
  ctx.conversation.push({ role: 'user', content: text });

  const reply = await getAssistantReply(ctx.conversation);
  if (!reply) return;

  console.log(`🤖 Agent: ${reply}`);
  ctx.conversation.push({ role: 'assistant', content: reply });

  await speakTextOverTwilio(ctx, reply);
}

async function getAssistantReply(conversation) {
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: conversation,
    temperature: 0.4,
  });

  const choice = completion.choices?.[0];
  const content = (choice?.message?.content || '').trim();
  return content;
}

async function speakTextOverTwilio(ctx, text) {
  if (!text) return;
  if (!ctx.ws || ctx.ws.readyState !== WebSocket.OPEN) return;

  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  const xiKey = process.env.ELEVENLABS_API_KEY || process.env.XI_API_KEY;

  if (!voiceId || !xiKey) {
    console.error('❌ ElevenLabs env vars missing (ELEVENLABS_VOICE_ID & XI_API_KEY / ELEVENLABS_API_KEY)');
    return;
  }

  ctx.isSpeaking = true;

  try {
    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': xiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text,
          model_id: 'eleven_multilingual_v2',
          output_format: 'ulaw_8000', // matches Twilio media stream
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.7,
          },
        }),
      }
    );

    if (!resp.ok || !resp.body) {
      console.error('❌ ElevenLabs TTS error:', resp.status, await resp.text());
      return;
    }

    const reader = resp.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const chunk = Buffer.from(value);

      // Twilio expects 20 ms of audio per media message:
      // 8000 samples/sec * 0.02 sec = 160 bytes per chunk (µ-law)
      for (let offset = 0; offset < chunk.length; offset += 160) {
        const slice = chunk.subarray(offset, offset + 160);
        const payload = slice.toString('base64');

        ctx.ws.send(
          JSON.stringify({
            event: 'media',
            streamSid: ctx.streamSid,
            media: { payload },
          })
        );
      }
    }

    // Optional mark to tell Twilio that the agent finished speaking
    ctx.ws.send(
      JSON.stringify({
        event: 'mark',
        streamSid: ctx.streamSid,
        mark: { name: 'agent-finished' },
      })
    );
  } catch (err) {
    console.error('❌ Error streaming audio back to Twilio:', err);
  } finally {
    ctx.isSpeaking = false;
  }
}

// ---------- Cleanup ----------

function cleanupCall(streamSid) {
  const ctx = calls.get(streamSid);
  if (!ctx) return;

  if (ctx.deepgramSocket && ctx.deepgramSocket.readyState === WebSocket.OPEN) {
    try {
      ctx.deepgramSocket.close();
    } catch {}
  }

  if (ctx.ws && ctx.ws.readyState === WebSocket.OPEN) {
    try {
      ctx.ws.close();
    } catch {}
  }

  calls.delete(streamSid);
}
