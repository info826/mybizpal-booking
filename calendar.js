// calendar.js
// Google Calendar helpers: earliest-available, create, cancel, find existing

import { google } from 'googleapis';
import { addMinutes, addDays, isBefore, isAfter, setSeconds } from 'date-fns';

// ✅ date-fns-tz v3+ API
import { formatInTimeZone, toZonedTime, fromZonedTime } from 'date-fns-tz';

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || process.env.CALENDAR_ID || 'primary';

const WORK_START_HOUR = Number(process.env.BUSINESS_START_HOUR || 9); // 09:00
const WORK_END_HOUR = Number(process.env.BUSINESS_END_HOUR || 17); // 17:00
const SLOT_MINUTES = Number(process.env.BUSINESS_SLOT_MINUTES || 30); // 30-min increments

const TAG = 'tag: booked by mybizpal (gabriel)'; // ✅ keep consistent lower-case for matching
const SUMMARY_PREFIX = 'MyBizPal'; // summary includes this so we can filter quickly

// ---------- GOOGLE CALENDAR SETUP ----------

const jwt = new google.auth.JWT(
  process.env.GOOGLE_CLIENT_EMAIL,
  null,
  (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
  ['https://www.googleapis.com/auth/calendar']
);

const calendar = google.calendar({ version: 'v3', auth: jwt });

let googleReady = false;
let googleReadyPromise = null;

async function ensureGoogleAuth() {
  if (googleReady) return;

  if (!googleReadyPromise) {
    googleReadyPromise = (async () => {
      await jwt.authorize();
      googleReady = true;
      console.log('✅ Google service account authorized for Calendar');
    })().catch((err) => {
      // allow retry next time
      googleReadyPromise = null;
      throw err;
    });
  }

  await googleReadyPromise;
}

// ---------- TIME HELPERS (TZ-SAFE) ----------

function isWeekendZoned(zonedDate) {
  const day = zonedDate.getDay(); // 0 = Sun, 6 = Sat
  return day === 0 || day === 6;
}

function setZonedTime(zonedDate, hours, minutes = 0, seconds = 0, ms = 0) {
  const d = new Date(zonedDate.getTime());
  d.setHours(hours, minutes, seconds, ms);
  return d;
}

function zonedDayStart(zonedDate) {
  return setZonedTime(zonedDate, WORK_START_HOUR, 0, 0, 0);
}

function zonedDayEnd(zonedDate) {
  // end boundary at 17:00; last valid start is 16:30 for 30-min slot
  return setZonedTime(zonedDate, WORK_END_HOUR, 0, 0, 0);
}

function snapZonedToSlotBoundary(zonedDate) {
  const d = new Date(zonedDate.getTime());
  d.setSeconds(0, 0);

  const mins = d.getMinutes();
  const extra = mins % SLOT_MINUTES;
  if (extra !== 0) {
    d.setMinutes(mins + (SLOT_MINUTES - extra));
  }
  return d;
}

function normaliseCursorToWorkingTimeZoned(zonedCursor) {
  let c = new Date(zonedCursor.getTime());

  // If weekend, move to next Monday at start of day
  while (isWeekendZoned(c)) {
    c = zonedDayStart(addDays(c, 1));
  }

  // If before start hour → move to day start
  if (isBefore(c, zonedDayStart(c))) {
    c = zonedDayStart(c);
  }

  // If at/after end hour → move to next weekday day start
  if (isAfter(c, zonedDayEnd(c)) || +c === +zonedDayEnd(c)) {
    c = zonedDayStart(addDays(c, 1));
    while (isWeekendZoned(c)) c = zonedDayStart(addDays(c, 1));
  }

  // Snap to slot boundary (00/30)
  c = snapZonedToSlotBoundary(c);

  // After snapping, re-check end-of-day
  const lastStart = setZonedTime(c, WORK_END_HOUR - 1, 30, 0, 0); // assumes 30-min slot; safe for default
  if (SLOT_MINUTES === 30) {
    if (isAfter(c, lastStart)) {
      c = zonedDayStart(addDays(c, 1));
      while (isWeekendZoned(c)) c = zonedDayStart(addDays(c, 1));
    }
  } else {
    // generic: if slot start + slot mins would exceed day end, move next day
    const endCandidate = addMinutes(c, SLOT_MINUTES);
    if (isAfter(endCandidate, zonedDayEnd(c))) {
      c = zonedDayStart(addDays(c, 1));
      while (isWeekendZoned(c)) c = zonedDayStart(addDays(c, 1));
      c = snapZonedToSlotBoundary(c);
    }
  }

  return c;
}

/**
 * Clamp a proposed start time into business hours in the BUSINESS timezone:
 * - Mon–Fri only (date is preserved; earliest-slot logic avoids weekends)
 * - WORK_START_HOUR–WORK_END_HOUR
 * - Slot boundary snap (00/30 by default)
 *
 * Clamp happens in TZ, then converts back to UTC ISO.
 */
function clampToBusinessHours(startISO, timezone = TZ) {
  const utcDate = new Date(startISO);
  const zoned = toZonedTime(utcDate, timezone);

  let c = new Date(zoned.getTime());
  c = setSeconds(c, 0);

  // If weekend, keep the date as-is (booking flow already avoids weekends),
  // but still clamp time. (Alternatively you can bump to next weekday here.)
  let hours = c.getHours();
  let mins = c.getMinutes();

  // Snap minutes to slot boundary
  const extra = mins % SLOT_MINUTES;
  if (extra !== 0) mins += SLOT_MINUTES - extra;

  // Clamp range: earliest start WORK_START_HOUR, latest start so slot ends at WORK_END_HOUR
  const latestStartMinutes = WORK_END_HOUR * 60 - SLOT_MINUTES;
  const proposedMinutes = hours * 60 + mins;

  if (proposedMinutes < WORK_START_HOUR * 60) {
    hours = WORK_START_HOUR;
    mins = 0;
  } else if (proposedMinutes > latestStartMinutes) {
    hours = Math.floor(latestStartMinutes / 60);
    mins = latestStartMinutes % 60;
  }

  c.setHours(hours, mins, 0, 0);

  const backToUtc = fromZonedTime(c, timezone);
  return backToUtc.toISOString();
}

// ---------- COMMON HELPERS ----------

// Format spoken time (for messages / read-back)
export function formatSpokenDateTime(iso, timezone = TZ) {
  const d = new Date(iso);
  const day = formatInTimeZone(d, timezone, 'eeee');
  const date = formatInTimeZone(d, timezone, 'd');
  const month = formatInTimeZone(d, timezone, 'LLLL');

  const mins = formatInTimeZone(d, timezone, 'mm'); // "00", "30", etc.
  const hour = formatInTimeZone(d, timezone, 'h'); // "1"–"12"
  const mer = formatInTimeZone(d, timezone, 'a'); // "AM"/"PM"

  let time;
  if (mins === '00') time = `${hour} o'clock ${mer[0]} ${mer[1]}`;
  else time = `${hour}:${mins} ${mer[0]} ${mer[1]}`;

  return `${day} ${date} ${month} at ${time}`;
}

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
  if (lower.length <= 2) return 'New caller';

  return raw;
}

function normalizePhoneDigits(phone) {
  if (!phone) return '';
  return String(phone).replace(/[^\d]/g, '');
}

// ---------- FAST FREEBUSY (PERFORMANCE) ----------

async function getBusyRanges({ timeMinISO, timeMaxISO }) {
  await ensureGoogleAuth();

  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: CALENDAR_ID }],
    },
  });

  const busy = fb.data.calendars?.[CALENDAR_ID]?.busy || [];
  // busy: [{ start, end }, ...] ISO strings (RFC3339)
  return busy
    .map((b) => ({ start: new Date(b.start), end: new Date(b.end) }))
    .filter((b) => b.start instanceof Date && b.end instanceof Date)
    .sort((a, b) => a.start - b.start);
}

function hasOverlapWithBusy(slotStart, slotEnd, busyRanges) {
  // busyRanges are sorted; small list typical; linear scan is fine
  for (const b of busyRanges) {
    // if busy starts after slot ends, can stop early
    if (b.start >= slotEnd) return false;
    if (b.end > slotStart && b.start < slotEnd) return true;
  }
  return false;
}

// ---------- EARLIEST AVAILABLE SLOT (TZ-CORRECT + FAST) ----------

/**
 * Find earliest available slot within next N days.
 * Rules:
 *  - Mon–Fri
 *  - WORK_START_HOUR–WORK_END_HOUR
 *  - SLOT_MINUTES increments
 *  - Uses FREEBUSY (faster + avoids pulling full event bodies)
 */
export async function findEarliestAvailableSlot({
  timezone = TZ,
  durationMinutes = SLOT_MINUTES,
  daysAhead = 7,
  fromISO = null,
}) {
  await ensureGoogleAuth();

  const baseUtc = fromISO ? new Date(fromISO) : new Date();
  const windowEndUtc = addDays(baseUtc, daysAhead);

  // Build cursor in business TZ, not server-local time
  let cursorZoned = toZonedTime(baseUtc, timezone);
  cursorZoned = setSeconds(cursorZoned, 0);
  cursorZoned = snapZonedToSlotBoundary(cursorZoned);
  cursorZoned = normaliseCursorToWorkingTimeZoned(cursorZoned);

  const timeMinISO = baseUtc.toISOString();
  const timeMaxISO = windowEndUtc.toISOString();

  const busyRanges = await getBusyRanges({ timeMinISO, timeMaxISO });

  for (;;) {
    // stop when cursor (converted to UTC) exceeds window end
    const cursorUtc = fromZonedTime(cursorZoned, timezone);
    if (isAfter(cursorUtc, windowEndUtc)) break;

    // ensure cursor is valid working time
    cursorZoned = normaliseCursorToWorkingTimeZoned(cursorZoned);

    const slotStartUtc = fromZonedTime(cursorZoned, timezone);
    const slotEndUtc = addMinutes(slotStartUtc, durationMinutes);

    // Ensure slot fits within work day (in TZ)
    const zonedSlotEnd = toZonedTime(slotEndUtc, timezone);
    const dayEnd = zonedDayEnd(cursorZoned);
    if (isAfter(zonedSlotEnd, dayEnd)) {
      cursorZoned = zonedDayStart(addDays(cursorZoned, 1));
      continue;
    }

    // Overlap check using busy ranges (UTC)
    if (!hasOverlapWithBusy(slotStartUtc, slotEndUtc, busyRanges)) {
      const iso = slotStartUtc.toISOString();
      return { iso, spoken: formatSpokenDateTime(iso, timezone) };
    }

    // advance cursor by slot size
    cursorZoned = addMinutes(cursorZoned, durationMinutes);
  }

  return null;
}

// ---------- BASIC CONFLICT CHECKER (FAST) ----------

export async function hasConflict({ startISO, durationMin = SLOT_MINUTES }) {
  await ensureGoogleAuth();

  const startUtc = new Date(startISO);
  const endUtc = new Date(startUtc.getTime() + durationMin * 60000);

  const busy = await getBusyRanges({
    timeMinISO: startUtc.toISOString(),
    timeMaxISO: endUtc.toISOString(),
  });

  return hasOverlapWithBusy(startUtc, endUtc, busy);
}

// ---------- FIND & CANCEL EXISTING BOOKINGS ----------

/**
 * Finds an upcoming MyBizPal booking for this caller.
 * Performance:
 * - First tries extendedProperties (privateExtendedProperty)
 * - Falls back to scanning only "MyBizPal" events and tag match
 */
export async function findExistingBooking({ phone, email }) {
  await ensureGoogleAuth();

  const nowISO = new Date().toISOString();
  const untilISO = addDays(new Date(), 60).toISOString();

  const wantPhone = phone ? String(phone).trim() : '';
  const wantEmail = email ? String(email).trim().toLowerCase() : '';
  const wantDigits = normalizePhoneDigits(wantPhone);

  // 1) Fast path: search by extended properties (most reliable)
  try {
    const privateExtendedProperty = [];
    if (wantPhone) privateExtendedProperty.push(`mybizpal_phone=${wantPhone}`);
    if (wantEmail) privateExtendedProperty.push(`mybizpal_email=${wantEmail}`);

    if (privateExtendedProperty.length) {
      const r1 = await calendar.events.list({
        calendarId: CALENDAR_ID,
        timeMin: nowISO,
        timeMax: untilISO,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 10,
        privateExtendedProperty,
      });

      const items1 = r1.data.items || [];
      const found1 =
        items1.find((ev) => {
          const desc = (ev.description || '').toLowerCase();
          const sum = (ev.summary || '').toLowerCase();
          return desc.includes(TAG) && sum.includes(SUMMARY_PREFIX.toLowerCase());
        }) || null;

      if (found1) return found1;
    }
  } catch (e) {
    console.warn('Extended property search failed, falling back:', e?.message || e);
  }

  // 2) Fallback: scan a limited set using q to reduce payload
  const r = await calendar.events.list({
    calendarId: CALENDAR_ID,
    timeMin: nowISO,
    timeMax: untilISO,
    singleEvents: true,
    maxResults: 50,
    orderBy: 'startTime',
    q: SUMMARY_PREFIX, // helps performance
  });

  const items = r.data.items || [];
  return (
    items.find((ev) => {
      const descRaw = ev.description || '';
      const desc = descRaw.toLowerCase();
      const sum = (ev.summary || '').toLowerCase();

      const hasTag = desc.includes(TAG);
      const isOurMeeting = sum.includes(SUMMARY_PREFIX.toLowerCase());

      const descDigits = normalizePhoneDigits(descRaw);
      const phoneMatches = wantDigits && descDigits && descDigits.includes(wantDigits);
      const emailMatches = wantEmail && desc.includes(wantEmail);

      return hasTag && isOurMeeting && (phoneMatches || emailMatches);
    }) || null
  );
}

export async function cancelEventById(id) {
  await ensureGoogleAuth();
  await calendar.events.delete({ calendarId: CALENDAR_ID, eventId: id });
}

// ---------- CREATE BOOKING EVENT ----------

/**
 * Creates the event at `startISO` clamped into business hours (in TZ)
 * and returns the created Google Calendar event.
 */
export async function createBookingEvent({
  startISO,
  durationMinutes = SLOT_MINUTES,
  name,
  email,
  phone,
  summaryNotes,
}) {
  await ensureGoogleAuth();

  const correctedStartISO = clampToBusinessHours(startISO, TZ);
  const endISO = new Date(new Date(correctedStartISO).getTime() + durationMinutes * 60000).toISOString();

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const safeName = safeCallerName(name);

  const descriptionLines = [];

  if (summaryNotes && summaryNotes.trim()) {
    descriptionLines.push(summaryNotes.trim());
    descriptionLines.push('');
  }

  descriptionLines.push('Booked by MyBizPal (Gabriel).');
  descriptionLines.push(`Caller name: ${safeName}`);
  descriptionLines.push(`Caller phone: ${phone || 'n/a'}`);
  descriptionLines.push(`Caller email: ${email || 'n/a'}`);
  descriptionLines.push('');
  if (zoomLink) {
    descriptionLines.push(`Zoom: ${zoomLink}`);
    if (zoomId || zoomPass) descriptionLines.push(`ID: ${zoomId}  Passcode: ${zoomPass}`);
    descriptionLines.push('');
  }
  descriptionLines.push(TAG);

  const event = {
    summary: `Business Strategy Consultation with ${safeName} — ${SUMMARY_PREFIX}`,
    start: { dateTime: correctedStartISO, timeZone: TZ },
    end: { dateTime: endISO, timeZone: TZ },
    description: descriptionLines.join('\n'),
    // IMPORTANT FOR REMINDERS + FINDING EXISTING EVENTS
    extendedProperties: {
      private: {
        mybizpal_phone: phone || '',
        mybizpal_email: (email || '').toLowerCase(),
        mybizpal_name: safeName,
        // legacy mirrors
        phone: phone || '',
        email: (email || '').toLowerCase(),
        name: safeName,
        mybizpal_lastNotifiedStartISO: correctedStartISO,
        mybizpal_cancel_notified: '0',
      },
    },
  };

  const created = await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: event,
    sendUpdates: 'none',
  });

  console.log('📅 Created calendar event', {
    id: created.data.id,
    start: correctedStartISO,
    phone,
    email: (email || '').toLowerCase(),
    name: safeName,
  });

  return created.data;
}

/**
 * Adapter helper: call with a booking-ish object if needed.
 */
export async function createBookingCalendarEventAndNotify(booking) {
  if (!booking) throw new Error('createBookingCalendarEventAndNotify called without booking');

  const startISO = booking.slotStartIso || booking.startISO;
  const durationMinutes = booking.durationMinutes || SLOT_MINUTES;

  if (!startISO) throw new Error('Booking is missing slotStartIso/startISO');

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
