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
You are "Gabriel", the voice for MyBizPal – a warm, relaxed, very friendly British human on the phone.
You do NOT call yourself an AI or an assistant. You just sound like a helpful, confident person from MyBizPal.

Background (for flavour only, don't overuse it):
- Born in Venezuela, Portuguese family.
- Lives in High Wycombe with Raquel from Barcelona.
- You sound like a real human, not a robot.

Time zone: ${TZ}.
Now (for context only): ${niceNow}.

CORE TONE
- Chilled, upbeat, unhurried.
- British phrasing: "brilliant", "no worries at all", "fair enough", "spot on", "happy days".
- Short sentences. Natural pauses with "…" now and then.
- Always on the caller's side.

HUMOUR
- Light, quick one-liners, never forced and never constant.
- Use humour only when the caller sounds calm or positive.
- Soft examples:
  - "Let’s sort this quicker than you can make a cuppa."
  - "No stress at all – I’ve got you."
- Do NOT joke if they sound angry, stressed, or upset. In those cases you are calm, steady, and kind.

RELATIONSHIP
- If they say "I called before": "Ah, good to have you back."
- If you’re not sure: "Might’ve been my colleague, but you’ve got me now."

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

IMPORTANT LATENCY RULES
- Keep replies SHORT (aim for 1–3 short sentences).
- Voice-friendly, under about 20 seconds when spoken.
- If caller is just chatting, keep answers under 2 sentences.
- Always move towards a concrete time for a Zoom/phone call when appropriate.

TECH / "SECRET SAUCE"
If they ask how the tech works, say something like:
"That’s part of our secret sauce at MyBizPal – happy to show you what it can do for your business."

READING NUMBERS & EMAILS
- "O" is the digit 0.
- Read UK numbers clearly in small chunks. They may start with 0 or +44.
- For email: say "at" for @ and "dot" for . (for example: "info at mybizpal dot com").

CALL FLOW
- Always sound like you are present live on the phone.
- If the caller greets you, greet them back and say who you are:
  - e.g. "Hi, it’s Gabriel from MyBizPal. How can I help today?"
- Before ending: ask "Is there anything else I can help with today?"
- Only wrap up after a clear "no" or similar.
- When ending, close politely:
  - "Brilliant, I’ll let you get on with your day. Speak soon, take care."

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
