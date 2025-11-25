// sms.js
// WhatsApp (card template) + SMS confirmation & reminders using Twilio

import twilio from 'twilio';
import { formatInTimeZone } from 'date-fns-tz';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  SMS_FROM,
  TWILIO_WHATSAPP_FROM,
  WHATSAPP_APPOINTMENT_TEMPLATE_SID,
  BUSINESS_TIMEZONE,
  ZOOM_LINK,
  ZOOM_MEETING_ID,
  ZOOM_PASSCODE,
} = process.env;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — messaging disabled.');
}

// SMS "from" number (E.164, e.g. +447456438935)
const SMS_FROM_NUMBER = TWILIO_NUMBER || SMS_FROM || null;

// WhatsApp "from" identity (we will normalise it to whatsapp:+447...)
function normaliseWhatsAppFrom(rawFrom) {
  if (!rawFrom) return null;
  const s = String(rawFrom).trim();
  if (s.startsWith('whatsapp:')) return s;
  // if it's just +447..., prepend whatsapp:
  return `whatsapp:${s.replace(/^whatsapp:/, '')}`;
}

const WHATSAPP_FROM_NUMBER = normaliseWhatsAppFrom(TWILIO_WHATSAPP_FROM || process.env.WHATSAPP_FROM || '');
const WA_TEMPLATE_SID = WHATSAPP_APPOINTMENT_TEMPLATE_SID || null;

const TZ = BUSINESS_TIMEZONE || 'Europe/London';

function formatDateForHuman(iso) {
  return formatInTimeZone(new Date(iso), TZ, 'eee dd MMM yyyy');
}

function formatTimeForHuman(iso) {
  return formatInTimeZone(new Date(iso), TZ, 'h:mmaaa');
}

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

  const zoomLink = ZOOM_LINK || '';
  const zoomId = ZOOM_MEETING_ID || '';
  const zoomPass = ZOOM_PASSCODE || '';

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

function buildReminderText({ startISO }) {
  const when = formatDateForSms(startISO);
  const zoomLink = ZOOM_LINK || '';
  const zoomId = ZOOM_MEETING_ID || '';
  const zoomPass = ZOOM_PASSCODE || '';

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

// ------------ CHANNEL HELPERS ------------

function normaliseE164(to) {
  // We expect something like '+44...' (possibly with a whatsapp: prefix)
  const clean = String(to || '').replace(/^whatsapp:/, '').trim();
  return clean;
}

function makeWhatsAppTo(to) {
  const e164 = normaliseE164(to);
  if (!e164) return null;
  return `whatsapp:${e164}`;
}

async function sendSmsMessage({ to, body }) {
  if (!twilioClient || !SMS_FROM_NUMBER || !to) {
    console.warn('SMS not sent — missing Twilio config or recipient');
    return false;
  }
  try {
    await twilioClient.messages.create({
      to,
      from: SMS_FROM_NUMBER,
      body,
    });
    return true;
  } catch (e) {
    console.error('❌ SMS send error:', e?.message || e);
    return false;
  }
}

// ---------- NEW: WhatsApp template sender with strong normalisation + debug ----------

async function sendWhatsAppTemplate({ to, startISO, name }) {
  if (!twilioClient || !WHATSAPP_FROM_NUMBER || !WA_TEMPLATE_SID) {
    console.warn(
      'WhatsApp template not sent — missing config (client, WHATSAPP_FROM_NUMBER, or WA_TEMPLATE_SID)'
    );
    return false;
  }

  const e164 = normaliseE164(to);
  const waTo = makeWhatsAppTo(e164);
  if (!waTo) {
    console.warn('WhatsApp template not sent — invalid recipient:', to);
    return false;
  }

  const displayName = name || 'Guest';
  const dateStr = formatDateForHuman(startISO); // e.g. Mon 12 Dec 2025
  const timeStr = formatTimeForHuman(startISO); // e.g. 2:30PM
  const phoneForCard = e164;
  const zoomUrl = ZOOM_LINK || '';

  // Your card has variables:
  // {{1}} = Name
  // {{2}} = Date
  // {{3}} = Time
  // {{4}} = Phone number
  // {{5}} = Zoom link
  const variables = {
    '1': displayName,
    '2': dateStr,
    '3': timeStr,
    '4': phoneForCard || '',
    '5': zoomUrl || '',
  };

  const from = WHATSAPP_FROM_NUMBER;

  // DEBUG: see exactly what we send to Twilio
  console.log('📲 WhatsApp DEBUG', {
    from,
    to: waTo,
    templateSid: WA_TEMPLATE_SID,
    variables,
  });

  try {
    await twilioClient.messages.create({
      from,
      to: waTo,
      contentSid: WA_TEMPLATE_SID,
      contentVariables: JSON.stringify(variables),
    });
    console.log('✅ WhatsApp card template sent to', waTo);
    return true;
  } catch (e) {
    console.error('❌ WhatsApp template send error:', e?.message || e);
    return false;
  }
}

async function sendWhatsAppText({ to, body }) {
  if (!twilioClient || !WHATSAPP_FROM_NUMBER) {
    return false;
  }
  const waTo = makeWhatsAppTo(to);
  if (!waTo) return false;

  const from = WHATSAPP_FROM_NUMBER;

  console.log('📲 WhatsApp REMINDER DEBUG', { from, to: waTo });

  try {
    await twilioClient.messages.create({
      from,
      to: waTo,
      body,
    });
    return true;
  } catch (e) {
    console.error('❌ WhatsApp text send error:', e?.message || e);
    return false;
  }
}

// ------------ PUBLIC API ------------

export async function sendConfirmationAndReminders({ to, startISO, name }) {
  if (!twilioClient || !to) {
    console.warn('Messaging not sent — missing Twilio client or recipient');
    return;
  }

  const e164 = normaliseE164(to);
  if (!e164) {
    console.warn('Messaging not sent — invalid recipient:', to);
    return;
  }

  let usedWhatsApp = false;

  // 1) Try WhatsApp card template first
  if (WHATSAPP_FROM_NUMBER && WA_TEMPLATE_SID) {
    usedWhatsApp = await sendWhatsAppTemplate({
      to: e164,
      startISO,
      name,
    });
  }

  // 2) Fallback to SMS confirmation if WhatsApp not used / failed
  if (!usedWhatsApp) {
    const body = buildConfirmationSms({ startISO, name });
    await sendSmsMessage({ to: e164, body });
  }

  // 3) Schedule reminders (24h & 60m before)
  const startMs = new Date(startISO).getTime();
  const nowMs = Date.now();

  const reminderTimes = [
    startMs - 24 * 60 * 60 * 1000, // 24h
    startMs - 60 * 60 * 1000,      // 60m
  ];

  for (const fireAt of reminderTimes) {
    const delay = fireAt - nowMs;
    if (delay > 0 && delay < 7 * 24 * 60 * 60 * 1000) {
      setTimeout(async () => {
        try {
          const bodyRem = buildReminderText({ startISO });

          if (usedWhatsApp && WHATSAPP_FROM_NUMBER) {
            // Try WhatsApp reminder first
            const ok = await sendWhatsAppText({
              to: e164,
              body: bodyRem,
            });
            if (!ok) {
              await sendSmsMessage({ to: e164, body: bodyRem });
            }
          } else {
            // SMS-only path
            await sendSmsMessage({ to: e164, body: bodyRem });
          }
        } catch (e) {
          console.error('Reminder send error:', e?.message || e);
        }
      }, delay);
    }
  }
}
