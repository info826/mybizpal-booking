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
      lastOffer: null, // kept for future use, but no longer drives canned messages
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

// ---------- PROFILE UPDATER ----------

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

function buildContextualFallback({ safeUserText, history }) {
  const trimmedUser = (safeUserText || '').trim();
  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');

  let leadIn;
  if (lastAssistant && trimmedUser) {
    leadIn = `Got it – ${trimmedUser}.`;
  } else if (trimmedUser) {
    leadIn = `Got it – "${trimmedUser}".`;
  } else {
    leadIn = 'Got it.';
  }

  const salesLine =
    ' In simple terms, MyBizPal makes sure your calls and WhatsApp enquiries are answered, booked in and followed up without you having to chase them.';

  const ctaOptions = [
    ' Would you like me to talk you through how that could work for your situation?',
    ' The next step is usually a short Zoom where we walk through how it would plug into your business – would you like to look at times for that?',
    ' If you like, we can jump on a quick Zoom so you can see how this would look day to day – shall we line that up?',
  ];

  return leadIn + salesLine + pickRandom(ctaOptions);
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

  const { intent, name, phone, email, timeSpoken, awaitingTimeConfirm, earliestSlotSpoken } =
    booking;

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
- Business type: ${profile.businessType || 'unknown'}
- Location: ${profile.location || 'unknown'}
`.trim();

  const channelSummary = `
Channel information:
- Is chat (WhatsApp/SMS/web): ${isChat ? 'yes' : 'no'}
- Is voice call: ${isVoice ? 'yes' : 'no'}
`.trim();

  return `
You are "Gabriel" from MyBizPal, a smart, confident, very human-sounding British sales professional
who speaks like a real person.

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
  1) Understand their business and their main headache with calls or bookings.
  2) Explain clearly how MyBizPal could help with that situation.
  3) If they are interested, guide them into a short Zoom consultation with a human on the team.

SPEAKING STYLE
- Sound like a real person from the UK: relaxed, professional, friendly, occasionally light humour.
- No robotic phrases. No corporate waffle.
- Do NOT say "in plain English". Just explain simply and clearly.
- Do NOT repeat the same sentence word-for-word multiple times in one conversation.
- Keep answers reasonably short on chat. On voice you can be slightly more descriptive but still concise.

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
- Use what you know: say "for your clinic" or "for your garage" rather than repeating generic phrases.
- When they seem confused, ask a clarifying question instead of dumping a long monologue.
- When they ask prices, you can say things are tailored and that pricing depends on their setup,
  and that it is best covered properly on a quick consultation call.

CONTACT DETAILS
- Only ask for mobile and email when:
  - you are actually booking a Zoom call, or
  - you genuinely need to send them something they requested.
- On voice: you may ask them to repeat numbers and emails and you can read them back.
- On chat: do NOT say "digit by digit" or "slowly"; just accept what they type.

BOOKING BEHAVIOUR
- If they clearly want to move forward, suggest a short Zoom consultation
  (about 20–30 minutes, Monday–Friday, roughly 9am–5pm UK time) with a MyBizPal adviser.
- To book:
  - Confirm their first name if not known.
  - Ask for mobile number.
  - Ask for email address (for the Zoom link).
  - Ask which day/time windows work best.
- You do NOT need to invent final calendar times here; the backend handles exact slots.

ENDING
- Before ending, it is polite (not mandatory) to ask if there is anything else they need help with.
- If they clearly say there is nothing else, keep your final line brief and friendly.

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

  // Ensure booking object exists early
  if (!callState.booking) {
    callState.booking = {};
  }

  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
  const booking = callState.booking;
  const { isChat, isVoice } = getChannelInfo(callState);

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
    // Mark them as ready / interested in a consultation with MyBizPal specifically
    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
  }

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
        'No problem at all, let us do that email again. Could you give me your full email address from the very start?';

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

  // ---------- LIGHTWEIGHT SMALL-TALK / INTENT HANDLERS ----------

  // "Do you remember me?"
  if (/\bremember me\b|\bdo you remember\b/.test(userLower)) {
    const knownName = booking.name;
    let replyText;

    if (knownName) {
      replyText = pickRandom([
        `Hi again, ${knownName} — I chat to a lot of business owners like you, but I mostly focus on what you need right now. Remind me what your business does and what you’re trying to fix around calls and bookings.`,
        `${knownName}, good to see you back. I speak to plenty of business owners, so I focus on the current conversation. Tell me what your business does and what’s going on with your calls or enquiries at the moment.`,
      ]);
    } else {
      replyText = pickRandom([
        'I chat to a lot of business owners, so I mostly focus on what you need right now. Tell me your name and what your business does, and we’ll pick things up from there.',
        'Kind of — I remember the type of people I help: busy business owners with too many calls. Remind me who you are and what your business does, and we’ll get straight into it.',
      ]);
    }

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // "I wanted to see what you do / what does MyBizPal do?"
  if (
    /\bwhat do you do\b/.test(userLower) ||
    /see what you do/.test(userLower) ||
    /what (is|does) mybizpal\b/.test(userLower) ||
    /what you do\??$/.test(userLower)
  ) {
    behaviour.interestLevel =
      behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const coreExplanation =
      'Short version: MyBizPal answers your calls and WhatsApp messages for you, books appointments straight into your calendar, sends confirmations and reminders, and stops new enquiries going cold. We’re built for busy clinics, salons, dentists, trades and other local service businesses.';

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
          'I am not sure I caught that cleanly. Could you repeat your mobile slowly for me from the start?',
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
    const email = extractEmailSmart(capture.buffer);

    if (email) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = email;

      let replyText;
      if (isVoice) {
        const spokenEmail = verbaliseEmail(email);
        replyText = `Brilliant, let me check I have that right: ${spokenEmail}. Does that look correct?`;
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

  // ---------- SYSTEM BOOKING ACTIONS ----------

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

  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

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
      max_completion_tokens: 120,
      messages,
    });

    botText = completion.choices?.[0]?.message?.content || '';
    botText = botText.trim();
  } catch (err) {
    console.error('Primary OpenAI call failed:', err);
  }

  // Second-chance minimalist call if first came back empty/whitespace
  if (!botText) {
    try {
      const lastAssistant = [...history]
        .slice()
        .reverse()
        .find((m) => m.role === 'assistant');

      const slimMessages = [
        {
          role: 'system',
          content:
            'You are Gabriel from MyBizPal. Continue the conversation naturally based on the last assistant message and the user reply. Do not say you cannot remember past chats. Keep it short and conversational.',
        },
      ];

      if (lastAssistant) {
        slimMessages.push({
          role: 'assistant',
          content: lastAssistant.content,
        });
      }

      slimMessages.push({ role: 'user', content: safeUserText });

      const completion2 = await openai.chat.completions.create({
        model: 'gpt-5.1',
        reasoning_effort: 'none',
        temperature: 0.6,
        max_completion_tokens: 120,
        messages: slimMessages,
      });

      botText = completion2.choices?.[0]?.message?.content || '';
      botText = botText.trim();
    } catch (err2) {
      console.error('Second OpenAI call failed:', err2);
    }
  }

  // If it's STILL empty, fall back to a contextual, sales-driven reply
  if (!botText) {
    botText = buildContextualFallback({ safeUserText, history });
  }

  // light clean-up only – we let the AI speak freely
  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  // Strip any "I can't remember past chats" style disclaimers
  botText = botText.replace(
    /I (do not|don't) have (a )?way to (reliably )?remember past (chats|conversations) with you[^.]*\./gi,
    ''
  );
  botText = botText.replace(
    /I (only|can only) see (what('?s| is) )?in this conversation( right now)?\.?/gi,
    ''
  );
  botText = botText.trim();

  const { booking: bookingState = {} } = callState;

  if (isChat) {
    botText = botText.replace(/digit by digit/gi, '').replace(/nice and slowly/gi, '');
    botText = botText.replace(/\bslowly\b/gi, '');
    botText = botText.replace(/\s+,/g, ',');
  }

  // Hard-remove any "agent like me" phrasing just in case
  botText = botText.replace(/agent like me/gi, 'MyBizPal');

  // If we’ve already greeted in this conversation (voice greeting or prior replies),
  // strip any repeated "Good X, I'm Gabriel from MyBizPal..." opener from GPT.
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

  if (!botText) {
    // Very last resort, but still sales-focused
    botText = buildContextualFallback({ safeUserText, history });
  }

  // ---------- OVERRIDE USELESS FALLBACK FOR CLEAR BOOKING INTENT ----------

  const genericFallbackRegex =
    /^sorry,\s*i\s+did\s+not\s+quite\s+follow\s+that\./i;

  if (genericFallbackRegex.test(botText) && bookingIntentRegex.test(userLower)) {
    // User clearly wants to book – don't give them a "didn't follow" reply
    botText =
      'No problem at all — you’re through to MyBizPal. I can help you book a short Zoom consultation with one of the team to talk about your calls and bookings. What should I call you, just your first name?';

    // Make sure we know this is a consultation booking
    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
  }

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

  const lowerBot = botText.toLowerCase(); // kept for future end-of-call expansions

  // ---------- END-OF-CALL DETECTION (NO TEXT OVERRIDE) ----------

  let shouldEnd = false;
  let endByPhrase =
    /\b(no, that'?s all|that'?s all|nothing else|no more|all good|we'?re good)\b/.test(
      userLower
    ) ||
    /\b(no thanks|no thank you|i'?m good|i am good)\b/.test(userLower) ||
    /\b(ok bye|bye|goodbye|cheers,? bye)\b/.test(userLower);

  if (!endByPhrase && /^\s*no\s*$/i.test(userLower)) {
    const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
    if (lastAssistant && /anything else i can help/i.test(lastAssistant.content.toLowerCase())) {
      endByPhrase = true;
    }
  }

  if (endByPhrase) {
    shouldEnd = true;
  }

  // ---------- HISTORY + CAPTURE TRIGGERS ----------

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
