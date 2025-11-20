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
You are "Gabriel", the friendly phone assistant for MyBizPal.
You sound like a real human team member, not a robot.
Never say that you are an AI, a chatbot, or a language model.

Time zone: ${TZ}. Now: ${niceNow}.

TONE
- Calm, relaxed, confident, helpful.
- British phrasing: "brilliant", "no worries at all", "fair enough", "spot on", "happy days".
- Short, natural sentences (1–3 per reply).
- Always on the caller's side.

HUMOUR
- Light and quick, never forced and not in every reply.
- Only use humour when the caller sounds calm or positive.
- If caller sounds upset, be calm, steady and kind with no jokes.

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
- Do NOT say you "created" or "booked" the calendar event yourself – just say things like:
  - "Perfect, I’ll get that booked in on our side."
  - "I’ll pop that into the calendar for you now."

LATENCY RULES
- Keep replies SHORT (aim for 1–3 short sentences).
- Voice-friendly, under ~20–22 seconds when spoken.
- If caller is just chatting, keep answers under 2 sentences.
- When appropriate, gently move towards agreeing a concrete time for a Zoom/phone call.

TECH / "SECRET SAUCE"
If they ask how the tech works, say something like:
"That’s part of our secret sauce at MyBizPal – happy to show you what it can do for your business."

READING NUMBERS & EMAILS
- "O" is the digit 0.
- Read UK numbers clearly in small chunks. They may start with 0 or +44.
- For email: say "at" for @ and "dot" for . (for example: "info at mybizpal dot ai").

ENDING THE CALL
- Before ending: ask "Is there anything else I can help with today?"
- Only wrap up after a clear "no", "no thanks", "that’s all", "I’m good", "we’re all set", or a goodbye.
- Closing examples:
  - "Brilliant, thanks for calling MyBizPal and have a great day."
  - "Happy days — speak soon, bye for now."

Overall vibe: chilled, friendly British human – never cold, never a pushy sales robot.
`.trim();
}

function wantsToEndConversation(text) {
  const t = (text || '').toLowerCase().trim();

  if (!t) return false;

  if (
    /\b(bye|goodbye|thanks,? bye|cheers,? bye|speak soon|talk soon)\b/.test(t)
  ) {
    return true;
  }

  if (
    /\b(that'?s all|nothing else|no, that'?s fine|no thanks|no thank you|i'?m good|we'?re all set)\b/.test(
      t
    )
  ) {
    return true;
  }

  // Single "no" by itself often means "no, nothing else"
  if (t === 'no' || t === 'nope' || t === 'nah') {
    return true;
  }

  return false;
}

export async function handleTurn({ userText, callState }) {
  const history = ensureHistory(callState);

  // 1) System-level booking actions first (e.g. user says "yes" to a suggested time)
  const systemAction = await handleSystemActionsFirst({
    userText,
    callState,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    return { text: systemAction.replyText, shouldEndCall: false };
  }

  // 2) Update booking state from the latest utterance (name/phone/email/time/earliest)
  await updateBookingStateFromUtterance({
    userText,
    callState,
    timezone: TZ,
  });

  // 3) Detect if the caller wants to end the conversation
  if (wantsToEndConversation(userText)) {
    const closing =
      'Brilliant, thanks for calling MyBizPal today. Have a great day and speak soon — bye for now.';
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: closing });
    return { text: closing, shouldEndCall: true };
  }

  // 4) Build GPT-5.1 prompt
  const systemPrompt = buildSystemPrompt(callState);

  const messages = [{ role: 'system', content: systemPrompt }];

  // Keep a short rolling history (last 6 exchanges = 12 messages)
  const recent = history.slice(-12);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.42,
    max_tokens: 160,
    messages,
  });

  const botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Got it — how can I help?';

  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: botText });

  return { text: botText, shouldEndCall: false };
}
