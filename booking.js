// booking.js
// Booking state machine: extract fields, propose earliest slot, confirm & create events.

import {
  extractName,
  parseUkPhone,
  isLikelyUkNumberPair,
  extractEmail,
  parseNaturalDate,
  yesInAnyLang,
  noInAnyLang,
  formatSpokenDateTime,
} from './parsing.js';
import {
  findEarliestAvailableSlot,
  createBookingEvent,
  findExistingBooking,
  cancelEventById,
} from './calendar.js';
import { sendConfirmationAndReminders } from './sms.js';

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/London';

function ensureBooking(callState) {
  if (!callState.booking) {
    callState.booking = {
      intent: 'none',
      name: null,
      phone: null,
      email: null,

      // Requested time
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
    /earliest|soonest|asap|as soon as possible|first available|next available/.test(
      t
    )
  );
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

  // Try extract name
  if (!booking.name) {
    const n = extractName(raw);
    if (n) booking.name = n;
  }

  // Try extract phone
  if (!booking.phone) {
    const pair = parseUkPhone(raw);
    if (pair && isLikelyUkNumberPair(pair)) {
      booking.phone = pair.e164;
    }
  }

  // Try extract email
  if (!booking.email) {
    const e = extractEmail(raw);
    if (e) booking.email = e;
  }

  // Try parse natural date/time
  if (!booking.timeISO) {
    const nat = parseNaturalDate(raw, timezone);
    if (nat) {
      booking.timeISO = nat.iso;
      booking.timeSpoken = nat.spoken;
      booking.awaitingTimeConfirm = true;
    }
  }

  // If user wants earliest and we don't yet have a candidate, look it up
  if (
    booking.intent === 'wants_booking' &&
    booking.wantsEarliest &&
    !booking.earliestSlotISO
  ) {
    const earliest = await findEarliestAvailableSlot({
      timezone,
      durationMinutes: 30,
      daysAhead: 7,
    });
    if (earliest && earliest.iso) {
      booking.earliestSlotISO = earliest.iso;
      booking.earliestSlotSpoken =
        earliest.spoken ||
        formatSpokenDateTime(earliest.iso, timezone);
      booking.awaitingTimeConfirm = true;
      booking.lastPromptWasTimeSuggestion = true;
    }
  }

  callState.booking = booking;
}

/**
 * Step 2: system actions that must happen BEFORE GPT speaks:
 *  - User confirms or rejects a suggested time (natural or earliest)
 *  - If yes, we book in calendar + send SMS
 */
export async function handleSystemActionsFirst({ userText, callState }) {
  const booking = ensureBooking(callState);
  const t = (userText || '').trim();

  // If we are waiting on a yes/no for a specific time
  if (booking.awaitingTimeConfirm && (yesInAnyLang(t) || noInAnyLang(t))) {
    if (yesInAnyLang(t)) {
      // Decide which time to book: explicit requested time > earliest suggestion
      const timeISO =
        booking.timeISO || booking.earliestSlotISO || null;

      if (!timeISO) {
        // No actual time stored; reset and let GPT re-ask
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        return {
          intercept: false,
        };
      }

      // We have a time, plus (hopefully) contact details.
      // Fallback phone: callerNumber on callState
      const phone = booking.phone || callState.callerNumber || null;
      const email = booking.email || null;
      const name = booking.name || null;

      if (!phone) {
        // We need at least a phone to send SMS; let GPT handle asking for it.
        booking.awaitingTimeConfirm = false;
        booking.timeISO = timeISO;
        booking.timeSpoken =
          booking.timeSpoken ||
          booking.earliestSlotSpoken ||
          formatSpokenDateTime(timeISO, BUSINESS_TIMEZONE);
        return {
          intercept: false,
        };
      }

      // Perform booking: cancel previous, create new, send SMS + reminders
      try {
        const existing = await findExistingBooking({ phone, email });
        if (existing && existing.id) {
          try {
            await cancelEventById(existing.id);
          } catch (e) {
            console.warn('Cancel previous booking failed:', e?.message || e);
          }
        }

        const event = await createBookingEvent({
          startISO: timeISO,
          durationMinutes: 30,
          name,
          email,
          phone,
        });

        const startISO = event.start?.dateTime || timeISO;

        await sendConfirmationAndReminders({
          to: phone,
          startISO,
          name,
        });

        booking.bookingConfirmed = true;
        booking.lastEventId = event.id;
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;

        const spoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);

        const replyText =
          name
            ? `Brilliant ${name} — I’ve got you booked in for ${spoken}. You’ll get a text with the Zoom details in a moment. Anything else I can help with today?`
            : `Brilliant — I’ve got that booked in for ${spoken}. You’ll get a text with the Zoom details in a moment. Anything else I can help with today?`;

        return {
          intercept: true,
          replyText,
        };
      } catch (err) {
        console.error('Booking error:', err);
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        return {
          intercept: true,
          replyText:
            "Hmm, something didn’t quite go through on my side. I’ll note your details and follow up, but is there anything else I can help with for now?",
        };
      }
    } else if (noInAnyLang(t)) {
      // User rejected the suggested time
      booking.awaitingTimeConfirm = false;
      booking.timeISO = null;
      booking.timeSpoken = null;
      booking.earliestSlotISO = null;
      booking.earliestSlotSpoken = null;
      booking.lastPromptWasTimeSuggestion = false;

      const replyText =
        'No worries at all — what day and time would work better for you?';

      return {
        intercept: true,
        replyText,
      };
    }
  }

  // No special system action needed
  return { intercept: false };
}
