import 'dotenv/config';
import express from 'express';
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import cors from 'cors';

// ---- Env helpers ----
const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  DEEPGRAM_API_KEY,
} = process.env;

if (!PUBLIC_BASE_URL) {
  console.warn('⚠️  PUBLIC_BASE_URL is not set – Twilio <Stream> URL logs will be generic.');
}

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
  console.warn('⚠️  Missing Twilio credentials in env.');
}

if (!DEEPGRAM_API_KEY) {
  console.warn(
    '⚠️  Missing DEEPGRAM_API_KEY – calls will answer but speech recognition will be disabled.'
  );
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Twilio REST client (keep for SMS / future features)
const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// Basic health check for Render
app.get('/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

// Optional cron endpoint so your existing Render cron jobs stop 404-ing
app.post('/cron/reminders', (req, res) => {
  console.log('⏰ /cron/reminders ping received');
  // You can import and call your outbound reminder logic here.
  res.json({ ok: true });
});

// ---------- Twilio <Stream> entrypoint ----------

// Twilio hits this when a call comes in
app.post('/twilio/voice', express.urlencoded({ extended: false }), (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const twiml = new VoiceResponse();

  const baseUrl = PUBLIC_BASE_URL || `https://example.com`;
  const streamUrl = new URL('/media-stream', baseUrl).toString();
  console.log('📞 Incoming call from', req.body.From, '– streaming to', streamUrl);

  // Greeting via Twilio itself, then hand over to media stream
  twiml.say(
    {
      voice: 'Polly.Brian',
      language: 'en-GB',
    },
    "Hi, you're speaking with Gabriel from MyBizPal. One moment while I get set up."
  );

  const connect = twiml.connect();
  connect.stream({
    url: streamUrl,
    track: 'inbound_track',
  });

  res.type('text/xml');
  res.send(twiml.toString());
});

// ---------- WebSocket plumbing ----------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/media-stream' });

// Per-call state: callSid -> { deepgramWs, twilioWs, streamSid }
const calls = new Map();

function safeClose(ws, code = 1000, reason = '') {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close(code, reason);
    }
  } catch (err) {
    console.error('safeClose error', err);
  }
}

// When Twilio opens the media WebSocket
wss.on('connection', (twilioWs, req) => {
  console.log('🔌 Twilio media WebSocket connected');

  let callSid = null;
  let streamSid = null;
  let deepgramWs = null;

  function attachDeepgramHandlers() {
    if (!deepgramWs) return;

    deepgramWs.on('open', () => {
      console.log(`🎧 Deepgram stream opened for ${callSid}`);
    });

    deepgramWs.on('message', (message) => {
      try {
        const dg = JSON.parse(message.toString());
        if (dg.type !== 'results') return;

        const channel = dg.channel;
        if (!channel || !channel.alternatives?.length) return;

        const alt = channel.alternatives[0];
        const transcript = alt.transcript?.trim();
        const isFinal = dg.is_final;

        if (!transcript) return;

        console.log(`📝 Deepgram (${callSid})${isFinal ? ' [final]' : ''}:`, transcript);

        // TODO: plug transcript into your AI agent + TTS and send audio back to Twilio.
      } catch (err) {
        console.error('Error parsing Deepgram message', err);
      }
    });

    deepgramWs.on('error', (err) => {
      console.error('Deepgram WS error', err);
    });

    deepgramWs.on('close', (code, reason) => {
      console.log(`🔒 Deepgram stream closed for ${callSid}`, code, reason.toString());
    });
  }

  twilioWs.on('message', async (msg) => {
    let data;
    try {
      data = JSON.parse(msg.toString());
    } catch (err) {
      console.error('Failed to parse WS message from Twilio', err);
      return;
    }

    const { event } = data;

    if (event === 'start') {
      callSid = data.start.callSid;
      streamSid = data.start.streamSid;
      console.log('▶️ Call started', callSid, 'streamSid', streamSid);

      if (!DEEPGRAM_API_KEY) {
        console.warn('Deepgram key missing – will not create STT stream.');
      } else {
        const url =
          'wss://api.deepgram.com/v1/listen?encoding=mulaw&sample_rate=8000&channels=1&interim_results=true&vad_events=true';

        deepgramWs = new WebSocket(url, {
          headers: {
            Authorization: `Token ${DEEPGRAM_API_KEY}`,
          },
        });

        calls.set(callSid, { deepgramWs, twilioWs, streamSid });
        attachDeepgramHandlers();
      }

      return;
    }

    if (event === 'media') {
      if (!deepgramWs || deepgramWs.readyState !== WebSocket.OPEN) {
        // Drop audio if Deepgram is not ready to avoid 429 spam
        return;
      }

      const payload = data.media.payload; // base64 mu-law
      try {
        deepgramWs.send(Buffer.from(payload, 'base64'));
      } catch (err) {
        console.error('Error forwarding audio to Deepgram', err.message);
      }
      return;
    }

    if (event === 'stop') {
      console.log('⏹️ Call stopped', callSid);
      if (callSid && calls.has(callSid)) {
        const st = calls.get(callSid);
        safeClose(st.deepgramWs, 1000, 'call ended');
        calls.delete(callSid);
      }
      safeClose(twilioWs, 1000, 'call ended');
      return;
    }
  });

  twilioWs.on('close', () => {
    console.log('🧹 Twilio media WebSocket closed');
    if (callSid && calls.has(callSid)) {
      const st = calls.get(callSid);
      safeClose(st.deepgramWs, 1000, 'twilio ws closed');
      calls.delete(callSid);
    }
  });

  twilioWs.on('error', (err) => {
    console.error('Twilio WS error', err);
  });
});

// ---------- Start server ----------

server.listen(PORT, () => {
  const base = PUBLIC_BASE_URL || `http://localhost:${PORT}`;
  console.log('==> Voice server listening on port', PORT);
  console.log('==> Your service is live 🎉');
  console.log('==> ');
  console.log('==> ///////////////////////////////////////////////');
  console.log('==> Available at your primary URL', base);
  console.log('==> Twilio streaming to:', new URL('/media-stream', base).toString());
  console.log('==> ///////////////////////////////////////////////');
});
v
