// sms.js
// WhatsApp (card template + simple template) + SMS confirmation & reminders using Twilio

import twilio from 'twilio';
import { formatInTimeZone } from 'date-fns-tz';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  SMS_FROM,
  TWILIO_WHATSAPP_FROM,
  WHATSAPP_FROM,
  WHATSAPP_APPOINTMENT_TEMPLATE_SID,
  TWILIO_WHATSAPP_TEMPLATE_SID,
  BUSINESS_TIMEZONE,
  ZOOM_LINK,
  ZOOM_MEETING_ID,
  ZOOM_PASSCODE,
} = process.env;

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn(
    '⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — messaging disabled.'
  );
}

// SMS "from" number (E.164, e.g. +447456438935)
const SMS_FROM_NUMBER = SMS_FROM || TWILIO_NUMBER || null;

// WhatsApp "from" identity (e.g. whatsapp:+447456438935)
// We support either WHATSAPP_FROM or legacy TWILIO_WHATSAPP_FROM
const WHATSAPP_FROM_NUMBER = WHATSAPP_FROM || TWILIO_WHATSAPP_FROM || null;

// Content Template SID for your WhatsApp card / simple template
// We support either TWILIO_WHATSAPP_TEMPLATE_SID or WHATSAPP_APPOINTMENT_TEMPLATE_SID
const WA_TEMPLATE_SID =
  TWILIO_WHATSAPP_TEMPLATE_SID || WHATSAPP_APPOINTMENT_TEMPLATE_SID || null;

const TZ = BUSINESS_TIMEZONE || 'Europe/London';

// ---------- DATE / TIME FORMATTING ----------

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

// We expect to get something like '+44...' from the booking logic.
// Strip any whatsapp: prefix just in case.
function normaliseE164(to) {
  if (!to) return null;
  const clean = String(to).replace(/^whatsapp:/, '').trim();
  return clean || null;
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

// Internal helper: WhatsApp card template with numeric variables (your existing template)
async function sendWhatsAppCardTemplate({ to, startISO, name }) {
  if (!twilioClient || !WHATSAPP_FROM_NUMBER || !WA_TEMPLATE_SID) {
    console.warn('WhatsApp template not sent — missing config');
    return false;
  }

  const waTo = makeWhatsAppTo(to);
  if (!waTo) {
    console.warn('WhatsApp template not sent — invalid recipient:', to);
    return false;
  }

  const displayName = name || 'Guest';
  const dateStr = formatDateForHuman(startISO); // e.g. Mon 12 Dec 2025
  const timeStr = formatTimeForHuman(startISO); // e.g. 2:30PM
  const phoneForCard = normaliseE164(to);
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

  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM_NUMBER,
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

  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM_NUMBER,
      to: waTo,
      body,
    });
    return true;
  } catch (e) {
    console.error('❌ WhatsApp text send error:', e?.message || e);
    return false;
  }
}

// ------------ SIMPLE HELPERS FOR THE VOICE AGENT ------------

// This is the helper you asked for: uses named template variables {name, time}
export async function sendWhatsAppTemplate({ to, name, timeSpoken }) {
  if (!twilioClient) {
    console.warn('No Twilio client configured – skipping WhatsApp send.');
    return;
  }

  if (!WHATSAPP_FROM_NUMBER || !WA_TEMPLATE_SID) {
    console.error(
      '❌ WhatsApp template send error: Missing WHATSAPP_FROM/TWILIO_WHATSAPP_FROM or TWILIO_WHATSAPP_TEMPLATE_SID/WHATSAPP_APPOINTMENT_TEMPLATE_SID env vars'
    );
    return;
  }

  const e164 = normaliseE164(to);
  if (!e164) {
    console.error('❌ WhatsApp template send error: Invalid "to" number', to);
    return;
  }

  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM_NUMBER,          // e.g. "whatsapp:+44..."
      to: `whatsapp:${e164}`,              // e.g. "whatsapp:+447999462166"
      contentSid: WA_TEMPLATE_SID,
      // MUST be valid JSON string and match template variables in Twilio
      contentVariables: JSON.stringify({
        name: name || 'there',
        time: timeSpoken || '',
      }),
    });
    console.log('✅ WhatsApp template sent to', e164);
  } catch (err) {
    console.error('❌ WhatsApp template send error:', err?.message || err);
  }
}

// Simple SMS fallback helper you asked for
export async function sendSmsFallback({ to, message }) {
  if (!twilioClient) return;

  if (!SMS_FROM_NUMBER) {
    console.error(
      '❌ SMS fallback send error: Missing SMS_FROM or TWILIO_NUMBER env var'
    );
    return;
  }

  const e164 = normaliseE164(to);
  if (!e164) {
    console.error('❌ SMS fallback send error: Invalid "to" number', to);
    return;
  }

  try {
    await twilioClient.messages.create({
      from: SMS_FROM_NUMBER,
      to: e164, // "+447999462166"
      body: message,
    });
    console.log('✅ SMS fallback sent to', e164);
  } catch (err) {
    console.error('❌ SMS fallback send error:', err?.message || err);
  }
}

// ------------ PUBLIC API (EXISTING FLOW) ------------

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

  // 1) Try WhatsApp card template first (existing behaviour)
  if (WHATSAPP_FROM_NUMBER && WA_TEMPLATE_SID) {
    usedWhatsApp = await sendWhatsAppCardTemplate({
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
    startMs - 60 * 60 * 1000, // 60m
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
