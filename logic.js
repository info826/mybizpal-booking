// logic.js
// Gabriel brain: GPT-5.1 + booking orchestration (clean, no loops, Zoom-based)

import OpenAI from 'openai';
import {
  updateBookingStateFromUtterance,
  handleSystemActionsFirst,
} from './booking.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// ---------- BASIC STATE HELPERS ----------

function ensureHistory(callState) {
  if (!callState.history) callState.history = [];
  return callState.history;
}

function getChannelInfo(callState) {
  const channel =
    callState.channel ||
    callState.transport ||
    callState.mode ||
    process.env.MYBIZPAL_CHANNEL ||
    'voice';

  const lower = String(channel).toLowerCase();
  const isChat =
    lower.includes('chat') ||
    lower.includes('whatsapp') ||
    lower.includes('message') ||
    lower.includes('sms');

  return {
    channel,
    isChat,
    isVoice: !isChat,
  };
}

// ---------- SYSTEM PROMPT ----------

function buildSystemPrompt(callState) {
  const booking = callState.booking || {};
  const history = callState.history || [];
  const { isChat, isVoice } = getChannelInfo(callState);

  const now = new Date();
  const niceNow = now.toLocaleString('en-GB', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const hourLocal = Number(
    now.toLocaleString('en-GB', {
      timeZone: TZ,
      hour: 'numeric',
      hour12: false,
    })
  );
  let timeOfDay = 'day';
  if (hourLocal >= 5 && hourLocal < 12) timeOfDay = 'morning';
  else if (hourLocal >= 12 && hourLocal < 17) timeOfDay = 'afternoon';
  else if (hourLocal >= 17 && hourLocal < 22) timeOfDay = 'evening';
  else timeOfDay = 'late';

  const hasAssistantMessage = history.some((m) => m.role === 'assistant');

  const {
    intent,
    name,
    phone,
    email,
    timeSpoken,
    earliestSlotSpoken,
    bookingConfirmed,
  } = booking;

  const bookingSummary = `
Current booking context (do NOT read out directly):
- Intent: ${intent || 'none'}
- Name: ${name || 'unknown'}
- Phone: ${phone || 'unknown'}
- Email: ${email || 'unknown'}
- Requested/confirmed time: ${timeSpoken || 'none'}
- Earliest available slot: ${earliestSlotSpoken || 'none'}
- Booking confirmed flag: ${bookingConfirmed ? 'yes' : 'no'}
- Local time now: ${niceNow} (${TZ})
- Time of day label: ${timeOfDay}
- Has already greeted this caller in this conversation: ${hasAssistantMessage ? 'yes' : 'no'}
`.trim();

  const channelSummary = `
Channel information (do NOT read this out):
- Is chat (WhatsApp / SMS / web): ${isChat ? 'yes' : 'no'}
- Is voice call: ${isVoice ? 'yes' : 'no'}
`.trim();

  return `
You are "Gabriel" from MyBizPal, a smart, confident, very human-sounding British sales professional.

You are talking to business owners who might want an always-on agent like you
to answer calls, qualify leads and book appointments into their calendar.

${bookingSummary}

${channelSummary}

ABOUT MYBIZPAL (FOR YOU, NOT TO RECITE LIKE A SCRIPT)
- MyBizPal gives a business an always-on agent like you:
  - Answers calls 24/7.
  - Qualifies leads properly.
  - Answers common questions.
  - Books calls/appointments straight into their calendar.
  - Sends confirmations & reminders by WhatsApp or SMS.
- It is more than a receptionist. It is a sales and booking assistant.
- Consultations with the team are done on ZOOM.
  - Never say "we will call your mobile" for the consultation.
  - Instead say things like:
    - "You will get a WhatsApp and email with the Zoom link."
    - "You will join the consultation via Zoom using that link."

GREETING & FIRST IMPRESSION (IMPORTANT)
- Only start with "Good morning/afternoon/evening" in your FIRST reply of this conversation.
- If there has already been an assistant message in the history, do NOT start again with
  "Good evening" or a full re-introduction.
- Typical first message (voice or chat), if the user just said "hi":
  - "Good ${timeOfDay}, I am Gabriel from MyBizPal. How can I help you today?"
- On chat / WhatsApp:
  - Keep messages shorter and more direct.
  - No "digit by digit" / "say it slowly" phrases.

STYLE & TONE
- Very human, natural British conversational style.
- Use light phrases like "brilliant", "no worries at all", "fair enough", but do not repeat
  the same one every time.
- You sound confident but not pushy, slightly cheeky but always professional.
- You respond directly to what they say; avoid long scripted monologues.

WHEN THEY ASK "WHAT DO YOU DO?" OR "WHAT ARE YOUR SERVICES?"
- Always answer the question FIRST in one or two short sentences.
- Then follow with ONE simple question to learn about them.
  Examples:
  - "We set up an agent like me for your business to answer calls, qualify leads and book people straight into your calendar 24/7. How are you handling calls at the moment?"
  - Keep it conversational, not robotic.

BOOKING BEHAVIOUR (MON–FRI, 9–5 UK TIME)
- If they want to book a consultation:
  - The booking system will handle the actual time and calendar event.
  - You focus on guiding the conversation: name, what the consultation is about, mobile number, email.
- Consultations:
  - Are 15–30 minute Zoom calls.
  - You should talk about "booking a Zoom consultation" / "Zoom call with the team".
  - Do NOT say "the team will call you on your mobile".
  - Instead say: "You will receive a WhatsApp and email with the Zoom link and details."

ASKING FOR NAME, MOBILE & EMAIL
- Only ask for contact details when there is a reason (booking, sending info, demo).
- Name:
  - Ask once near the start if unknown: "By the way, what is your name?".
  - Once you know it, use the first name naturally; never ask for it again in this conversation.
- Mobile number (voice):
  - You *may* say "digit by digit" on voice.
- Mobile number (chat/WhatsApp):
  - Just say: "What is your mobile number?"
  - Do NOT ask for it "digit by digit".
- Email (chat/WhatsApp):
  - "What is your best email address?".
  - Do NOT say "slowly".
  - Do NOT spell it back unless they ask.

NO LOOPS, NO SCRIPTED FEELING
- Do not keep asking the same probing question again and again.
  - For example, avoid repeating things like
    "How can I best help you with your calls and bookings today?"
    or "What is the main thing you want to improve with your calls right now?"
    more than once.
- Do not keep asking "What kind of business are you running?" if the caller has already said it.
- If the caller has already given a clear problem (missed calls, lost leads, overwhelmed, etc.),
  do NOT go back to very basic probing. Move the conversation forward.

ENDING THE CONVERSATION
- Before ending, you may ask once:
  - "Is there anything else I can help with today?"
- If they say no / no thanks / that is all:
  - Give a short warm sign-off and then stop. No more sales questions.
- If they later just reply "Thanks" or "Thank you" after your sign-off:
  - You CAN just reply "You are welcome" or you can end with no extra question.
  - Do NOT start a new discovery question like "What kind of business are you running?" at that point.

OVERALL
- Your answers must be short to medium length on WhatsApp.
- Avoid paragraphs that feel like a rehearsed script.
- Always sound like a real person thinking about what they just said, not like a template.
`.trim();
}

// ---------- MAIN TURN HANDLER ----------

export async function handleTurn({ userText, callState }) {
  const safeUserText = (userText || '').trim();
  const lowerUser = safeUserText.toLowerCase();
  const history = ensureHistory(callState);
  const { isChat } = getChannelInfo(callState);

  // Ensure booking state exists
  if (!callState.booking) callState.booking = {};
  const bookingState = callState.booking;

  // Detect strong booking intent early so booking.js can see it
  if (
    /(can we|can i|could we|could i)\s+book\b/i.test(lowerUser) ||
    /\bbook (a |something )?(call|zoom|consultation|meeting|appointment)\b/i.test(
      lowerUser
    ) ||
    /\bschedule (a )?(call|zoom|consultation|meeting|appointment)\b/i.test(
      lowerUser
    ) ||
    /\bset up (a )?(call|zoom|consultation|meeting)\b/i.test(lowerUser) ||
    /\bi want to book\b/i.test(lowerUser)
  ) {
    bookingState.intent = 'wants_booking';
  }

  // If they say they don't know / not sure, mark as exploratory, we will steer to a Zoom
  const userUnsure =
    /\bi don.?t know\b/.test(lowerUser) ||
    /\bnot sure\b/.test(lowerUser) ||
    /\bi'm not sure\b/.test(lowerUser) ||
    /\bim not sure\b/.test(lowerUser);

  // ---------- 1) SYSTEM-LEVEL BOOKING ACTIONS (calendar + SMS/WhatsApp) ----------

  const systemAction = await handleSystemActionsFirst({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    return { text: systemAction.replyText, shouldEnd: false };
  }

  // Update booking state (name/phone/email/time extraction, earliest slot handling)
  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  // ---------- 2) BUILD OPENAI MESSAGES ----------

  const systemPrompt = buildSystemPrompt(callState);
  const messages = [{ role: 'system', content: systemPrompt }];

  // Only feed the last ~12 messages of history to keep it snappy
  const recent = history.slice(-12);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: safeUserText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.6,
    max_completion_tokens: 180,
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Alright, thanks for that. How can I best help you with your calls and bookings today?';

  // ---------- 3) POST-PROCESSING TO KILL LOOPS & FIX COPY ----------

  // Normalise em dashes & multi dots
  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');

  // CHAT channel: remove voice-style phrases
  if (isChat) {
    botText = botText
      .replace(/digit by digit/gi, '')
      .replace(/nice and slowly/gi, '')
      .replace(/\bslowly\b/gi, '');
    botText = botText.replace(/\s+,/g, ',');
  }

  // Do not re-greet with "Good morning/evening" after first assistant message
  const hasAssistantBefore = history.some((m) => m.role === 'assistant');
  if (hasAssistantBefore) {
    botText = botText
      .replace(
        /^\s*good\s+(morning|afternoon|evening|morning,|afternoon,|evening,)\s*/i,
        ''
      )
      .trim();
  }

  const lowerBotInitial = botText.toLowerCase();
  const lastAssistant = [...history].slice().reverse()
    .find((m) => m.role === 'assistant');

  // Loop breaker for the exact "How can I best help..." line
  const helpLine =
    'alright, thanks for that. how can i best help you with your calls and bookings today?';

  if (
    lastAssistant &&
    lastAssistant.content.trim().toLowerCase() === helpLine &&
    botText.trim().toLowerCase() === helpLine
  ) {
    // We just repeated the same thing → pivot to something more useful
    if (userUnsure || bookingState.intent === 'wants_booking') {
      botText =
        'No worries if you are not sure. The easiest next step is a short Zoom call where we walk you through how this could work for your clinic and answer questions. Would you like me to book a Zoom consultation for you?';
      bookingState.intent = 'wants_booking';
    } else {
      botText =
        'Alright, that helps. Are you mainly trying to reduce missed calls, get more bookings, or free up your team from the phone?';
    }
  } else if (botText.trim().toLowerCase() === helpLine && userUnsure) {
    // If GPT generated it once *and* user is unsure, steer to Zoom instead
    botText =
      'That is totally fine, you do not need to have all the answers yet. A good starting point is a short Zoom call so we can show you how it works and you can ask questions. Would you like to book a quick Zoom consultation?';
    bookingState.intent = 'wants_booking';
  }

  // If user explicitly asked to book, but GPT didn't, override with a booking-focused reply
  if (
    bookingState.intent === 'wants_booking' &&
    /(can we|can i|could we|could i)\s+book\b/.test(lowerUser) &&
    !/zoom/.test(lowerBotInitial)
  ) {
    botText =
      'Yes, of course, we can. The best thing is a 20-30 minute Zoom consultation so we can walk you through how MyBizPal would work for your clinic and pricing. What day and time suits you best between Monday and Friday, 9am and 5pm UK time?';
  }

  // Ensure we talk about Zoom, not "calling your mobile"
  botText = botText.replace(
    /(the team|we|they)('?ll)? call you on (your )?(mobile|cell|phone)[^.]*/gi,
    'you will get a WhatsApp and email with the Zoom link, and you will join the consultation via Zoom'
  );
  botText = botText.replace(
    /call you on \*?[0-9+ ]+\*?[^.]*/gi,
    'invite you to join via Zoom using the link we send you'
  );

  // If it promises WhatsApp/email with Zoom link but we STILL have no time picked, force it to ask for day & time first
  const noTimeChosen =
    !bookingState.timeSpoken && !bookingState.earliestSlotSpoken;

  if (
    /you'?ll receive a whatsapp and an email with (the )?zoom link/i.test(
      botText.toLowerCase()
    ) &&
    noTimeChosen
  ) {
    botText =
      'Perfect, that gives me what I need about your clinic. Next step is to pick a day and time for the Zoom call. What day and time suits you best for a 20-30 minute Zoom consultation between Monday and Friday, 9am and 5pm UK time?';
  }

  // Trim overly long responses (keep natural sentence end)
  if (botText.length > 600) {
    const cut = botText.slice(0, 600);
    const lastBreak = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? '),
      cut.lastIndexOf('\n')
    );
    if (lastBreak > 0) botText = cut.slice(0, lastBreak + 1);
    else botText = cut;
  }

  // ---------- 4) END-OF-CONVERSATION DETECTION ----------

  let shouldEnd = false;

  let endByPhrase =
    /\b(no,?\s*that'?s all|that'?s all|nothing else|no more|all good|we'?re good)\b/.test(
      lowerUser
    ) ||
    /\b(no thanks?|no thank you|i'?m good|i am good)\b/.test(lowerUser) ||
    /\b(ok(ay)? bye|bye|goodbye|speak soon|talk soon)\b/.test(lowerUser);

  // Extra rule: if last assistant message was a clear signoff and user now says "thanks"
  if (!endByPhrase && /^(thanks|thank you|cheers)\b/.test(lowerUser)) {
    const lastAssistant2 = [...history].slice().reverse()
      .find((m) => m.role === 'assistant');
    if (
      lastAssistant2 &&
      /thanks for speaking with mybizpal/i.test(
        lastAssistant2.content.toLowerCase()
      )
    ) {
      endByPhrase = true;
      botText = "You're very welcome 🙂";
    }
  }

  if (endByPhrase) {
    shouldEnd = true;
    if (
      !/bye|have a (great|good) (day|evening|night)/i.test(botText)
    ) {
      botText =
        'No worries at all, thanks for speaking with MyBizPal. Have a great day.';
    }
  }

  // ---------- 5) SAVE HISTORY & RETURN ----------

  history.push({ role: 'user', content: safeUserText });
  history.push({ role: 'assistant', content: botText });

  return { text: botText, shouldEnd };
}
