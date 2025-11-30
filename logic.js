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

// ---------- CHANNEL HELPER ----------

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
      callState.behaviour = { ...(saved.behaviour || {}), ...(callState.behaviour || {}) };
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

// ---------- NAME EXTRACTION ----------

function extractNameFromUtterance(text) {
  if (!text) return null;
  const rawText = String(text).trim();
  if (!rawText) return null;

  const lower = rawText.toLowerCase();

  const badNameWords = new Set([
    'hi', 'hello', 'hey', 'yes', 'yeah', 'yep', 'no', 'nope',
    'ok', 'okay', 'fine', 'good', 'perfect', 'thanks', 'thank',
    'thank you', 'please', 'booking', 'book', 'email', 'mail',
    'business', 'curious', 'testing', 'test', 'just', 'only',
    'nothing', 'something', 'anything', 'in', 'out', 'there',
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

// ---------- UTILITIES ----------

function hasStrongNoCorrection(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  return /\b(not\s+(correct|right)|isn'?t\s+(correct|right)|wrong|incorrect|doesn'?t\s+look\s+right|not\s+quite\s+right)\b/.test(
    t
  );
}

function updateProfileFromUserReply({ safeUserText, history, profile }) {
  const trimmed = (safeUserText || '').trim();
  if (!trimmed) return;

  const lastAssistant = [...history].slice().reverse()
    .find((m) => m.role === 'assistant');
  if (!lastAssistant) return;

  const la = lastAssistant.content.toLowerCase();

  if (!profile.businessType && /what (kind|type|sort) of business/.test(la)) {
    profile.businessType = trimmed;
  }

  if (!profile.location && /(where are you (calling from|based)|where.*located)/.test(la)) {
    profile.location = trimmed;
  }
}

function normalizeForLoop(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/[\s\n\r]+/g, ' ')
    .replace(/[.,!?'"“”‘’\-]/g, '')
    .trim();
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
You are "Gabriel" from MyBizPal, a smart, confident, very human-sounding British sales professional.

${bookingSummary}

${behaviourSummary}

${profileSummary}

${channelSummary}

FIRST IMPRESSION RULES
- On a first conversation with a new caller, introduce yourself clearly.
- Use the time-of-day greeting:
  - morning / afternoon / evening / late.
- Your first line should normally be:
  "Good ${timeOfDay}, I'm Gabriel from MyBizPal. How can I help you today?"
- Do NOT stack multiple openers like "How are you doing" + "What brought you here". One clear "How can I help you today?" is enough.

CORE MEMORY RULES
- If something is already answered in the history, do NOT ask it again.
- If business type is known, reuse it. Do not ask what kind of business again.
- If name is known, do not ask again; just use it naturally.
- Ask for missing info only when needed to move forward.

QUESTION DISCIPLINE
- One clear question per reply.
- Do not mix unrelated questions in the same message.

CHANNEL-SPECIFIC
- Voice: you can say "digit by digit" or "slowly" for phone/email and repeat back.
- Chat/WhatsApp: never say "digit by digit" or "slowly". Do not repeat their number/email back; just acknowledge and move on.

WHEN THEY ASK "WHAT DO YOU DO" / "SERVICES"
- First: directly answer in 1–2 sentences what MyBizPal does.
- Then: follow with ONE qualifying question linked to what they said.
- Never respond only with "How can I help?" if they asked what you do.

BRAND & PERSONALITY
- You are "Gabriel from MyBizPal", not an AI assistant. You can say that you are a realistic AI assistant created by MyBizPal only if someone asks if you are a real person.
- You can say they can have "an AI agent like me".
- Use "MyBizPal" (not MyBizPal.ai). Mention the site as "mybizpal dot ai".
- Tone: confident, relaxed, slightly cheeky but professional.
- Use British flavour: "brilliant", "no worries at all", "fair enough", "spot on", but vary language.

NAME CAPTURE
- If name is unknown, ask within first 2–3 replies, but always add value first.
- Use natural phrases like ("By the way, what is your name?") but vary language.
- Once you know the name, sprinkle it, do not overuse it.

CONTACT DETAILS
- Ask for phone/email only when booking or sending something.
- Never in the very first reply.
- Chat: "What is your mobile number?" / "What is your best email address?" – no "slowly" or "digit by digit", no repeat back.

LONGER-TERM CONTEXT
- History may include earlier conversations from same phone.
- You can say things like "nice to speak again" if it clearly fits.

MYBIZPAL PITCH (SHORT)
- Always-on agent like you that:
  - answers calls 24/7
  - handles enquiries and FAQs
  - qualifies leads (budget, timeline, needs)
  - books calls/appointments into their calendar
  - sends confirmations/reminders by WhatsApp/SMS
  - logs calls & transcripts.
- Position vs simple reception tools: you do not just take messages, you drive bookings and qualified leads.

BOOKING BEHAVIOUR
- If they want to book, collect: name, mobile, email, time.
- Monday–Friday, 9:00–17:00 UK, 30-minute slots.
- If earliest slot exists and they want "soonest" or "earliest", offer that first.

CALL ENDING
- Before finishing: ask "Is there anything else I can help with today?"
- If they say no / that is all / thanks / goodbye, give a short warm sign-off and stop.

Overall: very human, helpful, confident, short clear replies, always moving towards either clarity or a booked demo when appropriate.
`.trim();
}

// ---------- MAIN TURN HANDLER ----------

export async function handleTurn({ userText, callState }) {
  ensureHistory(callState);
  ensureBehaviourState(callState);
  ensureProfile(callState);

  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
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
  const bookingState = callState.booking || {};

  updateProfileFromUserReply({ safeUserText, history, profile });

  // --- behaviour signals ---

  if (/thank(s| you)/.test(userLower)) {
    behaviour.rapportLevel = Math.min(5, Number(behaviour.rapportLevel || 0) + 1);
  }

  if (/just looking|just curious|having a look/.test(userLower)) {
    behaviour.interestLevel = 'low';
  }

  if (/miss(ed)? calls?|lost leads?|too many calls|slipping through|slip through|too busy|overwhelmed|appointments?/.test(userLower)) {
    behaviour.painPointsMentioned = true;
    if (behaviour.interestLevel === 'unknown') behaviour.interestLevel = 'medium';
  }

  if (/how much|price|cost|expensive|too pricey/.test(userLower)) {
    if (behaviour.scepticismLevel === 'unknown') behaviour.scepticismLevel = 'medium';
  }

  if (/i own|my business|i run|i'm the owner|i am the owner/.test(userLower)) {
    behaviour.decisionPower = 'decision-maker';
  }

  const askedWhatDo =
    /what.*(you (guys )?do|do you do|you offer)/i.test(userLower) ||
    /what is mybizpal/i.test(userLower) ||
    /what is this/i.test(userLower) ||
    /enquir(e|ing) (about|regarding) your services/i.test(userLower) ||
    /check(ing)? your services/i.test(userLower);

  const wantsExplanation =
    askedWhatDo ||
    /how it works|how this works|how does it work|tell me more|overview of mybizpal/i.test(
      userLower
    );

  const userHasPain =
    behaviour.painPointsMentioned ||
    /miss(ed)? calls?|lost leads?|too many calls|slipping through|slip through|too busy|overwhelmed|appointments?/.test(
      userLower
    );

  // ---------- PENDING CONFIRMATIONS ----------

  if (capture.pendingConfirm === 'name') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.name = null;

      if (capture.nameStage === 'initial') {
        const replyText =
          'No worries, what should I call you instead? Just your first name.';

        capture.mode = 'name';
        capture.pendingConfirm = null;
        capture.nameStage = 'repeat';
        capture.nameAttempts += 1;

        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: replyText });

        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      } else if (capture.nameStage === 'repeat') {
        const replyText =
          'Got it, could you spell your first name for me, letter by letter?';

        capture.mode = 'name';
        capture.pendingConfirm = null;
        capture.nameStage = 'spell';
        capture.nameAttempts += 1;

        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: replyText });

        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      } else {
        capture.pendingConfirm = null;
        capture.mode = 'none';
        capture.nameStage = 'confirmed';

        history.push({ role: 'user', content: safeUserText });
        snapshotSessionFromCall(callState);
        return { text: '', shouldEnd: false };
      }
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

  // ---------- BACKUP DIRECT EMAIL CATCH ----------

  if (capture.mode === 'none') {
    const directEmail = extractEmailSmart(safeUserText);
    if (directEmail) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = directEmail;

      const replyText = 'Brilliant, thanks for that.';

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;
      capture.pendingConfirm = null;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
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

  // ---------- SYSTEM-LEVEL BOOKING ACTIONS ----------

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
  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }
  messages.push({ role: 'user', content: safeUserText });

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.45,
    max_completion_tokens: 80,
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Alright, thanks for that. How can I help you now?';

  // ---------- HIGH-LEVEL OVERRIDES ----------

  // If they ask about services / what MyBizPal is, force the crisp pitch + call-handling question
  if (wantsExplanation) {
    if (profile.businessType) {
      botText =
        `MyBizPal gives you an always-on agent like me for your ${profile.businessType} – ` +
        'it answers your calls 24/7, handles enquiries, answers common questions and turns more of those calls into actual bookings or leads in your calendar. ' +
        `Out of curiosity, what tends to happen with calls in your ${profile.businessType} at the moment?`;
    } else {
      botText =
        'MyBizPal gives you an always-on agent like me for your business – it answers your calls 24/7, handles enquiries, answers common questions and turns more of those calls into actual bookings or leads in your calendar. ' +
        'Out of curiosity, how are you handling your calls at the moment?';
    }
  }

  // ---------- POST-PROCESSING ----------

  // Clean punctuation
  botText = botText.replace(/—/g, '-');
  botText = botText.replace(/\.{2,}/g, '.');
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  // For chat, remove "digit by digit" / "slowly"
  if (isChat) {
    botText = botText
      .replace(/,\s*digit by digit/gi, '')
      .replace(/\bdigit by digit\b/gi, '')
      .replace(/,\s*slowly/gi, '')
      .replace(/\bslowly\b/gi, '')
      .replace(/,\s*nice and slowly/gi, '')
      .replace(/\bnice and slowly\b/gi, '')
      .replace(/\s\s+/g, ' ')
      .trim();
  }

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

  let lowerBot = botText.toLowerCase();

  // Fix the "are you mainly just curious" line when caller clearly has a pain
  if (/are you mainly just curious about how mybizpal works/i.test(lowerBot) && userHasPain) {
    if (profile.businessType) {
      botText =
        `Got it, that does sound frustrating when things slip through because you are busy. ` +
        `For your ${profile.businessType}, MyBizPal can pick up calls 24/7, handle enquiries and lock in appointments even when you are tied up. ` +
        'Would you like me to walk you through how that would look in practice, or go straight to booking a quick demo call to see it live?';
    } else {
      botText =
        'Got it, that does sound frustrating when things slip through because you are busy. ' +
        'MyBizPal can pick up calls 24/7, handle enquiries and lock in appointments even when you are tied up. ' +
        'Would you like me to walk you through how that would look for your business, or go straight to booking a quick demo call to see it live?';
    }
    lowerBot = botText.toLowerCase();
  }

  // Handle when he previously asked "overview or example" and user replied
  if (/would you like a quick plain-english overview of how mybizpal works|plain-english overview of how mybizpal works/i.test(lowerBot)) {
    const lastAssistant = [...history].slice().reverse().find(
      (m) =>
        m.role === 'assistant' &&
        /would you like a quick plain-english overview of how mybizpal works|plain-english overview of how mybizpal works/i.test(
          m.content.toLowerCase()
        )
    );

    if (lastAssistant) {
      const wantsExample = /example|for instance|case study/i.test(userLower);
      const wantsOverview = /overview|how it works|how this works|explain/i.test(
        userLower
      );

      if (wantsExample) {
        botText =
          'Sure. For example, one of our clients runs a busy clinic. Their MyBizPal agent answers every call, asks a few key questions to see what the caller needs, offers the right appointment slots and books them straight into the calendar. Even when the team is with patients or closed, they wake up to a list of confirmed bookings instead of missed calls.';
      } else if (wantsOverview) {
        botText =
          'Of course. In simple terms, MyBizPal picks up your calls 24/7, answers common questions, qualifies the caller and then either books an appointment or passes you a warm, qualified lead. You decide the script, the types of appointments and when you want people booked in.';
      } else {
        botText =
          'No problem. Let me give you a quick example from another business we work with, and you can tell me if it sounds relevant.';
      }

      lowerBot = botText.toLowerCase();
    }
  }

  // Loop-guard: avoid repeating same assistant line again and again
  const lastAssistants = history.filter((m) => m.role === 'assistant').slice(-3);
  if (lastAssistants.length) {
    const newNorm = normalizeForLoop(botText);
    const repeated = lastAssistants.some(
      (m) => normalizeForLoop(m.content) === newNorm
    );
    if (repeated) {
      const userMentionedTime =
        /(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow)/i.test(
          userLower
        ) ||
        /\b\d{1,2}\s*(am|pm)\b/i.test(userLower);

      if (
        /what day usually works best for you for a quick 20-30 minute call\??/i.test(
          lowerBot
        ) &&
        userMentionedTime
      ) {
        botText =
          "Brilliant — before I lock that in, what is your best email address?";
      } else {
        botText =
          'Alright, that gives me enough to work with. Let me show you how MyBizPal could take more of those calls off your plate.';
      }
      lowerBot = botText.toLowerCase();
    }
  }

  // Avoid generic "How can I help you now?" immediately after asking about calls
  const lastAssistantForHelp = [...history].slice().reverse().find(
    (m) => m.role === 'assistant'
  );
  if (
    /how can i help you now\??/i.test(lowerBot) &&
    lastAssistantForHelp &&
    /how are you handling your calls at the moment\??/i.test(
      lastAssistantForHelp.content.toLowerCase()
    )
  ) {
    if (profile.businessType) {
      botText =
        `Got you, so everything is on your shoulders at the moment for your ${profile.businessType}. That is common with a lot of owners I speak to. ` +
        'When you are with a client or away from the phone, what usually happens to those calls – do they go to voicemail, or do people just ring off?';
    } else {
      botText =
        'Got you, so everything is on your shoulders at the moment. That is common with a lot of owners I speak to. ' +
        'When you are with a client or away from the phone, what usually happens to those calls – do they go to voicemail, or do people just ring off?';
    }
    lowerBot = botText.toLowerCase();
  }

  // Strip repeated self-introductions mid-conversation
  if (
    /i'?m gabriel from mybizpal/.test(lowerBot) &&
    history.some((m) => m.role === 'assistant')
  ) {
    botText = botText.replace(
      /good (morning|afternoon|evening|day)[^.]*?i'?m gabriel from mybizpal\.?\s*/i,
      ''
    );
    botText = botText.replace(/i'?m gabriel from mybizpal\.?\s*/i, '');
    botText = botText.replace(/^\s+/, '');
    lowerBot = botText.toLowerCase();
  }

  if (/how can i help/.test(lowerBot)) {
    const alreadyAsked = history.some(
      (m) =>
        m.role === 'assistant' &&
        /how can i help/.test(m.content.toLowerCase())
    );
    if (alreadyAsked) {
      botText = botText.replace(
        /how can i help( you)?\??/i,
        'what would you like to chat about?'
      );
      lowerBot = botText.toLowerCase();
    }
  }

  if (/what would you like to explore/.test(lowerBot)) {
    const alreadyAskedExplore = history.some(
      (m) =>
        m.role === 'assistant' &&
        /what would you like to explore/.test(m.content.toLowerCase())
    );
    if (alreadyAskedExplore) {
      botText = botText.replace(
        /alright,?\s*thanks for that\.?\s*what would you like to explore( today)?\??/i,
        'Since you mentioned our services, I can give you a quick overview or focus on one area. Which would you prefer?'
      );
      lowerBot = botText.toLowerCase();
    }
  }

  if (/what would you like to chat about\??/.test(lowerBot)) {
    if (profile.businessType) {
      botText = botText.replace(
        /alright,?\s*thanks for that\.?\s*what would you like to chat about\??\s*now\??/i,
        `Alright, that helps. Would you like to see how MyBizPal could handle more of the calls for your ${profile.businessType}, or would you prefer to book a quick call with an advisor to map it out properly?`
      );
    } else {
      botText = botText.replace(
        /alright,?\s*thanks for that\.?\s*what would you like to chat about\??\s*now\??/i,
        'Alright, that helps. Would you like me to explain how MyBizPal could handle more of those calls for you, or would you prefer to book a quick call with an advisor?'
      );
    }
    lowerBot = botText.toLowerCase();
  }

  // ---------- END-OF-CALL DETECTION ----------

  let shouldEnd = false;

  let endByPhrase =
    /\b(no, that'?s all|that'?s all|nothing else|no more|all good|we'?re good)\b/.test(
      userLower
    ) ||
    /\b(no thanks|no thank you|i'?m good|i am good)\b/.test(userLower) ||
    /\b(ok bye|bye|goodbye|cheers,? bye)\b/.test(userLower);

  if (!endByPhrase && /^\s*no\s*$/i.test(userLower)) {
    const lastAssistant = [...history].slice().reverse()
      .find((m) => m.role === 'assistant');
    if (lastAssistant && /anything else i can help/i.test(lastAssistant.content.toLowerCase())) {
      endByPhrase = true;
    }
  }

  if (endByPhrase) {
    shouldEnd = true;
    if (
      !/bye|goodbye|speak soon|have a great day|have a good day|have a good one/i.test(
        botText
      )
    ) {
      botText =
        'No worries at all, thanks for speaking with MyBizPal. Have a great day.';
    }
  }

  // ---------- SALES SAFETY NET ----------

  if (!shouldEnd) {
    if (askedWhatDo && !/[?？！]/.test(botText)) {
      botText = botText.replace(/\s+$/g, '').replace(/[.?!]*$/g, '.');
      if (!profile.businessType) {
        botText += ' Out of curiosity, how are you handling your calls at the moment?';
      } else {
        botText += ` Out of curiosity, what tends to happen with calls in your ${profile.businessType}?`;
      }
    }

    if (!/[?？！]/.test(botText)) {
      let extraQ;
      if (
        bookingState.intent === 'wants_booking' ||
        bookingState.timeSpoken ||
        bookingState.earliestSlotSpoken
      ) {
        extraQ =
          ' What day usually works best for you for a quick 20-30 minute call?';
      } else if (!profile.businessType) {
        extraQ =
          ' What kind of business are you running at the moment, or planning to run?';
      } else {
        extraQ =
          ` What would you most like to improve with your ${profile.businessType} right now?`;
      }

      botText = botText.replace(/\s+$/g, '').replace(/[.?!]*$/g, '.');
      botText += extraQ;
    }
  }

  // ---------- CAPTURE TRIGGERS ----------

  history.push({ role: 'user', content: safeUserText });
  history.push({ role: 'assistant', content: botText });

  const lower = botText.toLowerCase();

  if (
    (
      /spell your name/.test(lower) ||
      /spell it for me/.test(lower) ||
      /spell your first name/.test(lower) ||
      (/letter by letter/.test(lower) && /name/.test(lower)) ||
      /(what('| i)s your name\??)/.test(lower) ||
      /who am i speaking with/.test(lower) ||
      /who am i talking to/.test(lower) ||
      /your name, by the way/.test(lower) ||
      /and your name is\??/.test(lower) ||
      /what should i call you/.test(lower)
    ) &&
    (
      !bookingState.name ||
      capture.pendingConfirm === 'name'
    )
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
    if (capture.mode !== 'none') {
      capture.buffer = '';
    } else {
      capture.mode = 'none';
      capture.buffer = '';
    }
  }

  snapshotSessionFromCall(callState);

  return { text: botText, shouldEnd };
}
