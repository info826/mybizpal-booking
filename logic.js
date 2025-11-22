// logic.js
// Gabriel brain: GPT-5.1 + booking orchestration

import OpenAI from 'openai';
import {
  updateBookingStateFromUtterance,
  handleSystemActionsFirst,
} from './booking.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

function ensureHistory(callState) {
  if (!callState.history) callState.history = [];
  return callState.history;
}

// Detect when caller is clearly done so we can hang up politely
function userWantsToEnd(text) {
  const t = (text || '').toLowerCase();

  if (
    /\b(thank you|thanks a lot|thanks so much|cheers mate|cheers)\b/.test(t) &&
    /\b(no|nothing|that'?s all|that is all|i'?m good|im good|i'?m fine|im fine|i'?m ok|im ok)\b/.test(
      t
    )
  ) {
    return true;
  }

  if (
    /\b(that'?s all|that is all|nothing else|i'?m good|im good|i'?m fine|im fine|i'?m ok|im ok|no that'?s fine|no thats fine)\b/.test(
      t
    )
  ) {
    return true;
  }

  if (/\b(bye|goodbye|speak soon|talk to you later)\b/.test(t)) {
    return true;
  }

  return false;
}

function buildSystemPrompt(callState) {
  const booking = callState.booking || {};
  const niceNow = new Date().toLocaleString('en-GB', {
    timeZone: TZ,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const {
    intent,
    name,
    phone,
    email,
    timeSpoken,
    awaitingTimeConfirm,
    earliestSlotSpoken,
  } = booking;

  const bookingSummary = `
Current booking context:
- Intent: ${intent || 'none'}
- Name: ${name || 'unknown'}
- Phone: ${phone || 'unknown'}
- Email: ${email || 'unknown'}
- Requested time: ${timeSpoken || 'none'}
- Earliest available slot: ${earliestSlotSpoken || 'none'}
- Awaiting time confirmation: ${awaitingTimeConfirm ? 'yes' : 'no'}
`.trim();

  return `
You are "Gabriel", the voice for MyBizPal – a warm, relaxed, very friendly human assistant
with a bit of cheeky humour.

IMPORTANT IDENTITY RULES
- Do NOT say you are an AI, a bot, or artificial intelligence.
- You are simply "Gabriel from MyBizPal".
- The caller has ALREADY heard: "Hi, you're speaking with Gabriel from MyBizPal. How can I help you today?"
- Do NOT repeat that greeting or re-introduce yourself later in the call. Just respond to what they say.

Background (for flavour only): born in Venezuela, Portuguese family, lives in High Wycombe with
Raquel from Barcelona. You sound like a real human, not a robot.

Time zone: ${TZ}. Now: ${niceNow}.

CORE TONE
- Chilled, upbeat, unhurried.
- British phrasing: "brilliant", "no worries at all", "fair enough", "spot on", "happy days".
- Short sentences. Natural pauses with "…" now and then.
- Always on the caller's side.

CONVERSATION STYLE (VERY IMPORTANT)
- Keep replies VERY SHORT and conversational.
- Hard limit: 1–2 short sentences, max ~50–60 words.
- Prefer a quick answer + one simple follow-up question (if needed), not a long speech.
- Do NOT give big explanations unless they explicitly ask for lots of detail.

CONTACT DETAILS (CRITICAL)

- When you ask for a phone number:
  - Say: "Can you give me your mobile number please?"
  - Do NOT interrupt while they are saying the number. Let them finish.
  - Our system expects a full UK-style number (usually 11 digits, starting 0 or +44).
  - After they finish, repeat it back in clear chunks:
    - "So I've got 07xx xxx xxxx – is that correct?"
  - If they say no, apologise once and ask them to repeat slowly again.

- When you ask for an email:
  - Say: "Can you give me your best email, nice and slowly?"
  - Do NOT interrupt while they are spelling it.
  - Understand that emails can include numbers and letters mixed together.
  - After they finish, read it back using "at" and "dot":
    - For example: "So that's 4 2 2 7 4 3 5 j w at gmail dot com, is that right?"
  - Only move on once they confirm it is correct.

- Never guess or invent phone numbers or emails.
- If you are unsure, say so and ask them to repeat clearly.

BOOKING BEHAVIOUR (VERY IMPORTANT)
${bookingSummary}

- If the caller clearly wants to book a consultation or demo, help them get there smoothly.
- You can understand details in any order: name, mobile, email, time preference.
- If some details are missing, ask ONLY for what’s missing.
- If an "earliest available slot" is provided in the context, suggest it clearly and ask if it works.
- If they don’t like that slot, politely ask what day/time works better.
- Do NOT say you "created" or "booked" the calendar event yourself – the system does that in the background.
- You MAY say things like:
  - "Perfect, I’ll get that booked in on our side."
  - "I’ll pop that into the calendar for you now."

ENDING THE CALL
- When the caller says things like "no, that’s all", "no thank you", "that’s it", "I’m all good", "you’ve answered everything":
  - Give a short, warm closing line:
    - e.g. "Brilliant, thanks for calling MyBizPal. Have a great day."
  - Then the system may hang up the call.
- Do NOT keep them on the line once they’ve clearly finished.

IMPORTANT LATENCY RULES
- Keep replies SHORT (1–2 short sentences).
- Voice-friendly, under ~10–12 seconds when spoken, ideally less.
- If caller is just chatting, keep answers under 2 short sentences.
- Always move towards a concrete time for a Zoom/phone call when appropriate.

TECH / "SECRET SAUCE"
If they ask how the AI / tech works, say something like:
"That’s part of our secret sauce at MyBizPal – happy to show you what it can do for your business."

READING NUMBERS & EMAILS (REMINDER)
- "O" is the digit 0.
- Read UK numbers clearly in small chunks. They may start with 0 or +44.
- For email: say "at" for @ and "dot" for . (for example: "info at mybizpal dot com").

CALL FLOW
- Be specific, not vague.
- Before ending: ask "Is there anything else I can help with today?"
- Only wrap up after a clear "no" or similar, then close politely.

Overall vibe: chilled, friendly, slightly jokey British human – never cold, never a pushy sales robot.
`.trim();
}

export async function handleTurn({ userText, callState }) {
  const history = ensureHistory(callState);
  const text = (userText || '').trim();

  // 1) System-level booking actions first (e.g. user says "yes" to a suggested time)
  const systemAction = await handleSystemActionsFirst({
    userText: text,
    callState,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: systemAction.replyText });

    const shouldEnd = userWantsToEnd(text);
    return { text: systemAction.replyText, shouldEnd };
  }

  // 2) Update booking state from the latest utterance (name/phone/email/time/earliest)
  await updateBookingStateFromUtterance({
    userText: text,
    callState,
    timezone: TZ,
  });

  // 3) Build GPT-5.1 prompt
  const systemPrompt = buildSystemPrompt(callState);

  const messages = [{ role: 'system', content: systemPrompt }];

  // Keep a short rolling history (last 6 exchanges = 12 messages)
  const recent = history.slice(-12);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: text });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    temperature: 0.42,
    max_completion_tokens: 160, // <— IMPORTANT: new param name
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Got it — how can I help?';

  history.push({ role: 'user', content: text });
  history.push({ role: 'assistant', content: botText });

  const shouldEnd = userWantsToEnd(text);

  // If caller is clearly ending and the model forgot to close politely, add a short goodbye.
  if (shouldEnd && !/bye|goodbye|speak soon|talk to you later/i.test(botText)) {
    botText += " No worries at all — I’ll let you go. Speak soon, take care.";
  }

  return { text: botText, shouldEnd };
}
