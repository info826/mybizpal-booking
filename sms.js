// sms.js
// SMS confirmation + reminders using Twilio

import twilio from 'twilio';
import { formatInTimeZone } from 'date-fns-tz';

const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
const TWILIO_NUMBER =
  process.env.TWILIO_NUMBER || process.env.SMS_FROM || null;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — SMS disabled.');
}

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

function formatDateForSms(iso) {
  return formatInTimeZone(
    new Date(iso),
    TZ,
    "eee dd MMM yyyy, h:mmaaa '('zzzz')'"
  );
}

function buildConfirmationSms({ startISO, name }) {
  const when = formatDateForSms(startISO);
  const who = name ? `(${name}) ` : '';

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const lines = [
    `✅ ${who}MyBizPal — Business Consultation (15–30 min)`,
    `Date: ${when}`,
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) {
      lines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
    }
  }

  lines.push('Reply CHANGE to reschedule.');
  return lines.join('\n');
}

function buildReminderSms({ startISO }) {
  const when = formatDateForSms(startISO);
  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const lines = [
    '⏰ Reminder: your MyBizPal consultation',
    `Starts: ${when}`,
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) {
      lines.push(`ID: ${zoomId} | Passcode: ${zoomPass}`);
    }
  }

  return lines.join('\n');
}

export async function sendConfirmationAndReminders({ to, startISO, name }) {
  if (!twilioClient || !TWILIO_NUMBER || !to) {
    console.warn('SMS not sent — missing Twilio config or recipient');
    return;
  }

  // Confirmation now
  const body = buildConfirmationSms({ startISO, name });
  await twilioClient.messages.create({
    to,
    from: TWILIO_NUMBER,
    body,
  });

  const startMs = new Date(startISO).getTime();
  const nowMs = Date.now();

  const reminderTimes = [
    startMs - 24 * 60 * 60 * 1000, // 24h
    startMs - 60 * 60 * 1000, // 60m
  ];

  for (const fireAt of reminderTimes) {
    const delay = fireAt - nowMs;
    if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
      setTimeout(async () => {
        try {
          const bodyRem = buildReminderSms({ startISO });
          await twilioClient.messages.create({
            to,
            from: TWILIO_NUMBER,
            body: bodyRem,
          });
        } catch (e) {
          console.error('Reminder SMS error:', e?.message || e);
        }
      }, delay);
    }
  }
}
