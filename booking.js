// booking.js
// Booking state machine: extract fields, propose earliest slot, confirm & create events.

import {
  extractName,
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
} from './calendar.js';
import { sendConfirmationAndReminders } from './sms.js';

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// ---- NAME SAFETY HELPERS ----

function isFillerWord(str = '') {
  const t = str.trim().toLowerCase();
  if (!t) return true;
  // Single “yes/no/ok” style words we never want as a name
  const badSingles = [
    'yes',
    'yeah',
    'ye',
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
  ];
  if (badSingles.includes(t)) return true;

  // Very short 1–2 letter “names” are almost always noise here
  if (t.length <= 2) return true;

  return false;
}

// If the caller says “put it under John Smith” etc, we allow overriding name.
function isExplicitNameOverridePhrase(text = '') {
  const t = text.toLowerCase();
  return /put it under|book it under|make it under|put the booking under|put the appointment under|in the name of/.test(
    t
  );
}

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
      needEmailBeforeBooking: false,
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

  // Try extract name, but avoid filler like “yeah”, “ok”, etc.
  const extractedName = extractName(raw);
  if (extractedName && !isFillerWord(extractedName)) {
    if (!booking.name) {
      // First good name we hear → treat as caller’s name
      booking.name = extractedName;
    } else if (isExplicitNameOverridePhrase(raw)) {
      // Caller has explicitly asked to put the booking under a (new) name
      booking.name = extractedName;
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
 *  - If we already have time + phone + email and need to book, create the event.
 *  - User confirms or rejects a suggested time (natural or earliest).
 */
export async function handleSystemActionsFirst({ userText, callState }) {
  const booking = ensureBooking(callState);
  const t = (userText || '').trim().toLowerCase();

  const phone = booking.phone || callState.callerNumber || null;
  const email = booking.email || null;
  const name = booking.name || null;

  // A) If we already have time + phone + email and we previously decided
  //    we needed the email before booking, now create the event.
  if (
    booking.needEmailBeforeBooking &&
    booking.timeISO &&
    phone &&
    email &&
    !booking.bookingConfirmed
  ) {
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
        startISO: booking.timeISO,
        durationMinutes: 30,
        name,
        email,
        phone,
      });

      const startISO = event.start?.dateTime || booking.timeISO;

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
      const replyText = name
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

  // B) If we are waiting on a yes/no for a specific time
  if (booking.awaitingTimeConfirm && (yesInAnyLang(t) || noInAnyLang(t))) {
    if (yesInAnyLang(t)) {
      // Decide which time to book: explicit requested time > earliest suggestion
      const timeISO = booking.timeISO || booking.earliestSlotISO || null;

      if (!timeISO) {
        // No actual time stored; reset and let GPT re-ask
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;
        return {
          intercept: false,
        };
      }

      // We have a time, plus (hopefully) contact details.
      const phoneNow = booking.phone || callState.callerNumber || null;
      const emailNow = booking.email || null;
      const nameNow = booking.name || null;

      // If no phone, we can't confirm — let GPT ask for it.
      if (!phoneNow) {
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

      // If phone is present but email is missing → ask email FIRST, don't book yet.
      if (!emailNow) {
        booking.awaitingTimeConfirm = false;
        booking.timeISO = timeISO;
        booking.timeSpoken =
          booking.timeSpoken ||
          booking.earliestSlotSpoken ||
          formatSpokenDateTime(timeISO, BUSINESS_TIMEZONE);
        booking.needEmailBeforeBooking = true;

        const replyText =
          'Brilliant — before I lock that in, what’s your best email address, nice and slowly?';

        return {
          intercept: true,
          replyText,
        };
      }

      // We have time + phone + email → perform booking now
      try {
        const existing = await findExistingBooking({
          phone: phoneNow,
          email: emailNow,
        });
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
          name: nameNow,
          email: emailNow,
          phone: phoneNow,
        });

        const startISO = event.start?.dateTime || timeISO;

        await sendConfirmationAndReminders({
          to: phoneNow,
          startISO,
          name: nameNow,
        });

        booking.bookingConfirmed = true;
        booking.lastEventId = event.id;
        booking.awaitingTimeConfirm = false;
        booking.lastPromptWasTimeSuggestion = false;

        const spoken = formatSpokenDateTime(startISO, BUSINESS_TIMEZONE);

        const replyText = nameNow
          ? `Brilliant ${nameNow} — I’ve got you booked in for ${spoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`
          : `Brilliant — I’ve got that booked in for ${spoken}. You’ll get a message with the Zoom details in a moment. Anything else I can help with today?`;

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
