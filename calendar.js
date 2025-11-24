// calendar.js
// Google Calendar helpers: earliest-available, create, cancel, find existing
// + WhatsApp-first confirmation with SMS fallback

import { google } from 'googleapis';
import twilio from 'twilio';
import {
  addMinutes,
  addDays,
  isBefore,
  isAfter,
  setHours,
  setMinutes,
  setSeconds,
} from 'date-fns';
import { formatInTimeZone } from 'date-fns-tz';

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const CALENDAR_ID =
  process.env.GOOGLE_CALENDAR_ID ||
  process.env.CALENDAR_ID ||
  'primary';

// ---------- GOOGLE CALENDAR SETUP ----------

const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);

const calendar = google.calendar({ version: 'v3', auth: jwt });

let googleReady = false;
async function ensureGoogleAuth() {
  if (!googleReady) {
    await jwt.authorize();
    googleReady = true;
    console.log('✅ Google service account authorized for Calendar');
  }
}

// ---------- TWILIO SETUP (WHATSAPP + SMS) ----------

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM;        // e.g. 'whatsapp:+447456438935'
const SMS_FROM = process.env.TWILIO_SMS_FROM;                  // e.g. '+447456438935'
const WHATSAPP_TEMPLATE_SID = process.env.TWILIO_WHATSAPP_TEMPLATE_SID;

// ---------- COMMON HELPERS ----------

// Format spoken time (for messages etc.)
export function formatSpokenDateTime(iso, timezone = TZ) {
  const d = new Date(iso);
  const day = formatInTimeZone(d, timezone, 'eeee');
  const date = formatInTimeZone(d, timezone, 'd');
  const month = formatInTimeZone(d, timezone, 'LLLL');
  const mins = formatInTimeZone(d, timezone, 'mm');
  const hour = formatInTimeZone(d, timezone, 'h');
  const mer = formatInTimeZone(d, timezone, 'a').toLowerCase();
  const time = mins === '00' ? `${hour} ${mer}` : `${hour}:${mins} ${mer}`;
  return `${day} ${date} ${month} at ${time}`;
}

function isWeekend(d) {
  const day = d.getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

function dayStart(d) {
  let s = new Date(d.getTime());
  s = setHours(s, 9);
  s = setMinutes(s, 0);
  s = setSeconds(s, 0);
  return s;
}

function dayEnd(d) {
  // We want last START time 16:30 so a 30-min slot ends at 17:00
  let e = new Date(d.getTime());
  e = setHours(e, 17);
  e = setMinutes(e, 0);
  e = setSeconds(e, 0);
  return e;
}

// Never let "hi/hello/hey/thanks/booking" be saved as a name
function safeCallerName(rawName) {
  const raw = rawName ? String(rawName).trim() : '';
  if (!raw) return 'New caller';

  const lower = raw.toLowerCase();
  const bad = new Set(['hi', 'hello', 'hey', 'thanks', 'thank you', 'booking']);
  if (bad.has(lower)) return 'New caller';

  return raw;
}

// Build SMS body (used when WhatsApp fails)
function buildSmsBody({ startISO }) {
  const spoken = formatSpokenDateTime(startISO, TZ);

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const lines = [
    `✅ (hi) MyBizPal — Business Consultation (15–30 min)`,
    `Date: ${spoken}`,
    '(Greenwich Mean Time)',
    '',
  ];

  if (zoomLink) {
    lines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) {
      lines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
    }
    lines.push('');
  }

  lines.push('Reply CHANGE to reschedule.');

  return lines.join('\n');
}

// ---------- EARLIEST AVAILABLE SLOT ----------

/**
 * Find earliest available 30-min slot within next N days,
 * starting from `fromISO` if provided, otherwise "now".
 * Rules:
 *  - Only Monday–Friday
 *  - Working hours: 09:00–17:00 UK time
 *  - 30-minute increments (00 or 30)
 *  - No overlap with existing events
 */
export async function findEarliestAvailableSlot({
  timezone = TZ,
  durationMinutes = 30,
  daysAhead = 7,
  fromISO = null,
}) {
  await ensureGoogleAuth();

  const base = fromISO ? new Date(fromISO) : new Date();
  const windowEnd = addDays(base, daysAhead);

  const timeMin = base.toISOString();
  const timeMax = windowEnd.toISOString();

  const res = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  const events = (res.data.items || []).filter(
    (ev) => ev.start?.dateTime && ev.end?.dateTime
  );

  // Start cursor from base, rounded UP to the next 30-min boundary
  let cursor = new Date(base.getTime());
  cursor.setSeconds(0, 0);
  const mins = cursor.getMinutes();
  const extra = mins % 30;
  if (extra !== 0) {
    cursor = addMinutes(cursor, 30 - extra);
  }

  // Move cursor to a valid working time (Mon–Fri, 9–17)
  function normaliseCursorToWorkingTime(d) {
    let c = new Date(d.getTime());
    // If weekend or after hours, bump to next valid weekday at 9:00
    while (isWeekend(c) || isAfter(c, dayEnd(c))) {
      c = dayStart(addDays(c, 1));
    }
    // If before 9am, move to 9am
    if (isBefore(c, dayStart(c))) {
      c = dayStart(c);
    }
    return c;
  }

  cursor = normaliseCursorToWorkingTime(cursor);

  for (;;) {
    if (isAfter(cursor, windowEnd)) break;

    cursor = normaliseCursorToWorkingTime(cursor);
    if (isAfter(cursor, windowEnd)) break;

    const slotEnd = addMinutes(cursor, durationMinutes);

    // Ensure this 30-min slot fits entirely within working hours
    if (isAfter(slotEnd, dayEnd(cursor))) {
      cursor = dayStart(addDays(cursor, 1));
      continue;
    }

    // Check overlap
    const overlapping = events.some((ev) => {
      const evStart = new Date(ev.start.dateTime);
      const evEnd = new Date(ev.end.dateTime);
      const latestStart = evStart > cursor ? evStart : cursor;
      const earliestEnd = evEnd < slotEnd ? evEnd : slotEnd;
      return earliestEnd > latestStart; // overlap if end > start
    });

    if (!overlapping) {
      const iso = cursor.toISOString();
      return {
        iso,
        spoken: formatSpokenDateTime(iso, timezone),
      };
    }

    // Move cursor to just after the end of the earliest overlapping event
    const overlappingEvents = events.filter((ev) => {
      const evStart = new Date(ev.start.dateTime);
      const evEnd = new Date(ev.end.dateTime);
      const latestStart = evStart > cursor ? evStart : cursor;
      const earliestEnd = evEnd < slotEnd ? evEnd : slotEnd;
      return earliestEnd > latestStart;
    });

    if (overlappingEvents.length === 0) {
      cursor = addMinutes(cursor, durationMinutes);
    } else {
      let soonestEnd = null;
      for (const ev of overlappingEvents) {
        const evEnd = new Date(ev.end.dateTime);
        if (!soonestEnd || evEnd < soonestEnd) {
          soonestEnd = evEnd;
        }
      }
      cursor = new Date(soonestEnd.getTime());
    }
  }

  // If no free slot found, return null
  return null;
}

// ---------- BASIC CONFLICT CHECKER ----------

export async function hasConflict({ startISO, durationMin = 30 }) {
  await ensureGoogleAuth();
  const start = new Date(startISO).toISOString();
  const end = new Date(new Date(startISO).getTime() + durationMin * 60000).toISOString();

  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: start,
    timeMax: end,
    maxResults: 1,
    singleEvents: true,
    orderBy: 'startTime',
  });
  return (r.data.items || []).length > 0;
}

// ---------- FIND & CANCEL EXISTING BOOKINGS ----------

export async function findExistingBooking({ phone, email }) {
  await ensureGoogleAuth();
  const nowISO = new Date().toISOString();
  const untilISO = addDays(new Date(), 60).toISOString();

  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: nowISO,
    timeMax: untilISO,
    singleEvents: true,
    maxResults: 50,
    orderBy: 'startTime',
  });

  const items = r.data.items || [];
  return (
    items.find((ev) => {
      const desc = (ev.description || '').toLowerCase();
      const sum = (ev.summary || '').toLowerCase();
      const tag = 'booked by mybizpal (gabriel)';
      const hasTag = desc.includes(tag);
      const hasContact =
        (phone && desc.includes(phone.replace('+', ''))) ||
        (email && desc.includes((email || '').toLowerCase()));
      const isOurMeeting = sum.includes('mybizpal');
      return hasTag && isOurMeeting && hasContact;
    }) || null
  );
}

export async function cancelEventById(id) {
  await ensureGoogleAuth();
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
}

// ---------- CREATE BOOKING EVENT + NOTIFICATIONS ----------

/**
 * Old-style API (what your code is using now).
 * Creates the event at `startISO` and sends WhatsApp confirmation,
 * with SMS fallback if WhatsApp fails.
 *
 * Returns the created Google Calendar event (same as before).
 */
export async function createBookingEvent({
  startISO,
  durationMinutes = 30,
  name,
  email,
  phone,
}) {
  await ensureGoogleAuth();

  const endISO = new Date(
    new Date(startISO).getTime() + durationMinutes * 60000
  ).toISOString();

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const safeName = safeCallerName(name);
  const whoPrefix = safeName && safeName !== 'New caller' ? `(${safeName}) ` : '';

  const descriptionLines = [
    'Booked by MyBizPal (Gabriel).',
    `Caller name: ${safeName}`,
    `Caller phone: ${phone || 'n/a'}`,
    `Caller email: ${email || 'n/a'}`,
  ];

  if (zoomLink) {
    descriptionLines.push('');
    descriptionLines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) {
      descriptionLines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
    }
    descriptionLines.push('');
    descriptionLines.push('tag: booked by mybizpal (gabriel)');
  } else {
    descriptionLines.push('');
    descriptionLines.push('tag: booked by mybizpal (gabriel)');
  }

  const event = {
    summary: `${whoPrefix}MyBizPal — Business Consultation (15–30 min)`,
    start: { dateTime: startISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    description: descriptionLines.join('\n'),
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'none',
  });

  // ----- WhatsApp first, then SMS fallback -----
  if (!phone) {
    console.warn('⚠️ No caller phone provided; cannot send WhatsApp/SMS confirmation');
    return created.data;
  }

  const smsBody = buildSmsBody({ startISO });
  let whatsappError = null;

  try {
    if (!WHATSAPP_FROM || !WHATSAPP_TEMPLATE_SID) {
      throw new Error('Missing WHATSAPP_FROM or TWILIO_WHATSAPP_TEMPLATE_SID env vars');
    }

    const toWhatsapp = phone.startsWith('whatsapp:') ? phone : `whatsapp:${phone}`;

    // We keep variables simple here – adapt to match your Twilio template
    const spoken = formatSpokenDateTime(startISO, TZ);

    const vars = {
      1: safeName,           // {{1}} name
      2: spoken,             // {{2}} full date/time text
      3: phone,              // {{3}} phone
      4: zoomLink || '',     // {{4}} zoom link (if any)
    };

    await twilioClient.messages.create({
      from: WHATSAPP_FROM,
      to: toWhatsapp,
      contentSid: WHATSAPP_TEMPLATE_SID,
      contentVariables: JSON.stringify(vars),
    });

    console.log('✅ WhatsApp confirmation sent');
  } catch (err) {
    whatsappError = err;
    console.error('❌ WhatsApp template send error:', err.message || err);
  }

  if (whatsappError) {
    try {
      if (!SMS_FROM) {
        throw new Error('Missing SMS_FROM env var');
      }

      await twilioClient.messages.create({
        from: SMS_FROM,
        to: phone,
        body: smsBody,
      });

      console.log('✅ SMS fallback confirmation sent');
    } catch (err) {
      console.error('❌ SMS fallback send error:', err.message || err);
    }
  }

  return created.data;
}

/**
 * New-style helper if you ever want to call with the whole booking object.
 * This simply adapts `booking` → `createBookingEvent` so either style works.
 */
export async function createBookingCalendarEventAndNotify(booking) {
  if (!booking) {
    throw new Error('createBookingCalendarEventAndNotify called without booking');
  }

  const startISO = booking.slotStartIso || booking.startISO;
  const durationMinutes = booking.durationMinutes || 30;

  if (!startISO) {
    throw new Error('Booking is missing slotStartIso/startISO');
  }

  return createBookingEvent({
    startISO,
    durationMinutes,
    name: booking.name,
    email: booking.email,
    phone: booking.phone,
  });
}

// Backwards-compatible alias if any file imports this name
export async function createCalendarEventAndNotify(booking) {
  return createBookingCalendarEventAndNotify(booking);
}
