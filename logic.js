// logic.js
// Gabriel brain: GPT-5.1 + booking orchestration + careful phone/email/name capture
// Update goals (Jan 2026):
// - More natural, human rapport (warm, spontaneous, sympathetic, professional)
// - Match caller sentiment (frustrated / sceptical / rushed / friendly)
// - Keep core flow + capture reliability
// - Reduce robotic repetition + hard-script feel via variation + tone steering
// - Preserve loop guards + confirmation fixes + opt-out safety

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

// ---------- SMALL HELPERS ----------
function pickRandom(arr) {
  if (!arr || !arr.length) return '';
  const idx = Math.floor(Math.random() * arr.length);
  return arr[idx];
}

function clamp(n, min, max) {
  const x = Number(n);
  if (Number.isNaN(x)) return min;
  return Math.max(min, Math.min(max, x));
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
      interestLevel: 'unknown', // low | medium | high | unknown
      scepticismLevel: 'unknown', // low | medium | high | unknown
      painPointsMentioned: false,
      decisionPower: 'unknown',
      bookingReadiness: 'unknown', // low | medium | high | unknown
      lastOffer: null,
      // NEW: tone memory
      sentiment: 'neutral', // friendly | neutral | frustrated | sceptical | rushed | confused
      lastSentimentAt: 0,
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

function ensureFlags(callState) {
  if (!callState.flags) {
    callState.flags = {
      doNotContact: false,
      doNotCall: false,
      doNotText: false,
      optOutReason: null,
      optOutAt: null,
    };
  }
  return callState.flags;
}

// ---------- FLOW / LOOP GUARD ----------
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

  if (
    flow.lastAssistantNorm &&
    norm &&
    flow.lastAssistantNorm === norm &&
    now - flow.lastAssistantAt < 60000
  ) {
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
    (/\bquick\b/.test(t) ||
      /\bshort\b/.test(t) ||
      /\bwith one of the team\b/.test(t) ||
      /\bsee how\b/.test(t) ||
      /\bsee it\b/.test(t) ||
      /\bdemo\b/.test(t))
  );
}

// ---------- NEW: SENTIMENT DETECTION (LIGHTWEIGHT, FAST) ----------
function detectSentiment(text) {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return 'neutral';

  // frustration / annoyance
  if (
    /\b(annoyed|annoying|ridiculous|this is (bad|terrible)|waste of time|stop asking|are you listening|you keep|again\?)\b/.test(
      t
    ) ||
    /\b(frustrat|fed up|pissed|angry|mad)\b/.test(t)
  )
    return 'frustrated';

  // sceptical / cautious
  if (
    /\b(scam|too good to be true|prove|evidence|guarantee|bull|sounds like|not sure|skeptic|sceptic|doubt)\b/.test(
      t
    ) ||
    /\b(price|cost|expensive|what do you charge|how much)\b/.test(t)
  )
    return 'sceptical';

  // rushed / busy
  if (
    /\b(quick|quickly|in a rush|busy|no time|make it fast|short version|just tell me)\b/.test(
      t
    )
  )
    return 'rushed';

  // confused
  if (
    /\b(confus|don.?t get it|what do you mean|huh\??|not following|say that again)\b/.test(
      t
    )
  )
    return 'confused';

  // friendly / positive
  if (/\b(thanks|thank you|cheers|appreciate|great|perfect|lovely|amazing)\b/.test(t))
    return 'friendly';

  return 'neutral';
}

function updateSentiment(behaviour, userText) {
  const s = detectSentiment(userText);
  behaviour.sentiment = s;
  behaviour.lastSentimentAt = Date.now();

  // tiny, safe nudges (do not overfit)
  if (s === 'friendly') behaviour.rapportLevel = clamp((behaviour.rapportLevel || 0) + 1, 0, 5);
  if (s === 'sceptical' && behaviour.scepticismLevel === 'unknown') behaviour.scepticismLevel = 'medium';
  if (s === 'frustrated') {
    behaviour.interestLevel = behaviour.interestLevel === 'unknown' ? 'medium' : behaviour.interestLevel;
  }
}

// ---------- NEW: TONE MICRO-PHRASES (NOT SCRIPTS; SMALL HUMAN VARIATION) ----------
const TONE = {
  ack: [
    'Got it.',
    'Gotcha.',
    'Right, okay.',
    'No worries.',
    'Makes sense.',
    'Yep, I’m with you.',
  ],
  empathy: {
    frustrated: [
      'I hear you.',
      'That’s frustrating, honestly.',
      'Yeah, that would do my head in too.',
      'Totally get why that’s annoying.',
    ],
    sceptical: [
      'Fair question.',
      'Completely fair to be cautious.',
      'Yeah, I’d ask that too.',
      'Totally get the scepticism.',
    ],
    rushed: [
      'No problem, I’ll keep it quick.',
      'Sure — quick version.',
      'Yep, two seconds.',
      'Got you — straight to the point.',
    ],
    confused: [
      'No stress — let me make that clearer.',
      'All good — let me say it another way.',
      'Sure — here’s the simple version.',
    ],
    friendly: [
      'Love that.',
      'Nice one.',
      'Perfect.',
      'Brilliant.',
    ],
    neutral: ['Okay.', 'Got it.', 'Sure.', 'Alright.'],
  },
  softeners: [
    'if you like',
    'when you’re ready',
    'at your pace',
    'no pressure',
  ],
};

function tonePrefix(behaviour) {
  const s = behaviour?.sentiment || 'neutral';
  const emp = TONE.empathy[s] || TONE.empathy.neutral;
  // Keep it short; do not prefix every time.
  return pickRandom(emp);
}

function shouldAddTonePrefix(callState) {
  // Avoid adding empathy prefix repeatedly; add it occasionally or when sentiment is non-neutral.
  const behaviour = ensureBehaviourState(callState);
  const s = behaviour.sentiment || 'neutral';
  const now = Date.now();
  callState._tone = callState._tone || { lastPrefixAt: 0 };

  if (s === 'neutral') {
    // only occasionally
    if (now - (callState._tone.lastPrefixAt || 0) < 45000) return false;
    return Math.random() < 0.18;
  }

  // for non-neutral, a bit more often but still not every turn
  if (now - (callState._tone.lastPrefixAt || 0) < 25000) return false;
  return Math.random() < 0.55;
}

function applyTonePrefixIfHelpful(callState, text) {
  if (!text) return text;
  const behaviour = ensureBehaviourState(callState);
  if (!shouldAddTonePrefix(callState)) return text;

  // Don't prefix if we already have an empathy/ack opening
  const lower = String(text).toLowerCase();
  if (/^(got it|gotcha|no worries|okay|alright|sure|thanks|perfect|brilliant|fair question)\b/.test(lower))
    return text;

  const prefix = tonePrefix(behaviour);
  callState._tone.lastPrefixAt = Date.now();
  return `${prefix} ${text}`.trim();
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
      callState.behaviour = { ...(saved.behaviour || {}), ...(callState.behaviour || {}) };
    }
    if (saved.capture) {
      callState.capture = { ...(saved.capture || {}), ...(callState.capture || {}) };
    }
    if (saved.profile) {
      callState.profile = { ...(saved.profile || {}), ...(callState.profile || {}) };
    }
    if (saved.flow) {
      callState.flow = { ...(saved.flow || {}), ...(callState.flow || {}) };
    }
    if (saved.flags) {
      callState.flags = { ...(saved.flags || {}), ...(callState.flags || {}) };
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
  const flow = ensureFlowState(callState);
  const flags = ensureFlags(callState);

  const snapshot = {
    booking,
    behaviour,
    capture,
    profile,
    flow,
    flags,
    history: history.slice(-40),
  };

  saveSessionForPhone(phoneKey, snapshot);
}

// Ensure the latest user utterance is persisted
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

function isCleanYes(text) {
  if (!text) return false;
  if (hasStrongNoCorrection(text)) return false;
  return yesInAnyLang(text);
}

// ---------- OPT-OUT / DO-NOT-CONTACT DETECTOR ----------
function isOptOutIntent(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  return (
    /\b(stop calling|dont call|don't call|do not call|never call|no more calls|remove me|take me off|opt out|unsubscribe|stop texting|dont text|don't text|do not text|leave me alone)\b/.test(
      t
    ) ||
    /\bnot interested\b/.test(t) ||
    /\bwrong number\b/.test(t)
  );
}

function applyOptOut(callState, reason) {
  const flags = ensureFlags(callState);
  flags.doNotContact = true;
  flags.doNotCall = true;
  flags.doNotText = true;
  flags.optOutReason = reason || 'opt_out';
  flags.optOutAt = Date.now();

  const behaviour = ensureBehaviourState(callState);
  behaviour.interestLevel = 'low';
  behaviour.bookingReadiness = 'low';

  const flow = ensureFlowState(callState);
  flow.stage = 'done';
}

// ---------- PROACTIVE NAME CAPTURE ----------
function tryCaptureNameIfMissing(callState, safeUserText) {
  if (callState.booking?.name) return;

  const candidate = extractNameFromUtterance(safeUserText);
  if (candidate) {
    if (!callState.booking) callState.booking = {};
    callState.booking.name = candidate;
  }
}

function looksLikeBusinessType(text) {
  const t = String(text || '').trim();
  if (!t) return false;

  // too long to be a business type
  if (t.length > 40) return false;

  // avoid capturing generic intent statements
  if (
    /\b(inquire|enquire|services|help|booking|book|missed calls|zoom|availability|earliest)\b/i.test(
      t
    )
  ) {
    return false;
  }

  // not an email or phone
  if (/@/.test(t)) return false;
  if (/\d{3,}/.test(t)) return false;

  // must look like a plausible business noun phrase
  const keyword =
    /\b(garage|salon|clinic|dentist|plumber|electrician|restaurant|cafe|shop|studio|agency|law|account|builder|clean|cleaning|repairs|repair|hair|beauty|medical|vet|fitness|gym|dental|spa|trades|contractor|removals|landscap|roofer|architect|consult)\b/i.test(
      t
    );

  if (keyword) return true;

  // fallback: short noun-ish phrase
  return t.split(/\s+/).length <= 4;
}

// ---------- SMART BUSINESS TYPE CAPTURE ----------
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
    'medspa',
    'med spa',
    'medical spa',
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

  if (safeUserText.length < 60 && looksLikeBusinessType(safeUserText)) {
    const match = safeUserText.match(
      /\b(garage|salon|clinic|shop|studio|gym|dentist|plumber|electrician|mechanic|coach|restaurant|vet|physio|medspa|spa)\b/i
    );
    if (match) {
      profile.businessType =
        match[0].charAt(0).toUpperCase() + match[0].slice(1).toLowerCase();
    }
  }
}

function updateProfileFromUserReply({ safeUserText, history, profile }) {
  const trimmed = (safeUserText || '').trim();
  if (!trimmed) return;

  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return;
  const la = lastAssistant.content.toLowerCase();

  if (!profile.businessType && /what (kind|type|sort) of business/.test(la)) {
    if (looksLikeBusinessType(trimmed)) {
      profile.businessType = trimmed;
    }
  }

  if (!profile.location && /(where are you (calling from|based)|where.*located)/.test(la)) {
    profile.location = trimmed;
  }
}

// ---------- NEW: APPROX VOLUME EXTRACTOR ----------
function extractApproxVolume(text) {
  const t = String(text || '').toLowerCase();

  const n = t.match(/\b(\d{1,4})\b/);
  if (n) return Number(n[1]);

  if (/\b(a few|couple)\b/.test(t)) return 3;
  if (/\bdozens?\b/.test(t)) return 24;
  if (/\bloads?\b|\blots?\b|\bmany\b/.test(t)) return 15;

  return null;
}

// ---------- CONTEXTUAL FALLBACK BUILDER (MORE NATURAL + SENTIMENT) ----------
function buildContextualFallback({ profile, callState }) {
  const flow = ensureFlowState(callState);
  const behaviour = ensureBehaviourState(callState);
  const { isVoice } = getChannelInfo(callState);

  const biz = profile?.businessType ? ` for your ${profile.businessType}` : '';

  // If they sound annoyed, avoid repeating the same question; be direct and move forward.
  if (behaviour.sentiment === 'frustrated') {
    if (!profile.businessType) {
      return isVoice
        ? 'I hear you. Just quickly — what kind of business is it?'
        : 'I hear you. Just quickly — what kind of business is it, and what’s the main thing breaking: missed calls, slow replies, or bookings not getting confirmed?';
    }
    return isVoice
      ? `I hear you. What’s the biggest headache right now${biz} — missed calls or slow replies?`
      : `I hear you. What’s the biggest headache right now${biz} — missed calls, slow replies on WhatsApp, or bookings slipping through?`;
  }

  if (flow.stage === 'offer_zoom') {
    return isVoice
      ? 'Want to see it working on a quick Zoom, or do you want the short version first?'
      : 'Do you want to see it working on a quick Zoom, or would you prefer the short version here first?';
  }

  if (flow.stage === 'collect_contact') {
    return isVoice
      ? 'What’s the best email to send the invite and Zoom link to?'
      : 'What’s the best email to send the calendar invite and Zoom link to?';
  }

  if (flow.stage === 'pick_time') {
    return isVoice
      ? 'What day and roughly what time suits you for a 20 to 30 minute Zoom?'
      : 'What day and roughly what time suits you for a 20–30 minute Zoom — tomorrow, or another weekday 9 to 5?';
  }

  if (profile && profile.businessType) {
    return isVoice
      ? `Where do things usually go wrong${biz} — missed calls, slow replies, or bookings not confirmed?`
      : `Where do enquiries most often go wrong${biz} — missed calls, slow replies on WhatsApp, or bookings not getting confirmed?`;
  }

  return isVoice
    ? 'What kind of business is it, and what are you trying to fix?'
    : 'What kind of business is it, and what are you trying to fix — missed calls, slow replies, or bookings?';
}

// ---------- FAST CONSULTATION STEP FOR HOT LEADS (VOICE) ----------
function buildFastConsultStep(callState, { isVoice }) {
  const booking = callState.booking || {};
  const profile = ensureProfile(callState);
  const behaviour = ensureBehaviourState(callState);

  const capture =
    callState.capture || {
      mode: 'none',
      buffer: '',
      emailAttempts: 0,
      phoneAttempts: 0,
      nameAttempts: 0,
      nameStage: 'initial',
      pendingConfirm: null,
    };

  callState.capture = capture;

  // Keep it warm but short; vary a little
  const warm = shouldAddTonePrefix(callState) ? tonePrefix(behaviour) : null;

  if (!booking.name) {
    const replyText = `${warm ? warm + ' ' : ''}What’s your first name?`.trim();
    capture.mode = 'name';
    capture.buffer = '';
    capture.nameStage = 'initial';
    return replyText;
  }

  if (!profile.businessType) {
    return isVoice
      ? pickRandom([
          'And what kind of business is it?',
          'Quick one — what type of business are you running?',
          'What sort of business is this for?',
        ])
      : pickRandom([
          'Quick one — what type of business are you running?',
          'What kind of business is this for?',
          'What sort of business are you running day to day?',
        ]);
  }

  if (!booking.email) {
    const replyText = isVoice
      ? pickRandom([
          'What’s the best email for the Zoom link?',
          'What email should I send the invite to?',
          'What’s your best email address for the calendar invite?',
        ])
      : pickRandom([
          'What’s the best email to send the Zoom link to?',
          'What email should I send the calendar invite to?',
          'What’s your best email address for the Zoom invite?',
        ]);
    capture.mode = 'email';
    capture.buffer = '';
    capture.emailAttempts = 0;
    capture.pendingConfirm = null;
    return replyText;
  }

  return isVoice
    ? pickRandom([
        'What day and roughly what time suits you for a quick Zoom?',
        'When’s good for a 20 minute Zoom — tomorrow, or another weekday?',
        'What time works for a short Zoom — morning or afternoon?',
      ])
    : pickRandom([
        'What day and roughly what time suits you for a 20–30 minute Zoom?',
        'When’s good for a quick Zoom — tomorrow, or another weekday 9 to 5?',
        'What time works best for a short Zoom — morning or afternoon?',
      ]);
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
      sentiment: behaviour.sentiment || 'neutral',
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
You are Gabriel from MyBizPal. You sound like a real UK person: calm, friendly, confident, and natural.
Do NOT mention being AI unless asked.

Voice style (critical):
- 1–2 short sentences max.
- Sound spontaneous: contractions, natural fillers occasionally ("right", "okay", "gotcha") but not every line.
- Match the caller sentiment (frustrated/sceptical/rushed/confused/friendly) with brief empathy.
- Ask ONE clear question.
- No long explanations unless asked.

Business goal:
- Understand their business + main headache with calls/WhatsApp/bookings.
- If they want to proceed, book a short Zoom with a human adviser.
- Never pressure; "no pressure" tone.

Hard boundaries:
- If caller asks to stop: confirm opt-out and end.
- If caller corrects details: accept correction and move on.
- Avoid robotic repetition; if stuck, ask a different angle.

Flow context (internal):
stage=${ctx.flow.stage}; lastQuestion=${ctx.flow.lastQuestionTag}.
Booking (internal):
intent=${ctx.booking.intent}; name=${ctx.booking.name}; phone=${ctx.booking.phone}; email=${ctx.booking.email}; time=${ctx.booking.timeSpoken}; awaitingConfirm=${ctx.booking.awaitingTimeConfirm}; earliest=${ctx.booking.earliestSlotSpoken}.
Profile (internal):
businessType=${ctx.profile.businessType}; location=${ctx.profile.location}.
Sentiment (internal): ${ctx.behaviour.sentiment}.
`.trim();
}

function buildSystemPromptChat(callState) {
  const ctx = buildCompactContext(callState);
  return `
You are Gabriel from MyBizPal. Human-sounding UK tone: warm, helpful, confident. No corporate waffle.
Do NOT mention being AI unless asked.

Chat style:
- Keep it tight and natural, but not robotic.
- Match the user's sentiment with brief empathy and then progress.
- Ask one clear question at a time.
- Avoid hard scripts; vary phrasing.
- Never pressure; keep it "no pressure".

Business goal:
- Understand their business + main headache with calls/WhatsApp/bookings.
- If they want to proceed, offer a short Zoom with a human adviser.

Flow context (internal):
stage=${ctx.flow.stage}; lastQuestion=${ctx.flow.lastQuestionTag}.
Booking context (internal):
intent=${ctx.booking.intent}; name=${ctx.booking.name}; phone=${ctx.booking.phone}; email=${ctx.booking.email}; time=${ctx.booking.timeSpoken}; awaitingConfirm=${ctx.booking.awaitingTimeConfirm}; earliest=${ctx.booking.earliestSlotSpoken}.
Profile (internal):
businessType=${ctx.profile.businessType}; location=${ctx.profile.location}.
Sentiment (internal): ${ctx.behaviour.sentiment}.
`.trim();
}

// ---------- VOICE BREVITY ENFORCER ----------
function enforceVoiceBrevity(text) {
  if (!text) return text;

  let t = String(text).trim();
  t = t.replace(/\s+/g, ' ').trim();

  const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);

  if (parts.length <= 2) {
    // ensure there's a question somewhere; if not, keep as-is
    return t;
  }

  const first = parts[0].trim();
  const lastQuestion = [...parts].reverse().find((s) => s.includes('?'));
  let second = '';

  if (lastQuestion) {
    second = lastQuestion.trim();
    if (second === first) second = (parts[1] || '').trim();
  } else {
    second = (parts[1] || '').trim();
    if (second && !second.includes('?')) {
      second = second.replace(/[.!]+$/, '').trim() + '?';
    }
  }

  return [first, second].filter(Boolean).join(' ').trim();
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
  ensureHistory(callState);
  ensureBehaviourState(callState);
  ensureProfile(callState);
  ensureFlowState(callState);
  ensureFlags(callState);

  if (!callState.booking) callState.booking = {};
  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);
  const booking = callState.booking;
  const flow = ensureFlowState(callState);
  const flags = ensureFlags(callState);
  const { isChat, isVoice } = getChannelInfo(callState);

  const safeUserText = userText || '';
  const userLower = safeUserText.toLowerCase();
  const hasAnyAssistantInHistory = history.some((m) => m.role === 'assistant');
  const isFirstTurn = history.length === 0;

  // Update sentiment early (used by both rules + LLM)
  updateSentiment(behaviour, safeUserText);

  const lastAssistant = [...history].slice().reverse().find((m) => m.role === 'assistant');
  const lastAssistantText = lastAssistant ? lastAssistant.content : '';

  // If opted-out, keep response minimal and end.
  if (flags.doNotContact) {
    ensureLastUserInHistory(history, safeUserText);
    const replyText = isVoice
      ? 'No problem. I won’t contact you again.'
      : 'No problem — you’re opted out and we won’t contact you again.';
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'done');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: true };
  }

  // Ensure we always have a phone on voice calls
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

  // Opt-out early exit
  if (isOptOutIntent(safeUserText)) {
    const reason = /\bwrong number\b/.test(userLower)
      ? 'wrong_number'
      : /\bnot interested\b/.test(userLower)
      ? 'not_interested'
      : 'opt_out';

    applyOptOut(callState, reason);
    ensureLastUserInHistory(history, safeUserText);

    const replyText = isVoice
      ? 'No worries — I’ll stop contacting you.'
      : 'No worries — I’ll stop contacting you and remove you from follow-ups.';

    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'done');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: true };
  }

  // Proactive name & business capture
  if (!(isVoice && isFirstTurn)) {
    tryCaptureNameIfMissing(callState, safeUserText);
  }
  updateBusinessTypeFromAnyMessage({ safeUserText, profile });
  updateProfileFromUserReply({ safeUserText, history, profile });

  // Lightweight behaviour hints
  if (/thank(s| you)|cheers|appreciate/.test(userLower)) {
    behaviour.rapportLevel = clamp((behaviour.rapportLevel || 0) + 1, 0, 5);
  }

  if (/miss(ed)? calls?|lost leads?|losing leads?|loosing leads?|wasting leads?/.test(userLower)) {
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

  // If last message was a Zoom offer and user says YES, progress immediately
  if (lastAssistantOfferedZoom(lastAssistantText) && isCleanYes(safeUserText)) {
    booking.intent = 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown' || behaviour.bookingReadiness === 'medium') {
      behaviour.bookingReadiness = 'high';
    }
    if (behaviour.interestLevel === 'unknown') behaviour.interestLevel = 'high';
    flow.stage = 'collect_contact';

    const replyText = buildFastConsultStep(callState, { isVoice });

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // Intent regexes
  const earlyBookingRegex =
    /\b(book you in|get you booked|lock that in|lock it in|i can book you|let me get you booked|schedule (a )?(call|consultation|meeting))\b/;

  const bookingIntentRegex =
    /\b(book(ing)?|set up a call|set up an appointment|speak with (an )?(adviser|advisor)|talk to (an )?(adviser|advisor)|consultation|consult|demo)\b/;

  if (bookingIntentRegex.test(userLower) || earlyBookingRegex.test(userLower)) {
    booking.intent = booking.intent || 'mybizpal_consultation';
    if (behaviour.bookingReadiness === 'unknown') {
      behaviour.bookingReadiness = 'high';
    }
    flow.stage = flow.stage === 'discovery' ? 'collect_contact' : flow.stage;
  }

  const strongBookNowRegex =
    /\b(book (me|my consultation|a consultation|a call)|can you book (me|my consultation|a call)|please book (me|my consultation)|get me booked( in)?|book my consultation|book my call|book a consultation for me|book (a )?(discovery|strategy|demo) call)\b/;

  // --------- CONFIRMATION FIXES (NAME/EMAIL/PHONE) ----------
  function looksLikeEmail(text) {
    return /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(String(text || ''));
  }
  function looksLikePhoneDigits(text) {
    const d = String(text || '').replace(/[^\d]/g, '');
    return d.length >= 7 && d.length <= 16;
  }

  if (capture.pendingConfirm === 'name') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (!yesInAnyLang(safeUserText) && !noInAnyLang(safeUserText) && !strongNo) {
      capture.pendingConfirm = null;
      capture.mode = 'name';
      // fall through into name capture mode below
    } else if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.name = null;

      let replyText;
      if (capture.nameStage === 'initial') {
        replyText = pickRandom([
          'No worries — what should I call you? Just your first name.',
          'All good — what’s your first name?',
          'Okay, let’s redo that — what’s your first name?',
        ]);
        capture.nameStage = 'repeat';
      } else if (capture.nameStage === 'repeat') {
        replyText = pickRandom([
          'Got it. Could you spell your first name for me, letter by letter?',
          'No problem — can you spell it out for me, one letter at a time?',
        ]);
        capture.nameStage = 'spell';
      } else {
        replyText = pickRandom([
          'No problem — could you spell your first name for me, letter by letter?',
          'Sure — spell your first name for me, one letter at a time.',
        ]);
        capture.nameStage = 'spell';
      }

      capture.mode = 'name';
      capture.pendingConfirm = null;
      capture.nameAttempts += 1;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'name_confirm');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    } else if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
      capture.nameStage = 'confirmed';
    }
  } else if (capture.pendingConfirm === 'email') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (!yesInAnyLang(safeUserText) && !noInAnyLang(safeUserText) && looksLikeEmail(safeUserText)) {
      capture.pendingConfirm = null;
      capture.mode = 'email';
      capture.buffer = '';
      // fall through into email capture mode below
    } else if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText = pickRandom([
        'No worries — what’s the email again, from the start?',
        'All good — can you give me the full email address again?',
        'Okay, let’s redo it — full email address, all in one go.',
      ]);

      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;
      capture.pendingConfirm = null;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'email_retry');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    } else if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
    }
  } else if (capture.pendingConfirm === 'phone') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (!yesInAnyLang(safeUserText) && !noInAnyLang(safeUserText) && looksLikePhoneDigits(safeUserText)) {
      capture.pendingConfirm = null;
      capture.mode = 'phone';
      capture.buffer = '';
      // fall through into phone capture mode below
    } else if (strongNo || noInAnyLang(safeUserText)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.phone = null;

      const replyText = pickRandom([
        'Got it — what’s the mobile again, from the start?',
        'No worries — can you give me your mobile number again?',
        'Okay — full mobile number again, from the beginning.',
      ]);

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;
      capture.pendingConfirm = null;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'phone_retry');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    } else if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
    }
  }

  // ---------- QUICK INTENT: REPEAT PHONE / EMAIL / DETAILS ----------
  const wantsPhoneRepeat =
    /\b(repeat|read back|confirm|check|what)\b.*\b(my )?(number|phone|mobile)\b/.test(userLower) ||
    /\bwhat\b.*\bnumber do you have\b/.test(userLower);

  const wantsEmailRepeat =
    /\b(repeat|read back|confirm|check|what)\b.*\b(my )?(email|e-mail|e mail)\b/.test(userLower) ||
    /\bwhat\b.*\bemail (do you|have you) have\b/.test(userLower);

  const wantsDetailsRepeat =
    /\bwhat details (do you|have you) have (for|on) me\b/.test(userLower) ||
    /\bwhat (info|information) do you have on me\b/.test(userLower);

  if (wantsPhoneRepeat && booking.phone) {
    const spoken = isVoice ? verbalisePhone(booking.phone) : booking.phone;
    const replyText = isVoice
      ? `I’ve got ${spoken} as your mobile — if that’s wrong, just say the right one.`
      : `I’ve got **${booking.phone}** as your mobile number. If that’s wrong, just send the correct one.`;

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'repeat_phone');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (wantsEmailRepeat && booking.email) {
    const spoken = isVoice ? verbaliseEmail(booking.email) : booking.email;
    const replyText = isVoice
      ? `I’ve got ${spoken} as your email — if it’s wrong, just say the correct one.`
      : `I’ve got **${booking.email}** as your email. If that’s not right, just send the correct one.`;

    ensureLastUserInHistory(history, safeUserText);
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
      ? `Here’s what I’ve got so far:\n${summary}\n\nIf anything’s off, just send the updated details.`
      : `Here’s what I’ve got: ${summary}. If anything’s off, just correct me and I’ll update it.`;

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'repeat_details');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- USER SAYS THEY ALREADY ANSWERED ----------
  if (/\bi already (told you|answered that|said that)\b/.test(userLower)) {
    const lastAssistantTextLower = lastAssistant ? lastAssistant.content.toLowerCase() : '';
    let replyText;

    if (profile.businessType && /what (kind|type|sort) of business/.test(lastAssistantTextLower)) {
      const nameLabel = booking.name || 'you';
      replyText = `You’re right — my bad. I’ve got ${nameLabel} down for a ${profile.businessType}. What’s the main headache right now — missed calls or slow replies?`;
    } else if (booking.email && /(email|e-mail|e mail)/.test(lastAssistantTextLower)) {
      replyText = isChat
        ? `You’re right — I’ve already got **${booking.email}** noted. What day/time works for you?`
        : `You’re right — I’ve already got your email. What day and time suits you?`;
    } else if (booking.phone && /(number|mobile|phone)/.test(lastAssistantTextLower)) {
      replyText = isChat
        ? `You’re right — I’ve got **${booking.phone}** saved. What’s the main thing you want to fix?`
        : `You’re right — I’ve got your number saved. What’s the main thing you want to fix?`;
    } else {
      const bits = [];
      if (booking.name) bits.push(`name: ${booking.name}`);
      if (profile.businessType) bits.push(`business: ${profile.businessType}`);
      if (booking.email) bits.push(`email: ${booking.email}`);
      if (booking.phone) bits.push(`mobile: ${booking.phone}`);
      const summary = bits.length ? `I’ve got ${bits.join(', ')}.` : `I know I asked you a couple of things there.`;
      replyText = `You’re right — no need to repeat yourself. ${summary} What should we tackle first?`;
    }

    ensureLastUserInHistory(history, safeUserText);
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
        `Hey ${knownName} — good to have you back. Remind me, what business is it and what are you trying to fix with calls or bookings?`,
        `${knownName}, welcome back. Quick refresher — what business is it, and what’s the main issue with enquiries right now?`,
      ]);
    } else {
      replyText = pickRandom([
        'I speak to loads of business owners, so I focus on what you need right now. What’s your first name and what business is it?',
        'Remind me — what’s your name, and what sort of business is this for?',
      ]);
    }

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'remember_me');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (
    /\bwhat do you do\b/.test(userLower) ||
    /\bwhat you do\b/.test(userLower) ||
    /\bwhat you guys do\b/.test(userLower) ||
    /see what you do/.test(userLower) ||
    /what (is|does) mybizpal\b/.test(userLower)
  ) {
    behaviour.interestLevel = behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const core = pickRandom([
      'Quick version: MyBizPal answers your calls and WhatsApp messages, handles basic enquiries, books appointments into your calendar, and sends confirmations and reminders — so new leads don’t go cold.',
      'In short: we answer calls and WhatsApps like a real receptionist, qualify the enquiry, and book people in — with confirmations and reminders — so you stop losing work.',
    ]);

    const followUp = pickRandom([
      'What kind of business is this for?',
      'What sort of business are you running at the moment?',
      'Where do enquiries usually slip through for you — missed calls or slow replies?',
    ]);

    const replyText = `${core} ${followUp}`.trim();

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'what_do_you_do');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  if (/\bautomate\b/.test(userLower) || /\bautomation\b/.test(userLower)) {
    behaviour.interestLevel = behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;

    const replyText = pickRandom([
      'Yep — that’s exactly what we do. Where does it feel most manual right now: missed calls, slow replies, or bookings?',
      'Yes — we automate calls, WhatsApps and bookings so you’re not chasing leads. What kind of business is it?',
    ]);

    ensureLastUserInHistory(history, safeUserText);
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
    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- NAME CAPTURE MODE ----------
  if (capture.mode === 'name') {
    const raw = safeUserText || '';
    let cleaned = raw.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

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
      const proper = candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();

      if (!callState.booking) callState.booking = {};
      callState.booking.name = proper;

      let replyText;
      if (isVoice) {
        replyText = pickRandom([
          `Nice to meet you, ${proper}. Did I get that right?`,
          `${proper} — lovely. Is that right?`,
          `Perfect, ${proper}. Did I catch that correctly?`,
        ]);
        capture.pendingConfirm = 'name';
        if (capture.nameStage === 'confirmed') capture.nameStage = 'initial';
      } else {
        replyText = pickRandom([
          `Nice to meet you, ${proper}.`,
          `Perfect, ${proper}.`,
          `Great, ${proper}.`,
        ]);
        capture.pendingConfirm = null;
        capture.nameStage = 'confirmed';
      }

      capture.mode = 'none';

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'name');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (safeUserText.length > 40) {
      const replyText = pickRandom([
        'Sorry — I didn’t catch your first name. Can you say it again?',
        'I missed that — what’s your first name?',
        'Could you repeat your first name for me?',
      ]);
      capture.mode = 'name';
      capture.nameAttempts += 1;
      ensureLastUserInHistory(history, safeUserText);
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
        replyText = pickRandom([
          `Got it — ${spoken}. Is that right?`,
          `Perfect — ${spoken}. Correct?`,
          `Alright — ${spoken}. Did I get that right?`,
        ]);
        capture.pendingConfirm = 'phone';
      } else {
        replyText = pickRandom(['Perfect, thanks.', 'Got it — thanks.', 'Nice one, thanks.']);
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;

      ensureLastUserInHistory(history, safeUserText);
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
        replyText = pickRandom([
          `Got it — ${spokenNumber}. Is that right?`,
          `Alright — ${spokenNumber}. Correct?`,
        ]);
        capture.pendingConfirm = 'phone';
      } else {
        replyText = pickRandom(['Got it, thanks.', 'Perfect, thanks.', 'Nice one — got it.']);
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.phoneAttempts = 0;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'phone');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (capture.buffer.length > 40 || digitsOnly.length > 16) {
      const variants = isVoice
        ? [
            'I don’t think I caught that cleanly — can you repeat your mobile from the start?',
            'Sorry — can you give me the full mobile number again from the beginning?',
            'Let’s try that once more — full mobile number, from the start.',
          ]
        : [
            'That didn’t come through clearly — can you type your full mobile number again?',
            'Sorry — can you send the full mobile number once more in one message?',
            'Let’s try again — just send your full mobile number.',
          ];

      const replyText = variants[capture.phoneAttempts % variants.length];

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts += 1;

      ensureLastUserInHistory(history, safeUserText);
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
    if (/no email|don.?t have an email|do not have an email|i don.?t use email/.test(userLower)) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = null;

      const replyText = pickRandom([
        'No worries — we can still book you in without an email.',
        'All good — we can do it without email.',
        'That’s fine — we can still book it without an email address.',
      ]);

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;
      capture.pendingConfirm = null;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'email_none');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    capture.buffer = (capture.buffer + ' ' + safeUserText).trim();

    let email = null;
    const rawBuffer = capture.buffer;
    let bufferForEmail = rawBuffer;
    const lowerBuffer = rawBuffer.toLowerCase();

    const markerMatch = lowerBuffer.match(/(my\s+email\s+is|email\s+is|email\s*[:=])/i);
    if (markerMatch) {
      bufferForEmail = rawBuffer.slice(markerMatch.index + markerMatch[0].length);
    }

    const directMatch = bufferForEmail.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    if (directMatch) {
      email = directMatch[0].toLowerCase();
    } else {
      const extracted = extractEmailSmart(bufferForEmail);
      if (extracted) email = String(extracted).toLowerCase();
    }

    if (email) {
      if (!callState.booking) callState.booking = {};
      callState.booking.email = email;

      let replyText;
      if (isVoice) {
        const spokenEmail = verbaliseEmail(email);
        replyText = pickRandom([
          `Got it — ${spokenEmail}. Is that right?`,
          `Perfect — ${spokenEmail}. Correct?`,
          `Alright — ${spokenEmail}. Did I get that right?`,
        ]);
        capture.pendingConfirm = 'email';
      } else {
        replyText = pickRandom(['Perfect, thanks.', 'Got it — thanks.', 'Nice one — got it.']);
        capture.pendingConfirm = null;
      }

      capture.mode = 'none';
      capture.buffer = '';
      capture.emailAttempts = 0;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'email');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (capture.buffer.length > 80) {
      const variants = isVoice
        ? [
            'I might’ve missed that — can you say the whole email again from the start?',
            'Sorry — could you give me the full email again, all in one go?',
            'Let’s try that again — full email address from the beginning.',
          ]
        : [
            'I don’t think I got that — can you type the full email address again?',
            'Sorry — can you send the email again in full?',
            'Let’s try again — just send your full email address.',
          ];

      const replyText = variants[capture.emailAttempts % variants.length];

      capture.mode = 'email';
      capture.buffer = '';
      capture.emailAttempts += 1;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'email_retry');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // ---------- BOOKING STATE UPDATE ----------
  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  if (DEBUG_LOG) {
    console.log('BOOKING STATE AFTER NLU:', JSON.stringify(callState.booking, null, 2));
    console.log('PROFILE AFTER NLU:', JSON.stringify(callState.profile, null, 2));
  }

  // ---------- PHONE SANITY CHECK ----------
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

      const replyText = pickRandom([
        'That sounds a bit short for a full mobile — can you give me the full number from the start?',
        'I think I’ve only got part of that number — can you say the full mobile from the beginning?',
        'Just to be safe — can you give me the full mobile number again from the start?',
      ]);

      capture.mode = 'phone';
      capture.buffer = '';
      capture.phoneAttempts = (capture.phoneAttempts || 0) + 1;

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'phone_sanity');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
  } catch (e) {
    console.error('Phone sanity check error:', e);
  }

  // ---------- SYSTEM BOOKING ACTIONS ----------
  const systemAction = await handleSystemActionsFirst({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  if (DEBUG_LOG) {
    console.log('SYSTEM ACTION DECISION:', JSON.stringify(systemAction, null, 2));
  }

  if (systemAction && systemAction.intercept && systemAction.replyText) {
    ensureLastUserInHistory(history, safeUserText);

    // Make system action replies slightly warmer without changing meaning.
    let replyText = systemAction.replyText;
    replyText = applyTonePrefixIfHelpful(callState, replyText);

    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'system_action');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- AVAILABILITY OVERRIDE (PREVENT LOOP) ----------
  const availabilityQuestion =
    /\b(earliest|availability|available|what times|what time do you have|tomorrow morning|slots|next slot)\b/i.test(
      safeUserText
    );

  if (availabilityQuestion) {
    booking.intent = booking.intent || 'mybizpal_consultation';
    flow.stage = 'pick_time';
    booking.requestedAvailability = true;
    booking.requestedAvailabilityText = safeUserText;

    const replyText = pickRandom([
      'Sure — do you want the earliest slot, or specifically tomorrow morning?',
      'Got you — do you want the earliest we’ve got, or are you aiming for tomorrow morning?',
      'No worries — earliest available, or tomorrow morning specifically?',
    ]);

    ensureLastUserInHistory(history, safeUserText);
    history.push({ role: 'assistant', content: replyText });
    registerAssistantForLoopGuard(callState, replyText, 'availability_clarify');
    snapshotSessionFromCall(callState);
    return { text: replyText, shouldEnd: false };
  }

  // ---------- SPECIAL CASE: USER SAYS "BOTH" / "ALL OF THEM" ----------
  const userSaysBothOrAll = /\b(both|both really|all of (them|those|the above)|all really)\b/.test(
    userLower
  );

  if (userSaysBothOrAll && lastAssistant) {
    const laLower = lastAssistant.content.toLowerCase();
    const looksLikeOptions =
      lastAssistant.content.includes('•') ||
      /\bor\b/.test(laLower) ||
      /1\)/.test(laLower) ||
      /2\)/.test(laLower);

    if (looksLikeOptions) {
      const businessLabel = profile.businessType ? `in your ${profile.businessType}` : 'in your business';

      const replyText = `Got you — sounds like it’s a mix of both ${businessLabel}. Would it help to see it working on a quick Zoom, so you can picture it properly?`;

      flow.stage = 'offer_zoom';

      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'offer_zoom');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }
  }

  // ---------- RULE-BASED FAST REPLIES (MORE VARIATION; LESS SCRIPTY) ----------
  if (!DISABLE_RULE_BASED) {
    const hasBookingIntent =
      booking.intent === 'mybizpal_consultation' ||
      behaviour.bookingReadiness === 'high' ||
      strongBookNowRegex.test(userLower);

    if (isVoice && hasBookingIntent) {
      flow.stage = 'collect_contact';
      const replyText = buildFastConsultStep(callState, { isVoice });
      ensureLastUserInHistory(history, safeUserText);
      history.push({ role: 'assistant', content: replyText });
      registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (isVoice) {
      if (!profile.businessType) {
        flow.stage = 'discovery';
        const replyText = pickRandom([
          'Quick one — what type of business is it?',
          'What kind of business are you running?',
          'What sort of business is this for?',
        ]);
        ensureLastUserInHistory(history, safeUserText);
        history.push({ role: 'assistant', content: replyText });
        registerAssistantForLoopGuard(callState, replyText, 'business_type');
        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      }

      if (!behaviour.painPointsMentioned) {
        flow.stage = 'discovery';
        const biz = profile.businessType ? ` in your ${profile.businessType}` : '';
        const replyText = pickRandom([
          `Where do enquiries usually go wrong${biz} — missed calls, slow replies, or bookings not confirmed?`,
          `What’s the main issue${biz} — missed calls, WhatsApp replies, or booking follow-ups?`,
          `What’s costing you work${biz} — missed calls, slow messages, or people not getting booked in?`,
        ]);
        ensureLastUserInHistory(history, safeUserText);
        history.push({ role: 'assistant', content: replyText });
        registerAssistantForLoopGuard(callState, replyText, 'pain_point');
        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      }

      if (behaviour.painPointsMentioned && behaviour.bookingReadiness !== 'low') {
        // Ask one qualifying question before offering Zoom
        if (flow.lastQuestionTag !== 'missed_calls_volume') {
          flow.stage = 'discovery';
          const replyText = pickRandom([
            'Roughly how many missed calls do you reckon you get on a normal day?',
            'On a typical day, how many calls do you think you miss?',
            'Ballpark — how many missed calls per day?',
          ]);

          ensureLastUserInHistory(history, safeUserText);
          history.push({ role: 'assistant', content: replyText });
          registerAssistantForLoopGuard(callState, replyText, 'missed_calls_volume');
          snapshotSessionFromCall(callState);
          return { text: replyText, shouldEnd: false };
        }

        // If they just answered volume, bridge to Zoom offer
        const vol = extractApproxVolume(safeUserText);
        if (vol !== null) {
          behaviour.interestLevel = behaviour.interestLevel === 'unknown' ? 'high' : behaviour.interestLevel;
        }

        const offerText = pickRandom([
          'Thanks — that helps. Want to see how it would work for you on a quick Zoom?',
          'Got it. Would a quick Zoom help, just so you can see it working?',
          'Nice — would it be useful to jump on a short Zoom and show you what that looks like?',
        ]);

        if (wouldRepeat(callState, offerText) || flow.lastQuestionTag === 'offer_zoom') {
          booking.intent = booking.intent || 'mybizpal_consultation';
          behaviour.bookingReadiness = behaviour.bookingReadiness === 'low' ? 'low' : 'high';
          flow.stage = 'collect_contact';

          const replyText = buildFastConsultStep(callState, { isVoice });

          ensureLastUserInHistory(history, safeUserText);
          history.push({ role: 'assistant', content: replyText });
          registerAssistantForLoopGuard(callState, replyText, 'collect_contact');
          snapshotSessionFromCall(callState);
          return { text: replyText, shouldEnd: false };
        }

        flow.stage = 'offer_zoom';

        ensureLastUserInHistory(history, safeUserText);
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
      booking.intent === 'mybizpal_consultation' || behaviour.bookingReadiness === 'high';

    const mentionsEmail = /\b(email|e-mail|e mail)\b/.test(lower) || /\bzoom link\b/.test(lower);

    const hardBookingPhrases =
      /\b(book you in|get you booked|lock that in|lock it in|i can book you|let me get you booked|schedule (a )?(call|consultation|meeting))\b/.test(
        lower
      );

    if (!hasBookingIntent && (mentionsEmail || hardBookingPhrases)) {
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
        if (/\b(book you in|get you booked|lock that in|lock it in|book you for)\b/.test(sLower)) return false;
        return true;
      });

      let cleaned = filtered.join(' ').trim();

      if (!cleaned) {
        cleaned = isVoice
          ? 'Before we book anything, what kind of business is it and what’s going wrong with enquiries?'
          : 'Before we book anything, what kind of business is it and what’s going wrong with enquiries — missed calls, slow replies, or bookings not confirmed?';
      } else {
        const tail = isVoice
          ? ' Before we book anything, what kind of business is it and what’s going wrong with enquiries?'
          : ' Before we book anything, what kind of business is it and what’s going wrong with enquiries?';
        cleaned += tail;
      }

      return cleaned;
    }

    return botText;
  }

  // ---------- OPENAI CALL ----------
  const systemPrompt = isVoice ? buildSystemPromptVoice(callState) : buildSystemPromptChat(callState);
  const messages = [{ role: 'system', content: systemPrompt }];

  // keep context lean for speed
  const recent = isVoice ? history.slice(-4) : history.slice(-8);
  for (const msg of recent) messages.push({ role: msg.role, content: msg.content });
  messages.push({ role: 'user', content: safeUserText });

  let botText = '';

  try {
    const timeoutMs = isVoice ? 2500 : 4500;
    const maxTokens = isVoice ? 90 : 180;

    botText = await callOpenAIWithTimeout({
      model: isVoice ? MODEL_VOICE : MODEL_CHAT,
      messages,
      maxTokens,
      temperature: isVoice ? 0.7 : 0.75, // slightly higher for spontaneity
      timeoutMs,
    });
  } catch (err) {
    console.error('Primary OpenAI call failed or timed out:', err);
  }

  // slim fallback for chat if empty
  if (!botText && isChat) {
    try {
      const lastAssistantForSlim = [...history].slice().reverse().find((m) => m.role === 'assistant');

      const slimMessages = [
        {
          role: 'system',
          content:
            'You are Gabriel from MyBizPal. Continue naturally in a warm UK tone. Be helpful, brief, and human. Match the user’s sentiment with a short empathy line, then ask ONE specific question.',
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
        maxTokens: 150,
        temperature: 0.8,
        timeoutMs: 3000,
      });
    } catch (err2) {
      console.error('Second OpenAI call failed:', err2);
    }
  }

  if (!botText) {
    botText = buildContextualFallback({ profile, callState });
  }

  // ---------- POST-PROCESS: LIGHT TOUCH (avoid making it robotic) ----------
  botText = String(botText || '').trim();
  botText = botText.replace(/—/g, '-').replace(/\.{2,}/g, '.');

  // Remove common "AI-ish" disclaimers if they slip in
  botText = botText.replace(
    /I (do not|don't) have (a )?way to (reliably )?remember past (chats|conversations) with you[^.]*\./gi,
    ''
  );
  botText = botText.replace(/I (only|can only) see (what('?s| is) )?in this conversation( right now)?\.?/gi, '');

  // If the model apologises for confusion too often, redirect to a productive question
  const confusionRegex =
    /sorry[, ]+i (do not|don't|did not|didn't) (quite )?(understand|follow) that[^.]*\.?/gi;

  if (confusionRegex.test(botText)) {
    botText = buildContextualFallback({ profile, callState });
  }

  botText = botText.trim();

  // Guard: first assistant turn on voice should not jump to email
  const isFirstAssistantTurn = !hasAnyAssistantInHistory;
  if (isVoice && isFirstAssistantTurn && /email/i.test(botText) && !booking.intent && !profile.businessType) {
    const namePrefix = booking.name ? `${booking.name}, ` : '';
    botText = `${namePrefix}before we grab any details, what kind of business is it and what are you trying to fix — missed calls, slow replies, or bookings?`;
  }

  // Slightly reduce awkward phrasing created by model
  botText = botText
    .replace(/\btwo quick things so i can lock it in\b/gi, 'Quick one before we book anything')
    .replace(/\bto lock that in\b/gi, 'to get that booked');

  // Normalize time formats a bit
  botText = botText.replace(/\b([0-1]?\d):00\s*([AaPp])\.?m\.?\b/g, (_, h, ap) => `${h}${ap.toLowerCase()}m`);
  botText = botText.replace(/\b([0-1]?\d)\s*([AaPp])\.?m\.?\b/g, (_, h, ap) => `${h}${ap.toLowerCase()}m`);
  botText = botText.replace(
    /\b([0-1]?\d):([0-5]\d)\s*([AaPp])\.?m\.?\b/g,
    (_, h, m, ap) => `${h}:${m}${ap.toLowerCase()}m`
  );

  botText = cleanEarlyBookingAndEmail(botText, { booking, behaviour, isVoice });

  // Add a light empathy prefix sometimes (sentiment-aware) to avoid robotic feel
  botText = applyTonePrefixIfHelpful(callState, botText);

  // Respect "already greeted" flag to avoid re-introducing
  const alreadyGreeted = !!callState.greeted || history.length > 0 || !!callState._hasTextGreetingSent;
  if (alreadyGreeted) {
    botText = botText
      .replace(
        /^Good\s+(morning|afternoon|evening|late)[^.!\n]*?I['’` ]m\s+Gabriel\s+from\s+MyBizPal[.!?]*\s*/i,
        ''
      )
      .trim
