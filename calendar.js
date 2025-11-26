// calendar.js
// Google Calendar helpers: earliest-available, create, cancel, find existing

import { google } from 'googleapis';
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

// ---------- COMMON HELPERS ----------

// Format spoken time (for messages / Gabriel read-back)
export function formatSpokenDateTime(iso, timezone = TZ) {
  const d = new Date(iso);
  const day = formatInTimeZone(d, timezone, 'eeee');
  const date = formatInTimeZone(d, timezone, 'd');
  const month = formatInTimeZone(d, timezone, 'LLLL');

  const mins = formatInTimeZone(d, timezone, 'mm');   // "00", "30", etc.
  const hour = formatInTimeZone(d, timezone, 'h');    // "1"–"12"
  const mer = formatInTimeZone(d, timezone, 'a');     // "AM" / "PM"

  let time;
  if (mins === '00') {
    // e.g. "9 o'clock A M"
    time = `${hour} o'clock ${mer[0]} ${mer[1]}`;
  } else {
    // e.g. "9:30 A M"
    time = `${hour}:${mins} ${mer[0]} ${mer[1]}`;
  }

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

// Never let junk like "hi/hello/booking/yes" be saved as a name
function safeCallerName(rawName) {
  const raw = rawName ? String(rawName).trim() : '';
  if (!raw) return 'New caller';

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
  if (bad.has(lower)) return 'New caller';

  // super short "names" are also treated as unknown
  if (lower.length <= 2) return 'New caller';

  return raw;
}

/**
 * Clamp a proposed start time into business hours:
 * - Mon–Fri only (day is left as-is; earliest-slot logic already avoids weekends)
 * - 09:00–17:00, 30-minute increments (last valid start 16:30)
 * If time is outside this window, we snap it back into the window
 * on the SAME day. This is a safety net (e.g. fixing a 06:00 bug to 09:00).
 */
function clampToBusinessHours(startISO) {
  const d = new Date(startISO);

  // Only clamp hours/mins; leave the date alone.
  let hours = d.getHours();
  let mins = d.getMinutes();

  if (hours < 9) {
    hours = 9;
    mins = 0;
  } else if (hours > 16 || (hours === 16 && mins > 30)) {
    hours = 16;
    mins = 30;
  } else {
    // Snap minutes to nearest 0 or 30 to keep clean slots
    if (mins < 15) mins = 0;
    else if (mins < 45) mins = 30;
    else {
      hours += 1;
      mins = 0;
    }
  }

  d.setHours(hours, mins, 0, 0);
  return d.toISOString();
}

// ---------- EARLIEST AVAILABLE SLOT ----------

/**
 * Find earliest available 30-min slot within next N days,
 * starting from `fromISO` if provided, otherwise "now".
 * Rules:
 *  - Only Monday–Friday
 *  - Working hours: 09:00–17:00
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

    // Check overlap with any existing events
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

// ---------- CREATE BOOKING EVENT ----------

/**
 * Creates the event at `startISO` clamped into business hours
 * and returns the created Google Calendar event.
 * Notifications (WhatsApp/SMS) are handled separately in sms.js.
 */
export async function createBookingEvent({
  startISO,
  durationMinutes = 30,
  name,
  email,
  phone,
  summaryNotes, // optional smart summary text
}) {
  await ensureGoogleAuth();

  const correctedStartISO = clampToBusinessHours(startISO);
  const endISO = new Date(
    new Date(correctedStartISO).getTime() + durationMinutes * 60000
  ).toISOString();

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const safeName = safeCallerName(name);
  const whoPrefix = safeName && safeName !== 'New caller' ? `(${safeName}) ` : '';

  const descriptionLines = [];

  if (summaryNotes && summaryNotes.trim()) {
    descriptionLines.push(summaryNotes.trim());
    descriptionLines.push('');
  }

  descriptionLines.push('Booked by MyBizPal (Gabriel).');
  descriptionLines.push(`Caller name: ${safeName}`);
  descriptionLines.push(`Caller phone: ${phone || 'n/a'}`);
  descriptionLines.push(`Caller email: ${email || 'n/a'}`);

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
    start: { dateTime: correctedStartISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    description: descriptionLines.join('\n'),
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'none',
  });

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
    summaryNotes: booking.summaryNotes || null,
  });
}

// Backwards-compatible alias if any file imports this name
export async function createCalendarEventAndNotify(booking) {
  return createBookingCalendarEventAndNotify(booking);
}
