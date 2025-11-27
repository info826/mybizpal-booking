// booking.js
// Booking state machine: extract fields, propose earliest slot, confirm & create events.

import {
  parseUkPhone,
  isLikelyUkNumberPair,
  extractEmailSmart,
  yesInAnyLang,
  noInAnyLang,
  parseNaturalDate,
} from './parsing.js';
import {
  findEarliestAvailableSlot,
  createBookingEvent,
  findExistingBooking,
  cancelEventById,
  formatSpokenDateTime,
  hasConflict,
} from './calendar.js';
import { sendConfirmationAndReminders } from './sms.js';
import OpenAI from 'openai';

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/London';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function ensureBooking(callState) {
  if (!callState.booking) {
    callState.booking = {
      intent: 'none',
      name: null,
      phone: null,
      email: null,

      // Requested / confirmed time
      timeISO: null,
      timeSpoken: null,

      // Earliest-available suggestion
      wantsEarliest: false,
      earliestSlotISO: null,
      earliestSlotSpoken: null,

      // Confirmation state
      awaitingTimeConfirm: false,
      bookingConfirmed: false,
      lastEventId: null,

      // Internal flags
      lastPromptWasTimeSuggestion: false,
      needEmailBeforeBooking: false, // "we've already asked for email for this confirmed time"

      // Notes for calendar / Zoom prep
      summaryNotes: null,
    };
  }
  return callState.booking;
}

function detectBookingIntent(text) {
  const t = (text || '').toLowerCase();
  if (
    /(book|schedule|set up|arrange|appointment|consultation|call|meeting|demo)/.test(
      t
    )
  ) {
    return true;
  }
  return false;
}

function detectEarliestRequest(text) {
  const t = (text || '').toLowerCase();
  return (
    /earliest available|earliest|soonest|asap|as soon as possible|first available|next available/.test(
      t
    )
  );
}

// ---- SMART SUMMARY BUILDER ----

function isBoringSentence(str = '') {
  const t = str.trim().toLowerCase();
  if (!t) return true;
  if (t.length < 4) return true;

  const boring = new Set([
    'yes',
    'yeah',
    'yep',
    'yup',
    'no',
    'nope',
    'ok',
    'okay',
    'alright',
    'sure',
    'fine',
    'good',
    'perfect',
    'thanks',
    'thank you',
  ]);
  if (boring.has(t)) return true;

  return false;
}

// Old bullet-style summary kept as a fallback if AI is unavailable
function buildFallbackSummary(callState) {
  const history = (callState && callState.history) || [];
  const userUtterances = history
    .filter((m) => m.role === 'user')
    .map((m) => (m.content || '').trim())
    .filter(Boolean);

  if (userUtterances.length === 0) return null;

  const mainRequest =
    userUtterances.find((u) => !isBoringSentence(u)) || userUtterances[0];

  const keyPoints = userUtterances.filter(
    (u) => u !== mainRequest && !isBoringSentence(u)
  );

  const lines = [];
  lines.push('Smart summary (for Zoom prep):');
  lines.push('- Interested in a MyBizPal consultation / demo.');
  if (mainRequest) {
    lines.push(`- Main request in their words: "${mainRequest}"`);
  }

  const maxKeys = 3;
  for (let i = 0; i < Math.min(maxKeys, keyPoints.length); i++) {
    lines.push(`- Key point ${i + 1}: ${keyPoints[i]}`);
  }

  return lines.join('\n');
}

/**
 * New AI-powered smart summary.
 * Produces a SINGLE paragraph (no bullets) describing:
 * - enquiry + pain points
 * - sentiment / warmth / interest
 * - what to focus on in the Zoom to convert
 * - any specific questions or notes from the caller
 */
async function buildSmartSummary(callState) {
  try {
    if (!openai.apiKey) {
      // No API key available – fall back to simple list summary
      return buildFallbackSummary(callState);
    }

    const history = (callState && callState.history) || [];
    if (!history.length) return null;

    const booking = callState.booking || {};
    const behaviour = callState.behaviour || {};

    // Keep transcript short-ish: last 20 messages (10 exchanges)
    const recent = history.slice(-20);
    const transcript = recent
      .map((m) => {
        const speaker = m.role === 'user' ? 'Caller' : 'Gabriel';
        return `${speaker}: ${m.content || ''}`;
      })
      .join('\n')
      .trim();

    if (!transcript) return null;

    const bookingContext = `
Intent: ${booking.intent || 'none'}
Name (may be unknown): ${booking.name || 'unknown'}
Phone present: ${booking.phone ? 'yes' : 'no'}
Email present: ${booking.email ? 'yes' : 'no'}
Requested time (spoken): ${booking.timeSpoken || booking.earliestSlotSpoken || 'not specified'}
`.trim();

    const behaviourContext = `
Rapport level (0–5): ${behaviour.rapportLevel ?? 0}
Interest level: ${behaviour.interestLevel || 'unknown'}
Scepticism level: ${behaviour.scepticismLevel || 'unknown'}
Pain points mentioned: ${behaviour.painPointsMentioned ? 'yes' : 'no'}
Decision power: ${behaviour.decisionPower || 'unknown'}
Booking readiness: ${behaviour.bookingReadiness || 'unknown'}
`.trim();

    const systemPrompt = `
You are an internal assistant for MyBizPal creating a smart prep note
for a human consultant who will run a Zoom call.

Write a SINGLE short paragraph (3–6 sentences, no bullets, no headings) that summarises:
- What the caller was asking about and what they care about.
- Any explicit or implied pain points (e.g. missed calls, lost leads, time wasted).
- How the caller seemed emotionally and commercially (warm / neutral / cold; curious, sceptical, etc.).
- How interested they seem in MyBizPal and how strong the opportunity looks.
- What the consultant should focus on in the upcoming Zoom to maximise conversion.
- Any specific questions or requests the caller made that should be addressed on the call.

Tone: concise, professional and practical, written in third person
(“The caller…”, “They…”, “Gabriel’s impression is that…”).
Do NOT use bullet points. Do NOT include labels like “Pain points:”.
Just write one coherent paragraph.
`.trim();

    const userPrompt = `
CALL TRANSCRIPT (partial, most recent first-to-last):

${transcript}

BOOKING CONTEXT:
${bookingContext}

BEHAVIOUR CONTEXT:
${behaviourContext}
`.trim();

    const completion = await openai.chat.completions.create({
      model: 'gpt-5.1',
      reasoning_effort: 'none',
      temperature: 0.4,
      max_completion_tokens: 220,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    let summary =
      completion.choices?.[0]?.message?.content?.trim() || '';

    if (!summary) {
      return buildFallbackSummary(callState);
    }

    // Hard safety: ensure it's not accidentally bullet-style
    if (summary.includes('\n- ') || summary.startsWith('- ')) {
      summary = summary.replace(/\n- /g, ' ').replace(/^- /, '');
    }

    return summary;
  } catch (err) {
    console.error('Error building smart summary:', err);
    return buildFallbackSummary(callState);
  }
}

/**
 * Step 1: update booking state from the latest user utterance.
 *  - Fill in name / phone / email / time if found
 *  - If user wants "earliest" and we don't have a slot yet, look up earliest available
 */
export async function updateBookingStateFromUtterance({
  userText,
  callState,
  timezone = BUSINESS_TIMEZONE,
}) {
  const booking = ensureBooking(callState);
  const raw = userText || '';

  // Detect booking intent
  if (detectBookingIntent(raw)) {
    booking.intent = 'wants_booking';
  }

  // Earliest request?
  if (detectEarliestRequest(raw)) {
    booking.wantsEarliest = true;
  }

  // Try extract phone
  if (!booking.phone) {
    const pair = parseUkPhone(raw);
    if (pair && isLikelyUkNumberPair(pair)) {
      booking.phone = pair.e164; // store E.164 (+44…) for SMS / WhatsApp
    }
  }

  // Try extract email (smart)
  if (!booking.email) {
    const eSmart = extractEmailSmart(raw);
    if (eSmart) {
      booking.email = eSmart;
    }
  }

  // Try parse natural date/time (e.g. "tomorrow morning", "next Tuesday at 3")
  if (!booking.timeISO) {
    const nat = parseNaturalDate(raw, timezone);
    if (nat) {
      booking.timeISO = nat.iso;
      booking.timeSpoken = nat.spoken;
      booking.awaitingTimeConfirm = true;
    }
  }

  // If user wants earliest and we don't yet have a candidate, look it up.
  // If they mentioned a day ("tomorrow", "next Tuesday"), use that as a starting point.
  if (
    booking.intent === 'wants_booking' &&
    booking.wantsEarliest &&
    !booking.earliestSlotISO
  ) {
    const fromISO = booking.timeISO || null;

    const earliest = await findEarliestAvailableSlot({
      timezone,
      durationMinutes: 30,
      daysAhead: 7,
      fromISO,
    });

    if (earliest && earliest.iso) {
      booking.earliestSlotISO = earliest.iso;
      booking.earliestSlotSpoken =
        earliest.spoken || formatSpokenDateTime(earliest.iso, timezone);
      booking.awaitingTimeConfirm = true;
      booking.lastPromptWasTimeSuggestion = true;
    }
  }

  callState.booking = booking;
}

/**
 * Step 2: system actions that must happen BEFORE GPT speaks:
 *  - If we already have a confirmed time + phone (+ email), create the event.
 *  - User confirms or rejects a suggested time (natural or earliest).
 */
export async function handleSystemActionsFirst({ userText, callState }) {
  const booking = ensureBooking(callState);
  const t = (userText || '').trim().toLowerCase();

  const phone = booking.phone || callState.callerNumber || null;
  const email = booking.email || null;
  const name = booking.name || null;

  // Time that we would book if confirmed
  const timeCandidate = booking.timeISO || booking.earliestSlotISO || null;

  // A) If we already have a CONFIRMED time (awaitingTimeConfirm = false),
  //    plus phone, and no booking yet, handle email + booking.
  if (
    timeCandidate &&
    phone &&
    !booking.bookingConfirmed &&
    !booking.awaitingTimeConfirm
  ) {
    // If email missing → ask once, then wait for it
    if (!email) {
      if (!booking.needEmailBeforeBooking) {
        booking.needEmailBeforeBooking = true;
        const replyText =
          'Brilliant — before I lock that in, what’s your best email address, nice and slowly?';
        return {
          intercept: true,
          replyText,
        };
      }
      // We've already asked for email; let GPT handle the conversation while
      // the email-capture logic does its thing.
      return { intercept: false };
    }

    // 🔍 Check for conflicts with existing events before booking
    const conflict = await hasConflict({ startISO: timeCandidate, durationMin: 30 });

    if (conflict) {
      // Try to find the next available 30-min slot starting from this time
      const nextSlot = await findEarliestAvailableSlot({
        timezone: BUSINESS_TIMEZONE,
        durationMinutes: 30,
        daysAhead: 7,
        fromISO: timeCandidate,
      });

      if (nextSlot && nextSlot.iso) {
        booking.timeISO = null;
        booking.timeSpoken = null;
        booking.earliestSlotISO = nextSlot.iso;
        booking.earliestSlotSpoken =
          nextSlot.spoken || formatSpokenDateTime(nextSlot.iso, BUSINESS_TIMEZONE);
        booking.awaitingTimeConfirm = true;
        booking.lastPromptWasTimeSuggestion = true;
        booking.needEmailBeforeBooking = false;

        const replyText = `It looks like that exact time has just been taken. The next available slot I can see is ${booking.earliestSlotSpoken}. Would you like me to book you in for then?`;

        return {
          intercept: true,
          replyText,
        };
      }

      // No free slots found at all
      booking.timeISO = null;
      booking.timeSpoken = null;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;

      const replyText =
        "It looks like we’re fully booked around that time. What other day and time would work for you (Monday to Friday, 9 to 5 UK time)?";

      return {
        intercept: true,
        replyText,
      };
    }

    // We have time + phone + email and no conflict → create / replace booking now
    try {
      const existing = await findExistingBooking({ phone, email });
      if (existing && existing.id) {
        try {
          await cancelEventById(existing.id);
        } catch (e) {
          console.warn('Cancel previous booking failed:', e?.message || e);
        }
      }

      // Build smart summary from call history for the calendar notes
      const summaryNotes = await buildSmartSummary(callState);
      booking.summaryNotes = summaryNotes || null;

      const event = await createBookingEvent({
        startISO: timeCandidate,
        durationMinutes: 30,
        name,
        email,
        phone,
        summaryNotes,
      });

      const startISO = event.start?.dateTime || timeCandidate;

      await sendConfirmationAndReminders({
        to: phone,
        startISO,
        name,
      });

      booking.bookingConfirmed = true;
      booking.lastEventId = event.id;
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;

      const spoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);
      const replyText =
        name
          ? `Brilliant ${name} — I’ve got you booked in for ${spoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`
          : `Brilliant — I’ve got that booked in for ${spoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`;

      return {
        intercept: true,
        replyText,
      };
    } catch (err) {
      console.error('Booking error after email capture:', err);
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;
      return {
        intercept: true,
        replyText:
          "Hmm, something didn’t quite go through on my side. I’ll note your details and follow up, but is there anything else I can help with for now?",
      };
    }
  }

  // B) If we are waiting on a yes/no for a specific time suggestion
  if (booking.awaitingTimeConfirm && (yesInAnyLang(t) || noInAnyLang(t))) {
    if (yesInAnyLang(t)) {
      // Decide which time to use as the confirmed slot
      const timeISO = booking.timeISO || booking.earliestSlotISO || null;

      if (!timeISO) {
        // No actual time stored; reset and let GPT re-ask
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        return { intercept: false };
      }

      // Store this as the confirmed time; booking of the event
      // will be handled by the "A" block once we have phone + email.
      booking.timeISO = timeISO;
      booking.timeSpoken =
        booking.timeSpoken ||
        booking.earliestSlotSpoken ||
        formatSpokenDateTime(timeISO, BUSINESS_TIMEZONE);
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;

      return { intercept: false };
    } else if (noInAnyLang(t)) {
      // User rejected the suggested time
      booking.awaitingTimeConfirm = false;
      booking.timeISO = null;
      booking.timeSpoken = null;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;

      const replyText =
        'No worries at all — what day and time would work better for you (Monday to Friday, 9 to 5 UK time)?';

      return {
        intercept: true,
        replyText,
      };
    }
  }

  // No special system action needed
  return { intercept: false };
}
