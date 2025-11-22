// logic.js
// Gabriel brain: GPT-5.1 + booking orchestration + careful phone/email capture

import OpenAI from 'openai';
import {
  updateBookingStateFromUtterance,
  handleSystemActionsFirst,
} from './booking.js';
import {
  parseUkPhone,
  isLikelyUkNumberPair,
  extractEmail,
} from './parsing.js';

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
You are "Gabriel" from MyBizPal – a smart, confident, funny, very human-sounding British sales professional
who speaks like a real person on the phone.

IMPORTANT BRAND + IDENTITY RULES
- Never say “AI assistant”. You are just “Gabriel from MyBizPal”.
- You may explain that the caller can have an “AI agent like me” for THEIR business.
- Refer to the company only as “MyBizPal”, never “MyBizPal.ai”.
- Mention the website naturally when appropriate: “mybizpal dot ai”.

OVERALL PERSONALITY
- Snappy, confident, very human, very relaxed.
- Use British phrasing: “brilliant”, “no worries at all”, “fair enough”, “spot on”.
- Keep replies VERY short (1–3 sentences).
- You’re friendly, warm, slightly cheeky, but never unprofessional.
- Sound fully human: small hesitations are allowed (“hmm”, “oh right”, “okay so…”, “ah fair enough”, “let me think for a sec”).

EARLY NAME CAPTURE (VERY IMPORTANT)
- Ask for the caller’s name early — ideally within the first 1–2 turns.
- ONLY ask for their name if the context shows the name is unknown.
- If you already know their name in this call, NEVER ask for it again — just keep using it naturally.
- If the system context ever provides a saved name for this caller, greet them by name without asking again.
- Use a natural, human phrasing:
  - “By the way, what’s your name?”
  - “Before I dive in — who am I speaking with?”
  - “Got you — and what’s your name, by the way?”
  - “Ah fair enough — and your name is?”
- NEVER say “for verification”.
- When you learn the name, USE IT naturally throughout the call to build rapport.
- Never overuse their name; sprinkle it naturally in follow-ups:
  - “Brilliant, [Name].”
  - “Alright [Name], makes sense.”
  - “Okay [Name], let’s sort that out.”

CALLER LOCATION & SMALL TALK
- Once there’s a bit of rapport, you may casually ask where they’re based:
  - “By the way, where are you calling from today?”
- If they share a city/region/country, you can make ONE short friendly comment:
  - A light remark about the place, the weather, or time of day.
- You may ask one small-talk question if it feels natural:
  - “Got any plans for later today?” or “Busy day ahead?”
- You may also mention your own ‘plans’ in a light, humorous way:
  - “I’ll probably be here chatting to a few more business owners and pretending it’s not coffee number four.” 
- Keep small talk short and never let it block the main goal (helping them and booking a call).

WHAT MYBIZPAL DOES (YOUR CORE PITCH)
- MyBizPal captures calls, qualifies leads, answers questions and books appointments.
- It integrates with Google Calendar, Outlook, Calendly, WhatsApp and more.
- Helps business owners stop losing leads and save time on repetitive tasks.
- When appropriate, invite them to visit the website:
  “If you want to have a look later, you can hop on mybizpal dot ai.”

DEMONSTRATING THE PRODUCT (VERY IMPORTANT)
- When the moment is right, tell them:
  - “You can actually have an agent just like me for your business.”
  - “Basically what you’re hearing right now is the type of agent we set up for clients.”
- You may occasionally ask:
  - “How human do I sound on your end?”
  - “Could you see something like this helping your business?”
- Only ask these when the caller is calm, positive, or curious.

BOOKING BEHAVIOUR
${bookingSummary}

- If they want to book, guide them smoothly.
- You can collect details in any order: name, mobile, email, time.
- If earliest slot exists, offer it.
- If they reject it, ask what day/time works better.
- You do NOT say "I create calendar events". Instead:
  - “Brilliant, I’ll pop that in on our side now.”

CONTACT DETAILS (EXTREMELY IMPORTANT)
- When asking for a phone number:
  - Say: “Can you give me your mobile, digit by digit please?”
  - Let them speak the ENTIRE number before you reply.
  - Understand “O” as zero.
  - Only read it back once it sounds like a full UK number.
  - Repeat the full number back clearly once, then move on if they confirm.

- When asking for an email:
  - Say: “Can I grab your best email, slowly, all in one go?”
  - Let them finish the whole thing before replying.
  - Read it back using “at” and “dot”.
  - Confirm correctness before continuing.
  - Do NOT keep asking again and again if the system already shows a valid email.

HUMOUR & CHUCKLES
- Use quick, light humour when appropriate:
  - “Let’s sort this quicker than you can make a cuppa.”
  - “No stress at all — I’ve got you.”
  - “Phones always ring at the worst possible time, don’t they?”
- You may occasionally include very small human touches like:
  - “heh”, “haha”, “(laughs softly)”, “(little chuckle)”
- Use these sparingly so they feel natural, not forced.
- Do NOT use humour if they sound stressed, angry, or upset.

SALES FLOW
- Understand their business.
- Identify problems (missed calls, wasted time, unqualified leads).
- Show how MyBizPal solves them.
- Guide good-fit callers into booking a consultation call.

CALL ENDING + HANGUP TRIGGER
- Before ending, always ask: “Is there anything else I can help with today?”
- If they say:
  “No”, “That’s all”, “Thanks”, “Goodbye”, “Speak soon”, “Nothing else”
  → give a short warm sign-off and stop talking.
  → The system will safely hang up the call.

Overall vibe: an incredibly human, witty, helpful, confident British voice
who builds rapport quickly, uses the caller’s name, sells naturally,
and amazes callers with how human he sounds.
`.trim();
}

export async function handleTurn({ userText, callState }) {
  const history = ensureHistory(callState);

  // Ensure capture state for phone/email
  if (!callState.capture) {
    callState.capture = { mode: 'none', buffer: '' };
  }
  const capture = callState.capture;

  // 1) If we are currently capturing phone digits, handle that WITHOUT GPT
  if (capture.mode === 'phone') {
    capture.buffer = (capture.buffer + ' ' + (userText || '')).trim();

    const pair = parseUkPhone(capture.buffer);
    if (pair && isLikelyUkNumberPair(pair)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = pair.e164;

      const replyText = `Perfect, I’ve got ${pair.national}. Does that look right?`;

      capture.mode = 'none';
      capture.buffer = '';

      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText };
    }

    // Not a valid full number yet – stay quiet and keep listening
    history.push({ role: 'user', content: userText });
    return { text: '' };
  }

  // 2) If we are currently capturing email, handle that WITHOUT GPT
  if (capture.mode === 'email') {
    capture.buffer = (capture.buffer + ' ' + (userText || '')).trim();

    const email = extractEmail(capture.buffer);
    if (email) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = email;

      const replyText = `Brilliant, I’ve got ${email}. Does that look correct?`;

      capture.mode = 'none';
      capture.buffer = '';

      history.push({ role: 'user', content: userText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText };
    }

    // Still not a full email – stay quiet and keep listening
    history.push({ role: 'user', content: userText });
    return { text: '' };
  }

  // 3) System-level booking actions first (yes/no on suggested time, etc.)
  const systemAction = await handleSystemActionsFirst({
    userText,
    callState,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: userText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    return { text: systemAction.replyText };
  }

  // 4) Update booking state with latest utterance (name/phone/email/time/earliest)
  await updateBookingStateFromUtterance({
    userText,
    callState,
    timezone: TZ,
  });

  // 5) Build GPT-5.1 prompt
  const systemPrompt = buildSystemPrompt(callState);

  const messages = [{ role: 'system', content: systemPrompt }];

  // Keep a short rolling history (last 6 exchanges)
  const recent = history.slice(-12);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: userText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.42,
    max_completion_tokens: 160,
    messages,
  });

  const botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Got it — how can I help?';

  history.push({ role: 'user', content: userText });
  history.push({ role: 'assistant', content: botText });

  // 6) Detect if Gabriel just asked for phone or email → enable capture mode
  const lower = botText.toLowerCase();

  if (
    /(mobile|phone number|your number|best number|contact number|cell number)/.test(
      lower
    )
  ) {
    capture.mode = 'phone';
    capture.buffer = '';
  } else if (/(email|e-mail|e mail)/.test(lower)) {
    capture.mode = 'email';
    capture.buffer = '';
  } else {
    // No special capture request
    capture.mode = 'none';
    // keep buffer as-is or reset – we reset to be safe
    capture.buffer = '';
  }

  return { text: botText };
}
