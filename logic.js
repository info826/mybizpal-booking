// logic.js
// Gabriel brain: GPT-5.1 + booking orchestration + careful phone/email/name capture

import OpenAI from 'openai';
import {
  updateBookingStateFromUtterance,
  handleSystemActionsFirst,
} from './booking.js';
import {
  extractName,
  parseUkPhone,
  isLikelyUkNumberPair,
  extractEmailSmart,
  yesInAnyLang,
  noInAnyLang,
} from './parsing.js';
import { getSessionForPhone, saveSessionForPhone } from './sessionStore.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// small helper for more natural variation
function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

// ---------- BASIC STATE HELPERS ----------

function ensureHistory(callState) {
  if (!callState.history) callState.history = [];
}

function ensureBehaviour(callState) {
  if (!callState.behaviour) {
    callState.behaviour = {
      hasGreeted: false,
      askedBusinessType: false,
      askedPain: false,
      gaveOverview: false,
      bookingReadiness: 'unknown', // 'low' | 'medium' | 'high'
      rapportLevel: 0,
      lastGoodbye: null,
    };
  }
  return callState.behaviour;
}

function normaliseFrom(rawFrom) {
  // e.g. "whatsapp:+447456438935" or "+447456438935"
  if (!rawFrom) return null;
  const s = String(rawFrom).trim();
  if (s.startsWith('whatsapp:')) return s;
  return s.startsWith('+') ? `whatsapp:${s}` : s;
}

// simple goodbye detector
function isGoodbye(text) {
  const t = (text || '').trim().toLowerCase();
  if (!t) return false;
  return /^(no thanks|no thank you|no, thanks|no thats all|no that's all|that's all|thats all|all good|im good|i'm good|i am good|nothing else|nope, that.s it|nope thats it|nope that's it)$/.test(
    t
  );
}

// very light sentiment / interest tagging (for summary only)
function updateBehaviourFromUtterance(callState, userText) {
  const behaviour = ensureBehaviour(callState);
  const t = (userText || '').toLowerCase();

  if (/thank/i.test(t)) {
    behaviour.rapportLevel = Math.min(5, (behaviour.rapportLevel || 0) + 1);
  }
  if (/sounds good|that sounds good|perfect|great|nice|love that/i.test(t)) {
    behaviour.bookingReadiness = 'high';
  } else if (/maybe|not sure|thinking/i.test(t)) {
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'medium';
    }
  }

  return behaviour;
}

// build a short internal state line for the system prompt
function buildBookingStateLine(callState) {
  const b = callState.booking || {};
  const name = b.name || 'unknown';
  const phone = b.phone ? 'yes' : 'no';
  const email = b.email ? 'yes' : 'no';
  const time = b.timeSpoken || b.earliestSlotSpoken || 'none chosen yet';
  const confirmed = b.bookingConfirmed ? 'yes' : 'no';
  return `Booking state -> intent: ${b.intent || 'none'}, name: ${name}, phone captured: ${phone}, email captured: ${email}, chosen time: ${time}, confirmed in calendar: ${confirmed}.`;
}

// ---------- SYSTEM PROMPT ----------

function buildSystemPrompt(callState) {
  const behaviour = ensureBehaviour(callState);
  const bookingLine = buildBookingStateLine(callState);

  const alreadyGreeted = behaviour.hasGreeted ? 'yes' : 'no';

  return `
You are *Gabriel*, a friendly but commercially sharp WhatsApp agent for **MyBizPal**.

Your job:
- Chat naturally with business owners (mostly clinics, trades, agencies).
- Quickly understand what they do and whether MyBizPal is a fit.
- Then guide them *smoothly* to a booked Zoom consultation, where the human team will demo and close.

IMPORTANT HARD RULES:

1. No fake promises about the booking.
   - The system around you actually creates the calendar event and sends WhatsApp/SMS.
   - You MUST NOT say "I have added this to the calendar" or "You will get a WhatsApp confirmation"
     unless you are replying to the user's own confirmation message that clearly follows a time,
     phone number and email having been provided.
   - When unsure, use softer language like "we'll get that booked in" rather than stating it has already been booked.

2. Zoom, not phone calls.
   - All consultations happen on Zoom, not phone calls.
   - Never say "the team will call your mobile" or "we'll ring you".
   - Instead say things like:
     - "You'll get the Zoom link by WhatsApp/SMS and email."
     - "We'll meet you on Zoom at that time."

3. Rapport first, but don't waffle.
   - Be warm, a bit witty, and human. Light British flavour is fine.
   - Two or three short back-and-forths of small talk is fine if the user starts it,
     but once they show interest, move towards the consultation booking.
   - Do not repeat the same discovery question (like "what is the main thing you want to improve")
     more than once. Once they have answered, move on.

4. Discovery structure (keep it tight).
   - Find out:
     1) What kind of business they run (clinic, dentist, physio, spa, salon, trades, etc.).
     2) Roughly what happens with calls now (missed calls? voicemails? staff too busy?).
     3) Whether they are curious enough to look at a quick Zoom consultation.
   - Once they clearly say they want a consultation or a demo:
     - Stop deep discovery.
     - Focus on confirming it's a business owner / decision-maker and then guide to times.

5. How to talk about MyBizPal (short, not scripted).
   - MyBizPal gives them an AI agent that:
     - answers calls 24/7 when the team can't,
     - answers common questions in normal human language,
     - qualifies callers and captures details,
     - and books people straight into their diary/calendar.
   - Explain this in plain English, in 1–3 short sentences.
   - Avoid long scripted paragraphs. Absolutely DO NOT send chunky repeated scripts.

6. Tone rules.
   - Use short paragraphs and line breaks on WhatsApp.
   - Use their first name occasionally but don't overdo it.
   - Avoid re-greeting ("Good evening again, X") once the conversation has started.
     INTERNAL INFO: has already greeted: ${alreadyGreeted}.
   - If the user says things like "No thanks" or "No, that’s all", treat that as the end of the conversation.
     Reply briefly, say thanks, and DO NOT ask a brand new qualifying question afterwards.

7. When a time has been agreed but you're still chatting.
   - If the system has already confirmed the booking (bookingConfirmed = yes) you can reference the time
     as "your consultation on <time>" but you should NOT change it unless the user asks.
   - Don't keep trying to sell after the booking is done; just answer anything they ask and end politely.

INTERNAL BOOKING STATE (for you, not to be spoken directly):
${bookingLine}

Your replies must:
- Be under about 4 sentences.
- Feel like natural WhatsApp messages, not a formal email.
`.trim();
}

// ---------- MAIN HANDLER ----------

/**
 * Main entry point for WhatsApp chat.
 * @param {Object} params
 * @param {string} params.fromNumber - e.g. "whatsapp:+447456438935"
 * @param {string} params.userText   - latest inbound message text
 * @returns {Promise<{ replyText: string, callState: any }>}
 */
export async function handleIncomingMessage({ fromNumber, userText }) {
  const normFrom = normaliseFrom(fromNumber);
  const rawText = userText || '';

  // Load or create session
  let callState = (await getSessionForPhone(normFrom)) || {};
  ensureHistory(callState);
  ensureBehaviour(callState);

  // always remember the caller's number for later SMS/WhatsApp
  callState.callerNumber = normFrom;

  // record user message in history first (so summaries include it)
  callState.history.push({ role: 'user', content: rawText });

  // update light behaviour info
  updateBehaviourFromUtterance(callState, rawText);

  // goodbye intercept – clean ending, no extra questions
  if (isGoodbye(rawText)) {
    const goodbyeReply = pickRandom([
      'No worries at all – thanks for chatting with MyBizPal. Have a great day.',
      'All good, thanks for your time. If you need anything else, just drop me a message here.',
      'Perfect, thanks – I’ll leave you to it. If anything pops up later, just ping me here.',
    ]);
    callState.behaviour.lastGoodbye = new Date().toISOString();

    // record assistant reply
    callState.history.push({ role: 'assistant', content: goodbyeReply });
    await saveSessionForPhone(normFrom, callState);

    return { replyText: goodbyeReply, callState };
  }

  // Step 1: let the booking module read this utterance & update state
  await updateBookingStateFromUtterance({
    userText: rawText,
    callState,
    timezone: TZ,
  });

  // Step 2: run any required system actions BEFORE we ask GPT to speak
  const systemResult = await handleSystemActionsFirst({
    userText: rawText,
    callState,
  });

  if (systemResult && systemResult.intercept && systemResult.replyText) {
    // e.g. confirmation after creating the booking, conflict handling, etc.
    const replyText = systemResult.replyText;

    callState.history.push({ role: 'assistant', content: replyText });
    await saveSessionForPhone(normFrom, callState);

    return { replyText, callState };
  }

  // Step 3: normal GPT reply (sales/rapport/dialogue)
  const behaviour = ensureBehaviour(callState);

  // mark that we've greeted if this is the very first assistant reply
  if (
    !behaviour.hasGreeted &&
    callState.history.filter((m) => m.role === 'assistant').length === 0
  ) {
    behaviour.hasGreeted = true;
  }

  const systemPrompt = buildSystemPrompt(callState);

  const messages = [
    { role: 'system', content: systemPrompt },
    // include condensed transcript – last 12 messages is usually enough
    ...callState.history.slice(-12).map((m) => ({
      role: m.role,
      content: m.content,
    })),
  ];

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.5,
    max_completion_tokens: 260,
    messages,
  });

  let replyText =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Sorry, my brain froze for a second there. Could you say that one more time?";

  // small safety: trim mega-long replies
  if (replyText.length > 1200) {
    replyText = replyText.slice(0, 1100) + '…';
  }

  // record assistant reply in history
  callState.history.push({ role: 'assistant', content: replyText });

  await saveSessionForPhone(normFrom, callState);

  return { replyText, callState };
}

// default export for convenience
export default handleIncomingMessage;
