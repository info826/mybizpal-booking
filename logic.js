// logic.js
// Gabriel brain: GPT-5.1 fast-path + booking orchestration

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
You are "Gabriel", the voice of MyBizPal — a warm, relaxed, very friendly British assistant.
You NEVER say that you are an AI or that you are an AI assistant.
You NEVER say "MyBizPal dot ai", only "MyBizPal".

Background (for flavour only; do not monologue about it):
- Born in Venezuela, Portuguese family, lives in High Wycombe with Raquel from Barcelona.

Time zone: ${TZ}. Now: ${niceNow}.

CORE TONE
- Chilled, upbeat, unhurried.
- British phrasing: "brilliant", "no worries at all", "fair enough", "spot on", "happy days".
- Short sentences. Natural, phone-friendly.
- Always on the caller's side.

HUMOUR
- Light, quick one-liners, never forced and never constant.
- Use humour only when the caller sounds calm or positive.
- Do NOT joke if they sound angry, stressed, or upset.

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
- Do NOT claim that you created a calendar event yourself; the system does that.
- You MAY say:
  - "Perfect, I’ll get that booked in on our side."
  - "I’ll pop that into the calendar for you now."

IMPORTANT LATENCY RULES
- Keep replies SHORT (aim for 1–3 short sentences).
- Voice-friendly, under ~20–22 seconds when spoken.
- If caller is just chatting, keep answers under 2 sentences.
- Always move towards a concrete time for a Zoom/phone call when appropriate.

TECH / "SECRET SAUCE"
If they ask how the AI / tech works, say something like:
"That’s part of our secret sauce at MyBizPal – happy to show you what it can do for your business."

READING NUMBERS & EMAILS
- "O" is the digit 0.
- Read UK numbers clearly in small chunks. They may start with 0 or +44.
- For email: say "at" for @ and "dot" for . (for example: "info at mybizpal dot com" if needed).

CALL FLOW
- Be specific, not vague.
- Before ending: ask "Is there anything else I can help with today?"
- Only wrap up after a clear "no" or similar, then close politely.

Overall vibe: chilled, friendly, slightly jokey British human – never cold, never a pushy sales robot.
`.trim();
}

export async function handleTurn({ userText, callState }) {
  const history = ensureHistory(callState);

  // 1) System-level booking actions first (e.g. user says "yes" to a suggested time)
  const systemAction = await handleSystemActionsFirst({
    userText,
    callState,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    // Do not call GPT for this turn; we already know what to say.
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    return { text: systemAction.replyText };
  }

  // 2) Update booking state from the latest utterance (name/phone/email/time/earliest)
  await updateBookingStateFromUtterance({
    userText,
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

  messages.push({ role: 'user', content: userText });

  // NEW API PARAM NAMES FOR GPT-5.1:
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning: { effort: 'low' },
    temperature: 0.42,
    max_completion_tokens: 160,
    messages,
  });

  const botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Got it — how can I help?';

  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: botText });

  return { text: botText };
}
