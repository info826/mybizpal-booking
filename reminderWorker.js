// reminderWorker.js
// Runs as a separate process (e.g. Render cron job) every 5 minutes
// - Looks at Google Calendar
// - Finds events ~24h and ~60m away and sends reminders via sms.js
// - Detects reschedules/cancellations and notifies customers

import { google } from 'googleapis';
import {
  sendReminderMessage,
  sendCancellationNotice,
  sendRescheduleNotice,
} from './sms.js';

const {
  GOOGLE_CLIENT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_CALENDAR_ID,
  BUSINESS_TIMEZONE,
} = process.env;

const TZ = BUSINESS_TIMEZONE || 'Europe/London';

function getJwtClient() {
  if (!GOOGLE_CLIENT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.error('❌ Missing GOOGLE_CLIENT_EMAIL or GOOGLE_PRIVATE_KEY');
    process.exit(1);
  }

  const key = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  // ⬇️ full calendar scope so we can PATCH extendedProperties
  return new google.auth.JWT(
    GOOGLE_CLIENT_EMAIL,
    undefined,
    key,
    ['https://www.googleapis.com/auth/calendar']
  );
}

function getCalendar(auth) {
  return google.calendar({ version: 'v3', auth });
}

async function fetchEventsInWindow({ calendar, timeMin, timeMax }) {
  const res = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });

  return res.data.items || [];
}

// Try to recover phone & name from the event
function extractPhoneAndNameFromEvent(event) {
  let phone = null;
  let name = null;

  const priv = event.extendedProperties?.private || {};

  // Support old + new keys
  if (priv.mybizpal_phone) phone = String(priv.mybizpal_phone);
  else if (priv.phone) phone = String(priv.phone);

  if (priv.mybizpal_name) name = String(priv.mybizpal_name);
  else if (priv.name) name = String(priv.name);

  const desc = event.description || '';

  if (!phone && desc) {
    const m = desc.match(/Phone:\s*([+\d][\d\s\-()]+)/i);
    if (m) {
      phone = m[1].replace(/[^\d+]/g, '');
    }
  }

  if (!name) {
    if (priv.name) name = String(priv.name);
    else if (event.summary) name = event.summary;
  }

  return { phone, name };
}

async function sendRemindersForOffset({ calendar, label, offsetMinutes }) {
  const now = new Date();

  // Window: offsetMinutes ± 2 minutes
  const timeMin = new Date(now.getTime() + (offsetMinutes - 2) * 60 * 1000);
  const timeMax = new Date(now.getTime() + (offsetMinutes + 2) * 60 * 1000);

  console.log(
    `🔍 [${label}] Checking events between ${timeMin.toISOString()} and ${timeMax.toISOString()}`
  );

  const events = await fetchEventsInWindow({ calendar, timeMin, timeMax });

  console.log(`🔍 [${label}] Found ${events.length} event(s)`);

  for (const event of events) {
    const startISO = event.start?.dateTime || event.start?.date;
    if (!startISO) {
      console.warn(`[${label}] Event ${event.id} has no start dateTime, skipping`);
      continue;
    }

    const { phone, name } = extractPhoneAndNameFromEvent(event);
    if (!phone) {
      console.warn(`[${label}] Event ${event.id} has no phone, skipping`);
      continue;
    }

    console.log(`📤 [${label}] Sending reminder`, {
      eventId: event.id,
      phone,
      name,
      startISO,
    });

    try {
      await sendReminderMessage({
        to: phone,
        startISO,
        name,
        label,
      });
    } catch (err) {
      console.error(`❌ [${label}] Failed to send reminder for event ${event.id}`, err);
    }
  }
}

// NEW: detect cancellations and reschedules and notify customers
async function handleUpdatedEvents(calendar) {
  const now = new Date();
  const updatedMin = new Date(now.getTime() - 10 * 60 * 1000); // last 10 minutes

  console.log(
    `🔁 [changes] Checking events updated since ${updatedMin.toISOString()}`
  );

  const res = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    singleEvents: false,
    showDeleted: true,
    updatedMin: updatedMin.toISOString(),
    maxResults: 50,
  });

  const events = res.data.items || [];
  console.log(`[changes] Found ${events.length} recently updated event(s)`);

  for (const ev of events) {
    const priv = ev.extendedProperties?.private || {};

    const phone =
      priv.mybizpal_phone || priv.phone ? String(priv.mybizpal_phone || priv.phone) : null;
    const name =
      priv.mybizpal_name || priv.name || ev.summary || '';

    if (!phone) {
      // Not a MyBizPal-tracked booking
      continue;
    }

    const lastNotifiedStartISO = priv.mybizpal_lastNotifiedStartISO || null;
    const cancelNotified = priv.mybizpal_cancel_notified === '1';

    const startISO = ev.start?.dateTime || ev.start?.date || null;

    // 1) CANCELLATION
    if (ev.status === 'cancelled') {
      if (cancelNotified) {
        continue;
      }

      const prevStart = lastNotifiedStartISO || startISO;
      if (!prevStart) continue;

      console.log('[changes] Sending cancellation notice for event', ev.id);

      try {
        await sendCancellationNotice({
          to: phone,
          startISO: prevStart,
          name,
        });

        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: {
              private: {
                ...priv,
                mybizpal_cancel_notified: '1',
              },
            },
          },
        });
      } catch (err) {
        console.error('[changes] Failed to send/mark cancellation for', ev.id, err);
      }

      continue;
    }

    // From here on, we only care about confirmed (non-cancelled) events
    if (ev.status !== 'confirmed') {
      continue;
    }

    // 2) RESCHEDULE: start time changed compared to lastNotifiedStartISO
    if (lastNotifiedStartISO && startISO && startISO !== lastNotifiedStartISO) {
      console.log('[changes] Sending reschedule notice for event', ev.id, {
        old: lastNotifiedStartISO,
        new: startISO,
      });

      try {
        await sendRescheduleNotice({
          to: phone,
          oldStartISO: lastNotifiedStartISO,
          newStartISO: startISO,
          name,
        });

        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: {
              private: {
                ...priv,
                mybizpal_lastNotifiedStartISO: startISO,
                mybizpal_cancel_notified: '0', // reset in case it was ever set
              },
            },
          },
        });
      } catch (err) {
        console.error('[changes] Failed to send/mark reschedule for', ev.id, err);
      }
    } else if (!lastNotifiedStartISO && startISO) {
      // Seed the tracking field for older events created before we added this logic
      try {
        await calendar.events.patch({
          calendarId: GOOGLE_CALENDAR_ID,
          eventId: ev.id,
          requestBody: {
            extendedProperties: {
              private: {
                ...priv,
                mybizpal_lastNotifiedStartISO: startISO,
              },
            },
          },
        });
      } catch (err) {
        console.error('[changes] Failed to seed lastNotifiedStartISO for', ev.id, err);
      }
    }
  }
}

(async () => {
  try {
    const auth = getJwtClient();
    await auth.authorize();

    const calendar = getCalendar(auth);

    console.log('🚀 Reminder worker started', {
      tz: TZ,
      calendarId: GOOGLE_CALENDAR_ID,
    });

    // 60-minute reminders
    await sendRemindersForOffset({ calendar, label: '60m', offsetMinutes: 60 });

    // 24-hour reminders
    await sendRemindersForOffset({ calendar, label: '24h', offsetMinutes: 1440 });

    // Detect changes/cancellations and notify customers
    await handleUpdatedEvents(calendar);

    console.log('✅ Reminder worker finished');
    process.exit(0);
  } catch (err) {
    console.error('❌ Reminder worker crashed', err);
    process.exit(1);
  }
})();
