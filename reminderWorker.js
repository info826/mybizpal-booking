// reminderWorker.js
// Runs as a separate process (e.g. Render cron job) every 5 minutes
// - Looks at Google Calendar
// - Finds events ~24h and ~60m away
// - Sends reminders via sms.js

import { google } from 'googleapis';
import { sendReminderMessage } from './sms.js';

const {
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY,
  GOOGLE_CALENDAR_ID,
  BUSINESS_TIMEZONE,
} = process.env;

const TZ = BUSINESS_TIMEZONE || 'Europe/London';

function getJwtClient() {
  if (!GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.error('❌ Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_PRIVATE_KEY');
    process.exit(1);
  }

  const key = GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n');

  return new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    undefined,
    key,
    ['https://www.googleapis.com/auth/calendar.readonly']
  );
}

async function fetchEventsInWindow({ auth, timeMin, timeMax }) {
  const calendar = google.calendar({ version: 'v3', auth });

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
  if (priv.phone) phone = String(priv.phone);
  if (priv.name) name = String(priv.name);

  const desc = event.description || '';

  if (!phone && desc) {
    // Look for "Phone: +44..." style
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

async function sendRemindersForOffset(label, offsetMinutes) {
  const now = new Date();

  // Window: offsetMinutes ± 2 minutes
  const timeMin = new Date(now.getTime() + (offsetMinutes - 2) * 60 * 1000);
  const timeMax = new Date(now.getTime() + (offsetMinutes + 2) * 60 * 1000);

  const auth = getJwtClient();
  await auth.authorize();

  console.log(`🔍 [${label}] Checking events between ${timeMin.toISOString()} and ${timeMax.toISOString()}`);

  const events = await fetchEventsInWindow({ auth, timeMin, timeMax });

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

(async () => {
  try {
    console.log('🚀 Reminder worker started', {
      tz: TZ,
      calendarId: GOOGLE_CALENDAR_ID,
    });

    // 60-minute reminders
    await sendRemindersForOffset('60m', 60);

    // 24-hour reminders
    await sendRemindersForOffset('24h', 1440);

    console.log('✅ Reminder worker finished');
    process.exit(0);
  } catch (err) {
    console.error('❌ Reminder worker crashed', err);
    process.exit(1);
  }
})();
