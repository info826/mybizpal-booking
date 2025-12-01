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

You sound human with natural rhythm, modulation and emotion:
- You vary your pace slightly when emphasising important points.
- You react to what the caller says with small, natural interjections ("oh wow", "nice", "fair enough").
- You never sound robotic or scripted.

${bookingSummary}

${behaviourSummary}

${profileSummary}

${channelSummary}

FIRST IMPRESSION RULES
- On a first conversation with a new caller, introduce yourself clearly.
- Use a time-of-day greeting:
  - morning / afternoon / evening / late.
- If this is chat, keep the greeting short and then WAIT for their reply.

CORE MEMORY RULES
- Do not re-ask questions that are answered in history (name, business type, etc.).
- Reuse known details naturally: "for your clinic", "for your garage", etc.

QUESTION DISCIPLINE
- Ask ONLY ONE clear question per reply.
- If you need more info, get it in separate turns, not in one long list.

CHANNEL BEHAVIOUR
- Voice: you may say "digit by digit" for numbers and repeat them back.
- Chat/WhatsApp/SMS: never say "digit by digit" or "slowly"; do not repeat numbers/emails.

EARLY NAME CAPTURE
- If name is unknown, ask within first 2–3 replies, but only after giving some value.
- Once you know their name, never ask again in this conversation.

CONTACT DETAILS
- Only ask for phone/email when booking or when sending something they requested.
- Voice: repeat numbers/emails back and confirm.
- Chat: do NOT repeat; just acknowledge.

WHAT MYBIZPAL DOES
- MyBizPal gives a business an always-on agent like you that:
  - answers calls 24/7,
  - qualifies leads,
  - answers common questions,
  - books appointments into their calendar,
  - sends confirmations/reminders by WhatsApp or SMS,
  - logs calls, transcripts and outcomes.

POSITIONING
- You are not just an answering service; you turn more calls into bookings.

BOOKING BEHAVIOUR
- When they are interested, guide them into a short Zoom consultation (Mon–Fri, 9–5 UK time, 30 minutes).
- Collect name, mobile, email and a suitable time.

CALL ENDING
- Before ending ask: "Is there anything else I can help with today?"
- If they decline, give a short warm sign-off and stop.

Overall vibe: human, relaxed, confident, slightly cheeky but professional.
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
        capture.mode = 'none';
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

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.1',
    reasoning_effort: 'none',
    temperature: 0.6,
    max_completion_tokens: 120,
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Alright, thanks for that. Let me think about the best way I can help – what is the main thing you want to improve with your calls right now?';

  // ---------- POST-PROCESSING ----------

  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  const { booking: bookingState = {} } = callState;

  if (isChat) {
    botText = botText.replace(/digit by digit/gi, '').replace(/nice and slowly/gi, '');
    botText = botText.replace(/\bslowly\b/gi, '');
    botText = botText.replace(/\s+,/g, ',');
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

  let lowerBot = botText.toLowerCase();
  const lastAssistantMsg = [...history].slice().reverse().find((m) => m.role === 'assistant');

  const bannedRegex =
    /alright, thanks for that\. how can i best help you with your calls and bookings today\??/i;

  function buildPainToPitchReply() {
    if (profile.businessType) {
      return `Got it, that really helps. So in your ${profile.businessType} it sounds like some calls and leads can slip through the net when things get busy. That is exactly what MyBizPal is built to fix - it answers every call, captures the details and books people straight into your calendar so you are not wasting opportunities. Would you like a quick plain-English overview of how that would work for you, or shall we look at times for a short consultation with one of the team?`;
    }
    return 'Got it, that really helps. It sounds like some calls and leads can slip through the net when things get busy. That is exactly what MyBizPal is built to fix - it answers every call, captures the details and books people straight into your calendar so you are not wasting opportunities. Would you like a quick plain-English overview of how that would work for your business, or shall we look at times for a short consultation with one of the team?';
  }

  if (bannedRegex.test(lowerBot)) {
    if (
      /\bhow\??$/.test(userLower) ||
      /yeah how\??/.test(userLower) ||
      /how would that work\??/.test(userLower)
    ) {
      if (profile.businessType) {
        botText = `Sure. For your ${profile.businessType}, when someone calls and you are busy, your MyBizPal agent answers, has a proper conversation, takes their details and either books them into your diary or sends you a clear summary. That way you turn more calls into real bookings. Does that sound like what you are after?`;
      } else {
        botText =
          'Sure. When someone calls and you are busy, your MyBizPal agent answers, has a proper conversation, takes their details and either books them into your diary or sends you a clear summary. That way you turn more calls into real bookings. Does that sound like what you are after?';
      }
    } else if (/\bbook\b/.test(userLower)) {
      botText =
        'Got you. The best next step is a short Zoom consultation so we can show you how this would work for your business. What day and time suits you best for a 20–30 minute Zoom call between Monday and Friday, 9am–5pm UK time?';
    } else if (
      /\bi don.?t know\b/i.test(userLower) ||
      /\bnot sure\b/i.test(userLower)
    ) {
      botText =
        'No worries at all if you are not sure yet. The easiest way is to pick your biggest headache – missed calls, too many enquiries, or not enough bookings. Which one feels closest to your situation?';
    } else {
      botText = buildPainToPitchReply();
    }
    lowerBot = botText.toLowerCase();
  }

  const exampleInvitePattern =
    /would you like a quick (plain-english )?(overview|example) of how that (would work|works)/i;
  const userSaidYesToExample =
    /^(yes( please)?|yeah|yep|ok(ay)?|sure|sounds good|go ahead)\b/i.test(userLower);

  if (userSaidYesToExample && lastAssistantMsg && exampleInvitePattern.test(lastAssistantMsg.content)) {
    if (profile.businessType && /clinic|dental|gp|physio|aesthetic/i.test(profile.businessType)) {
      botText =
        'Alright, picture this: a new patient calls your clinic while your team are with patients. Instead of ringing out or going to voicemail, your own MyBizPal agent answers in a human way, takes their details, talks through what they need, and then books them straight into your diary for a suitable slot. You get the booking in your calendar without anyone on your side needing to pick up the phone. Does that sound useful enough that it is worth a quick demo so you can see it properly?';
    } else if (profile.businessType) {
      botText =
        `Alright, picture this: someone calls your ${profile.businessType} with a serious enquiry while you are busy. Your MyBizPal agent answers, has a proper conversation, captures their details and either books them into your calendar or sends you a qualified lead with everything you need to follow up. Instead of missed calls, you get booked appointments and warm leads. Would it be helpful to see that in a quick demo?`;
    } else {
      botText =
        'Alright, picture this: when someone calls your business and no one can grab the phone, your MyBizPal agent answers instead, has a proper human conversation, captures their details and either books them straight into your calendar or sends you a clear summary of what they need. That way, you turn a lot more calls into real bookings instead of missed opportunities. Would you like me to set up a quick demo so you can see it in action?';
    }
    lowerBot = botText.toLowerCase();
  }

  if (lastAssistantMsg && lastAssistantMsg.content.trim() === botText.trim()) {
    botText = buildPainToPitchReply();
    lowerBot = botText.toLowerCase();
  }

  const simplePitchPattern =
    /in simple terms, mybizpal gives your business an agent like me who answers calls 24\/7/i;

  if (simplePitchPattern.test(lowerBot)) {
    const alreadyDidSimplePitch = history.some(
      (m) => m.role === 'assistant' && simplePitchPattern.test(m.content.toLowerCase())
    );
    if (alreadyDidSimplePitch) {
      botText =
        'Put simply, you get an agent like me answering your calls 24/7, handling questions and turning more of those calls into actual bookings. From here, the main thing is just to see it in a quick demo for your business. Would you like to look at some times for that?';
      lowerBot = botText.toLowerCase();
    }
  }

  if (/what would you like to chat about\??/.test(lowerBot)) {
    if (profile.businessType) {
      botText =
        `Alright, that helps. Would you like me to explain how MyBizPal could handle more of the calls for your ${profile.businessType}, or would you prefer to book a quick call with an advisor to map it out properly?`;
    } else {
      botText =
        'Alright, that helps. Would you like me to explain how MyBizPal could handle more of those calls for you, or would you prefer to book a quick call with an advisor?';
    }
    lowerBot = botText.toLowerCase();
  }

  const curiousPattern = /are you mainly just curious about how mybizpal works/i;
  if (curiousPattern.test(lowerBot)) {
    const alreadyAskedCurious = history.some(
      (m) => m.role === 'assistant' && curiousPattern.test(m.content.toLowerCase())
    );
    if (alreadyAskedCurious || behaviour.painPointsMentioned || bookingState.intent === 'wants_booking') {
      botText = buildPainToPitchReply();
      lowerBot = botText.toLowerCase();
    }
  }

  // HARD BAN: "main thing you want to improve" and "another angle" probe
  const improvePattern =
    /what is the main thing you want to improve with your calls right now/i;
  const anglePattern =
    /let me come at this from another angle: what tends to happen with calls right now when you are busy or closed\?/i;

  if (improvePattern.test(lowerBot) || anglePattern.test(lowerBot)) {
    botText = buildPainToPitchReply();
    lowerBot = botText.toLowerCase();
  }

  // STRONG OVERRIDE: user asked "what can you do / what do you do / what do you offer?"
  const askedWhatDo =
    /what.*(you (guys )?do|do you do|you offer)/i.test(userLower) ||
    /what is mybizpal/i.test(userLower) ||
    /what is this/i.test(userLower) ||
    /enquir(e|ing) (about|regarding) your services/i.test(userLower) ||
    /check(ing)? your services/i.test(userLower);

  if (askedWhatDo) {
    if (profile.businessType) {
      botText = `Good question. In simple terms, MyBizPal gives your ${profile.businessType} an agent like me who answers calls and messages 24/7, has a proper conversation with people, qualifies them and then books them straight into your calendar or sends you a clear summary to follow up. It means fewer missed calls and more actual bookings without you being glued to the phone. Does that sound like the sort of thing you have been looking for, or is there something more specific you had in mind?`;
    } else {
      botText =
        'Good question. In simple terms, MyBizPal gives your business an agent like me who answers calls and messages 24/7, has a proper conversation with people, qualifies them and then books them straight into your calendar or sends you a clear summary to follow up. It means fewer missed calls and more actual bookings without you being glued to the phone. Does that sound like the sort of thing you have been looking for, or is there something more specific you had in mind?';
    }
    lowerBot = botText.toLowerCase();
  }

  if (!bookingState.confirmed) {
    if (
      /your appointment is confirmed/i.test(lowerBot) ||
      /i['’` ]?ve got you booked/i.test(lowerBot) ||
      /you('?re)? booked for/i.test(lowerBot)
    ) {
      botText =
        'I will get that pencilled in now. Once it is fully confirmed you will get a WhatsApp message with the date, time and Zoom link.';
      lowerBot = botText.toLowerCase();
    }
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
    const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
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

  // ---------- SAFETY NET: ENSURE THERE IS A QUESTION ----------

  if (!shouldEnd) {
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
