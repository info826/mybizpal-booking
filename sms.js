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

let twilioClient = null;
if (TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN) {
  twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
} else {
  console.warn('⚠️ TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN missing — messaging disabled.');
}

// SMS "from" number (E.164, e.g. +447456438935)
const SMS_FROM_NUMBER = (TWILIO_NUMBER || SMS_FROM || '').trim() || null;

// WhatsApp "from" identity (we will normalise it to whatsapp:+447...)
function normaliseWhatsAppFrom(rawFrom) {
  if (!rawFrom) return null;
  const s = String(rawFrom).trim();
  if (s.startsWith('whatsapp:')) return s;
  // if it's just +447..., prepend whatsapp:
  return `whatsapp:${s.replace(/^whatsapp:/, '')}`;
}

const WHATSAPP_FROM_NUMBER = normaliseWhatsAppFrom(
  TWILIO_WHATSAPP_FROM || process.env.WHATSAPP_FROM || ''
);

// Accept either env var name for the template SID + trim
const WA_TEMPLATE_SID =
  (WHATSAPP_APPOINTMENT_TEMPLATE_SID ||
    process.env.TWILIO_WHATSAPP_TEMPLATE_SID ||
    ''
  ).trim() || null;

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
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `(${safeName}) ` : '';

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

// NEW: Cancellation SMS text
function buildCancellationSms({ startISO, name }) {
  const when = formatDateForSms(startISO);
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `${safeName}, ` : '';

  const lines = [
    `❌ ${who}your MyBizPal consultation has been cancelled.`,
    `Previous time: ${when}`,
    'If this was a mistake or you’d like to book a new time, just reply here or contact us via mybizpal.ai.',
  ];

  return lines.join('\n');
}

// NEW: Reschedule SMS text
function buildRescheduleSms({ oldStartISO, newStartISO, name }) {
  const oldWhen = formatDateForSms(oldStartISO);
  const newWhen = formatDateForSms(newStartISO);
  const safeName = safeDisplayName(name);
  const who = safeName && safeName !== 'Guest' ? `${safeName}, ` : '';

  const zoomLink = ZOOM_LINK || '';
  const zoomId = ZOOM_MEETING_ID || '';
  const zoomPass = ZOOM_PASSCODE || '';

  const lines = [
    `🔁 ${who}your MyBizPal consultation has been rescheduled.`,
    `Old time: ${oldWhen}`,
    `New time: ${newWhen}`,
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) {
      lines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
    }
  }

  lines.push('If this new time doesn’t work, reply CHANGE and we’ll sort another slot.');
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

// ---------- WhatsApp template sender with strong normalisation + debug ----------

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

  const displayName = safeDisplayName(name);
  const dateStr = formatDateForHuman(startISO); // e.g. Mon 12 Dec 2025
  const timeStr = formatTimeForHuman(startISO); // e.g. 2:30PM
  const phoneForCard = e164;
  const zoomUrl = ZOOM_LINK || '';

  // Template variables:
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
    contentSid: WA_TEMPLATE_SID,
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

// NEW: send cancellation notice (WhatsApp text preferred, then SMS)
export async function sendCancellationNotice({ to, startISO, name }) {
  if (!twilioClient || !to) {
    console.warn('Cancellation notice not sent — missing Twilio client or recipient');
    return;
  }

  const e164 = normaliseE164(to);
  if (!e164) {
    console.warn('Cancellation notice not sent — invalid recipient:', to);
    return;
  }

  const body = buildCancellationSms({ startISO, name });

  let usedWhatsApp = false;
  if (WHATSAPP_FROM_NUMBER) {
    usedWhatsApp = await sendWhatsAppText({ to: e164, body });
  }

  if (!usedWhatsApp) {
    await sendSmsMessage({ to: e164, body });
  }
}

// NEW: send reschedule notice (WhatsApp text preferred, then SMS)
export async function sendRescheduleNotice({ to, oldStartISO, newStartISO, name }) {
  if (!twilioClient || !to) {
    console.warn('Reschedule notice not sent — missing Twilio client or recipient');
    return;
  }

  const e164 = normaliseE164(to);
  if (!e164) {
    console.warn('Reschedule notice not sent — invalid recipient:', to);
    return;
  }

  const body = buildRescheduleSms({ oldStartISO, newStartISO, name });

  let usedWhatsApp = false;
  if (WHATSAPP_FROM_NUMBER) {
    usedWhatsApp = await sendWhatsAppText({ to: e164, body });
  }

  if (!usedWhatsApp) {
    await sendSmsMessage({ to: e164, body });
  }
}
