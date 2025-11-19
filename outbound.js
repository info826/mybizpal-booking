// outbound.js
// /start-call endpoint: website lead → outbound call into the IVR

import twilio from 'twilio';

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const TWILIO_NUMBER =
  process.env.TWILIO_NUMBER || process.env.SMS_FROM || null;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — outbound calls disabled.');
}

export function registerOutboundRoutes(app) {
  app.post('/start-call', async (req, res) => {
    try {
      const {
        Name,
        Email,
        Message,
        'Full Phone Number': FullPhone,
      } = req.body || {};

      console.log('▲ New website lead from /start-call:', {
        name: Name,
        email: Email,
        phone: FullPhone,
        message: Message,
      });

      if (!twilioClient || !TWILIO_NUMBER) {
        console.error('❌ Twilio client or TWILIO_NUMBER missing – cannot start call');
        return res.status(500).json({ ok: false, error: 'Twilio not configured' });
      }

      let to = String(FullPhone || '').trim();

      // Normalise into E.164
      to = to.replace(/[^\d+]/g, '');
      if (to.startsWith('00')) to = '+' + to.slice(2);
      if (/^0\d{10}$/.test(to)) to = '+44' + to.slice(1);
      if (/^44\d{10}$/.test(to)) to = '+' + to;
      if (!to.startsWith('+')) {
        console.error('❌ Not calling – invalid phone format:', to);
        return res.json({ ok: false, error: 'Invalid phone format' });
      }

      const baseUrl = process.env.PUBLIC_BASE_URL || '';
      if (!baseUrl) {
        console.error('❌ PUBLIC_BASE_URL missing – cannot create call');
        return res.json({ ok: false, error: 'PUBLIC_BASE_URL missing' });
      }

      const call = await twilioClient.calls.create({
        to,
        from: TWILIO_NUMBER,
        url: `${baseUrl.replace(/\/$/, '')}/twilio/voice`,
      });

      console.log('📞 Outbound call created:', call.sid, '→', to);
      res.json({ ok: true, received: true });
    } catch (err) {
      console.error('❌ Error in /start-call:', err);
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}
