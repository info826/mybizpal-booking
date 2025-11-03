import express from "express";
import bodyParser from "body-parser";
import { google } from "googleapis";
import { DateTime, Interval } from "luxon";
import twilio from "twilio";

/**
 * =========================
 *  ENV & CONFIG
 * =========================
 * Required on Render:
 *   - CALENDAR_ID           = info@mybizpal.ai
 *   - GOOGLE_CREDENTIALS    = (full service-account JSON)
 *   - BUSINESS_TIMEZONE     = Europe/London
 *   - WEBHOOK_SECRET        = mybizpal123
 *   - BUFFER_BEFORE_MIN     = 10
 *   - BUFFER_AFTER_MIN      = 10
 *   - TWILIO_ACCOUNT_SID    = ACxxxx
 *   - TWILIO_AUTH_TOKEN     = ********
 *   - SMS_FROM              = +447456438935   ✅ your UK sender
 *   - ADMIN_MOBILE          = +44XXXXXXXXXX   (your phone to receive alerts)
 */
const TZ = process.env.BUSINESS_TIMEZONE || "Europe/London";
const CALENDAR_ID = process.env.CALENDAR_ID;
const SECRET = process.env.WEBHOOK_SECRET || "";
const BUF_BEFORE = parseInt(process.env.BUFFER_BEFORE_MIN || "10", 10);
const BUF_AFTER  = parseInt(process.env.BUFFER_AFTER_MIN  || "10", 10);
const PORT = process.env.PORT || 3000;

// Twilio
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const SMS_FROM = process.env.SMS_FROM || "+447456438935"; // default to your number
const ADMIN_MOBILE = process.env.ADMIN_MOBILE || ""; // set this in env for admin alerts

// Google auth (Domain-Wide Delegation; impersonate info@mybizpal.ai)
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

// App
const app = express();
app.use(bodyParser.json());

/* =========================
   HELPERS
========================= */
function okAuth(req) {
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

async function createEvent({ summary, description, startISO, endISO, attendees, privateProps }) {
  return (await calendar.events.insert({
    calendarId: CALENDAR_ID,
    requestBody: {
      summary,
      description,
      start: { dateTime: startISO, timeZone: TZ },
      end:   { dateTime: endISO,   timeZone: TZ },
      attendees,
      reminders: { useDefault: true },
      extendedProperties: privateProps ? { private: privateProps } : undefined
    },
    sendUpdates: attendees?.length ? "all" : "none"
  })).data;
}

async function patchEventPrivateProps(eventId, props) {
  return (await calendar.events.patch({
    calendarId: CALENDAR_ID,
    eventId,
    requestBody: {
      extendedProperties: { private: props }
    }
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

// SMS helpers
function normalizeUK(phone) {
  if (!phone) return "";
  const p = phone.toString().trim().replace(/\s+/g, "");
  if (p.startsWith("+")) return p;
  if (p.startsWith("0")) return "+44" + p.slice(1);
  if (p.startsWith("44")) return "+" + p;
  return p; // assume already E.164
}

async function sendSMS(to, body) {
  if (!to) return;
  const dst = normalizeUK(to);
  await twilioClient.messages.create({ from: SMS_FROM, to: dst, body });
}

function fmt(dtISO) {
  return DateTime.fromISO(dtISO, { zone: TZ }).toFormat("ccc dd LLL, HH:mm");
}

/* =========================
   ROUTES
========================= */
app.get("/", (_req, res) => res.send("MyBizPal Booking API ✅"));
app.get("/health", (_req, res) => res.json({ ok: true, tz: TZ }));

/**
 * Create booking
 * Body:
 *  - auth, name, email, phone, service, duration_min, time_preference, notes
 */
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

    // Search forward in 15-minute steps
    for (let i = 0; i < 800; i++) {
      const { isBusinessDay, start, end } = businessWindow(candidate);

      let slot = candidate;
      if (!isBusinessDay || slot < start) slot = start;

      if (slot > end) {
        // next business day at 09:00
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      // Buffers and checks
      const eventStart = slot.plus({ minutes: BUF_BEFORE });
      const eventEnd   = eventStart.plus({ minutes: duration_min });
      const hardEnd    = end.minus({ minutes: BUF_AFTER });

      if (eventEnd > hardEnd) {
        candidate = start.plus({ days: 1 }).set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
        continue;
      }

      if (await isFree(eventStart.toISO(), eventEnd.toISO())) {
        // Create event with private flags (to track reminder state)
        const privateProps = {
          sms_sent_confirm: "0",
          sms_sent_24h: "0",
          sms_sent_2h: "0",
          client_phone: phone ? normalizeUK(phone) : "",
          client_email: email || "",
          client_name: name || ""
        };

        const ev = await createEvent({
          summary: `${service} — ${name || "Client"}`,
          description: [notes && `Notes: ${notes}`, phone && `Phone: ${normalizeUK(phone)}`]
            .filter(Boolean)
            .join("\n"),
          startISO: eventStart.toISO(),
          endISO: eventEnd.toISO(),
          attendees: email ? [{ email }] : [],
          privateProps
        });

        // SMS: Client confirmation
        if (phone) {
          await sendSMS(phone,
            `Hi ${name || "there"}, your ${service} is booked for ${fmt(ev.start.dateTime)} (${TZ}). ` +
            `Reply to this SMS if you need help.\n— MyBizPal.ai`
          );
        }

        // SMS: Admin alert
        if (ADMIN_MOBILE) {
          await sendSMS(ADMIN_MOBILE,
            `New booking: ${service} at ${fmt(ev.start.dateTime)}. ` +
            `${name || "Client"} ${phone ? "(" + normalizeUK(phone) + ")" : ""}`
          );
        }

        // Mark confirm sent
        await patchEventPrivateProps(ev.id, { ...privateProps, sms_sent_confirm: "1" });

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
 * Cancel booking (by eventId)
 * Body: { auth, eventId, reason? }
 */
app.post("/cancel", async (req, res) => {
  try {
    if (!okAuth(req)) return res.status(401).json({ error: "unauthorized" });
    const { eventId, reason } = req.body || {};
    if (!eventId) return res.status(400).json({ error: "eventId required" });

    // Read event to get phone/email before deleting
    const ev = (await calendar.events.get({ calendarId: CALENDAR_ID, eventId })).data;
    const startISO = ev.start?.dateTime;
    const startStr = startISO ? fmt(startISO) : "(unknown time)";
    const priv = ev.extendedProperties?.private || {};
    const phone = priv.client_phone || "";
    const name  = priv.client_name || "Client";

    await calendar.events.delete({ calendarId: CALENDAR_ID, eventId, sendUpdates: "all" });

    // SMS client + admin
    if (phone) {
      await sendSMS(phone, `Your appointment on ${startStr} has been cancelled${reason ? `: ${reason}` : "."}`);
    }
    if (ADMIN_MOBILE) {
      await sendSMS(ADMIN_MOBILE, `Cancelled: ${ev.summary || "Appointment"} on ${startStr}${reason ? ` (Reason: ${reason})` : ""}`);
    }

    res.json({ status: "cancelled", eventId });
  } catch (err) {
    console.error("Cancel failed:", err?.response?.data || err);
    res.status(500).json({ error: "Cancel failed", details: err.message || "unknown" });
  }
});

/**
 * CRON: reminder sender (hit hourly)
 * - Sends T-24h and T-2h reminders
 * - Uses event extendedProperties.private to avoid duplicates
 */
app.post("/cron/reminders", async (req, res) => {
  try {
    if (!okAuth(req)) return res.status(401).json({ error: "unauthorized" });

    const now = DateTime.now().setZone(TZ);
    const windowEnd = now.plus({ hours: 26 }); // scan the next ~day
    const events = (await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: now.toISO(),
      timeMax: windowEnd.toISO(),
      singleEvents: true,
      orderBy: "startTime"
    })).data.items || [];

    let sent = 0;

    for (const ev of events) {
      if (!ev.start?.dateTime) continue;
      const start = DateTime.fromISO(ev.start.dateTime, { zone: TZ });
      const priv = ev.extendedProperties?.private || {};
      const phone = priv.client_phone || "";

      if (!phone) continue;

      const hoursToGo = start.diff(now, "hours").hours;

      // T-24h window: 23.5h–24.5h
      if (hoursToGo <= 24.5 && hoursToGo >= 23.5 && priv.sms_sent_24h !== "1") {
        await sendSMS(phone,
          `Reminder: your ${ev.summary || "appointment"} is tomorrow at ${fmt(ev.start.dateTime)} (${TZ}). ` +
          `Reply to this SMS if you need to reschedule.`
        );
        await patchEventPrivateProps(ev.id, { ...priv, sms_sent_24h: "1" });
        sent++;
      }

      // T-2h window: 1.5h–2.5h
      if (hoursToGo <= 2.5 && hoursToGo >= 1.5 && priv.sms_sent_2h !== "1") {
        await sendSMS(phone,
          `Heads up: your ${ev.summary || "appointment"} is at ${fmt(ev.start.dateTime)} (${TZ}). ` +
          `See you soon!`
        );
        await patchEventPrivateProps(ev.id, { ...priv, sms_sent_2h: "1" });
        sent++;
      }
    }

    res.json({ ok: true, reminders_sent: sent });
  } catch (err) {
    console.error("Reminders failed:", err?.response?.data || err);
    res.status(500).json({ error: "Reminders failed", details: err.message || "unknown" });
  }
});

/**
 * CRON: daily summary (hit once each morning)
 * - Sends today's schedule to ADMIN_MOBILE
 */
app.post("/cron/daily_summary", async (req, res) => {
  try {
    if (!okAuth(req)) return res.status(401).json({ error: "unauthorized" });
    if (!ADMIN_MOBILE) return res.json({ ok: true, note: "ADMIN_MOBILE not set — skipping" });

    const today = DateTime.now().setZone(TZ).startOf("day");
    const tomorrow = today.plus({ days: 1 });
    const events = (await calendar.events.list({
      calendarId: CALENDAR_ID,
      timeMin: today.toISO(),
      timeMax: tomorrow.toISO(),
      singleEvents: true,
      orderBy: "startTime"
    })).data.items || [];

    if (!events.length) {
      await sendSMS(ADMIN_MOBILE, `Daily summary: No bookings today (${today.toFormat("ccc dd LLL")}).`);
      return res.json({ ok: true, sent: "no-events" });
    }

    const lines = events.map((ev) => {
      const start = ev.start?.dateTime ? fmt(ev.start.dateTime) : "unknown";
      const priv = ev.extendedProperties?.private || {};
      const who = priv.client_name || (ev.summary || "").split("—").pop()?.trim() || "Client";
      return `• ${start} — ${ev.summary || "Appointment"} — ${who}`;
    });

    await sendSMS(ADMIN_MOBILE, `Today's bookings:\n${lines.join("\n")}`);
    res.json({ ok: true, count: events.length });
  } catch (err) {
    console.error("Daily summary failed:", err?.response?.data || err);
    res.status(500).json({ error: "Daily summary failed", details: err.message || "unknown" });
  }
});

app.listen(PORT, () => {
  console.log("✅ MyBizPal Booking Server (Full Automation) listening on", PORT);
});
