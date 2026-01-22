// sms.js
// WhatsApp (card template) + SMS confirmation & reminders using Twilio
// Optimised for: strict E.164 normalisation, consistent WhatsApp addressing, safe fallbacks,
// predictable logging, and harmony with booking.js + logic.js

import twilio from 'twilio';
import { formatInTimeZone } from 'date-fns-tz';

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,

  // IMPORTANT: prefer explicit envs, but keep backwards compatibility
  TWILIO_NUMBER, // legacy
  SMS_FROM, // legacy

  // WhatsApp sender (must be whatsapp:+E164 or +E164)
  TWILIO_WHATSAPP_FROM,
  WHATSAPP_FROM, // legacy alias

  // Twilio Content (WhatsApp template) SID
  WHATSAPP_APPOINTMENT_TEMPLATE_SID,
  TWILIO_WHATSAPP_TEMPLATE_SID, // legacy alias

  BUSINESS_TIMEZONE,

  ZOOM_LINK,
  ZOOM_MEETING_ID,
  ZOOM_PASSCODE,

  // Logging control
  DEBUG_LOG,
} = process.env;

const TZ = (BUSINESS_TIMEZONE || 'Europe/London').trim();
const DEBUG = DEBUG_LOG === '1';

// ---------- NAME SAFETY FOR MESSAGES ----------

function safeDisplayName(rawName) {
  const raw = rawName ? String(rawName).trim() : '';
  if (!raw) return 'Guest';

  const lower = raw.toLowerCase();
  const bad = new Set([
    'hi',
    'hello',
    'hey',
    'thanks',
    'thank you',
    'thank',
    'booking',
    'book',
    'yes',
    'yeah',
    'yep',
    'ok',
    'okay',
    'sure',
    'fine',
    'perfect',
    'please',
    'would',
    'email',
    'mail',
  ]);

  if (bad.has(lower) || lower.length <= 2) return 'Guest';
  return raw;
}

// ---------- TWILIO CLIENT ----------

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — messaging disabled.');
}

// ---------- NORMALISATION HELPERS ----------

function stripToE164Like(raw) {
  // Keeps leading + if present, strips spaces/dashes/() and any whatsapp:
  const s = String(raw || '').trim().replace(/^whatsapp:/i, '');
  const cleaned = s.replace(/[^\d+]/g, '').trim();
  return cleaned;
}

function isValidE164(e164) {
  // Minimal sanity: + and 8–15 digits (E.164 max 15)
  if (!e164) return false;
  if (!e164.startsWith('+')) return false;
  const digits = e164.replace(/[^\d]/g, '');
  return digits.length >= 8 && digits.length <= 15;
}

function normaliseE164(to) {
  const cleaned = stripToE164Like(to);
  // If the caller passes a UK local number without +, you should already be providing +44 from parseUkPhone.
  // We intentionally do NOT guess country codes here to avoid wrong deliveries.
  return isValidE164(cleaned) ? cleaned : null;
}

function makeWhatsAppTo(to) {
  const e164 = normaliseE164(to);
  if (!e164) return null;
  return `whatsapp:${e164}`;
}

function normaliseWhatsAppFrom(rawFrom) {
  const s = String(rawFrom || '').trim();
  if (!s) return null;

  // Accept whatsapp:+E164 or +E164 and output whatsapp:+E164
  if (s.toLowerCase().startsWith('whatsapp:')) {
    const e164 = normaliseE164(s);
    return e164 ? `whatsapp:${e164}` : null;
  }

  const e164 = normaliseE164(s);
  return e164 ? `whatsapp:${e164}` : null;
}

// ---------- FROM CONFIG (STRICT + COMPATIBLE) ----------

// SMS "from" number (must be +E164). Prefer SMS_FROM then TWILIO_NUMBER.
const SMS_FROM_NUMBER = normaliseE164(SMS_FROM || TWILIO_NUMBER || '');

// WhatsApp "from" identity
const WHATSAPP_FROM_NUMBER = normaliseWhatsAppFrom(
  TWILIO_WHATSAPP_FROM || WHATSAPP_FROM || ''
);

// Template SID
const WA_TEMPLATE_SID = String(
  WHATSAPP_APPOINTMENT_TEMPLATE_SID || TWILIO_WHATSAPP_TEMPLATE_SID || ''
)
  .trim() || null;

// ---------- FORMATTING ----------

function formatDateForHuman(iso) {
  return formatInTimeZone(new Date(iso), TZ, 'eee dd MMM yyyy');
}

function formatTimeForHuman(iso) {
  return formatInTimeZone(new Date(iso), TZ, 'h:mmaaa');
}

function formatDateForSms(iso) {
  return formatInTimeZone(new Date(iso), TZ, "eee dd MMM yyyy, h:mmaaa '('zzzz')'");
}

// ---------- MESSAGE BUILDERS ----------

function buildConfirmationSms({ startISO, name }) {
  const when = formatDateForSms(startISO);
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `(${safeName}) ` : '';

  const zoomLink = (ZOOM_LINK || '').trim();
  const zoomId = (ZOOM_MEETING_ID || '').trim();
  const zoomPass = (ZOOM_PASSCODE || '').trim();

  const lines = [
    `✅ ${who}MyBizPal — Business Consultation (15–30 min)`,
    `Date: ${when}`,
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) lines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
  }

  lines.push('Reply CHANGE to reschedule.');
  return lines.join('\n');
}

function buildCancellationSms({ startISO, name }) {
  const when = formatDateForSms(startISO);
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `${safeName}, ` : '';

  return [
    `❌ ${who}your MyBizPal consultation has been cancelled.`,
    `Previous time: ${when}`,
    'If this was a mistake or you’d like to book a new time, reply here or visit mybizpal.ai.',
  ].join('\n');
}

function buildRescheduleSms({ oldStartISO, newStartISO, name }) {
  const oldWhen = formatDateForSms(oldStartISO);
  const newWhen = formatDateForSms(newStartISO);
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `${safeName}, ` : '';

  const zoomLink = (ZOOM_LINK || '').trim();
  const zoomId = (ZOOM_MEETING_ID || '').trim();
  const zoomPass = (ZOOM_PASSCODE || '').trim();

  const lines = [
    `🔁 ${who}your MyBizPal consultation has been rescheduled.`,
    `Old time: ${oldWhen}`,
    `New time: ${newWhen}`,
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) lines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
  }

  lines.push('If this new time doesn’t work, reply CHANGE and we’ll sort another slot.');
  return lines.join('\n');
}

function buildReminderText({ startISO }) {
  const when = formatDateForSms(startISO);

  const zoomLink = (ZOOM_LINK || '').trim();
  const zoomId = (ZOOM_MEETING_ID || '').trim();
  const zoomPass = (ZOOM_PASSCODE || '').trim();

  const lines = ['⏰ Reminder: your MyBizPal consultation', `Starts: ${when}`];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) lines.push(`ID: ${zoomId} | Passcode: ${zoomPass}`);
  }

  return lines.join('\n');
}

// ---------- LOW-LEVEL SENDERS ----------

async function sendSmsMessage({ to, body }) {
  const dest = normaliseE164(to);

  if (!twilioClient || !SMS_FROM_NUMBER || !dest) {
    console.warn('SMS not sent — missing Twilio config or invalid recipient', {
      hasClient: !!twilioClient,
      SMS_FROM_NUMBER,
      to,
      dest,
    });
    return false;
  }

  try {
    if (DEBUG) console.log('📤 Sending SMS', { from: SMS_FROM_NUMBER, to: dest });
    await twilioClient.messages.create({ to: dest, from: SMS_FROM_NUMBER, body });
    return true;
  } catch (e) {
    console.error('❌ SMS send error:', e?.message || e);
    if (e) {
      console.error('SMS Twilio error details:', {
        code: e.code,
        status: e.status,
        moreInfo: e.moreInfo,
        details: e.details,
      });
    }
    return false;
  }
}

async function sendWhatsAppTemplate({ to, startISO, name }) {
  const waTo = makeWhatsAppTo(to);

  if (!twilioClient || !WHATSAPP_FROM_NUMBER || !WA_TEMPLATE_SID || !waTo) {
    console.warn('WhatsApp template not sent — missing config or invalid recipient', {
      hasClient: !!twilioClient,
      WHATSAPP_FROM_NUMBER,
      WA_TEMPLATE_SID,
      to,
      waTo,
    });
    return false;
  }

  const displayName = safeDisplayName(name);
  const dateStr = formatDateForHuman(startISO);
  const timeStr = formatTimeForHuman(startISO);

  const variables = {
    '1': displayName,
    '2': dateStr,
    '3': timeStr,
    '4': normaliseE164(to) || '',
    '5': (ZOOM_LINK || '').trim(),
  };

  if (DEBUG) {
    console.log('📲 WhatsApp TEMPLATE DEBUG', {
      from: WHATSAPP_FROM_NUMBER,
      to: waTo,
      contentSid: WA_TEMPLATE_SID,
      variables,
    });
  }

  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM_NUMBER,
      to: waTo,
      contentSid: WA_TEMPLATE_SID,
      contentVariables: JSON.stringify(variables),
    });
    return true;
  } catch (e) {
    console.error('❌ WhatsApp template send error:', e?.message || e);
    if (e) {
      console.error('WhatsApp Twilio error details:', {
        code: e.code,
        status: e.status,
        moreInfo: e.moreInfo,
        details: e.details,
      });
    }
    return false;
  }
}

async function sendWhatsAppText({ to, body }) {
  const waTo = makeWhatsAppTo(to);

  if (!twilioClient || !WHATSAPP_FROM_NUMBER || !waTo) {
    console.warn('WhatsApp text not sent — missing config or invalid recipient', {
      hasClient: !!twilioClient,
      WHATSAPP_FROM_NUMBER,
      to,
      waTo,
    });
    return false;
  }

  try {
    if (DEBUG) console.log('📲 WhatsApp TEXT DEBUG', { from: WHATSAPP_FROM_NUMBER, to: waTo });
    await twilioClient.messages.create({ from: WHATSAPP_FROM_NUMBER, to: waTo, body });
    return true;
  } catch (e) {
    console.error('❌ WhatsApp text send error:', e?.message || e);
    if (e) {
      console.error('WhatsApp text Twilio error details:', {
        code: e.code,
        status: e.status,
        moreInfo: e.moreInfo,
        details: e.details,
      });
    }
    return false;
  }
}

// ---------- PUBLIC API (USED BY booking.js) ----------

// 1) Confirmation when booking is created by the agent
export async function sendConfirmationAndReminders({ to, startISO, name }) {
  // booking.js passes E.164 (+44...) as `to`
  const e164 = normaliseE164(to);

  if (DEBUG) {
    console.log('🔔 sendConfirmationAndReminders', {
      rawTo: to,
      e164,
      startISO,
      name,
      hasClient: !!twilioClient,
      SMS_FROM_NUMBER,
      WHATSAPP_FROM_NUMBER,
      WA_TEMPLATE_SID,
    });
  }

  if (!twilioClient || !e164) {
    console.warn('Messaging not sent — missing Twilio client or invalid recipient', {
      hasClient: !!twilioClient,
      rawTo: to,
      e164,
    });
    return;
  }

  // Priority order:
  // 1) WhatsApp template (best UX)
  // 2) WhatsApp text (if template not configured)
  // 3) SMS
  let sent = false;

  if (WHATSAPP_FROM_NUMBER && WA_TEMPLATE_SID) {
    sent = await sendWhatsAppTemplate({ to: e164, startISO, name });
  } else if (WHATSAPP_FROM_NUMBER) {
    const body = buildConfirmationSms({ startISO, name });
    sent = await sendWhatsAppText({ to: e164, body });
  }

  if (!sent) {
    const body = buildConfirmationSms({ startISO, name });
    await sendSmsMessage({ to: e164, body });
  }

  // Reminders: handled by separate reminderWorker cron job.
}

// 2) Cancellation notice (WhatsApp text preferred, then SMS)
export async function sendCancellationNotice({ to, startISO, name }) {
  const e164 = normaliseE164(to);

  if (!twilioClient || !e164) {
    console.warn('Cancellation notice not sent — missing Twilio client or invalid recipient', {
      hasClient: !!twilioClient,
      to,
      e164,
    });
    return;
  }

  const body = buildCancellationSms({ startISO, name });

  let sent = false;
  if (WHATSAPP_FROM_NUMBER) sent = await sendWhatsAppText({ to: e164, body });
  if (!sent) await sendSmsMessage({ to: e164, body });
}

// 3) Reschedule notice (WhatsApp text preferred, then SMS)
export async function sendRescheduleNotice({ to, oldStartISO, newStartISO, name }) {
  const e164 = normaliseE164(to);

  if (!twilioClient || !e164) {
    console.warn('Reschedule notice not sent — missing Twilio client or invalid recipient', {
      hasClient: !!twilioClient,
      to,
      e164,
    });
    return;
  }

  const body = buildRescheduleSms({ oldStartISO, newStartISO, name });

  let sent = false;
  if (WHATSAPP_FROM_NUMBER) sent = await sendWhatsAppText({ to: e164, body });
  if (!sent) await sendSmsMessage({ to: e164, body });
}

// 4) Helper used by the reminder worker for 24h / 60m messages
export async function sendReminderMessage({ to, startISO, name, label }) {
  const e164 = normaliseE164(to);

  if (!twilioClient || !e164) {
    console.warn(`[${label}] Reminder not sent — missing Twilio client or invalid recipient`, {
      hasClient: !!twilioClient,
      to,
      e164,
    });
    return;
  }

  const body = buildReminderText({ startISO, name });

  let sent = false;
  if (WHATSAPP_FROM_NUMBER) sent = await sendWhatsAppText({ to: e164, body });
  if (!sent) await sendSmsMessage({ to: e164, body });
}
