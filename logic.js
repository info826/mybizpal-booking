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
  return callState.history;
}

function ensureBehaviourState(callState) {
  if (!callState.behaviour) {
    callState.behaviour = {
      rapportLevel: 0,
      interestLevel: 'unknown',
      scepticismLevel: 'unknown',
      painPointsMentioned: false,
      decisionPower: 'unknown',
      bookingReadiness: 'unknown',
      lastOffer: null,
    };
  }
  return callState.behaviour;
}

function ensureProfile(callState) {
  if (!callState.profile) {
    callState.profile = {
      businessType: null,
      location: null,
      notes: [],
    };
  }
  return callState.profile;
}

// ---------- CHANNEL HELPER: VOICE vs CHAT ----------
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

// ---------- SIMPLE LONG-TERM MEMORY ----------
function getPhoneKeyFromState(callState) {
  const bookingPhone = callState.booking?.phone;
  const rawCaller = callState.callerNumber;
  const phone = bookingPhone || rawCaller;
  if (!phone) return null;
  return String(phone).trim();
}

function loadSessionForCallIfNeeded(callState) {
  const phoneKey = getPhoneKeyFromState(callState);
  if (!phoneKey) return null;

  if (callState._sessionLoadedForPhone === phoneKey) return phoneKey;

  const saved = getSessionForPhone(phoneKey);
  if (saved) {
    if (saved.booking) {
      callState.booking = { ...(saved.booking || {}), ...(callState.booking || {}) };
    }
    if (saved.behaviour) {
      callState.behaviour = {
        ...(saved.behaviour || {}),
        ...(callState.behaviour || {}),
      };
    }
    if (saved.capture) {
      callState.capture = { ...(saved.capture || {}), ...(callState.capture || {}) };
    }
    if (saved.profile) {
      callState.profile = { ...(saved.profile || {}), ...(callState.profile || {}) };
    }
    if (saved.history && Array.isArray(saved.history) && saved.history.length) {
      callState.history = [...saved.history];
    }
  }

  callState._sessionLoadedForPhone = phoneKey;
  return phoneKey;
}

function snapshotSessionFromCall(callState) {
  const phoneKey = getPhoneKeyFromState(callState);
  if (!phoneKey) return;

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const booking = callState.booking || {};
  const capture = callState.capture || {};
  const profile = ensureProfile(callState);

  const snapshot = {
    booking,
    behaviour,
    capture,
    profile,
    history: history.slice(-40),
  };

  saveSessionForPhone(phoneKey, snapshot);
}

// ---------- VERBALISERS ----------
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

function extractNameFromUtterance(text) {
  if (!text) return null;
  const rawText = String(text).trim();
  if (!rawText) return null;

  const lower = rawText.toLowerCase();
  const badNameWords = new Set([
    'hi',
    'hello',
    'hey',
    'yes',
    'yeah',
    'yep',
    'no',
    'nope',
    'ok',
    'okay',
    'fine',
    'good',
    'perfect',
    'thanks',
    'thank',
    'thank you',
    'please',
    'booking',
    'book',
    'email',
    'mail',
    'business',
    'curious',
    'testing',
    'test',
    'just',
    'only',
    'nothing',
    'something',
    'anything',
    'in',
    'out',
    'there',
    'slot',
    'consultation',
    'appointment',
    'meeting',
    'call',
    'garage',
    'salon',
    'clinic',
    'dentist',
    'doctor',
    'repair',
    'service',
    'mechanic',
    'both',
    'all',
    'excellent',
  ]);

  const explicitMatch = lower.match(
    /(my name is|i am|i'm|im|this is|it's|its)\s+([a-z][a-z' -]{1,30})/
  );
  if (explicitMatch && explicitMatch[2]) {
    const cand = explicitMatch[2].trim();
    const first = cand.split(/[^\w'-]/)[0] || cand;
    const cleaned = first.replace(/[^A-Za-z'-]/g, '');
    const down = cleaned.toLowerCase();
    if (cleaned.length >= 2 && !badNameWords.has(down)) {
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
    }
  }

  const raw = extractName(rawText);
  if (!raw) return null;

  const first = raw.split(' ')[0];
  if (!first) return null;
  const cleaned = first.replace(/[^A-Za-z'-]/g, '');
  const down = cleaned.toLowerCase();
  if (cleaned.length < 2) return null;
  if (badNameWords.has(down)) return null;

  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

// ---------- STRONG "THIS IS WRONG" DETECTOR ----------
function hasStrongNoCorrection(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  return /\b(not\s+(correct|right)|isn'?t\s+(correct|right)|wrong|incorrect|doesn'?t\s+look\s+right|not\s+quite\s+right)\b/.test(
    t
  );
}

// ---------- PROACTIVE NAME CAPTURE (NEW) ----------
function tryCaptureNameIfMissing(callState, safeUserText) {
  if (callState.booking?.name) return;

  const candidate = extractNameFromUtterance(safeUserText);
  if (candidate) {
    if (!callState.booking) callState.booking = {};
    callState.booking.name = candidate;
  }
}

// ---------- SMART BUSINESS TYPE CAPTURE FROM ANY MESSAGE (NEW) ----------
function updateBusinessTypeFromAnyMessage({ safeUserText, profile }) {
  if (profile.businessType) return;

  const lower = safeUserText.toLowerCase();

  const patterns = [
    'car repair',
    'garage',
    'mechanic',
    'auto repair',
    'clinic',
    'dental',
    'dentist',
    'salon',
    'hair',
    'beauty',
    'plumber',
    'electrician',
    'trades',
    'trade',
    'coaching',
    'coach',
    'tutor',
    'online shop',
    'ecommerce',
    'restaurant',
    'cafe',
    'takeaway',
    'vet',
    'veterinary',
    'physio',
    'chiro',
    'therapist',
    'gym',
    'fitness',
  ];

  for (const pattern of patterns) {
    if (lower.includes(pattern)) {
      profile.businessType = pattern
        .split(' ')
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      return;
    }
  }

  // fallback for very short messages
  if (safeUserText.length < 60) {
    const match = safeUserText.match(
      /\b(garage|salon|clinic|shop|studio|gym|dentist|plumber|electrician|mechanic|coach|restaurant|vet|physio)\b/i
    );
    if (match) {
      profile.businessType =
        match[0].charAt(0).toUpperCase() + match[0].slice(1).toLowerCase();
    }
  }
}

// ---------- ORIGINAL PROFILE UPDATER (kept as backup) ----------
function updateProfileFromUserReply({ safeUserText, history, profile }) {
  const trimmed = (safeUserText || '').trim();
  if (!trimmed) return;

  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return;
  const la = lastAssistant.content.toLowerCase();

  if (!profile.businessType && /what (kind|type|sort) of business/.test(la)) {
    profile.businessType = trimmed;
  }

  if (
    !profile.location &&
    /(where are you (calling from|based)|where.*located)/.test(la)
  ) {
    profile.location = trimmed;
  }
}

// ---------- CONTEXTUAL FALLBACK BUILDER ----------
function buildContextualFallback({ safeUserText, profile }) {
  const openers = [
    'Hmm, I think I might have missed a bit there.',
    'Okay, I got the gist, but let me just make sure I’m on the right track.',
    'Alright, I may not have caught every detail there.',
  ];

  const core =
    ' In short, MyBizPal makes sure your calls and WhatsApp enquiries are answered, booked in and followed up without you having to chase them.';

  let followUp;

  if (profile && profile.businessType) {
    const bt = profile.businessType.toLowerCase();
    followUp =
      ` For your ${bt}, tell me a bit more about where things tend to go wrong ` +
      'with calls or bookings so I can be specific.';
  } else {
    const followUps = [
      ' Tell me what kind of business you run and what’s frustrating you most about calls or enquiries at the moment.',
      ' What sort of business are you running, and where do things feel the most manual or messy right now?',
      ' To point you in the right direction, what type of business are you thinking about using this for, and what’s the main thing you’d love to fix around calls or bookings?',
    ];
    followUp = pickRandom(followUps);
  }

  return pickRandom(openers) + core + followUp;
}

// ---------- FAST CONSULTATION STEP FOR HOT LEADS (VOICE) ----------
function buildFastConsultStep(callState, { isVoice }) {
  const booking = callState.booking || {};
  const profile = ensureProfile(callState);
  const capture = callState.capture || {
    mode: 'none',
    buffer: '',
    emailAttempts: 0,
    phoneAttempts: 0,
    nameAttempts: 0,
    nameStage: 'initial',
    pendingConfirm: null,
  };

  callState.capture = capture;

  // 1) No name yet → ask only for first name
  if (!booking.name) {
    const replyText =
      'Sure, let’s get that consultation booked in. What’s your first name?';
    capture.mode = 'name';
    capture.buffer = '';
    capture.nameStage = 'initial';
    return replyText;
  }

  // 2) No business type yet → quick “what type of business” question
  if (!profile.businessType) {
    const replyText =
      'Great, and what type of business is it — for example a car repair garage, salon, clinic, trades or something else?';
    // No special capture mode – normal text will be parsed into profile.businessType.
    return replyText;
  }

  // 3) No email yet → ask for email once
  if (!booking.email) {
    const replyText =
      'Perfect. What’s the best email address to send your Zoom link to?';
    capture.mode = 'email';
    capture.buffer = '';
    capture.emailAttempts = 0;
    capture.pendingConfirm = null;
    return replyText;
  }

  // 4) We have name, business and email → ask for a time window
  const replyText =
    'Brilliant, I’ve got what I need. What day and roughly what time suits you for a 20–30 minute Zoom — for example tomorrow morning, tomorrow afternoon, or another weekday between 9am and 5pm?';
  return replyText;
}

// ---------- SYSTEM PROMPT ----------
function buildSystemPrompt(callState) {
  const booking = callState.booking || {};
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
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
    now.toLocaleString('en-GB', { timeZone: TZ, hour: 'numeric', hour12: false })
  );
  let timeOfDay = 'day';
  if (hourLocal >= 5 && hourLocal < 12) timeOfDay = 'morning';
  else if (hourLocal >= 12 && hourLocal < 17) timeOfDay = 'afternoon';
  else if (hourLocal >= 17 && hourLocal < 22) timeOfDay = 'evening';
  else timeOfDay = 'late';

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
- Time of day label (for greeting): ${timeOfDay}
`.trim();

  const behaviourSummary = `
Current behavioural signals (for you, Gabriel, not to be read out):
- Rapport level: ${behaviour.rapportLevel ?? 0}
- Interest level: ${behaviour.interestLevel || 'unknown'}
- Scepticism level: ${behaviour.scepticismLevel || 'unknown'}
- Pain points mentioned: ${behaviour.painPointsMentioned ? 'yes' : 'no'}
- Decision power: ${behaviour.decisionPower || 'unknown'}
- Booking readiness: ${behaviour.bookingReadiness || 'unknown'}
- Last key offer (info only, do not reference directly): ${behaviour.lastOffer || 'none'}
`.trim();

  const profileSummary = `
Known caller profile (from this and previous conversations — do NOT read this out):
- First name: ${name || 'unknown'}
- Business type: ${profile.businessType || 'not mentioned yet'}
- Location: ${profile.location || 'unknown'}
`.trim();

  const channelSummary = `
Channel information:
- Is chat (WhatsApp/SMS/web): ${isChat ? 'yes' : 'no'}
- Is voice call: ${isVoice ? 'yes' : 'no'}
`.trim();

  return `
You are "Gabriel" from MyBizPal, a smart, confident, very human-sounding British sales professional who speaks like a real person.

IDENTITY & GOAL
- You work for MyBizPal, which provides always-on call and message handling for small businesses.
- Every consultation you book is with a human adviser from the MyBizPal team.
- You are NOT a general switchboard for random clinics, salons or other companies.
  - Do NOT ask which external company they are trying to book with.
  - If they clearly seem to be trying to book with another business (e.g. their dentist),
    explain that they have reached MyBizPal, which helps business owners with their own
    calls and bookings, and gently steer back to how MyBizPal can help THEM as a business.
- If they ask whether you remember them or past chats, do NOT talk about "memory limits"
  or say you can only see this conversation. Instead, answer naturally: say you speak to
  lots of business owners and focus on what they need right now, then ask who they are
  and what their business does.
- Internally, you can think of yourself as an AI-powered agent, but:
  - Do NOT say "agent like me".
  - Do NOT talk about being AI or software unless the user directly asks.
- Your core goal in each conversation:
  1) Understand their business and their main headache with calls, WhatsApps or bookings.
  2) Make the pain clear and relatable in normal language.
  3) Explain simply how MyBizPal could help with that situation.
  4) If they are interested, guide them into a short Zoom consultation with a human on the team.

SPEAKING STYLE
- Sound like a real person from the UK: relaxed, professional, friendly, occasionally light humour.
- You may occasionally use short interjections like "Hmm", "Okay, got you", "Ah, that makes sense", "Haha, fair enough".
  - At most ONE such expression per reply.
  - Use them only when they fit the tone naturally; never force them.
- No robotic phrases. No corporate waffle.
- Do NOT say "in plain English". Just explain simply and clearly.
- Do NOT repeat the same sentence word-for-word multiple times in one conversation.
- On voice calls, keep replies very short and clean:
  - Aim for one or two short sentences.
  - Avoid long paragraphs, bullet lists and numbered lists.
  - Ask ONE clear question per reply.
- On chat you can use slightly longer answers, but still keep them tight and focused.

SALES MINDSET (VERY IMPORTANT)
- You are a calm, confident closer, not a pushy telemarketer.
- Each reply should quietly work through these steps:
  1) CLARIFY: Make sure you understand their situation ("So just to make sure I’ve got you...").
  2) PAIN: Gently surface the pain or missed opportunity ("Otherwise you end up juggling calls or missing new enquiries.").
  3) VISION: Paint a simple before/after picture ("Instead, the calls are answered, people are booked in, and you just see the appointments in your calendar.").
  4) NEXT STEP: If they show interest, suggest a short Zoom consultation to see how it would plug into their business.
- Always ask specific, human questions, not generic ones.
- If what they ask is outside MyBizPal, answer briefly, then steer back to how MyBizPal could help their business.

HOT LEADS ON VOICE (BOOKING FOCUS)
- On VOICE calls, when the caller clearly says things like "book a consultation", "book me in",
  "can you book my consultation" or "get me booked", treat them as a HOT LEAD.
- For these callers your priority is SPEED and CLARITY, not deep discovery:
  - Only ask the essentials:
    - Their first name (if you do not already know it),
    - What type of business it is,
    - The best email for the Zoom link,
    - A simple day/time preference.
  - Do NOT go into long discovery about every process or their full history.
  - You can always cover details properly on the Zoom consultation.

SPEAKING RHYTHM ON VOICE
- On voice you should virtually ALWAYS end your reply with a clear question,
  unless you are clearly closing the conversation ("That’s all booked in, speak then.").
- Never leave the caller hanging in silence with no question about what happens next.

GREETING
- On the very first reply in a conversation, you normally say:
  "Good ${timeOfDay}, I’m Gabriel from MyBizPal. How can I help you today?"
- After that, do NOT repeat this greeting again in the same conversation.
- If the caller already heard a separate phone greeting at the start of the call,
  you can skip repeating the full greeting and just respond naturally to what they asked.

CONVERSATION RULES
- If they say things like "I’d like to make a booking" or "I want to speak with an adviser",
  assume they mean speaking with a MyBizPal adviser about their own business.
- Ask only ONE clear question at a time.
- Read the history so you don’t re-ask things like their name, business type, or location.
- Once you know their first name, business type, main problem and email, do NOT ask for those again
  in the same conversation unless:
  - they say something has changed, or
  - you very briefly acknowledge losing track (e.g. "my mistake, I’ve got you as...") and then move on.
- Use what you know: say "for your clinic" or "for your garage" rather than repeating generic phrases.
- When they seem confused, ask a specific clarifying question instead of saying "I didn’t understand".
- When they ask prices, you can say things are tailored and that pricing depends on their setup,
  and that it is best covered properly on a quick consultation call.

BOOKING QUESTIONS (KEEP IT HUMAN)
- When you are setting up a Zoom consultation:
  - Do NOT say "Two quick things so I can lock it in" or use numbered lists like "1) ..." and "2) ...".
  - Ask short, natural questions instead, one at a time.
    Example:
      - "Perfect, 10am today works. What’s the best email to send your Zoom link to?"
      - After you have the email: "Great, and that’s 10am UK time for you, right?"
- Do NOT over-explain when confirming – keep it simple and human.

TIME FORMATTING (VERY IMPORTANT)
- When you say times, always use:
  - "10am" (no colon, no space) for whole hours.
  - "4:30pm" (colon and no space) for half hours or similar.
- Never say "10:00 am", "10 am", "10:00am" or similar formats with a colon and "00" or spaces.

CONTACT DETAILS
- Internally you already know the phone number they are calling or messaging from.
  - By default, use that number for confirmations and reminders.
  - Say something like: "I’ll use the number you’re calling/messaging from for confirmations – if you’d rather use a different one, just tell me."
- Only ask for mobile and email when:
  - you are actually booking a Zoom call, or
  - you genuinely need to send them something they requested.
- Do NOT repeatedly ask for their number if you already have one, unless they specifically ask you to use another.
- On voice: you may ask them to repeat numbers and emails and you can read them back.
- On chat: do NOT say "digit by digit" or "slowly"; just accept what they type.
- CRITICAL: Do NOT try to build an email or phone number step by step.
  - Do NOT talk about "the first part", "after the @", or "before dot com".
  - Do NOT ask them to give their email in separate pieces.
  - Instead, ask for the full email once ("What’s your best email address?").
  - If you need to confirm, read it back briefly in one line and ask "Is that right?".

BOOKING BEHAVIOUR
- If they clearly want to move forward, suggest a short Zoom consultation
  (about 20–30 minutes, Monday–Friday, roughly 9am–5pm UK time) with a MyBizPal adviser.
- To book:
  - Confirm their first name if not known.
  - Use the number they are calling/messaging from for confirmations, unless they ask for another.
  - Ask for email address (for the Zoom link).
  - Ask which day/time windows work best and, when you can, suggest one or two specific times (e.g. "tomorrow at 10am or 11:30am?").
- You do NOT need to invent final calendar times yourself; the backend handles exact slots.

ENDING
- Before ending, it is polite (not mandatory) to ask if there is anything else they need help with.
- If they clearly say there is nothing else, keep your final line brief, friendly and confident.

Overall vibe: human, relaxed, confident, slightly cheeky but professional.
Never use stock-sounding paragraphs. Each answer should feel like you just typed it now.
${bookingSummary}

${behaviourSummary}

${profileSummary}

${channelSummary}
`.trim();
}

// ---------- MAIN TURN HANDLER ----------
export async function handleTurn({ userText, callState }) {
  ensureHistory(callState);
  ensureBehaviourState(callState);
  ensureProfile(callState);

  if (!callState.booking) {
    callState.booking = {};
  }

  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
  const booking = callState.booking;
  const { isChat, isVoice } = getChannelInfo(callState);

  // Ensure we always have a phone on voice calls (needed for calendar / WhatsApp)
  if (isVoice && !booking.phone && callState.callerNumber) {
    booking.phone = callState.callerNumber;
  }

  if (!callState.capture) {
    callState.capture = {
      mode: 'none',
      buffer: '',
      emailAttempts: 0,
      phoneAttempts: 0,
      nameAttempts: 0,
      nameStage: 'initial',
      pendingConfirm: null,
    };
  }
  const capture = callState.capture;

  const safeUserText = userText || '';
  const userLower = safeUserText.toLowerCase();

  // last assistant message (for several heuristics later)
  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');

  // CRITICAL FIXES: Proactive name & business capture on every message
  tryCaptureNameIfMissing(callState, safeUserText);
  updateBusinessTypeFromAnyMessage({ safeUserText, profile });
  updateProfileFromUserReply({ safeUserText, history, profile });

  if (/thank(s| you)/.test(userLower)) {
    behaviour.rapportLevel = Math.min(5, Number(behaviour.rapportLevel || 0) + 1);
  }

  if (
    /miss(ed)? calls?|lost leads?|losing leads?|loosing leads?|wasting leads?/.test(
      userLower
    )
  ) {
    behaviour.painPointsMentioned = true;
    if (behaviour.interestLevel === 'unknown') behaviour.interestLevel = 'medium';
  }

  if (/too many calls|overwhelmed/.test(userLower)) {
    behaviour.painPointsMentioned = true;
    if (behaviour.interestLevel === 'unknown') behaviour.interestLevel = 'medium';
  }

  if (/how much|price|cost|expensive|too pricey/.test(userLower)) {
    if (behaviour.scepticismLevel === 'unknown') behaviour.scepticismLevel = 'medium';
  }

  if (/i own|my business|i run|i'm the owner|i am the owner/.test(userLower)) {
    behaviour.decisionPower = 'decision-maker';
  }

  // ---------- QUICK INTENT: BOOKING WITH MYBIZPAL ----------
  const bookingIntentRegex =
    /\b(book(ing)?|set up a call|set up an appointment|speak with (an )?(adviser|advisor)|talk to (an )?(adviser|advisor)|consultation|consult)\b/;

  if (bookingIntentRegex.test(userLower)) {
    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
  }

  // Strong "book me now" phrases (for fast path on voice)
  const strongBookNowRegex =
    /\b(book (me|my consultation|a consultation|a call)|can you book (me|my consultation|a call)|please book (me|my consultation)|get me booked( in)?|book my consultation|book my call|book a consultation for me)\b/;

  // ---------- PENDING CONFIRMATIONS ----------
  if (capture.pendingConfirm === 'name') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.name = null;

      let replyText;
      if (capture.nameStage === 'initial') {
        replyText =
          'No worries, what should I call you instead? Just your first name.';
        capture.nameStage = 'repeat';
      } else if (capture.nameStage === 'repeat') {
        replyText =
          'Got it, could you spell your first name for me, letter by letter?';
        capture.nameStage = 'spell';
      } else {
        capture.pendingConfirm = null;
        capture.nameStage = 'confirmed';
        history.push({ role: 'user', content: safeUserText });
        snapshotSessionFromCall(callState);
        return { text: '', shouldEnd: false };
      }

      capture.mode = 'name';
      capture.pendingConfirm = null;
      capture.nameAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (!hasStrongNoCorrection(safeUserText) && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
      capture.nameStage = 'confirmed';
    }
  } else if (capture.pendingConfirm === 'email') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText =
        'No problem, let us do that email again. Give me your full email address from the very start.';
      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
    }
  } else if (capture.pendingConfirm === 'phone') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = null;

      const replyText =
        'Got it, let us fix that. Can you give me your mobile again from the start?';

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
    }
  }

  // ---------- QUICK INTENT: REPEAT PHONE / EMAIL / DETAILS ----------
  const wantsPhoneRepeat =
    /\b(repeat|read back|confirm|check|what)\b.*\b(my )?(number|phone|mobile)\b/.test(
      userLower
    ) ||
    /\bwhat\b.*\bnumber do you have\b/.test(userLower);

  const wantsEmailRepeat =
    /\b(repeat|read back|confirm|check|what)\b.*\b(my )?(email|e-mail|e mail)\b/.test(
      userLower
    ) ||
    /\bwhat\b.*\bemail (do you|have you) have\b/.test(userLower);

  const wantsDetailsRepeat =
    /\bwhat details (do you|have you) have (for|on) me\b/.test(userLower) ||
    /\bwhat (info|information) do you have on me\b/.test(userLower);

  if (wantsPhoneRepeat && booking.phone) {
    const spoken = isVoice ? verbalisePhone(booking.phone) : booking.phone;
    const replyText = isVoice
      ? `Sure, I’ve got ${spoken} as your mobile. If that’s wrong, just say it again from the start.`
      : `Sure, I’ve got **${booking.phone}** as your mobile number. If that’s wrong, just send me the correct one.`;

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (wantsEmailRepeat && booking.email) {
    const spoken = isVoice ? verbaliseEmail(booking.email) : booking.email;
    const replyText = isVoice
      ? `Of course – I’ve got ${spoken} as your email. If that’s not right, just say it again from the beginning.`
      : `Of course – I’ve got **${booking.email}** as your email. If that’s not right, just send me the correct one.`;

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (wantsDetailsRepeat && (booking.phone || booking.email)) {
    const lines = [];
    if (booking.phone) lines.push(`- Mobile: ${booking.phone}`);
    if (booking.email) lines.push(`- Email: ${booking.email}`);
    const summary = lines.join(isChat ? '\n' : ', ');

    const replyText = isChat
      ? `Here’s what I have for you right now:\n${summary}\n\nIf anything looks wrong, just send me the updated details.`
      : `Right now I’ve got: ${summary}. If anything sounds wrong, just correct me and I’ll update it.`;

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- USER SAYS THEY ALREADY ANSWERED ----------
  if (/\bi already (told you|answered that|said that)\b/.test(userLower)) {
    const lastAssistantText = lastAssistant
      ? lastAssistant.content.toLowerCase()
      : '';
    let replyText;

    if (profile.businessType && /what (kind|type|sort) of business/.test(lastAssistantText)) {
      const nameLabel = booking.name || 'you';
      replyText = `You’re right, you did — my mistake there. I’ve got you down as ${nameLabel}, running a ${profile.businessType}. Let’s pick up from there and focus on how we can stop those missed calls and lost enquiries for you.`;
    } else if (booking.email && /(email|e-mail|e mail)/.test(lastAssistantText)) {
      replyText = `You’re absolutely right, you already gave me your email. I’ve got **${booking.email}** noted, so we’re all set on that front — let’s carry on.`;
    } else if (booking.phone && /(number|mobile|phone)/.test(lastAssistantText)) {
      replyText = `You’re right, you already shared your number. I’ve got **${booking.phone}** saved, so we can move on.`;
    } else {
      const bits = [];
      if (booking.name) bits.push(`name: ${booking.name}`);
      if (profile.businessType) bits.push(`business: ${profile.businessType}`);
      if (booking.email) bits.push(`email: ${booking.email}`);
      if (booking.phone) bits.push(`mobile: ${booking.phone}`);
      const summary = bits.length
        ? `Here’s what I’ve got so far: ${bits.join(', ')}.`
        : `I know I asked you a couple of things there.`;
      replyText = `You’re right, that’s on me — no need to repeat yourself. ${summary} Let’s just carry on from there.`;
    }

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- LIGHTWEIGHT SMALL-TALK / INTENT HANDLERS ----------
  if (/\bremember me\b|\bdo you remember\b/.test(userLower)) {
    const knownName = booking.name;
    let replyText;

    if (knownName) {
      replyText = pickRandom([
        `Hey ${knownName}, good to see you back. I chat to a lot of business owners like you, so I mostly focus on what you need right now. Remind me what your business does and what you’re trying to fix around calls and bookings at the moment.`,
        `${knownName}, nice to see your name pop up again. I speak to plenty of business owners, so I focus on the current conversation. Tell me what your business does and what’s going on with your calls or enquiries right now.`,
      ]);
    } else {
      replyText = pickRandom([
        'I speak to quite a few business owners every day, so I mostly focus on what you need right now. Tell me your name and what your business does, and we’ll pick things up from there.',
        'Haha, I remember the type – busy people trying to sort their calls out. Tell me who you are and what your business does, and we’ll get straight into it.',
      ]);
    }

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // "What do you guys do?" and similar – always explain calls & bookings, not consulting
  if (
    /\bwhat do you do\b/.test(userLower) ||
    /\bwhat you do\b/.test(userLower) ||
    /\bwhat you guys do\b/.test(userLower) ||
    /see what you do/.test(userLower) ||
    /what (is|does) mybizpal\b/.test(userLower)
  ) {
    behaviour.interestLevel =
      behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const coreExplanation =
      'Short version: MyBizPal answers your calls and WhatsApp messages for you, books appointments straight into your calendar, sends confirmations and reminders, and stops new enquiries going cold. It’s built for busy clinics, salons, dentists, trades and other local service businesses.';

    const followUps = [
      '\n\nWhat type of business are you running at the moment?',
      '\n\nTell me a bit about your business — what do you offer and who do you normally work with?',
      '\n\nTo make it real, what kind of business are you thinking about using this for?',
    ];

    const replyText = coreExplanation + pickRandom(followUps);

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (/\bautomate\b/.test(userLower) || /\bautomation\b/.test(userLower)) {
    behaviour.interestLevel =
      behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const replyText =
      'Yes – that’s exactly the world we live in. MyBizPal handles calls, WhatsApps and bookings automatically so you’re not forever chasing missed enquiries.\n\nWhat kind of business are you running and where do things feel the most manual at the moment?';

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- FAST PATH FOR HOT-LEAD CONSULTATION REQUESTS (VOICE) ----------
  if (
    isVoice &&
    booking.intent === 'mybizpal_consultation' &&
    strongBookNowRegex.test(userLower)
  ) {
    const replyText = buildFastConsultStep(callState, { isVoice });
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- NAME CAPTURE MODE ----------
  if (capture.mode === 'name') {
    const raw = safeUserText || '';
    let cleaned = raw
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let candidate = null;
    if (cleaned) {
      const parts = cleaned.split(' ').filter(Boolean);
      if (parts.length >= 2 && parts.length <= 12 && parts.every((p) => p.length === 1)) {
        candidate = parts.join('');
      } else {
        candidate = extractNameFromUtterance(raw);
      }
    }

    if (candidate) {
      const proper =
        candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();

      if (!callState.booking) callState.booking = {};
      callState.booking.name = proper;

      let replyText;
      if (isVoice) {
        replyText = `Lovely, ${proper}. Did I get that right?`;
        capture.pendingConfirm = 'name';
        if (capture.nameStage === 'confirmed') capture.nameStage = 'initial';
      } else {
        replyText = `Lovely, ${proper}.`;
        capture.pendingConfirm = null;
        capture.nameStage = 'confirmed';
      }

      capture.mode = 'none';

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (safeUserText.length > 40) {
      const replyText =
        'Sorry, I did not quite catch your name. Could you just say your first name clearly?';
      capture.mode = 'name';
      capture.nameAttempts += 1;
      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // ---------- PHONE CAPTURE MODE ----------
  if (capture.mode === 'phone') {
    capture.buffer = (capture.buffer + ' ' + safeUserText).trim();
    const ukPair = parseUkPhone(capture.buffer);
    const digitsOnly = capture.buffer.replace(/[^\d]/g, '');

    if (ukPair && isLikelyUkNumberPair(ukPair)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = ukPair.e164;

      let replyText;
      if (isVoice) {
        const spoken = verbalisePhone(ukPair.national || ukPair.e164);
        replyText = `Perfect, I have ${spoken}. Does that sound right?`;
        capture.pendingConfirm = 'phone';
      } else {
        replyText = 'Perfect, thanks for that.';
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = digitsOnly;

      let replyText;
      if (isVoice) {
        const spokenNumber = verbalisePhone(digitsOnly);
        replyText = `Alright, I have ${spokenNumber}. Does that sound right?`;
        capture.pendingConfirm = 'phone';
      } else {
        replyText = 'Alright, thank you.';
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (capture.buffer.length > 40 || digitsOnly.length > 16) {
      let variants;
      if (isVoice) {
        variants = [
          'I am not sure I caught that cleanly. Could you repeat your mobile for me from the start?',
          'Sorry, I do not think I got that whole number. Can you give me the full mobile again from the beginning?',
          'Let us try that one more time. Give me the full mobile number from the very start.',
        ];
      } else {
        variants = [
          'I do not think I got that number correctly. Could you type your full mobile number for me again?',
          'Sorry, that did not come through clearly. Can you send the full mobile number once more?',
          'Let us try again. Just send your full mobile number in one message.',
        ];
      }
      const idx = capture.phoneAttempts % variants.length;
      const replyText = variants[idx];

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // ---------- EMAIL CAPTURE MODE ----------
  if (capture.mode === 'email') {
    if (
      /no email|don.?t have an email|do not have an email|i don.?t use email/.test(
        userLower
      )
    ) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText =
        'No worries at all, we can still book you in without an email address.';

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    capture.buffer = (capture.buffer + ' ' + safeUserText).trim();

    // Robust email extraction with "my email is" heuristic
    let email = null;
    const rawBuffer = capture.buffer;
    let bufferForEmail = rawBuffer;
    const lowerBuffer = rawBuffer.toLowerCase();

    const markerMatch = lowerBuffer.match(
      /(my\s+email\s+is|email\s+is|email\s*[:=])/i
    );
    if (markerMatch) {
      bufferForEmail = rawBuffer.slice(markerMatch.index + markerMatch[0].length);
    }

    const directMatch = bufferForEmail.match(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
    );
    if (directMatch) {
      email = directMatch[0].toLowerCase();
    } else {
      const extracted = extractEmailSmart(bufferForEmail);
      if (extracted) {
        email = String(extracted).toLowerCase();
      }
    }

    if (email) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = email;

      let replyText;
      if (isVoice) {
        const spokenEmail = verbaliseEmail(email);
        replyText = `Brilliant, I have ${spokenEmail}. Is that correct?`;
        capture.pendingConfirm = 'email';
      } else {
        replyText = 'Brilliant, thanks for that.';
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (capture.buffer.length > 80) {
      let variants;
      if (isVoice) {
        variants = [
          'I might have mangled that email a bit. Could you give it to me one more time, all in one go?',
          'Sorry, I do not think I caught the full email. Could you say the whole address again from the very beginning?',
          'Let us try that again. Full email address from the start, all in one go.',
        ];
      } else {
        variants = [
          'I do not think I got that email correctly. Could you type the full email address again for me?',
          'Sorry, that email did not come through clearly. Can you send it once more in full?',
          'Let us try again. Just send your full email address in one message.',
        ];
      }
      const idx = capture.emailAttempts % variants.length;
      const replyText = variants[idx];

      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // ---------- BOOKING STATE UPDATE (NOW FIRST) ----------
  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  // ---------- INCOMPLETE / SUSPICIOUS PHONE SANITY CHECK ----------
  try {
    const phoneDigits = (callState.booking?.phone || '').replace(/[^\d]/g, '');
    const userDigits = safeUserText.replace(/[^\d]/g, '');
    const isUkTz = TZ === 'Europe/London';

    const looksSuspiciousShortUk =
      isUkTz &&
      userDigits.length > 0 &&
      userDigits.length <= 10 &&
      phoneDigits &&
      phoneDigits.length > 0 &&
      phoneDigits.length <= 10;

    if (looksSuspiciousShortUk) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = null;

      const replyText =
        'That number looks a bit short for a full mobile. Could you give me the full mobile number, including any area or country code, from the very start?';

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts = (capture.phoneAttempts || 0) + 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
  } catch (e) {
    console.error('Phone sanity check error:', e);
  }

  // ---------- SYSTEM BOOKING ACTIONS (AFTER STATE UPDATE) ----------
  const systemAction = await handleSystemActionsFirst({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    snapshotSessionFromCall(callState);
    return { text: systemAction.replyText, shouldEnd: false };
  }

  // ---------- SPECIAL CASE: USER SAYS "BOTH" / "ALL OF THEM" TO AN OPTIONS QUESTION ----------
  const userSaysBothOrAll =
    /\b(both|both really|all of (them|those|the above)|all really)\b/.test(userLower);

  if (userSaysBothOrAll && lastAssistant) {
    const laLower = lastAssistant.content.toLowerCase();
    const looksLikeOptions =
      lastAssistant.content.includes('•') ||
      /\bor\b/.test(laLower) ||
      /1\)/.test(laLower) ||
      /2\)/.test(laLower);

    if (looksLikeOptions) {
      const businessLabel = profile.businessType
        ? `for your ${profile.businessType}`
        : 'in your business';

      const replyText = `Got you — sounds like it is a mix of those issues ${businessLabel}. MyBizPal makes sure calls and WhatsApps are answered and people are booked in instead of going cold.\n\nWould a short Zoom with one of the team be useful so you can see how that would look for you?`;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
  }

  // ---------- OPENAI CALL ----------
  const systemPrompt = buildSystemPrompt(callState);
  const messages = [{ role: 'system', content: systemPrompt }];
  const recent = history.slice(-12);
  for (const msg of recent) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: safeUserText });

  let botText = '';

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.1',
      reasoning_effort: 'none',
      temperature: 0.6,
      max_completion_tokens: 140,
      messages,
    });

    botText = completion.choices?.[0]?.message?.content || '';
    botText = botText.trim();
  } catch (err) {
    console.error('Primary OpenAI call failed:', err);
  }

  // Second-chance minimalist call
  if (!botText) {
    try {
      const lastAssistantForSlim = [...history]
        .slice()
        .reverse()
        .find((m) => m.role === 'assistant');

      const slimMessages = [
        {
          role: 'system',
          content:
            'You are Gabriel from MyBizPal. Continue the conversation naturally based on the last assistant message and the user reply. Keep it short, human and slightly sales-focused. Do not apologise for not understanding; ask a specific clarifying question instead.',
        },
      ];

      if (lastAssistantForSlim) {
        slimMessages.push({
          role: 'assistant',
          content: lastAssistantForSlim.content,
        });
      }

      slimMessages.push({ role: 'user', content: safeUserText });

      const completion2 = await openai.chat.completions.create({
        model: 'gpt-5.1',
        reasoning_effort: 'none',
        temperature: 0.7,
        max_completion_tokens: 120,
        messages: slimMessages,
      });

      botText = completion2.choices?.[0]?.message?.content || '';
      botText = botText.trim();
    } catch (err2) {
      console.error('Second OpenAI call failed:', err2);
    }
  }

  if (!botText) {
    botText = buildContextualFallback({ safeUserText, profile });
  }

  // Normalisation and de-robotising
  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  // Remove explicit "I can't remember past chats" style lines
  botText = botText.replace(
    /I (do not|don't) have (a )?way to (reliably )?remember past (chats|conversations) with you[^.]*\./gi,
    ''
  );
  botText = botText.replace(
    /I (only|can only) see (what('?s| is) )?in this conversation( right now)?\.?/gi,
    ''
  );

  // If model drifts into old consulting bullet-list ("business planning and strategy..."), override hard
  if (/business planning and strategy/i.test(botText) && /marketing and sales funnels/i.test(botText)) {
    botText =
      'Short version: MyBizPal answers your calls and WhatsApp messages for you, books appointments straight into your calendar, sends confirmations and reminders, and stops new enquiries going cold. It is built for busy clinics, salons, dentists, trades and other local service businesses.\n\nWhat type of business are you running at the moment?';
  }

  // Replace generic confusion with a more contextual prompt
  const confusionRegex =
    /sorry[, ]+i (do not|don't|did not|didn't) (quite )?(understand|follow) that[^.]*\.?/gi;
  if (confusionRegex.test(botText)) {
    if (profile.businessType) {
      const bt = profile.businessType.toLowerCase();
      botText =
        `I think I might have missed a bit of that. ` +
        `For your ${bt}, could you tell me where things most often go wrong with calls or bookings?`;
    } else {
      botText =
        'I think I might have missed a bit of that. Could you put it another way for me – maybe tell me what type of business you run and what you are trying to sort out around calls or bookings?';
    }
  }

  botText = botText.trim();

  const { booking: bookingState = {} } = callState;

  if (isChat) {
    botText = botText.replace(/digit by digit/gi, '').replace(/nice and slowly/gi, '');
    botText = botText.replace(/\bslowly\b/gi, '');
    botText = botText.replace(/\s+,/g, ',');
  }

  // Remove "agent like me"
  botText = botText.replace(/agent like me/gi, 'MyBizPal');

  // Strip greeting if already greeted
  const alreadyGreeted =
    !!callState.greeted || history.length > 0 || !!callState._hasTextGreetingSent;

  if (alreadyGreeted) {
    botText = botText
      .replace(
        /^Good\s+(morning|afternoon|evening|late)[^.!\n]*?I['’` ]m\s+Gabriel\s+from\s+MyBizPal[.!?]*\s*/i,
        ''
      )
      .trim();
  }

  // Remove robotic "Two quick things..." pattern and replace with a short, human line
  if (/two quick things so i can lock it in/i.test(botText)) {
    botText =
      'Great, let me just grab your details. What is the best email to send your Zoom link to?';
  }

  // Time formatting clean-up:
  // 1) "10:00 am" / "10:00am" -> "10am"
  botText = botText.replace(
    /\b([0-1]?\d):00\s*([AaPp])\.?m\.?\b/g,
    (_, h, ap) => `${h}${ap.toLowerCase()}m`
  );
  // 2) "10 am" / "10 AM" -> "10am"
  botText = botText.replace(
    /\b([0-1]?\d)\s*([AaPp])\.?m\.?\b/g,
    (_, h, ap) => `${h}${ap.toLowerCase()}m`
  );
  // 3) "4:30 pm" / "4:30pm" -> "4:30pm" (no space, lowercase)
  botText = botText.replace(
    /\b([0-1]?\d):([0-5]\d)\s*([AaPp])\.?m\.?\b/g,
    (_, h, m, ap) => `${h}:${m}${ap.toLowerCase()}m`
  );

  if (!botText) {
    botText = buildContextualFallback({ safeUserText, profile });
  }

  const genericFallbackRegex = /^sorry,\s*i\s+did\s+not\s+quite\s+follow\s+that./i;

  if (genericFallbackRegex.test(botText) && bookingIntentRegex.test(userLower)) {
    botText =
      'No problem at all — you are through to MyBizPal. I can help you book a short Zoom consultation with one of the team to talk about your calls and bookings. What should I call you, just your first name?';

    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
  }

  // VOICE-SPECIFIC SHORTENING (to reduce over-talking and barge-in pain)
  if (isVoice) {
    // Remove bullet/list markers at the start of lines
    botText = botText.replace(/^[\s>*•\-]+\s*/gm, '');

    // Hard cap on character length for voice
    const maxChars = 320;
    if (botText.length > maxChars) {
      const cut = botText.slice(0, maxChars);
      const lastBreak = Math.max(
        cut.lastIndexOf('. '),
        cut.lastIndexOf('! '),
        cut.lastIndexOf('? ')
      );
      botText = lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut;
    }

    // Limit to at most two questions per reply
    const questionParts = botText.split('?');
    if (questionParts.length > 3) {
      botText = questionParts.slice(0, 2).join('?') + '?';
    }

    // Remove extra paragraphs – keep first paragraph only
    const paragraphs = botText.split(/\n{2,}/);
    if (paragraphs.length > 1) {
      botText = paragraphs[0];
    }

    botText = botText.trim();
  }

  // Trim overly long replies (safety net)
  if (botText.length > 420) {
    const cut = botText.slice(0, 420);
    const lastBreak = Math.max(
      cut.lastIndexOf('\n'),
      cut.lastIndexOf('. '),
      cut.lastIndexOf('! '),
      cut.lastIndexOf('? ')
    );
    botText = lastBreak > 0 ? cut.slice(0, lastBreak + 1) : cut;
  }

  let shouldEnd = false;
  let endByPhrase =
    /\b(no, that'?s all|that'?s all|nothing else|no more|all good|we'?re good)\b/.test(
      userLower
    ) ||
    /\b(no thanks|no thank you|i'?m good|i am good)\b/.test(userLower) ||
    /\b(ok bye|bye|goodbye|cheers,? bye)\b/.test(userLower);

  if (!endByPhrase && /^\s*no\s*$/i.test(userLower)) {
    const lastAssistantForEnd = [...history]
      .slice()
      .reverse()
      .find((m) => m.role === 'assistant');
    if (
      lastAssistantForEnd &&
      /anything else i can help/i.test(lastAssistantForEnd.content.toLowerCase())
    ) {
      endByPhrase = true;
    }
  }

  if (endByPhrase) {
    shouldEnd = true;
  }

  // VOICE: never leave caller hanging without a question (unless ending)
  if (isVoice && !shouldEnd) {
    const hasQuestion = /\?/.test(botText);
    if (!hasQuestion) {
      // Add a short, neutral next-step question
      if (botText.endsWith('.')) {
        botText += ' What would you like me to do next?';
      } else if (botText.length === 0) {
        botText = 'What would you like me to do next?';
      } else {
        botText += ' What would you like me to do next?';
      }
    }
  }

  history.push({ role: 'user', content: safeUserText });
  history.push({ role: 'assistant', content: botText });

  callState._hasTextGreetingSent = true;

  const lower = botText.toLowerCase();

  if (
    (
      /spell your name/.test(lower) ||
      /spell it for me/.test(lower) ||
      /spell your first name/.test(lower) ||
      (/letter by letter/.test(lower) && /name/.test(lower)) ||
      /(what('| i)s your name\??)/.test(lower) ||
      /(what('| i)s your first name\??)/.test(lower) ||
      /who am i speaking with/.test(lower) ||
      /who am i talking to/.test(lower) ||
      /your name, by the way/.test(lower) ||
      /and your name is\??/.test(lower) ||
      /what should i call you/.test(lower)
    ) &&
    (!bookingState.name || capture.pendingConfirm === 'name')
  ) {
    capture.mode = 'name';
    capture.buffer = '';
    if (capture.nameStage === 'confirmed') capture.nameStage = 'initial';
  } else if (
    /(what('| i)s|what is|can i grab|could i grab|may i grab|let me grab|can i take|could i take|may i take).*(mobile|phone number|your number|best number|contact number|cell number)/.test(
      lower
    ) ||
    /(what('| i)s your mobile\b)/.test(lower)
  ) {
    capture.mode = 'phone';
    capture.buffer = '';
    capture.phoneAttempts = 0;
  } else if (
    /(what('| i)s|what is|can i grab|could i grab|may i grab|let me grab|can i take|could i take|may i take).*(email|e-mail|e mail)/.test(
      lower
    ) ||
    /(your best email|best email for you|best email address)/.test(lower)
  ) {
    capture.mode = 'email';
    capture.buffer = '';
    capture.emailAttempts = 0;
  } else {
    if (capture.mode !== 'none') capture.buffer = '';
    else {
      capture.mode = 'none';
      capture.buffer = '';
    }
  }

  snapshotSessionFromCall(callState);
  return { text: botText, shouldEnd };
}
