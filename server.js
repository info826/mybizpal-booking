import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { DateTime } from "luxon";

const app = express();
app.use(bodyParser.json());

// ---- Config from env
const TZ = process.env.BUSINESS_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.CALENDAR_ID;
const SECRET = process.env.WEBHOOK_SECRET || "";
const BUF_BEFORE = parseInt(process.env.BUFFER_BEFORE_MIN || "10", 10);
const BUF_AFTER  = parseInt(process.env.BUFFER_AFTER_MIN  || "10", 10);
const PORT = process.env.PORT || 3000;

// ---- Google auth (Domain-Wide Delegation - impersonate info@mybizpal.ai)
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const sa = JSON.parse(process.env.GOOGLE_CREDENTIALS);
const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  SCOPES,
  "info@mybizpal.ai"   // <- the Workspace user we're acting as
);
const calendar = google.calendar({ version: "v3", auth });

// ---- Helpers
function businessWindow(dt) {
  const d = dt.setZone(TZ);
  const isBusinessDay = d.weekday >= 1 && d.weekday <= 5; // Mon–Fri
  const start = d.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  const end   = d.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  return { isBusinessDay, start, end };
}

function assertAuth(req) {
  return !SECRET || req.body?.auth === SECRET || req.headers["x-webhook-secret"] === SECRET;
}

async function isFree(startISO, endISO) {
  const fb = await calendar.freebusy.query({
    requestBody: { timeMin: startISO, timeMax: endISO, timeZone: TZ, items: [{ id: CALENDAR_ID }] }
  });
  return (fb.data.calendars[CALENDAR_ID]?.busy || []).length === 0;
}

async function createEvent({ summary, description, startISO, endISO, attendees }) {
  return (await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
      attendees,
      reminders: { useDefault: true }
    },
    // with DWD + impersonation we can send emails to attendees
    sendUpdates: attendees?.length ? "all" : "none"
  })).data;
}

function parsePreferredStart(now, hint) {
  let dt = now.setZone(TZ);
  if (hint?.toLowerCase().includes("tomorrow")) dt = dt.plus({ days: 1 });
  const m = hint?.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    dt = dt.set({ hour, minute: min, second: 0, millisecond: 0 });
  }
  // round up to next 15 minutes
  return dt.minute % 15 === 0 ? dt : dt.plus({ minutes: 15 - (dt.minute % 15) }).set({ second: 0, millisecond: 0 });
}

// ---- Routes
app.get("/", (req, res) => res.send("MyBizPal Booking API (Render) ✅"));

app.post("/book", async (req, res) => {
  try {
    if (!assertAuth(req)) return res.status(401).json({ error: "unauthorized" });
    if (!CALENDAR_ID) return res.status(500).json({ error: "CALENDAR_ID missing" });

    const { name, email, phone, service = "Discovery Call", duration_min = 30, time_preference = "", notes = "" } = req.body;

    const now = DateTime.now().setZone(TZ);
    let candidate = time_preference ? parsePreferredStart(now, time_preference) : now;

    // search forward in 15-min increments
    for (let i = 0; i < 800; i++) {
      const { isBusinessDay, start, end } = businessWindow(candidate);

      let slot = candidate;
      if (!isBusinessDay || slot < start) slot = start;
      if (slot > end) {
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0 });
        continue;
      }

      const eventStart = slot.plus({ minutes: BUF_BEFORE });
      const eventEnd = eventStart.plus({ minutes: duration_min });
      const hardEnd = end.minus({ minutes: BUF_AFTER });

      if (eventEnd > hardEnd) {
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0 });
        continue;
      }

      if (await isFree(eventStart.toISO(), eventEnd.toISO())) {
        const ev = await createEvent({
          summary: `${service} — ${name || "Client"}`,
          description: [notes && `Notes: ${notes}`, phone && `Phone: ${phone}`].filter(Boolean).join("\n"),
          startISO: eventStart.toISO(),
          endISO: eventEnd.toISO(),
          attendees: email ? [{ email }] : []
        });

        return res.json({
          status: "confirmed",
          eventId: ev.id,
          start: ev.start?.dateTime,
          end: ev.end?.dateTime,
          htmlLink: ev.htmlLink || null
        });
      }

      candidate = candidate.plus({ minutes: 15 });
    }

    res.status(409).json({ error: "No free slot found" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Booking failed", details: err.message });
  }
});

app.listen(PORT, () => console.log("✅ MyBizPal Booking Server (JWT impersonation) on PORT:", PORT));

