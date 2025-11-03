import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { DateTime } from "luxon";

/**
 * =========================
 *  ENV & CONFIG
 * =========================
 * Required env vars on Render:
 *   - CALENDAR_ID           = info@mybizpal.ai
 *   - GOOGLE_CREDENTIALS    = (full service-account JSON)
 *   - BUSINESS_TIMEZONE     = Europe/London
 *   - WEBHOOK_SECRET        = mybizpal123   (or your own)
 *   - BUFFER_BEFORE_MIN     = 10
 *   - BUFFER_AFTER_MIN      = 10
 */
const TZ = process.env.BUSINESS_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.CALENDAR_ID;
const SECRET = process.env.WEBHOOK_SECRET || "";
const BUF_BEFORE = parseInt(process.env.BUFFER_BEFORE_MIN || "10", 10);
const BUF_AFTER  = parseInt(process.env.BUFFER_AFTER_MIN  || "10", 10);
const PORT = process.env.PORT || 3000;

// ---- Google auth (Domain-Wide Delegation; impersonate info@mybizpal.ai)
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const sa = JSON.parse(process.env.GOOGLE_CREDENTIALS);

const auth = new google.auth.JWT(
  sa.client_email,
  null,
  sa.private_key,
  SCOPES,
  "info@mybizpal.ai" // act as your Workspace user for invites/emails
);

const calendar = google.calendar({ version: "v3", auth });

/**
 * =========================
 *  APP SETUP
 * =========================
 */
const app = express();
app.use(bodyParser.json());

/**
 * =========================
 *  HELPERS
 * =========================
 */
function okAuth(req) {
  // Allow either body.auth or header x-webhook-secret
  if (!SECRET) return true;
  return req.body?.auth === SECRET || req.headers["x-webhook-secret"] === SECRET;
}

function businessWindow(dt) {
  const d = dt.setZone(TZ);
  const isBusinessDay = d.weekday >= 1 && d.weekday <= 5; // Mon–Fri
  const start = d.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
  const end   = d.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
  return { isBusinessDay, start, end };
}

async function isFree(startISO, endISO) {
  const fb = await calendar.freebusy.query({
    requestBody: {
      timeMin: startISO,
      timeMax: endISO,
      timeZone: TZ,
      items: [{ id: CALENDAR_ID }]
    }
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
      attendees,                          // send guest invites
      reminders: { useDefault: true }
    },
    sendUpdates: attendees?.length ? "all" : "none" // email guests if present
  })).data;
}

function parsePreferredStart(now, hint) {
  let dt = now.setZone(TZ);
  if (!hint || typeof hint !== "string") return dt;

  const lower = hint.toLowerCase();
  if (lower.includes("tomorrow")) dt = dt.plus({ days: 1 });

  // e.g. "after 2pm", "after 14:30"
  const m = lower.match(/after\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (m) {
    let hour = parseInt(m[1], 10);
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    const ampm = (m[3] || "").toLowerCase();
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    dt = dt.set({ hour, minute, second: 0, millisecond: 0 });
  }

  // round up to next 15 min
  if (dt.minute % 15 !== 0) {
    dt = dt.plus({ minutes: 15 - (dt.minute % 15) }).set({ second: 0, millisecond: 0 });
  }
  return dt;
}

/**
 * =========================
 *  ROUTES
 * =========================
 */
app.get("/", (_req, res) => res.send("MyBizPal Booking API ✅"));
app.get("/health", (_req, res) => res.json({ ok: true, tz: TZ }));

app.post("/book", async (req, res) => {
  try {
    if (!okAuth(req)) return res.status(401).json({ error: "unauthorized" });
    if (!CALENDAR_ID) return res.status(500).json({ error: "CALENDAR_ID missing" });

    const {
      name,
      email,
      phone,
      service = "Discovery Call",
      duration_min = 30,
      time_preference = "",
      notes = ""
    } = req.body || {};

    const now = DateTime.now().setZone(TZ);
    let candidate = time_preference ? parsePreferredStart(now, time_preference) : now;

    // Search forward in 15-minute steps until we find a valid business slot that is free
    for (let i = 0; i < 800; i++) {
      const { isBusinessDay, start, end } = businessWindow(candidate);

      let slot = candidate;
      if (!isBusinessDay || slot < start) slot = start;

      if (slot > end) {
        // move to next day 09:00
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      // Apply buffers
      const eventStart = slot.plus({ minutes: BUF_BEFORE });
      const eventEnd   = eventStart.plus({ minutes: duration_min });
      const hardEnd    = end.minus({ minutes: BUF_AFTER });

      // If it would overflow the business window, move to next day
      if (eventEnd > hardEnd) {
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      // Freebusy check
      if (await isFree(eventStart.toISO(), eventEnd.toISO())) {
        const ev = await createEvent({
          summary: `${service} — ${name || "Client"}`,
          description: [
            notes && `Notes: ${notes}`,
            phone && `Phone: ${phone}`
          ].filter(Boolean).join("\n"),
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
    console.error("Booking failed:", err?.response?.data || err);
    res.status(500).json({ error: "Booking failed", details: err.message || "unknown" });
  }
});

/**
 * =========================
 *  START
 * =========================
 */
app.listen(PORT, () => {
  console.log("✅ MyBizPal Booking Server (JWT impersonation) listening on", PORT);
});
