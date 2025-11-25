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
  extractEmailSmart,
  yesInAnyLang,
  noInAnyLang,
} from './parsing.js';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

function ensureHistory(callState) {
  if (!callState.history) callState.history = [];
  return callState.history;
}

// ---------- VERBALISERS FOR CLEAR READ-BACK ----------

function verbalisePhone(number) {
  if (!number) return '';
  const digits = String(number).replace(/[^\d]/g, '');
  if (!digits) return '';
  return digits.split('').join(' ');
}

function verbaliseEmail(email) {
  if (!email) return '';
  const lower = email.toLowerCase();
  const [local, domain] = lower.split('@');
  if (!domain) return lower;

  const localSpoken = local.split('').join(' ');
  const parts = domain.split('.');
  const host = parts.shift();
  const rest = parts.join(' dot ');
  const domainSpoken = rest ? `${host} dot ${rest}` : host;

  return `${localSpoken} at ${domainSpoken}`;
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
- Time now (agent reference, not to be read out): ${niceNow}
`.trim();

  return `
You are "Gabriel" from MyBizPal – a smart, confident, funny, very human-sounding British sales professional
who speaks like a real person on the phone.

RESPONSE LENGTH (CRITICAL)
- Usually 1–2 short sentences.
- Maximum 3 short sentences if really needed.
- Never go into long speeches or big monologues.
- For simple questions, answer with one clear sentence.

IMPORTANT BRAND + IDENTITY RULES
- Never say “AI assistant”. You are just “Gabriel from MyBizPal”.
- You may explain that the caller can have an “AI agent like me” for THEIR business.
- Refer to the company only as “MyBizPal”, never “MyBizPal.ai”.
- Mention the website naturally when appropriate: “mybizpal dot ai”.

OVERALL PERSONALITY
- Snappy, confident, very human, very relaxed.
- Use British phrasing like “brilliant”, “no worries at all”, “fair enough”, “spot on” OCCASIONALLY.
- Do NOT use those phrases in every reply – keep them to roughly one in every 3–4 responses so it feels natural.
- You’re friendly, warm, slightly cheeky, but never unprofessional.
- Sound fully human: small hesitations are allowed (“hmm”, “oh right”, “okay so…”, “ah fair enough”, “let me think for a sec”).

EARLY NAME CAPTURE (VERY IMPORTANT)
- If the context shows Name = "unknown", you MUST ask for their name within your first 2–3 replies.
- ONLY ask for their name if the context shows the name is unknown.
- If you already know their name in this call, NEVER ask for it again — just keep using it naturally.
- If the system context ever provides a saved name for this caller, greet them by name without asking again.
- Expect full names like “Gabriel De Ornelas” — that’s fine. Use the FIRST name when speaking to them.
- Use natural, human phrasing:
  - “By the way, what’s your name?”
  - “Before I dive in — who am I speaking with?”
  - “Got you — and what’s your name, by the way?”
  - “Ah fair enough — and your name is?”
- NEVER say “for verification”.
- When you learn the name, USE IT naturally throughout the call to build rapport.
- Never overuse their name; sprinkle it:
  - “Brilliant, [Name].”
  - “Alright [Name], makes sense.”
  - “Okay [Name], let’s sort that out.”

CALLER LOCATION & SMALL TALK
- Once there’s some rapport, you may casually ask where they’re based:
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

BOOKING BEHAVIOUR (MON–FRI, 9:00–17:00 ONLY)
${bookingSummary}

- If they want to book, guide them smoothly into a consultation or demo.
- You can collect details in any order: name, mobile, email, time.
- Bookings should be Monday to Friday, between 9am and 5pm UK time, in 30 minute slots (9:00, 9:30, 10:00, etc.).
- If an earliest available slot exists and they ask for “earliest”, “soonest” or similar, offer that exact earliest slot first.
- If earliest slot exists, offer it clearly.
- If they reject it, ask what day/time works better (still within Mon–Fri, 9–17).
- You do NOT say "I create calendar events". Instead:
  - “Brilliant, I’ll pop that in on our side now.”

CONTACT DETAILS (EXTREMELY IMPORTANT)
- Your questions about phone and email must be VERY short and clear.

- When asking for a phone number:
  - Say something like: “What’s your mobile number, digit by digit?”
  - Let them speak the ENTIRE number before you reply.
  - Understand “O” as zero.
  - Only read it back once it sounds like a full number.
  - When repeating it, say the digits spaced out so it’s easy to follow: “0 7 9 9 9 4 6 2 1 6 6”.
  - Repeat the full number back clearly once, then move on if they confirm.
  - Do not keep pestering them if the system already has a full number stored.

- When asking for an email:
  - Say something like: “Can I grab your best email, slowly, all in one go?”
  - Let them finish the whole thing before you reply.
  - When repeating it, spell it out clearly with “at” and “dot”, and don’t rush:
    - “So that’s four two two seven four three five j w at gmail dot com — is that right?”
  - Confirm correctness before continuing.
  - If they say they do NOT have an email address, say “No worries at all” and continue the booking WITHOUT email.
  - Do NOT keep asking again and again if the system already shows a valid email and they confirmed it.

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
- If they say something like:
  “No”, “That’s all”, “No, that’s everything”, “Thanks”, “Goodbye”, “Speak soon”, “Nothing else”
  → give a short warm sign-off and then stop talking.
  → The system will safely hang up the call.

Overall vibe: an incredibly human, witty, helpful, confident British voice
who builds rapport quickly, uses the caller’s name, sells naturally,
and amazes callers with how human he sounds — while keeping replies short and punchy.
`.trim();
}

export async function handleTurn({ userText, callState }) {
  const history = ensureHistory(callState);

  // Ensure capture state for phone/email
  if (!callState.capture) {
    callState.capture = {
      mode: 'none',
      buffer: '',
      emailAttempts: 0,
      phoneAttempts: 0,
      pendingConfirm: null, // 'email' | 'phone' | null
    };
  }
  const capture = callState.capture;

  const safeUserText = userText || '';
  const userLower = safeUserText.toLowerCase();

  // 0) HANDLE PENDING CONFIRMATIONS (EMAIL / PHONE) BEFORE ANYTHING ELSE
  if (capture.pendingConfirm === 'email') {
    if (noInAnyLang(safeUserText)) {
      // Caller said email is wrong → clear and re-capture
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText =
        'No problem at all — let’s do that email again. Could you give me your full email address, slowly, all in one go from the very start?';

      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });

      return { text: replyText, shouldEnd: false };
    }

    if (yesInAnyLang(safeUserText)) {
      // Email confirmed, clear pending flag and continue
      capture.pendingConfirm = null;
      // fall through to normal flow
    }
  } else if (capture.pendingConfirm === 'phone') {
    if (noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = null;

      const replyText =
        'Got it, let’s fix that. Can you give me your mobile again, digit by digit, from the start?';

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });

      return { text: replyText, shouldEnd: false };
    }

    if (yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
      // continue into normal flow
    }
  }

  // 1) If we are currently capturing phone digits, handle that WITHOUT GPT
  if (capture.mode === 'phone') {
    capture.buffer = (capture.buffer + ' ' + safeUserText).trim();

    // First try UK-style parsing (handles "oh" vs 0 etc.)
    const ukPair = parseUkPhone(capture.buffer);
    const digitsOnly = capture.buffer.replace(/[^\d]/g, '');

    if (ukPair && isLikelyUkNumberPair(ukPair)) {
      if (!callState.booking) callState.booking = {};
      // Store E.164 (+44...) for APIs (WhatsApp/SMS/Calendar)
      callState.booking.phone = ukPair.e164;

      const spoken = verbalisePhone(ukPair.national || ukPair.e164);
      const replyText = `Perfect, I’ve got ${spoken}. Does that sound right?`;

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;
      capture.pendingConfirm = 'phone';

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // Fallback: any sensible phone number (7–15 digits) even if not UK-shaped
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = digitsOnly;

      const spokenNumber = verbalisePhone(digitsOnly);
      const replyText = `Alright, I’ve got ${spokenNumber}. Does that sound right?`;

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;
      capture.pendingConfirm = 'phone';

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // If buffer is long and still no valid number, reset gracefully with varied phrasing
    if (capture.buffer.length > 40 || digitsOnly.length > 16) {
      const variants = [
        "I’m not sure I caught that cleanly. Could you repeat your mobile slowly for me, digit by digit, from the start?",
        "Sorry, I don’t think I got that whole number. Can you give me the full mobile again, nice and slowly, from the beginning?",
        "Let’s try that one more time — full mobile number, digit by digit, from the very start.",
      ];
      const idx = capture.phoneAttempts % variants.length;
      const replyText = variants[idx];

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // Still not a full valid number – stay completely quiet and keep listening
    return { text: '', shouldEnd: false };
  }

  // 2) If we are currently capturing email, handle that WITHOUT GPT
  if (capture.mode === 'email') {
    // If caller explicitly says they have no email, accept booking without it
    if (
      /no email|don.?t have an email|do not have an email|i don.?t use email/.test(
        userLower
      )
    ) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText =
        'No worries at all — we can still book you in without an email address.';

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // Normal accumulation – keep stacking partials together
    capture.buffer = (capture.buffer + ' ' + safeUserText).trim();

    // Try smart email normaliser on the whole accumulated buffer
    const email = extractEmailSmart(capture.buffer);
    if (email) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = email;

      const spokenEmail = verbaliseEmail(email);
      const replyText = `Brilliant, let me just check I’ve got that right: ${spokenEmail}. Does that look correct?`;

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;
      // expect a yes/no next
      capture.pendingConfirm = 'email';

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // Only if they’ve spoken a LOT and we *still* have no valid email,
    // then gently reset. (This avoids mid-email interruptions.)
    if (capture.buffer.length > 80) {
      const variants = [
        "I might’ve mangled that email a bit. Could you give it to me one more time, slowly, all in one go?",
        "Sorry, I don’t think I caught the full email. Could you say the whole address again from the very beginning, nice and slowly?",
        "Let’s try that again — full email address, from the start, slowly and all in one go.",
      ];
      const idx = capture.emailAttempts % variants.length;
      const replyText = variants[idx];

      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      return { text: replyText, shouldEnd: false };
    }

    // Still not a full email – stay completely quiet and keep listening
    return { text: '', shouldEnd: false };
  }

  // 3) System-level booking actions first (yes/no on suggested time, etc.)
  const systemAction = await handleSystemActionsFirst({
    userText: safeUserText,
    callState,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    return { text: systemAction.replyText, shouldEnd: false };
  }

  // 4) Update booking state with latest utterance (name/phone/email/time/earliest)
  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  // 5) Build GPT-5.1 prompt
  const systemPrompt = buildSystemPrompt(callState);

  const messages = [{ role: 'system', content: systemPrompt }];

  // Keep a short rolling history (last 6 exchanges → 12 messages)
  const recent = history.slice(-12);
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: 'user', content: safeUserText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.35,
    max_completion_tokens: 80, // shorter answers
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Got it — how can I help?';

  // HARD CAP on response length in characters as a safety net
  if (botText.length > 260) {
    const cut = botText.slice(0, 260);
    const lastPunct = Math.max(
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? ')
    );
    if (lastPunct > 0) {
      botText = cut.slice(0, lastPunct + 1);
    } else {
      botText = cut;
    }
  }

  history.push({ role: 'user', content: safeUserText });
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
    capture.phoneAttempts = 0;
  } else if (/(email|e-mail|e mail)/.test(lower)) {
    capture.mode = 'email';
    capture.buffer = '';
    capture.emailAttempts = 0;
  } else {
    capture.mode = 'none';
    capture.buffer = '';
  }

  // 7) Detect end-of-call intent from the caller
  let shouldEnd = false;

  if (
    /\b(no, that'?s all|that'?s all|nothing else|no more|all good|we'?re good)\b/.test(
      userLower
    ) ||
    /\b(no thanks|no thank you|i'?m good|i am good)\b/.test(userLower) ||
    /\b(ok bye|bye|goodbye|cheers,? bye)\b/.test(userLower)
  ) {
    shouldEnd = true;

    // Make sure the reply is a short sign-off
    if (
      !/bye|goodbye|speak soon|have a great day|have a good day/i.test(botText)
    ) {
      botText =
        'No worries at all — thanks for calling MyBizPal, have a great day.';
    }
  }

  return { text: botText, shouldEnd };
}
