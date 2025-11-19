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

// Format spoken time
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

/**
 * Find earliest available 30-min slot within the next N days.
 * Simple algorithm:
 *  - list events from now to now+daysAhead
 *  - walk from "cursor" time forward, skipping over busy blocks
 *  - respect basic working hours (9–18 local)
 */
export async function findEarliestAvailableSlot({
  timezone = TZ,
  durationMinutes = 30,
  daysAhead = 7,
}) {
  await ensureGoogleAuth();

  const now = new Date();
  const windowEnd = addDays(now, daysAhead);

  const timeMin = now.toISOString();
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

  // Start cursor: now rounded up to next 5 minutes
  let cursor = new Date(now.getTime());
  cursor.setSeconds(0, 0);
  const extraMins = cursor.getMinutes() % 5;
  if (extraMins !== 0) {
    cursor = addMinutes(cursor, 5 - extraMins);
  }

  // Working hour bounds per day
  function dayStart(d) {
    let s = new Date(d.getTime());
    s = setHours(s, 9);
    s = setMinutes(s, 0);
    s = setSeconds(s, 0);
    return s;
  }
  function dayEnd(d) {
    let e = new Date(d.getTime());
    e = setHours(e, 18);
    e = setMinutes(e, 0);
    e = setSeconds(e, 0);
    return e;
  }

  if (isBefore(cursor, dayStart(cursor))) {
    cursor = dayStart(cursor);
  }
  if (isAfter(cursor, dayEnd(cursor))) {
    cursor = dayStart(addDays(cursor, 1));
  }

  for (;;) {
    if (isAfter(cursor, windowEnd)) break;

    const slotEnd = addMinutes(cursor, durationMinutes);

    // If slotEnd is past working hours, move to next day 9:00
    if (isAfter(slotEnd, dayEnd(cursor))) {
      cursor = dayStart(addDays(cursor, 1));
      continue;
    }

    // Check if this [cursor, slotEnd) overlaps any event
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

    // Move cursor to just after the end of the earliest event that overlaps
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

// Basic conflict checker (not used by earliest, but useful)
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
  const who = name ? `(${name}) ` : '';

  const zoomLink = process.env.ZOOM_LINK || '';
  const zoomId = process.env.ZOOM_MEETING_ID || '';
  const zoomPass = process.env.ZOOM_PASSCODE || '';

  const descriptionLines = [
    'Booked by MyBizPal (Gabriel).',
    `Caller name: ${name || 'Prospect'}`,
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
    summary: `${who}MyBizPal — Business Consultation (15–30 min)`,
    start: { dateTime: startISO, timeZone: TZ },
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
