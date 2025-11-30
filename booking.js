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
  cancelEventById, // kept imported in case you want auto-reschedule later
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
      // No API key available – fall back to simple paragraph summary
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

    let summary = completion.choices?.[0]?.message?.content?.trim() || '';

    if (!summary) {
      return buildFallbackSummary(callState);
    }

    // Hard safety: ensure it's not accidentally bullet-style
    if (summary.includes('\n- ') || summary.startsWith('- ')) {
      summary = summary
        .replace(/\r/g, ' ')
        .replace(/\n/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/^- /, '')
        .trim();
    }

    return `Smart summary (for Zoom prep):\n\n${summary}`;
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
    // Giving a specific day/time is effectively agreeing to book
    if (!booking.intent || booking.intent === 'none') {
      booking.intent = 'wants_booking';
    }

    // Does this utterance contain an explicit date/day word?
    const hasExplicitDate = /\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next|this|\d{1,2}(st|nd|rd|th))\b/i.test(
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
      // New date + time request from user
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

          // Implied booking intent
          if (!booking.intent || booking.intent === 'none') {
            booking.intent = 'wants_booking';
          }
        }
      }
    }

    // 2) If we already have a date, but this utterance is likely a time-only answer
    //    like "nine o'clock", "9", "9am", "9:30", update the time on that date.
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
        // Words pattern: "nine o'clock", "ten o clock"
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
        // Clamp roughly into business hours window (9–17)
        if (hour < 9) hour = 9;
        if (hour > 17) hour = 17;

        const prev = new Date(booking.timeISO);
        prev.setHours(hour, minute, 0, 0);
        booking.timeISO = prev.toISOString();
        booking.timeSpoken = formatSpokenDateTime(booking.timeISO, timezone);
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;

        // Implied booking intent
        if (!booking.intent || booking.intent === 'none') {
          booking.intent = 'wants_booking';
        }
      }
    }
  }

  // If user wants earliest and we don't yet have a candidate, look it up.
  // If they mentioned a day ("tomorrow", "next Tuesday"), use that as a starting point.
  if (
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
 *  - If we already have a confirmed time + phone (+ email), create or move events.
 *  - User confirms or rejects a suggested time (earliest suggestion).
 */
export async function handleSystemActionsFirst({ userText, callState }) {
  const booking = ensureBooking(callState);
  const t = (userText || '').trim().toLowerCase();

  const phone = booking.phone || callState.callerNumber || null;
  const email = booking.email || null;
  const name = booking.name || null;

  // Time that we would book if confirmed
  const timeCandidate = booking.timeISO || booking.earliestSlotISO || null;
  const isUserSpecifiedTime =
    !!booking.timeISO && booking.timeISO === timeCandidate;

  // ---------- EXISTING BOOKING DECISION FLOW (MOVE / CANCEL / KEEP) ----------

  // If we previously asked what to do with an existing booking
  if (booking.pendingExistingAction === 'decide_move_keep_extra') {
    // CANCEL / MOVE TO NEW TIME
    if (/cancel|change|move|instead|earlier|rather/i.test(t) || yesInAnyLang(t)) {
      if (!timeCandidate) {
        // No new time to move to – just cancel and ask for a new time
        try {
          if (booking.existingEventId) {
            await cancelEventById(booking.existingEventId);
          }

          // 🔔 Send cancellation WhatsApp/SMS if we know the time & phone
          const phoneForNotice = phone;
          if (phoneForNotice && booking.existingEventStartISO) {
            try {
              await sendCancellationNotice({
                to: phoneForNotice,
                startISO: booking.existingEventStartISO,
                name,
              });
            } catch (err) {
              console.warn(
                'Error sending cancellation notice:',
                err?.message || err
              );
            }
          }
        } catch (err) {
          console.error('Error cancelling existing event (no new time):', err);
        }

        const existingSpoken =
          booking.existingEventStartISO
            ? formatSpokenDateTime(
                booking.existingEventStartISO,
                BUSINESS_TIMEZONE
              )
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
          ? formatSpokenDateTime(
              booking.existingEventStartISO,
              BUSINESS_TIMEZONE
            )
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

        // Standard confirmation (card + reminders)
        await sendConfirmationAndReminders({
          to: phone,
          startISO,
          name,
        });

        // 🔔 Extra reschedule notice (short plain text)
        if (phone && oldStartISO) {
          try {
            await sendRescheduleNotice({
              to: phone,
              oldStartISO,
              newStartISO: startISO,
              name,
            });
          } catch (err) {
            console.warn(
              'Error sending reschedule notice:',
              err?.message || err
            );
          }
        }

        booking.bookingConfirmed = true;
        booking.lastEventId = event.id;
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        booking.needEmailBeforeBooking = false;
        booking.timeISO = startISO;
        booking.timeSpoken = formatSpokenDateTime(
          startISO,
          BUSINESS_TIMEZONE
        );
        booking.pendingExistingAction = null;
        booking.existingEventId = null;
        booking.existingEventStartISO = null;
        booking.informedAboutExistingBooking = true;

        const replyText =
          name
            ? `All sorted, ${name} — I’ve cancelled your previous booking for ${existingSpoken} and moved it to ${newSpoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`
            : `All sorted — I’ve cancelled your previous booking for ${existingSpoken} and moved it to ${newSpoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`;

        return {
          intercept: true,
          replyText,
        };
      } catch (err) {
        console.error('Error moving existing booking to new time:', err);
        booking.pendingExistingAction = null;
        return {
          intercept: true,
          replyText:
            'I tried to move that booking but something didn’t quite go through on my side. I’ll note your details and follow up, but is there anything else I can help with for now?',
        };
      }
    }

    // KEEP EXISTING TIME (no extra)
    if (/keep|leave it|as it is|as it is|as it is|don'?t change/i.test(t) || noInAnyLang(t)) {
      const existingSpoken =
        booking.existingEventStartISO
          ? formatSpokenDateTime(
              booking.existingEventStartISO,
              BUSINESS_TIMEZONE
            )
          : 'your booked session';

      booking.pendingExistingAction = null;
      booking.timeISO = booking.existingEventStartISO;
      booking.timeSpoken = existingSpoken;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.awaitingTimeConfirm = false;
      booking.lastPromptWasTimeSuggestion = false;

      const replyText =
        name
          ? `No problem, ${name} — we’ll keep your booking at ${existingSpoken} just as it is. If you’d like to add another session at a different time, just let me know.`
          : `No problem — we’ll keep your booking at ${existingSpoken} just as it is. If you’d like to add another session at a different time, just let me know.`;

      return {
        intercept: true,
        replyText,
      };
    }

    // If they say something else, let GPT handle it but keep the state
    return { intercept: false };
  }

  // ---------- MAIN BOOKING FLOW ----------

  // A) If we already have a CONFIRMED time candidate + phone, and no booking yet
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

    // 🔍 Check if this caller already has a booking
    try {
      const existing = await findExistingBooking({ phone, email });
      if (existing && existing.id) {
        const existingStartISO =
          existing.start?.dateTime || existing.start?.date || null;
        const existingSpoken = existingStartISO
          ? formatSpokenDateTime(existingStartISO, BUSINESS_TIMEZONE)
          : 'a previously booked session';

        booking.existingBookingSpoken = existingSpoken;
        booking.existingEventId = existing.id;
        booking.existingEventStartISO = existingStartISO;

        // If the requested time is exactly the same as the existing one,
        // just confirm it instead of creating a new event.
        if (existingStartISO && timeCandidate && isSameMinute(existingStartISO, timeCandidate)) {
          booking.bookingConfirmed = true;
          booking.lastEventId = existing.id;
          booking.timeISO = existingStartISO;
          booking.timeSpoken = existingSpoken;
          booking.informedAboutExistingBooking = true;

          const replyText =
            name
              ? `You’re already booked in for ${existingSpoken}, ${name}, so you’re all set. Anything else I can help with today?`
              : `You’re already booked in for ${existingSpoken}, so you’re all set. Anything else I can help with today?`;

          return { intercept: true, replyText };
        }

        // Otherwise, ask clearly what they want to do with the existing booking.
        const newSpoken = formatSpokenDateTime(
          timeCandidate,
          BUSINESS_TIMEZONE
        );

        booking.pendingExistingAction = 'decide_move_keep_extra';
        booking.informedAboutExistingBooking = true;

        const replyText =
          `I can see you already have a MyBizPal session booked for ${existingSpoken}. ` +
          `Do you want me to move that booking to ${newSpoken}, keep it where it is, or are you trying to book an extra session as well?`;

        return {
          intercept: true,
          replyText,
        };
      }
    } catch (e) {
      console.warn('Existing booking check failed:', e?.message || e);
      // If this fails, we just carry on and try to create a new event.
    }

    // 🔍 Check for conflicts ONLY for system-suggested times.
    // If the caller explicitly asked for a time (booking.timeISO),
    // we trust that and avoid auto-moving them to "next available".
    if (!isUserSpecifiedTime) {
      const conflict = await hasConflict({
        startISO: timeCandidate,
        durationMin: 30,
      });

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
            nextSlot.spoken ||
            formatSpokenDateTime(nextSlot.iso, BUSINESS_TIMEZONE);
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
    }

    // We have time + phone + email and either no conflict or we trust user time → create booking now
    try {
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
      booking.timeISO = startISO;
      booking.timeSpoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);

      const spoken = booking.timeSpoken;
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

  // B) If we are waiting on a yes/no for one of OUR suggested times (earliest slot)
  if (
    booking.awaitingTimeConfirm &&
    booking.lastPromptWasTimeSuggestion &&
    (yesInAnyLang(t) || noInAnyLang(t))
  ) {
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
