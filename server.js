// server.js
// MyBizPal voice agent – Twilio <-> Deepgram <-> OpenAI (logic.js) <-> ElevenLabs

import 'dotenv/config';
import express from 'express';
import bodyParser from 'body-parser';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { handleTurn } from './logic.js';
import { registerOutboundRoutes } from './outbound.js';

// ---------- CONFIG ----------

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  DEEPGRAM_API_KEY,
  OPENAI_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️  PUBLIC_BASE_URL not set – falling back to request Host header.');
}
if (!DEEPGRAM_API_KEY) console.warn('⚠️  DEEPGRAM_API_KEY is not set.');
if (!OPENAI_API_KEY) console.warn('⚠️  OPENAI_API_KEY is not set.');
if (!ELEVENLABS_API_KEY) console.warn('⚠️  ELEVENLABS_API_KEY is not set.');
if (!ELEVENLABS_VOICE_ID) console.warn('⚠️  ELEVENLABS_VOICE_ID is not set.');

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — hang-up via API disabled.');
}

// ---------- EXPRESS APP ----------

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Twilio <Connect><Stream> webhook – NO Twilio TTS greeting.
app.post('/twilio/voice', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const baseUrl =
    PUBLIC_BASE_URL ||
    `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;

  const wsUrl = baseUrl.replace(/^http/, 'ws') + '/media-stream';

  const connect = twiml.connect();
  connect.stream({ url: wsUrl });

  res.type('text/xml');
  res.send(twiml.toString());
});

// Outbound /start-call endpoint (from outbound.js)
registerOutboundRoutes(app);

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

  const callState = {
    lastUserTranscript: '',
    isSpeaking: false,
    cancelSpeaking: false,
    hangupRequested: false,
    callerNumber: null,
    callSid: null,
    history: [],
    greeted: false,
    mainSpeaker: null, // future diarisation
    lastReplyAt: 0,    // timestamp of last assistant reply
    pendingTranscript: null,
    pendingTimer: null,
    // NEW: timing + silence tracking
    timing: {
      lastBotReplyAt: 0,
      lastUserSpeechAt: 0,
    },
    silenceStage: 0,   // 0 = none, 1 = first "are you still there?", 2 = second prompt sent
    silenceTimer: null,
  };

  // ---- Deepgram connection (STT) ----
  const dgUrl =
    'wss://api.deepgram.com/v1/listen' +
    '?encoding=mulaw' +
    '&sample_rate=8000' +
    '&channels=1' +
    '&interim_results=false' +
    '&vad_events=true' +
    '&endpointing=800';

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

  // ---- HELPER: small utterance / noise filter ----
  function shouldIgnoreUtterance(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return true;

    // Very short nothingness
    if (t.length <= 1) return true;

    const boringSet = new Set(['hi', 'hello', 'hey', 'ok', 'okay', 'yes', 'yeah', 'no']);
    if (boringSet.has(t)) {
      const now = Date.now();
      const sinceBot = now - (callState.timing.lastBotReplyAt || 0);

      // If they say "hello/yes/ok" within 2 seconds of Gabriel speaking,
      // it's probably echo or reflex → ignore.
      if (sinceBot < 2000) return true;
    }

    return false;
  }

  // ---- HELPER: detect "check-in hello?" when he's been quiet ----
  function isCheckInHello(text) {
    const t = (text || '').trim().toLowerCase();
    if (!t) return false;

    const simpleHello =
      t === 'hello' ||
      t === 'hi' ||
      t === 'hey' ||
      t === 'you there' ||
      t === 'are you there';
    if (!simpleHello) return false;

    const now = Date.now();
    const sinceBot = now - (callState.timing.lastBotReplyAt || 0);

    // If it's been quiet for more than ~4 seconds after Gabriel spoke,
    // treat this as "are you still there?"
    return sinceBot > 4000;
  }

  // ---- HELPER: initial greeting (Gabriel speaks first) ----
  async function sendInitialGreeting() {
    if (callState.greeted) return;
    if (!streamSid) return;

    callState.greeted = true;

    const reply =
      "Hi, you're speaking with Gabriel from MyBizPal. How can I help you today?";

    console.log('🤖 Gabriel (greeting):', `"${reply}"`);

    callState.isSpeaking = true;
    callState.cancelSpeaking = false;

    try {
      const audioBuffer = await synthesizeWithElevenLabs(reply);
      await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
    } catch (err) {
      console.error('Error during greeting TTS or sendAudio:', err);
    } finally {
      callState.isSpeaking = false;
      callState.cancelSpeaking = false;
      const now = Date.now();
      callState.lastReplyAt = now;
      callState.timing.lastBotReplyAt = now;
    }
  }

  // ---- HELPER: normal replies after user speaks ----
  async function respondToUser(transcript) {
    if (!transcript) return;

    console.log(`👤 Caller said: "${transcript}"`);

    // Avoid reacting twice to identical text
    if (transcript === callState.lastUserTranscript) return;
    callState.lastUserTranscript = transcript;

    try {
      const { text: reply, shouldEnd } = await handleTurn({
        userText: transcript,
        callState,
      });

      const trimmedReply = (reply || '').trim();

      // If logic says "say nothing" (e.g. still capturing phone/email),
      // then do not send any TTS at all — just stay quiet.
      if (!trimmedReply) {
        if (shouldEnd && !callState.hangupRequested) {
          callState.hangupRequested = true;

          if (twilioClient && callState.callSid) {
            try {
              await twilioClient
                .calls(callState.callSid)
                .update({ status: 'completed' });
              console.log('📞 Call ended by Gabriel (hangupRequested=true)');
            } catch (e) {
              console.error('Error ending call via Twilio API:', e?.message || e);
              ws.close();
            }
          } else {
            ws.close();
          }
        }
        return;
      }

      console.log(`🤖 Gabriel: "${trimmedReply}"`);

      callState.isSpeaking = true;
      callState.cancelSpeaking = false;

      try {
        const audioBuffer = await synthesizeWithElevenLabs(trimmedReply);
        await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
      } catch (err) {
        console.error('Error during TTS or sendAudio:', err);
      } finally {
        callState.isSpeaking = false;
        callState.cancelSpeaking = false;
        const now = Date.now();
        callState.lastReplyAt = now;
        callState.timing.lastBotReplyAt = now;
      }

      if (shouldEnd && !callState.hangupRequested) {
        callState.hangupRequested = true;

        if (twilioClient && callState.callSid) {
          try {
            await twilioClient.calls(callState.callSid).update({ status: 'completed' });
            console.log('📞 Call ended by Gabriel (hangupRequested=true)');
          } catch (e) {
            console.error('Error ending call via Twilio API:', e?.message || e);
            ws.close();
          }
        } else {
          ws.close();
        }
      }
    } catch (err) {
      console.error('Error in respondToUser:', err);
    }
  }

  // ---- SILENCE WATCHDOG ----
  async function checkSilenceAndNudge() {
    try {
      if (callState.hangupRequested) return;
      if (!callState.greeted) return;
      if (!streamSid) return;
      if (callState.isSpeaking) return;

      const lastUser = callState.timing.lastUserSpeechAt || 0;
      if (!lastUser) return; // no user speech yet

      const now = Date.now();
      const idle = now - lastUser;

      // Stage thresholds:
      //  - 6 seconds  → "Are you still there?"
      //  - 14 seconds → "This is Gabriel at MyBizPal, are you still there?"
      //  - 22 seconds → polite goodbye + hang up
      if (callState.silenceStage === 0 && idle >= 6000 && idle < 14000) {
        callState.silenceStage = 1;

        const reply = 'Are you still there?';
        console.log('🤖 Gabriel (silence check 1):', `"${reply}"`);

        callState.isSpeaking = true;
        callState.cancelSpeaking = false;

        try {
          const audioBuffer = await synthesizeWithElevenLabs(reply);
          await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
        } catch (err) {
          console.error('Error during silence check TTS (stage 1):', err);
        } finally {
          callState.isSpeaking = false;
          callState.cancelSpeaking = false;
          const t = Date.now();
          callState.lastReplyAt = t;
          callState.timing.lastBotReplyAt = t;
        }
      } else if (callState.silenceStage === 1 && idle >= 14000 && idle < 22000) {
        callState.silenceStage = 2;

        const reply = 'This is Gabriel at MyBizPal, are you still there?';
        console.log('🤖 Gabriel (silence check 2):', `"${reply}"`);

        callState.isSpeaking = true;
        callState.cancelSpeaking = false;

        try {
          const audioBuffer = await synthesizeWithElevenLabs(reply);
          await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
        } catch (err) {
          console.error('Error during silence check TTS (stage 2):', err);
        } finally {
          callState.isSpeaking = false;
          callState.cancelSpeaking = false;
          const t = Date.now();
          callState.lastReplyAt = t;
          callState.timing.lastBotReplyAt = t;
        }
      } else if (callState.silenceStage === 2 && idle >= 22000) {
        // Final goodbye and hang up
        callState.silenceStage = 3; // prevent repeating
        callState.hangupRequested = true;

        const reply =
          'I’ll let you go for now, but if you ever need to set up an agent like me, just reach out to MyBizPal again. Have a great day.';
        console.log('🤖 Gabriel (silence goodbye):', `"${reply}"`);

        callState.isSpeaking = true;
        callState.cancelSpeaking = false;

        try {
          const audioBuffer = await synthesizeWithElevenLabs(reply);
          await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
        } catch (err) {
          console.error('Error during silence goodbye TTS:', err);
        } finally {
          callState.isSpeaking = false;
          callState.cancelSpeaking = false;
          const t = Date.now();
          callState.lastReplyAt = t;
          callState.timing.lastBotReplyAt = t;
        }

        // End call via Twilio API or close WS
        if (twilioClient && callState.callSid) {
          try {
            await twilioClient.calls(callState.callSid).update({ status: 'completed' });
            console.log('📞 Call ended by Gabriel after prolonged silence');
          } catch (e) {
            console.error('Error ending call via Twilio API (silence):', e?.message || e);
            ws.close();
          }
        } else {
          ws.close();
        }
      }
    } catch (err) {
      console.error('Error in checkSilenceAndNudge:', err);
    }
  }

  // Start silence timer (every second)
  callState.silenceTimer = setInterval(() => {
    // fire and forget
    checkSilenceAndNudge();
  }, 1000);

  // Deepgram → transcript handler with cooldown & debouncing
  dgSocket.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (!msg.channel || !msg.channel.alternatives) return;

      const alt = msg.channel.alternatives[0];

      if (!msg.is_final) return;

      const transcript = (alt.transcript || '').trim();
      if (!transcript) return;

      // Update timing for user speech
      const now = Date.now();
      callState.timing.lastUserSpeechAt = now;
      // Reset silence stage once user speaks
      callState.silenceStage = 0;

      // If Gabriel is talking and caller interrupts → cancel TTS (barge-in)
      if (callState.isSpeaking) {
        console.log('🚫 Barge-in detected – cancelling current TTS');
        callState.cancelSpeaking = true;
      }

      // If this is a "check-in hello" after a pause, answer gently and skip full logic
      if (isCheckInHello(transcript)) {
        const reply =
          'I’m still here, don’t worry — I was just thinking for a second. Where were we?';

        console.log('🤖 Gabriel (check-in reply):', `"${reply}"`);

        callState.isSpeaking = true;
        callState.cancelSpeaking = false;

        try {
          const audioBuffer = await synthesizeWithElevenLabs(reply);
          await sendAudioToTwilio(ws, streamSid, audioBuffer, callState);
        } catch (err) {
          console.error('Error during check-in TTS or sendAudio:', err);
        } finally {
          callState.isSpeaking = false;
          callState.cancelSpeaking = false;
          const t = Date.now();
          callState.lastReplyAt = t;
          callState.timing.lastBotReplyAt = t;
        }
        return;
      }

      // Ignore tiny noise / reflex utterances straight after Gabriel spoke
      if (shouldIgnoreUtterance(transcript)) {
        return;
      }

      // Debounce + cooldown:
      // - at most one reply every ~900ms
      // - if multiple transcripts arrive, respond only to the latest
      const minGap = 900;

      if (callState.pendingTimer) {
        clearTimeout(callState.pendingTimer);
        callState.pendingTimer = null;
      }

      if (!callState.lastReplyAt || now - callState.lastReplyAt >= minGap) {
        await respondToUser(transcript);
      } else {
        const delay = callState.lastReplyAt + minGap - now;
        callState.pendingTranscript = transcript;
        callState.pendingTimer = setTimeout(async () => {
          const tText = callState.pendingTranscript;
          callState.pendingTranscript = null;
          callState.pendingTimer = null;
          await respondToUser(tText);
        }, delay);
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
      callState.callSid = msg.start.callSid || null;
      console.log('▶️  Twilio stream started', {
        streamSid,
        callSid: callState.callSid,
      });

      sendInitialGreeting().catch((e) =>
        console.error('Greeting error (outer):', e)
      );

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
      console.log('⏹️  Twilio stream stopped', {
        streamSid,
        callSid: callState.callSid,
      });
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
    if (callState.pendingTimer) {
      clearTimeout(callState.pendingTimer);
    }
    if (callState.silenceTimer) {
      clearInterval(callState.silenceTimer);
    }
  });

  ws.on('error', (err) => {
    console.error('Twilio WS error', err);
    try {
      dgSocket.close();
    } catch {}
    if (callState.pendingTimer) {
      clearTimeout(callState.pendingTimer);
    }
    if (callState.silenceTimer) {
      clearInterval(callState.silenceTimer);
    }
  });
});

// ---------- TTS + AUDIO HELPERS ----------

async function synthesizeWithElevenLabs(text) {
  if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
    console.warn('ElevenLabs config missing – returning empty Buffer');
    return Buffer.alloc(0);
  }

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream?optimize_streaming_latency=3&output_format=ulaw_8000`;

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

function sendAudioToTwilio(ws, streamSid, audioBuffer, callState) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WS not open – cannot send audio');
      return resolve();
    }

    if (!streamSid) {
      console.warn('No streamSid yet – cannot send audio');
      return resolve();
    }

    const chunkSize = 160;
    const usableLength =
      audioBuffer.length - (audioBuffer.length % chunkSize);
    let offset = 0;

    try {
      ws.send(
        JSON.stringify({
          event: 'clear',
          streamSid,
        })
      );
    } catch (err) {
      console.warn('Error sending clear event to Twilio:', err);
    }

    const interval = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        clearInterval(interval);
        return resolve();
      }

      if (callState && callState.cancelSpeaking) {
        console.log('🛑 Stopping TTS playback due to barge-in');
        clearInterval(interval);
        return resolve();
      }

      if (offset >= usableLength) {
        clearInterval(interval);
        return resolve();
      }

      const chunk = audioBuffer.slice(offset, offset + chunkSize);
      if (!chunk.length) {
        clearInterval(interval);
        return resolve();
      }

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
          clearInterval(interval);
          return resolve();
        }
      });
    }, 20);
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
