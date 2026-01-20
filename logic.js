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

// Debug logging (keeps existing logs but avoids expensive JSON.stringify in production)
const DEBUG_LOG = process.env.DEBUG_LOG === '1';

// Model selection (lets you swap to a faster model without code edits)
const MODEL_VOICE = process.env.MYBIZPAL_MODEL_VOICE || 'gpt-5.1';
const MODEL_CHAT = process.env.MYBIZPAL_MODEL_CHAT || 'gpt-5.1';

// Optional: disable rule-based fast replies (for testing)
const DISABLE_RULE_BASED = process.env.MYBIZPAL_DISABLE_RULE_BASED === '1';

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

// ---------- FLOW / LOOP GUARD (NEW) ----------
function ensureFlowState(callState) {
  if (!callState.flow) {
    callState.flow = {
      stage: 'discovery', // discovery | offer_zoom | collect_contact | pick_time | confirm_booking | done
      lastAssistantNorm: null,
      lastAssistantAt: 0,
      repeatCount: 0,
      lastQuestionTag: null,
    };
  }
  return callState.flow;
}

function normForRepeat(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^\w\s?]/g, '')
    .trim();
}

function registerAssistantForLoopGuard(callState, text, tag = null) {
  const flow = ensureFlowState(callState);
  const now = Date.now();
  const norm = normForRepeat(text);

  if (flow.lastAssistantNorm && norm && flow.lastAssistantNorm === norm && now - flow.lastAssistantAt < 60000) {
    flow.repeatCount = (flow.repeatCount || 0) + 1;
  } else {
    flow.repeatCount = 0;
  }

  flow.lastAssistantNorm = norm;
  flow.lastAssistantAt = now;
  if (tag) flow.lastQuestionTag = tag;
}

function wouldRepeat(callState, text) {
  const flow = ensureFlowState(callState);
  const now = Date.now();
  const norm = normForRepeat(text);
  if (!norm || !flow.lastAssistantNorm) return false;
  if (norm !== flow.lastAssistantNorm) return false;
  // within 60s and already repeated at least once -> block
  return now - flow.lastAssistantAt < 60000 && (flow.repeatCount || 0) >= 1;
}

function lastAssistantOfferedZoom(lastAssistantText) {
  if (!lastAssistantText) return false;
  const t = String(lastAssistantText).toLowerCase();
  return (
    /\bzoom\b/.test(t) &&
    (/\bquick\b/.test(t) || /\bshort\b/.test(t) || /\bwith one of the team\b/.test(t) || /\bsee how\b/.test(t))
  );
}

function isCleanYes(text) {
  if (!text) return false;
  // avoid treating corrections as yes
  if (hasStrongNoCorrection(text)) return false;
  return yesInAnyLang(text);
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
    if (saved.flow) {
      callState.flow = { ...(saved.flow || {}), ...(callState.flow || {}) };
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
  const flow = ensureFlowState(callState);

  const snapshot = {
    booking,
    behaviour,
    capture,
    profile,
    flow,
    history: history.slice(-40),
  };

  saveSessionForPhone(phoneKey, snapshot);
}

// Ensure the latest user utterance is persisted (fixes missing user turns in history on the main path)
function ensureLastUserInHistory(history, safeUserText) {
  if (!safeUserText) return;
  const last = history[history.length - 1];
  if (!last || last.role !== 'user' || last.content !== safeUserText) {
    history.push({ role: 'user', content: safeUserText });
  }
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
    // NEW: stop “Correct / Right / Exactly” being captured as a name
    'correct',
    'right',
    'exactly',
    'affirmative',
    'sure',
    'certainly',
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

// ---------- CONTEXTUAL FALLBACK BUILDER (UPDATED: no “safe generic”, always a productive next step) ----------
function buildContextualFallback({ safeUserText, profile, callState }) {
  const flow = ensureFlowState(callState);

  // keep it action-oriented and stage-aware
  if (flow.stage === 'offer_zoom') {
    return 'Got it. Do you want me to book a quick Zoom so you can see it working, or do you just want a quick summary first?';
  }

  if (flow.stage === 'collect_contact') {
    return 'Perfect. What’s the best email to send the calendar invite and Zoom link to?';
  }

  if (flow.stage === 'pick_time') {
    return 'Nice. What day and roughly what time suits you for a 20–30 minute Zoom - tomorrow morning, tomorrow afternoon, or another weekday 9am to 5pm?';
  }

  if (profile && profile.businessType) {
    const bt = profile.businessType.toLowerCase();
    return `For your ${bt}, what’s the biggest issue right now - missed calls, slow replies on WhatsApp, or bookings not getting confirmed?`;
  }

  return 'What type of business is it, and what’s the main headache you want to fix - missed calls, slow replies, or messy bookings?';
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

// ---------- SPEED: COMPACT SYSTEM PROMPTS ----------
function buildCompactContext(callState) {
  const booking = callState.booking || {};
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
  const { isChat, isVoice } = getChannelInfo(callState);
  const flow = ensureFlowState(callState);

  return {
    isChat,
    isVoice,
    flow: {
      stage: flow.stage || 'discovery',
      lastQuestionTag: flow.lastQuestionTag || 'none',
    },
    booking: {
      intent: booking.intent || 'none',
      name: booking.name || 'unknown',
      phone: booking.phone || 'unknown',
      email: booking.email || 'unknown',
      timeSpoken: booking.timeSpoken || 'none',
      awaitingTimeConfirm: booking.awaitingTimeConfirm ? 'yes' : 'no',
      earliestSlotSpoken: booking.earliestSlotSpoken || 'none',
    },
    behaviour: {
      rapportLevel: behaviour.rapportLevel ?? 0,
      interestLevel: behaviour.interestLevel || 'unknown',
      scepticismLevel: behaviour.scepticismLevel || 'unknown',
      painPointsMentioned: behaviour.painPointsMentioned ? 'yes' : 'no',
      decisionPower: behaviour.decisionPower || 'unknown',
      bookingReadiness: behaviour.bookingReadiness || 'unknown',
    },
    profile: {
      businessType: profile.businessType || 'not mentioned',
      location: profile.location || 'unknown',
    },
  };
}

function buildSystemPromptVoice(callState) {
  const ctx = buildCompactContext(callState);
  return `
You are Gabriel from MyBizPal. Sound like a real UK person: calm, friendly, confident.
DO NOT mention being AI unless asked.
Voice rules (critical):
- Keep replies to 1–2 short sentences.
- Ask ONE clear question.
- No long explanations unless the user asks.
Goal:
- Understand their business + main headache with calls/WhatsApp/bookings.
- If they want to proceed, book a short Zoom with a human adviser.
Flow context (for you only):
stage=${ctx.flow.stage}; lastQuestion=${ctx.flow.lastQuestionTag}.
Booking context (for you only):
intent=${ctx.booking.intent}; name=${ctx.booking.name}; phone=${ctx.booking.phone}; email=${ctx.booking.email}; time=${ctx.booking.timeSpoken}; awaitingConfirm=${ctx.booking.awaitingTimeConfirm}; earliest=${ctx.booking.earliestSlotSpoken}.
Profile (for you only):
businessType=${ctx.profile.businessType}; location=${ctx.profile.location}.
`.trim();
}

function buildSystemPromptChat(callState) {
  const ctx = buildCompactContext(callState);
  return `
You are Gabriel from MyBizPal. Human-sounding UK tone. No corporate waffle.
Do NOT mention being AI unless asked.
Chat rules:
- Keep it tight, helpful, slightly sales-focused.
- Ask one clear question at a time.
Goal:
- Understand their business + main headache with calls/WhatsApp/bookings.
- If they want to proceed, offer a short Zoom with a human adviser.
Flow context (for you only):
stage=${ctx.flow.stage}; lastQuestion=${ctx.flow.lastQuestionTag}.
Booking context (for you only):
intent=${ctx.booking.intent}; name=${ctx.booking.name}; phone=${ctx.booking.phone}; email=${ctx.booking.email}; time=${ctx.booking.timeSpoken}; awaitingConfirm=${ctx.booking.awaitingTimeConfirm}; earliest=${ctx.booking.earliestSlotSpoken}.
Profile (for you only):
businessType=${ctx.profile.businessType}; location=${ctx.profile.location}.
`.trim();
}

// ---------- VOICE BREVITY ENFORCER (HARD GUARD) ----------
function enforceVoiceBrevity(text) {
  if (!text) return text;

  let t = String(text).trim();

  // remove excessive whitespace/newlines
  t = t.replace(/\s+/g, ' ').trim();

  // split into sentences (simple heuristic)
  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (parts.length <= 2) {
    // still ensure there's a question at the end if possible
    if (!/[?]$/.test(t)) {
      // if any sentence contains ?, keep last question sentence
      const q = parts.find((s) => s.includes('?'));
      if (q) return q.trim();
    }
    return t;
  }

  // Prefer: first sentence + last question sentence (or second sentence).
  const first = parts[0].trim();
  const lastQuestion = [...parts].reverse().find((s) => s.includes('?'));
  let second = '';

  if (lastQuestion) {
    // avoid repeating the first sentence if the lastQuestion is basically the same
    second = lastQuestion.trim();
    if (second === first) {
      second = (parts[1] || '').trim();
    }
  } else {
    second = (parts[1] || '').trim();
    // ensure it ends with a question
    if (second && !second.includes('?')) {
      second = second.replace(/[.!]+$/, '').trim() + '?';
    }
  }

  const out = [first, second].filter(Boolean).join(' ');
  return out.trim();
}

// ---------- OPENAI CALL WITH TIMEOUT ----------
async function callOpenAIWithTimeout({ model, messages, maxTokens, temperature, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const completion = await openai.chat.completions.create(
      {
        model,
        reasoning_effort: 'none',
        temperature,
        max_completion_tokens: maxTokens,
        messages,
      },
      { signal: controller.signal }
    );

    const content = completion.choices?.[0]?.message?.content || '';
    return String(content).trim();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- MAIN TURN HANDLER ----------
export async function handleTurn({ userText, callState }) {
  let botText = '';
  let summaryText = '';

  try {
    // we don't put logic here
  } catch (err) {
    botText = 'Sorry something went wrong';
    return { text: botText, shouldEnd: false };
  }

  ensureHistory(callState);
  ensureBehaviourState(callState);
  ensureProfile(callState);
  ensureFlowState(callState);

  if (!callState.booking) {
    callState.booking = {};
  }

  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
  const booking = callState.booking;
  const flow = ensureFlowState(callState);
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
  const isFirstTurn = history.length === 0;

  // last assistant message (for several heuristics later)
  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
  const lastAssistantText = lastAssistant ? lastAssistant.content : '';

  // CRITICAL FIXES: Proactive name & business capture on every message
  // BUT: do NOT auto-grab name on the very first VOICE message – it can be noisy ("I'm Ra...") and cause early jumps.
  if (!(isVoice && isFirstTurn)) {
    tryCaptureNameIfMissing(callState, safeUserText);
  }
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

  // ---------- LOOP FIX: if last message was a Zoom offer and user says YES, progress immediately (NEW) ----------
  if (lastAssistantOfferedZoom(lastAssistantText) && isCleanYes(safeUserText)) {
    booking.intent = 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown' || behaviour.bookingReadiness === 'medium') {
      behaviour.bookingReadiness = 'high';
    }
    if (behaviour.interestLevel === 'unknown') behaviour.interestLevel = 'high';
    flow.stage = 'collect_contact';

    const replyText = buildFastConsultStep(callState, { isVoice });

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- QUICK INTENT: BOOKING WITH MYBIZPAL ----------
  const earlyBookingRegex =
    /\b(book you in|get you booked|lock that in|lock it in|i can book you|let me get you booked|schedule (a )?(call|consultation|meeting))\b/;

  const bookingIntentRegex =
    /\b(book(ing)?|set up a call|set up an appointment|speak with (an )?(adviser|advisor)|talk to (an )?(adviser|advisor)|consultation|consult)\b/;

  if (bookingIntentRegex.test(userLower) || earlyBookingRegex.test(userLower)) {
    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
    flow.stage = flow.stage === 'discovery' ? 'collect_contact' : flow.stage;
  }

  // Strong "book me now" phrases (for fast path on voice)
  const strongBookNowRegex =
    /\b(book (me|my consultation|a consultation|a call)|can you book (me|my consultation|a call)|please book (me|my consultation)|get me booked( in)?|book my consultation|book my call|book a consultation for me|book (a )?(discovery|strategy|demo) call)\b/;

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
      }

      capture.mode = 'name';
      capture.pendingConfirm = null;
      capture.nameAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'name_confirm');
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
      registerAssistantForLoopGuard(callState, replyText, 'email_retry');
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
      registerAssistantForLoopGuard(callState, replyText, 'phone_retry');
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
    registerAssistantForLoopGuard(callState, replyText, 'repeat_phone');
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
    registerAssistantForLoopGuard(callState, replyText, 'repeat_email');
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
    registerAssistantForLoopGuard(callState, replyText, 'repeat_details');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- USER SAYS THEY ALREADY ANSWERED ----------
  if (/\bi already (told you|answered that|said that)\b/.test(userLower)) {
    const lastAssistantTextLower = lastAssistant
      ? lastAssistant.content.toLowerCase()
      : '';
    let replyText;

    if (profile.businessType && /what (kind|type|sort) of business/.test(lastAssistantTextLower)) {
      const nameLabel = booking.name || 'you';
      replyText = `You’re right, you did — my mistake there. I’ve got you down as ${nameLabel}, running a ${profile.businessType}. Let’s pick up from there and focus on how we can stop those missed calls and lost enquiries for you.`;
    } else if (booking.email && /(email|e-mail|e mail)/.test(lastAssistantTextLower)) {
      replyText = `You’re absolutely right, you already gave me your email. I’ve got **${booking.email}** noted, so we’re all set on that front — let’s carry on.`;
    } else if (booking.phone && /(number|mobile|phone)/.test(lastAssistantTextLower)) {
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
    registerAssistantForLoopGuard(callState, replyText, 'already_answered');
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
    registerAssistantForLoopGuard(callState, replyText, 'remember_me');
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
      'Short version: MyBizPal answers your calls and WhatsApp messages for you, handles discovery calls and basic sales conversations, books appointments straight into your calendar, sends confirmations and reminders, and stops new enquiries going cold. It’s built for busy clinics, salons, dentists, trades and other local service businesses.';

    const followUps = [
      '\n\nWhat type of business are you running at the moment?',
      '\n\nTell me a bit about your business — what do you offer and who do you normally work with?',
      '\n\nTo make it real, what kind of business are you thinking about using this for?',
    ];

    const replyText = coreExplanation + pickRandom(followUps);

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'what_do_you_do');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (/\bautomate\b/.test(userLower) || /\bautomation\b/.test(userLower)) {
    behaviour.interestLevel =
      behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const replyText =
      'Yes – that’s exactly the world we live in. MyBizPal handles calls, WhatsApps, discovery calls and bookings automatically so you’re not forever chasing missed enquiries.\n\nWhat kind of business are you running and where do things feel the most manual at the moment?';

    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'automation');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- FAST PATH FOR HOT-LEAD CONSULTATION REQUESTS (VOICE) ----------
  if (
    isVoice &&
    booking.intent === 'mybizpal_consultation' &&
    strongBookNowRegex.test(userLower) &&
    history.some((m) => m.role === 'assistant')
  ) {
    flow.stage = 'collect_contact';
    const replyText = buildFastConsultStep(callState, { isVoice });
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
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
      registerAssistantForLoopGuard(callState, replyText, 'name');
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
      registerAssistantForLoopGuard(callState, replyText, 'name_retry');
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
      registerAssistantForLoopGuard(callState, replyText, 'phone');
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
      registerAssistantForLoopGuard(callState, replyText, 'phone');
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
      registerAssistantForLoopGuard(callState, replyText, 'phone_retry');
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
      registerAssistantForLoopGuard(callState, replyText, 'email_none');
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
      registerAssistantForLoopGuard(callState, replyText, 'email');
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
      registerAssistantForLoopGuard(callState, replyText, 'email_retry');
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

  if (DEBUG_LOG) {
    console.log('BOOKING STATE AFTER NLU:', JSON.stringify(callState.booking, null, 2));
    console.log('PROFILE AFTER NLU:', JSON.stringify(callState.profile, null, 2));
  }

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
      registerAssistantForLoopGuard(callState, replyText, 'phone_sanity');
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

  if (DEBUG_LOG) {
    console.log('SYSTEM ACTION DECISION:', JSON.stringify(systemAction, null, 2));
  }

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    history.push({ role: 'user', content: safeUserText });
    history.push({ role: 'assistant', content: systemAction.replyText });
    registerAssistantForLoopGuard(callState, systemAction.replyText, 'system_action');
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

      flow.stage = 'offer_zoom';

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'offer_zoom');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
  }

  // ---------- LATENCY KILLER: RULE-BASED FAST REPLIES (VOICE FIRST) ----------
  // This avoids an OpenAI call for the most common conversational steps.
  if (!DISABLE_RULE_BASED) {
    const hasBookingIntent =
      booking.intent === 'mybizpal_consultation' ||
      behaviour.bookingReadiness === 'high' ||
      strongBookNowRegex.test(userLower);

    if (isVoice && hasBookingIntent) {
      flow.stage = 'collect_contact';
      const replyText = buildFastConsultStep(callState, { isVoice });
      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (isVoice) {
      // If we still don't know business type, ask it directly (fast + consistent)
      if (!profile.businessType) {
        flow.stage = 'discovery';
        const replyText =
          'Got you. What type of business is it — for example a clinic, salon, trades, dentist, garage or something else?';
        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: replyText });
        registerAssistantForLoopGuard(callState, replyText, 'business_type');
        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      }

      // If we have business type but no pain point yet, ask the pain question (avoids OpenAI)
      if (!behaviour.painPointsMentioned) {
        flow.stage = 'discovery';
        const bt = profile.businessType ? profile.businessType.toLowerCase() : 'business';
        const replyText =
          `For your ${bt}, where do enquiries most often go wrong — missed calls, slow replies on WhatsApp, or bookings not getting confirmed?`;
        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: replyText });
        registerAssistantForLoopGuard(callState, replyText, 'pain_point');
        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      }

      // If pain point is known, move to close - but DO NOT LOOP (FIX)
      if (behaviour.painPointsMentioned && behaviour.bookingReadiness !== 'low') {
        const offerText =
          'Makes sense. Would a quick Zoom with one of the team help so you can see how it would work for you?';

        // if we’d repeat the offer, progress instead of looping
        if (wouldRepeat(callState, offerText) || flow.lastQuestionTag === 'offer_zoom') {
          booking.intent = booking.intent || 'mybizpal_consultation';
          behaviour.bookingReadiness = behaviour.bookingReadiness === 'low' ? 'low' : 'high';
          flow.stage = 'collect_contact';

          const replyText = buildFastConsultStep(callState, { isVoice });

          history.push({ role: 'user', content: safeUserText });
          history.push({ role: 'assistant', content: replyText });
          registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
          snapshotSessionFromCall(callState);
          return { text: replyText, shouldEnd: false };
        }

        flow.stage = 'offer_zoom';

        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: offerText });
        registerAssistantForLoopGuard(callState, offerText, 'offer_zoom');
        snapshotSessionFromCall(callState);
        return { text: offerText, shouldEnd: false };
      }
    }
  }

  // ---------- GUARD: NO BOOKING/EMAIL BEFORE CLEAR INTENT ----------
  function cleanEarlyBookingAndEmail(botText, { booking, behaviour, isVoice }) {
    if (!botText) return botText || '';

    const lower = botText.toLowerCase();

    const hasBookingIntent =
      booking.intent === 'mybizpal_consultation' ||
      behaviour.bookingReadiness === 'high';

    const mentionsEmail =
      /\b(email|e-mail|e mail)\b/.test(lower) ||
      /\bzoom link\b/.test(lower);

    const hardBookingPhrases =
      /\b(book you in|get you booked|lock that in|lock it in|i can book you|let me get you booked|schedule (a )?(call|consultation|meeting))\b/.test(
        lower
      );

    // If model tries to talk about booking or emails too early, strip that out.
    if (!hasBookingIntent && (mentionsEmail || hardBookingPhrases)) {
      // Remove sentences that mention email / zoom / booking from the reply
      const sentences = botText
        .split(/([.!?])/)
        .reduce((acc, cur, idx, arr) => {
          if (idx % 2 === 0) {
            const punct = arr[idx + 1] || '';
            acc.push(cur + punct);
          }
          return acc;
        }, [])
        .map((s) => s.trim())
        .filter(Boolean);

      const filtered = sentences.filter((s) => {
        const sLower = s.toLowerCase();
        if (/\b(email|e-mail|e mail|zoom link)\b/.test(sLower)) return false;
        if (
          /\b(book you in|get you booked|lock that in|lock it in|book you for)\b/.test(
            sLower
          )
        )
          return false;
        return true;
      });

      let cleaned = filtered.join(' ').trim();

      if (!cleaned) {
        // Fallback message if we stripped everything
        cleaned = isVoice
          ? 'Before we think about bookings or emails, tell me a bit about your business. What do you do?'
          : 'Before we get into bookings or emails, tell me a bit about your business. What do you do and what’s the main thing you’re trying to fix around calls or messages?';
      } else {
        // Add a gentle redirect so the user understands why we are not booking yet
        const tail = isVoice
          ? ' Before we even think about bookings, tell me a bit about your business and what you are trying to sort out.'
          : ' Before we even think about bookings, tell me a bit about your business and what you are trying to sort out around calls or enquiries.';
        cleaned += tail;
      }

      return cleaned;
    }

    return botText;
  }

  // ---------- OPENAI CALL ----------
  const systemPrompt = isVoice ? buildSystemPromptVoice(callState) : buildSystemPromptChat(callState);
  const messages = [{ role: 'system', content: systemPrompt }];

  // SPEED: fewer history messages (voice gets fewer than chat)
  const recent = isVoice ? history.slice(-4) : history.slice(-8);
  for (const msg of recent) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: safeUserText });

  botText = '';

  try {
    // SPEED: smaller token budget + hard timeout
    const timeoutMs = isVoice ? 2500 : 4500;
    const maxTokens = isVoice ? 80 : 140;

    botText = await callOpenAIWithTimeout({
      model: isVoice ? MODEL_VOICE : MODEL_CHAT,
      messages,
      maxTokens,
      temperature: isVoice ? 0.5 : 0.6,
      timeoutMs,
    });
  } catch (err) {
    console.error('Primary OpenAI call failed or timed out:', err);
  }

  // SPEED: Do NOT do a second OpenAI call on VOICE (it doubles perceived latency)
  if (!botText && isChat) {
    try {
      const lastAssistantForSlim = [...history]
        .slice()
        .reverse()
        .find((m) => m.role === 'assistant');

      const slimMessages = [
        {
          role: 'system',
          content:
            'You are Gabriel from MyBizPal. Continue naturally. Keep it short, human and slightly sales-focused. Ask one specific question. No apologies.',
        },
      ];

      if (lastAssistantForSlim) {
        slimMessages.push({
          role: 'assistant',
          content: lastAssistantForSlim.content,
        });
      }

      slimMessages.push({ role: 'user', content: safeUserText });

      botText = await callOpenAIWithTimeout({
        model: MODEL_CHAT,
        messages: slimMessages,
        maxTokens: 110,
        temperature: 0.6,
        timeoutMs: 3000,
      });
    } catch (err2) {
      console.error('Second OpenAI call failed:', err2);
    }
  }

  // ---------- FALLBACK (UPDATED: stage-aware, not generic) ----------
  if (!botText) {
    botText = buildContextualFallback({ safeUserText, profile, callState });
  }

  // ---------- NORMALISATION ----------
  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  // No booking/email too early
  botText = cleanEarlyBookingAndEmail(botText, {
    booking,
    behaviour,
    isVoice,
  });

  // Remove memory disclaimers hallucinations
  botText = botText.replace(
    /I (do not|don't) have (a )?way to (reliably )?remember past (chats|conversations) with you[^.]*\./gi,
    ''
  );
  botText = botText.replace(
    /I (only|can only) see (what('?s| is) )?in this conversation( right now)?\.?/gi,
    ''
  );

  // Remove legacy consulting sales pitch hallucination
  if (
    /business planning and strategy/i.test(botText) &&
    /marketing and sales funnels/i.test(botText)
  ) {
    botText =
      'Short version: MyBizPal answers your calls and WhatsApp messages for you, books appointments straight into your calendar, sends confirmations and reminders, and stops new enquiries going cold. It is built for busy clinics, salons, dentists, trades and other local service businesses.\n\nWhat type of business are you running at the moment?';
  }

  // ---------- CONFUSION HANDLER ----------
  const confusionRegex =
    /sorry[, ]+i (do not|don't|did not|didn't) (quite )?(understand|follow) that[^.]*\.?/gi;

  if (confusionRegex.test(botText)) {
    if (profile.businessType) {
      const bt = profile.businessType.toLowerCase();
      botText =
        `For your ${bt}, what’s the biggest issue right now — missed calls, slow replies on WhatsApp, or bookings not getting confirmed?`;
    } else {
      botText =
        'What type of business is it, and what’s the main headache — missed calls, slow replies, or messy bookings?';
    }
  }

  botText = botText.trim();

  // ---------- FIRST VOICE TURN: BLOCK EMAIL QUESTIONS ----------
  const isFirstAssistantTurn = history.length === 0;
  if (
    isVoice &&
    isFirstAssistantTurn &&
    /email/i.test(botText) &&
    !booking.intent &&
    !profile.businessType
  ) {
    const namePrefix = booking.name ? `${booking.name}, ` : '';
    botText = `${namePrefix}thanks for calling. Before we grab any details, tell me a bit about your business and what you are trying to sort out around calls or bookings.`;
  }

  // ---------- CHAT CLEANUP ----------
  if (isChat) {
    botText = botText
      .replace(/digit by digit/gi, '')
      .replace(/nice and slowly/gi, '')
      .replace(/\bslowly\b/gi, '')
      .replace(/\s+,/g, ',');
  }

  // Remove "agent like me" hallucination
  botText = botText.replace(
    /agent like me/gi,
    'a smart receptionist that sounds like this'
  );

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

  // Remove corporate phrase
  if (/two quick things so i can lock it in/i.test(botText)) {
    botText =
      'Great, let me just grab your details. What is the best email to send your Zoom link to?';
  }

  // ---------- TIME NORMALISATION ----------
  botText = botText.replace(
    /\b([0-1]?\d):00\s*([AaPp])\.?m\.?\b/g,
    (_, h, ap) => `${h}${ap.toLowerCase()}m`
  );
  botText = botText.replace(
    /\b([0-1]?\d)\s*([AaPp])\.?m\.?\b/g,
    (_, h, ap) => `${h}${ap.toLowerCase()}m`
  );
  botText = botText.replace(
    /\b([0-1]?\d):([0-5]\d)\s*([AaPp])\.?m\.?\b/g,
    (_, h, m, ap) => `${h}:${m}${ap.toLowerCase()}m`
  );

  // ---------- HARD VOICE BREVITY ----------
  if (isVoice) {
    botText = enforceVoiceBrevity(botText);
  }

  // Final fallback
  if (!botText) {
    botText = buildContextualFallback({ safeUserText, profile, callState });
  }

  // FIX: persist the user message before the assistant on the main path (prevents history gaps)
  ensureLastUserInHistory(history, safeUserText);

  // ---------- LOOP GUARD: if model repeats itself, force progress (NEW) ----------
  if (wouldRepeat(callState, botText)) {
    // if we are looping on a close/offer, progress into booking capture
    if (lastAssistantOfferedZoom(lastAssistantText) || /\bzoom\b/i.test(botText)) {
      booking.intent = booking.intent || 'mybizpal_consultation';
      behaviour.bookingReadiness = behaviour.bookingReadiness === 'low' ? 'low' : 'high';
      flow.stage = 'collect_contact';
      botText = buildFastConsultStep(callState, { isVoice });
    } else {
      // otherwise, ask a crisp disambiguation question
      botText = buildContextualFallback({ safeUserText, profile, callState });
    }
  }

  history.push({ role: 'assistant', content: botText });
  registerAssistantForLoopGuard(callState, botText, flow.stage || null);
  snapshotSessionFromCall(callState);

  return { text: botText, shouldEnd: false };
}
