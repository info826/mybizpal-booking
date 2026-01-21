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
  cancelEventById, // kept imported for move/cancel logic
  formatSpokenDateTime,
  hasConflict,
} from './calendar.js';
import {
  sendConfirmationAndReminders,
  sendCancellationNotice,
  sendRescheduleNotice,
} from './sms.js';
import OpenAI from 'openai';

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/London';
const DEBUG_LOG = process.env.DEBUG_LOG === '1';

// Model selection + latency guard for summaries
const MODEL_SUMMARY = process.env.MYBIZPAL_MODEL_SUMMARY || 'gpt-5.1';
const SUMMARY_ENABLED = process.env.MYBIZPAL_SUMMARY_ENABLED !== '0';
const SUMMARY_TIMEOUT_MS = Number(process.env.MYBIZPAL_SUMMARY_TIMEOUT_MS || 2500);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --------- SMALL HELPERS ----------

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

      // Existing-booking awareness
      existingBookingSpoken: null,
      informedAboutExistingBooking: false,
      existingEventId: null,
      existingEventStartISO: null,
      pendingExistingAction: null, // 'decide_move_keep_extra'

      // Notes for calendar / Zoom prep
      summaryNotes: null,
    };
  }
  return callState.booking;
}

// ✅ FIX: booking intent must mean "schedule/arrange a meeting", NOT "missed calls"
function detectBookingIntent(text) {
  const t = (text || '').toLowerCase().trim();
  if (!t) return false;

  // Negative guard: operational pain ≠ booking intent
  if (
    /\b(missed calls?|no calls?( been)? answered|calls? not answered|missed call|lost calls?)\b/.test(
      t
    )
  ) {
    return false;
  }

  // Strong scheduling phrases (highest precision)
  if (
    /\b(book a call|schedule a call|set up a call|setup a call|arrange a call|book a meeting|schedule a meeting|set up a meeting|setup a meeting|arrange a meeting|zoom call)\b/.test(
      t
    )
  ) {
    return true;
  }

  // Explicit noun-only booking intent
  if (/\b(appointment|consultation|demo)\b/.test(t)) return true;

  // Generic scheduling verbs
  if (/\b(book|schedule|set up|setup|arrange)\b/.test(t)) {
    // If they also mention the thing being booked, it's definitely booking intent
    if (/\b(call|zoom|meeting|appointment|consultation|demo)\b/.test(t)) return true;

    // Otherwise: allow, but only if not clearly about booking something else (e.g. "book a taxi")
    if (/\b(taxi|flight|hotel|table|restaurant|uber)\b/.test(t)) return false;

    return true;
  }

  return false;
}

function detectEarliestRequest(text) {
  const t = (text || '').toLowerCase();
  return (
    /earliest available|soonest|asap|as soon as possible|first available|next available/.test(
      t
    ) || /\bearliest\b/.test(t)
  );
}

function isSameMinute(isoA, isoB) {
  if (!isoA || !isoB) return false;
  const a = new Date(isoA);
  const b = new Date(isoB);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate() &&
    a.getHours() === b.getHours() &&
    a.getMinutes() === b.getMinutes()
  );
}

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
    'just',
  ]);
  if (boring.has(t)) return true;

  return false;
}

// Paragraph-style fallback summary (no bullets) if AI is unavailable
function buildFallbackSummary(callState) {
  const history = (callState && callState.history) || [];
  const userUtterances = history
    .filter((m) => m.role === 'user')
    .map((m) => (m.content || '').trim())
    .filter(Boolean);

  if (userUtterances.length === 0) return null;

  const meaningful = userUtterances.filter((u) => !isBoringSentence(u));
  const mainRequest =
    meaningful.find((u) => u.length > 15) || meaningful[0] || userUtterances[0];

  const extraPoints = meaningful.filter((u) => u !== mainRequest);

  const behaviour = callState?.behaviour || {};
  const interest = behaviour.interestLevel || 'unknown';
  const pain = behaviour.painPointsMentioned
    ? 'some pain points around calls or operations'
    : null;

  const sentences = [];

  if (mainRequest) {
    sentences.push(
      `The caller contacted MyBizPal primarily to discuss the following: "${mainRequest}".`
    );
  }

  if (extraPoints.length) {
    const trimmed = extraPoints.slice(0, 3).join(' | ');
    sentences.push(`During the conversation they also mentioned: ${trimmed}.`);
  }

  if (pain) {
    sentences.push(`They appear to be experiencing ${pain}.`);
  }

  if (interest !== 'unknown') {
    sentences.push(
      `Overall they came across as ${interest} in exploring MyBizPal further.`
    );
  } else {
    sentences.push(
      `Their level of interest is not fully clear from the partial transcript but there is at least some curiosity about what MyBizPal can do.`
    );
  }

  sentences.push(
    `On the Zoom call, it would be useful to clarify their current call handling process, quantify any missed-call or lead-loss issues, and show concrete ways MyBizPal can reduce friction and increase booked appointments.`
  );

  const paragraph = sentences.join(' ');

  return `Smart summary (for Zoom prep):\n\n${paragraph}`;
}

async function callOpenAIWithTimeout({ model, messages, maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const completion = await openai.chat.completions.create(
      {
        model,
        reasoning_effort: 'none',
        temperature,
        max_completion_tokens: maxTokens,
        messages,
      },
      { signal: controller.signal }
    );
    return (completion.choices?.[0]?.message?.content || '').trim();
  } finally {
    clearTimeout(timer);
  }
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
    if (!SUMMARY_ENABLED) return buildFallbackSummary(callState);

    if (!openai.apiKey) {
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

Write ONE short paragraph (3–6 sentences, no bullets, no headings) that summarises:
- What the caller was asking about and what they care about.
- Any explicit or implied pain points (e.g. missed calls, lost leads, time wasted).
- How the caller seemed emotionally and commercially (warm / neutral / cold; curious, sceptical, etc.).
- How interested they seem in MyBizPal and how strong the opportunity looks.
- A simple "call score" style judgement (e.g. overall this feels like a warm opportunity and worth prioritising).
- What the consultant should focus on in the upcoming Zoom to maximise conversion.
- Any specific questions or requests the caller made that should be addressed on the call.

Tone: concise, professional and practical, written in third person
(“The caller…”, “They…”, “Gabriel’s impression is that…”).
Do NOT use bullet points. Do NOT include labels like “Pain points:” or “Focus:”.
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

    const summary = await callOpenAIWithTimeout({
      model: MODEL_SUMMARY,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      maxTokens: 220,
      temperature: 0.4,
      timeoutMs: SUMMARY_TIMEOUT_MS,
    });

    if (!summary) return buildFallbackSummary(callState);

    // Hard safety: ensure it's not accidentally bullet-style
    const cleaned = summary
      .replace(/\r/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    return `Smart summary (for Zoom prep):\n\n${cleaned}`;
  } catch (err) {
    if (DEBUG_LOG) console.error('Error building smart summary:', err);
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

  // If they clearly want to book again but we have an old confirmed booking,
  // treat this as the start of a *new* booking flow.
  if (detectBookingIntent(raw) && booking.bookingConfirmed) {
    booking.bookingConfirmed = false;
    booking.intent = 'wants_booking';

    booking.timeISO = null;
    booking.timeSpoken = null;
    booking.wantsEarliest = false;
    booking.earliestSlotISO = null;
    booking.earliestSlotSpoken = null;

    booking.awaitingTimeConfirm = false;
    booking.lastPromptWasTimeSuggestion = false;
    booking.needEmailBeforeBooking = false;

    booking.existingBookingSpoken = null;
    booking.informedAboutExistingBooking = false;
    booking.existingEventId = null;
    booking.existingEventStartISO = null;
    booking.pendingExistingAction = null;

    booking.summaryNotes = null;
  }

  // Detect explicit booking intent
  if (detectBookingIntent(raw)) {
    booking.intent = 'wants_booking';
  }

  // Earliest request? (also implies booking intent)
  if (detectEarliestRequest(raw)) {
    booking.wantsEarliest = true;
    if (!booking.intent || booking.intent === 'none') {
      booking.intent = 'wants_booking';
    }
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

  // Try parse natural date/time (user saying things like "tomorrow at 12", "Monday at midday")
  const nat = parseNaturalDate(raw, timezone);
  if (nat) {
    if (!booking.intent || booking.intent === 'none') {
      booking.intent = 'wants_booking';
    }

    // Does this utterance contain an explicit date/day word?
    const hasExplicitDate =
      /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|\d{1,2}(st|nd|rd|th))\b/i.test(
        raw
      );

    if (booking.timeISO && !hasExplicitDate) {
      // We already have a date; user is probably just changing the time ("12", "half 12", etc.).
      const prev = new Date(booking.timeISO);
      const newDT = new Date(nat.iso);
      prev.setHours(newDT.getHours(), newDT.getMinutes(), 0, 0);
      booking.timeISO = prev.toISOString();
      booking.timeSpoken = formatSpokenDateTime(booking.timeISO, timezone);
    } else {
      booking.timeISO = nat.iso;
      booking.timeSpoken = nat.spoken;
    }

    // User-provided times are treated as already confirmed (no yes/no needed)
    booking.awaitingTimeConfirm = false;
    booking.lastPromptWasTimeSuggestion = false;
  }

  // --- EXTRA FALLBACK: basic weekday + time detection if parseNaturalDate missed it ---
  if (!nat) {
    // 1) If we don't yet have any date, but they mention a weekday,
    //    set the date to the *next* occurrence of that weekday at 9:00.
    if (!booking.timeISO) {
      const weekdayMatch = raw.match(
        /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
      );
      if (weekdayMatch) {
        const weekday = weekdayMatch[1].toLowerCase();
        const dayMap = {
          sunday: 0,
          monday: 1,
          tuesday: 2,
          wednesday: 3,
          thursday: 4,
          friday: 5,
          saturday: 6,
        };
        const targetDow = dayMap[weekday];
        if (targetDow !== undefined) {
          const now = new Date();
          const todayDow = now.getDay();
          let delta = (targetDow - todayDow + 7) % 7;
          if (delta === 0) delta = 7; // always move to *next* occurrence
          const dt = new Date(now);
          dt.setDate(now.getDate() + delta);
          dt.setHours(9, 0, 0, 0); // default 9:00
          booking.timeISO = dt.toISOString();
          booking.timeSpoken = formatSpokenDateTime(booking.timeISO, timezone);
          booking.awaitingTimeConfirm = false;
          booking.lastPromptWasTimeSuggestion = false;

          if (!booking.intent || booking.intent === 'none') {
            booking.intent = 'wants_booking';
          }
        }
      }
    }

    // 2) If we already have a date, but this utterance is likely a time-only answer
    if (booking.timeISO) {
      let hour = null;
      let minute = 0;

      // Digits pattern: "9", "9:30", "14:00", maybe with am/pm
      let m = raw.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?\b/i);
      if (m) {
        hour = parseInt(m[1], 10);
        minute = m[2] ? parseInt(m[2], 10) : 0;
        const ampm = m[3] ? m[3].toLowerCase() : null;
        if (ampm === 'pm' && hour < 12) hour += 12;
        if (ampm === 'am' && hour === 12) hour = 0;
      } else {
        // Words pattern: "nine o'clock"
        const wordMap = {
          one: 1,
          two: 2,
          three: 3,
          four: 4,
          five: 5,
          six: 6,
          seven: 7,
          eight: 8,
          nine: 9,
          ten: 10,
          eleven: 11,
          twelve: 12,
        };
        const wordMatch = raw.match(
          /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b.*(o['’]?clock)?/i
        );
        if (wordMatch) {
          const word = wordMatch[1].toLowerCase();
          hour = wordMap[word];
          minute = 0;
        }
      }

      if (hour !== null) {
        if (hour < 9) hour = 9;
        if (hour > 17) hour = 17;

        const prev = new Date(booking.timeISO);
        prev.setHours(hour, minute, 0, 0);
        booking.timeISO = prev.toISOString();
        booking.timeSpoken = formatSpokenDateTime(booking.timeISO, timezone);
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;

        if (!booking.intent || booking.intent === 'none') {
          booking.intent = 'wants_booking';
        }
      }
    }
  }

  // If user wants earliest and we don't yet have a candidate, look it up.
  if (booking.wantsEarliest && !booking.earliestSlotISO) {
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
 *  - If we already have a confirmed time + contact, create or move events.
 *  - User confirms or rejects a suggested time (earliest suggestion).
 */
export async function handleSystemActionsFirst({ userText, callState }) {
  const booking = ensureBooking(callState);
  const t = (userText || '').trim().toLowerCase();

  // Respect global opt-out / DNC flags if logic.js applied them
  if (callState?.flags?.doNotContact) {
    return { intercept: true, replyText: 'No problem. I won’t contact you again.' };
  }

  const phone = booking.phone || callState.callerNumber || null;
  const email = booking.email || null;
  const name = booking.name || null;

  // Allow booking if we have at least one contact method
  const hasContact = !!phone || !!email;

  // Time that we would book if confirmed
  const timeCandidate = booking.timeISO || booking.earliestSlotISO || null;
  const isUserSpecifiedTime = !!booking.timeISO && booking.timeISO === timeCandidate;

  if (DEBUG_LOG) {
    console.log('BOOKING SNAPSHOT IN handleSystemActionsFirst:', {
      name,
      email,
      phone,
      hasContact,
      timeISO: booking.timeISO,
      earliestSlotISO: booking.earliestSlotISO,
      timeCandidate,
      isUserSpecifiedTime,
      intent: booking.intent,
      bookingConfirmed: booking.bookingConfirmed,
      awaitingTimeConfirm: booking.awaitingTimeConfirm,
    });
  }

  // ---------- EXISTING BOOKING DECISION FLOW (MOVE / CANCEL / KEEP) ----------
  if (booking.pendingExistingAction === 'decide_move_keep_extra') {
    // CANCEL / MOVE TO NEW TIME
    if (/cancel|change|move|instead|earlier|rather/i.test(t) || yesInAnyLang(t)) {
      if (!timeCandidate) {
        try {
          if (booking.existingEventId) {
            await cancelEventById(booking.existingEventId);
          }

          const phoneForNotice = phone;
          if (phoneForNotice && booking.existingEventStartISO) {
            try {
              await sendCancellationNotice({
                to: phoneForNotice,
                startISO: booking.existingEventStartISO,
                name,
              });
            } catch (err) {
              if (DEBUG_LOG) {
                console.warn('Error sending cancellation notice:', err?.message || err);
              }
            }
          }
        } catch (err) {
          if (DEBUG_LOG) console.error('Error cancelling existing event (no new time):', err);
        }

        const existingSpoken =
          booking.existingEventStartISO
            ? formatSpokenDateTime(booking.existingEventStartISO, BUSINESS_TIMEZONE)
            : 'your previous session';

        booking.pendingExistingAction = null;
        booking.existingEventId = null;
        booking.existingEventStartISO = null;
        booking.informedAboutExistingBooking = true;

        return {
          intercept: true,
          replyText: `No worries, I’ve cancelled your previous booking for ${existingSpoken}. What day and time would you like your new session to be?`,
        };
      }

      // We have a timeCandidate → move booking to this new time
      const existingSpoken =
        booking.existingEventStartISO
          ? formatSpokenDateTime(booking.existingEventStartISO, BUSINESS_TIMEZONE)
          : 'your previous session';
      const newSpoken = formatSpokenDateTime(timeCandidate, BUSINESS_TIMEZONE);

      try {
        const oldStartISO = booking.existingEventStartISO || null;

        if (booking.existingEventId) {
          await cancelEventById(booking.existingEventId);
        }

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

        if (phone) {
          await sendConfirmationAndReminders({ to: phone, startISO, name });
        }

        if (phone && oldStartISO) {
          try {
            await sendRescheduleNotice({
              to: phone,
              oldStartISO,
              newStartISO: startISO,
              name,
            });
          } catch (err) {
            if (DEBUG_LOG) {
              console.warn('Error sending reschedule notice:', err?.message || err);
            }
          }
        }

        booking.bookingConfirmed = true;
        booking.lastEventId = event.id;
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        booking.needEmailBeforeBooking = false;
        booking.timeISO = startISO;
        booking.timeSpoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);
        booking.pendingExistingAction = null;
        booking.existingEventId = null;
        booking.existingEventStartISO = null;
        booking.informedAboutExistingBooking = true;

        const replyText = name
          ? `All sorted, ${name} — I’ve cancelled your previous booking for ${existingSpoken} and moved it to ${newSpoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`
          : `All sorted — I’ve cancelled your previous booking for ${existingSpoken} and moved it to ${newSpoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`;

        return { intercept: true, replyText };
      } catch (err) {
        if (DEBUG_LOG) console.error('Error moving existing booking to new time:', err);
        booking.pendingExistingAction = null;
        return {
          intercept: true,
          replyText:
            'I tried to move that booking but something didn’t quite go through on my side. I’ll note your details and follow up, but is there anything else I can help with for now?',
        };
      }
    }

    // KEEP EXISTING TIME
    if (/keep|leave it|as it is|don'?t change/i.test(t) || noInAnyLang(t)) {
      const existingSpoken =
        booking.existingEventStartISO
          ? formatSpokenDateTime(booking.existingEventStartISO, BUSINESS_TIMEZONE)
          : 'your booked session';

      booking.pendingExistingAction = null;
      booking.timeISO = booking.existingEventStartISO;
      booking.timeSpoken = existingSpoken;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;

      const replyText = name
        ? `No problem, ${name} — we’ll keep your booking at ${existingSpoken} just as it is. If you’d like to add another session at a different time, just let me know.`
        : `No problem — we’ll keep your booking at ${existingSpoken} just as it is. If you’d like to add another session at a different time, just let me know.`;

      return { intercept: true, replyText };
    }

    return { intercept: false };
  }

  // ---------- MAIN BOOKING FLOW ----------
  if (timeCandidate && hasContact && !booking.bookingConfirmed && !booking.awaitingTimeConfirm) {
    if (DEBUG_LOG) {
      console.log('MAIN BOOKING FLOW TRIGGERED with:', {
        name,
        email,
        phone,
        timeCandidate,
        isUserSpecifiedTime,
      });
    }

    // If we have a phone but email is missing → ask once, then wait for it
    if (phone && !email) {
      if (!booking.needEmailBeforeBooking) {
        booking.needEmailBeforeBooking = true;
        return {
          intercept: true,
          replyText: 'Brilliant — before I lock that in, what’s your best email address?',
        };
      }
      return { intercept: false };
    }

    // Existing booking check
    try {
      const existing = await findExistingBooking({ phone, email });
      if (existing && existing.id) {
        const existingStartISO = existing.start?.dateTime || existing.start?.date || null;
        const existingSpoken = existingStartISO
          ? formatSpokenDateTime(existingStartISO, BUSINESS_TIMEZONE)
          : 'a previously booked session';

        booking.existingBookingSpoken = existingSpoken;
        booking.existingEventId = existing.id;
        booking.existingEventStartISO = existingStartISO;

        if (existingStartISO && timeCandidate && isSameMinute(existingStartISO, timeCandidate)) {
          booking.bookingConfirmed = true;
          booking.lastEventId = existing.id;
          booking.timeISO = existingStartISO;
          booking.timeSpoken = existingSpoken;
          booking.informedAboutExistingBooking = true;

          const replyText = name
            ? `You’re already booked in for ${existingSpoken}, ${name}, so you’re all set. Anything else I can help with today?`
            : `You’re already booked in for ${existingSpoken}, so you’re all set. Anything else I can help with today?`;

          return { intercept: true, replyText };
        }

        const newSpoken = formatSpokenDateTime(timeCandidate, BUSINESS_TIMEZONE);

        booking.pendingExistingAction = 'decide_move_keep_extra';
        booking.informedAboutExistingBooking = true;

        return {
          intercept: true,
          replyText:
            `I can see you already have a MyBizPal session booked for ${existingSpoken}. ` +
            `Do you want me to move that booking to ${newSpoken}, keep it where it is, or are you trying to book an extra session as well?`,
        };
      }
    } catch (e) {
      if (DEBUG_LOG) console.warn('Existing booking check failed:', e?.message || e);
    }

    // Conflict checks ONLY for system-suggested times.
    if (!isUserSpecifiedTime) {
      const conflict = await hasConflict({ startISO: timeCandidate, durationMin: 30 });

      if (conflict) {
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

          return {
            intercept: true,
            replyText: `It looks like that exact time has just been taken. The next available slot I can see is ${booking.earliestSlotSpoken}. Would you like me to book you in for then?`,
          };
        }

        booking.timeISO = null;
        booking.timeSpoken = null;
        booking.earliestSlotISO = null;
        booking.earliestSlotSpoken = null;
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        booking.needEmailBeforeBooking = false;

        return {
          intercept: true,
          replyText:
            'It looks like we’re fully booked around that time. What other day and time would work for you (Monday to Friday, 9 to 5 UK time)?',
        };
      }
    }

    // Create booking
    try {
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

      if (phone) {
        await sendConfirmationAndReminders({ to: phone, startISO, name });
      }

      booking.bookingConfirmed = true;
      booking.lastEventId = event.id;
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;
      booking.timeISO = startISO;
      booking.timeSpoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);

      const spoken = booking.timeSpoken;
      const replyText = name
        ? `Brilliant ${name} — I’ve got you booked in for ${spoken}. You’ll get the Zoom details shortly. Anything else I can help with today?`
        : `Brilliant — I’ve got that booked in for ${spoken}. You’ll get the Zoom details shortly. Anything else I can help with today?`;

      if (DEBUG_LOG) console.log('BOOKING SUCCESSFULLY CREATED with event id:', event.id);

      return { intercept: true, replyText };
    } catch (err) {
      if (DEBUG_LOG) console.error('Booking error after email capture:', err);
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

  // B) If we are waiting on a yes/no for one of OUR suggested times
  if (
    booking.awaitingTimeConfirm &&
    booking.lastPromptWasTimeSuggestion &&
    (yesInAnyLang(t) || noInAnyLang(t))
  ) {
    if (yesInAnyLang(t)) {
      const timeISO = booking.timeISO || booking.earliestSlotISO || null;

      if (!timeISO) {
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        return { intercept: false };
      }

      booking.timeISO = timeISO;
      booking.timeSpoken =
        booking.timeSpoken ||
        booking.earliestSlotSpoken ||
        formatSpokenDateTime(timeISO, BUSINESS_TIMEZONE);
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;

      return { intercept: false };
    }

    if (noInAnyLang(t)) {
      booking.awaitingTimeConfirm = false;
      booking.timeISO = null;
      booking.timeSpoken = null;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.lastPromptWasTimeSuggestion = false;
      booking.needEmailBeforeBooking = false;

      return {
        intercept: true,
        replyText:
          'No worries at all — what day and time would work better for you (Monday to Friday, 9 to 5 UK time)?',
      };
    }
  }

  return { intercept: false };
}
