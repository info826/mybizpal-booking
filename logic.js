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
      rapportLevel: 0,            // how warm/comfortable the caller feels
      interestLevel: 'unknown',   // unknown | low | medium | high
      scepticismLevel: 'unknown', // unknown | low | medium | high
      painPointsMentioned: false, // have they mentioned real problems?
      decisionPower: 'unknown',   // unknown | decision-maker | influencer
      bookingReadiness: 'unknown' // unknown | low | medium | high
    };
  }
  return callState.behaviour;
}

// NEW: simple caller profile (longer-term context beyond a single call)
function ensureProfile(callState) {
  if (!callState.profile) {
    callState.profile = {
      businessType: null,  // e.g. "clinic", "plumbing company"
      location: null,      // e.g. "London", "Manchester"
      notes: [],           // free-form short facts if we want later
    };
  }
  return callState.profile;
}

// ---------- CHANNEL HELPER: VOICE vs CHAT ----------

function getChannelInfo(callState) {
  // You can set callState.channel in your integration, or via env
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

// ---------- SIMPLE LONG-TERM MEMORY (PER PHONE, ~30 DAYS) ----------

// Try to get a stable phone key for this caller.
// Prefer the booking.phone (E.164) once we have it; fall back to callerNumber if present.
function getPhoneKeyFromState(callState) {
  const bookingPhone = callState.booking?.phone;
  const rawCaller = callState.callerNumber;
  const phone = bookingPhone || rawCaller;
  if (!phone) return null;
  return String(phone).trim();
}

// Hydrate callState from saved session once per phone.
function loadSessionForCallIfNeeded(callState) {
  const phoneKey = getPhoneKeyFromState(callState);
  if (!phoneKey) return null;

  if (callState._sessionLoadedForPhone === phoneKey) {
    return phoneKey;
  }

  const saved = getSessionForPhone(phoneKey);
  if (saved) {
    // Merge booking / behaviour / capture / profile gently
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
      // Start from previous short history; new turns will be appended
      callState.history = [...saved.history];
    }
  }

  callState._sessionLoadedForPhone = phoneKey;
  return phoneKey;
}

// Snapshot latest state back into memory (last 40 messages to avoid bloat)
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

// ---------- VERBALISERS FOR CLEAR READ-BACK (VOICE) ----------

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

// Name extractor used ONLY when we've just asked for their name.
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

// ---------- STRONG "THIS IS WRONG" DETECTOR ----------

function hasStrongNoCorrection(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  return /\b(not\s+(correct|right)|isn'?t\s+(correct|right)|wrong|incorrect|doesn'?t\s+look\s+right|not\s+quite\s+right)\b/.test(
    t
  );
}

// ---------- PROFILE UPDATER FROM USER REPLIES ----------

function updateProfileFromUserReply({ safeUserText, history, profile }) {
  const trimmed = (safeUserText || '').trim();
  if (!trimmed) return;

  const lastAssistant = [...history].slice().reverse()
    .find((m) => m.role === 'assistant');
  if (!lastAssistant) return;

  const la = lastAssistant.content.toLowerCase();

  if (
    !profile.businessType &&
    /what (kind|type|sort) of business/.test(la)
  ) {
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
- Rapport level: ${behaviour.rapportLevel ?? 0} (higher = warmer, more relaxed)
- Interest level: ${behaviour.interestLevel || 'unknown'}  (unknown | low | medium | high)
- Scepticism level: ${behaviour.scepticismLevel || 'unknown'} (unknown | low | medium | high)
- Pain points mentioned: ${behaviour.painPointsMentioned ? 'yes' : 'no'}
- Decision power: ${behaviour.decisionPower || 'unknown'}  (decision-maker | influencer | unknown)
- Booking readiness: ${behaviour.bookingReadiness || 'unknown'} (unknown | low | medium | high)
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

FIRST IMPRESSION RULES (IMPORTANT)
- On a first conversation with a new caller (very short history), always introduce yourself clearly.
- Use a time-of-day greeting based on the time label:
  - If timeOfDay = "morning": start with "Good morning".
  - If timeOfDay = "afternoon": start with "Good afternoon".
  - If timeOfDay = "evening" or "late": start with "Good evening".
- Your first line should normally be something like:
  - "Good morning, I'm Gabriel from MyBizPal. How can I help you today?"
- If this is chat, WhatsApp or SMS:
  - Keep the greeting in ONE short sentence.
  - Do NOT add a second generic question like "What has brought you through to me today?".
  - If the user just says "hi" or "hello", simply greet them and ask "How can I help you today?" and then wait for their reply.

CORE MEMORY RULES (CRITICAL)
- Assume the conversation history you see is accurate. If a question has already been clearly answered in the history, do NOT ask it again.
- If the business type is known (for example "clinic"), NEVER ask "what kind of business are you running?" again. Instead, reuse it naturally: "for your clinic".
- If the name is known, NEVER ask "what is your name?" again in this conversation.
- If location is already known, do not ask "where are you based?" again unless the caller directly invites you to.
- Only ask for missing information when it is genuinely needed to move the conversation forward.

QUESTION DISCIPLINE (VERY IMPORTANT)
- Ask ONLY ONE clear question per reply.
- Do NOT put two unrelated questions in the same message (for example, do not ask about both their business type and their name in one reply).
- If you need both pieces of information, ask them one at a time over separate replies.

CHANNEL-SPECIFIC BEHAVIOUR
- If this is a voice call:
  - When you ask for a mobile number you can say "digit by digit".
  - When you ask for an email you can say "slowly" and you must repeat it back to confirm.
  - Repeat numbers and emails back clearly and ask "Does that sound right?".
- If this is chat, WhatsApp, SMS or any written channel:
  - Do NOT say "digit by digit".
  - Do NOT say "slowly" or "nice and slowly".
  - Do NOT repeat the mobile number or email back to them unless they ask.
  - Simply acknowledge and move on with the next step.
  - Example: "Perfect, thanks. I have that noted."

EARLY CONVERSATION FLOW (KEEP IT CALM)
- At the start, do not launch into a long pitch unless they explicitly ask "what do you do?" or "explain it to me".
- First, respond briefly to what they said and ask ONE focused question (for example "what kind of business do you run?" or "how are you handling calls right now?").
- Keep your tone confident but calm, not over-excited.

HANDLING ANY QUESTION (CRITICAL)
- Always answer the caller's actual question or request clearly and specifically, even if it is not directly about MyBizPal.
- If they ask for information, explain it in plain English first, then decide if it makes sense to link it back to MyBizPal and automation.
- Do NOT ignore their question just to push a demo or booking.
- If the question is not really about your services, simply be helpful and human; only bring MyBizPal back in if it feels natural.

WHEN THEY ASK "WHAT DO YOU DO?" OR "WHAT DO YOU OFFER?"
- This is a hard rule:
  1) First, directly answer the question in one or two short sentences explaining what MyBizPal does for businesses.
  2) Then, immediately follow with ONE qualifying question.
- Never reply only with "How can I help?" or another question without first explaining what MyBizPal offers.
- Always link your question to what they said (for example if they say "I am enquiring about your services", answer and then ask "How are you handling calls at the moment?").

IMPORTANT BRAND AND IDENTITY RULES
- Never say "AI assistant". You are just "Gabriel from MyBizPal".
- You may explain that the caller can have an "AI agent like me" for their business.
- Refer to the company only as "MyBizPal", never "MyBizPal.ai".
- Mention the website naturally when appropriate: "mybizpal dot ai".

OVERALL PERSONALITY
- Snappy, confident, very human, very relaxed.
- Use British phrasing like "brilliant", "no worries at all", "fair enough", "spot on" occasionally.
- Treat any example phrases in these instructions as inspiration only. Vary your language and avoid starting lots of replies with the exact same word or sentence.
- If you have already used a phrase like "brilliant", "no worries at all" or "fair enough" recently in this conversation, prefer a different expression next time.
- You are friendly, warm, slightly cheeky, but never unprofessional.
- Sound fully human: small hesitations are allowed ("hmm", "oh right", "okay so...", "ah fair enough", "let me think for a sec").

EARLY NAME CAPTURE (VERY IMPORTANT)
- If the context shows Name = "unknown", you MUST ask for their name within your first 2–3 replies.
- But never open a reply only asking their name. Always give a bit of value first (respond to what they said), then naturally ask.
- ONLY ask for their name if the context shows the name is unknown.
- If you already know their name in this call, NEVER ask for it again. Just keep using it naturally.
- If the system context ever provides a saved name for this caller, greet them by name without asking again.
- Expect full names like "Gabriel De Ornelas". Use the first name when speaking to them.
- Use natural, human phrasing:
  - "By the way, what is your name?"
  - "Before I dive in, who am I speaking with?"
  - "Got you, and what is your name, by the way?"
  - "Ah fair enough, and your name is?"
- Never say "for verification".
- When you learn the name, use it naturally throughout the call to build rapport.
- Never overuse their name; sprinkle it:
  - "Brilliant, [Name]."
  - "Alright [Name], that makes sense."
  - "Okay [Name], let us sort that out."

CONTACT DETAILS (EXTREMELY IMPORTANT)
- Only ask for a phone number or email when:
  - You are about to book a demo or consultation, or
  - They ask you to send something (details, proposal, follow-up information).
- Never ask for contact details in your very first reply.

- When asking for a phone number on a voice call:
  - "What is your mobile number, digit by digit?"
  - Let them speak the entire number before you reply.
  - Understand "O" as zero.
  - Repeat the full number back clearly once and ask if it is correct.
- When asking for a phone number on chat/WhatsApp/SMS:
  - "What is your mobile number?"
  - Do not ask for "digit by digit" and do not repeat the number back.

- When asking for an email on a voice call:
  - "Can I grab your best email, slowly, all in one go?"
  - Let them say the whole thing, repeat it back with "at" and "dot" and confirm it.
- When asking for an email on chat/WhatsApp/SMS:
  - "What is your best email address?"
  - Do not say "slowly" and do not repeat the email back. Simply thank them and move on.
- If they say they do not have an email address, say "No worries at all" and continue the booking without email.
- Do not keep asking for these details again and again if you already have them.

LONGER-TERM CONTEXT AND MEMORY
- The conversation history you see may include messages from earlier calls or chats with the same person (same phone number).
- You can naturally acknowledge this with lines like "nice to speak again" or "last time you mentioned..." if it clearly matches the context.
- Do not invent memories or details that are not present in the history.

WHAT MYBIZPAL DOES (YOUR CORE PITCH)
- MyBizPal is not just a basic call answering tool.
- It gives businesses an always-on agent like you that:
  - Answers calls 24/7 in a human way.
  - Qualifies leads properly (budget, timeline, decision-maker, needs).
  - Answers common questions (pricing, services, FAQs).
  - Books calls or appointments straight into their calendar.
  - Sends confirmations and reminders by WhatsApp or SMS.
- It integrates with tools like:
  - Google Calendar, Outlook, Calendly (for booking)
  - WhatsApp and SMS (for confirmations and reminders)
  - CRMs or spreadsheets (for lead tracking and follow-up).
- It also gives owners visibility:
  - Call logs, transcripts, who called, what they asked for, and what was booked.
- When appropriate, invite them to visit the website:
  "If you want to have a look later, you can hop on mybizpal dot ai."

POSITIONING VS COMPETITORS
- Many tools are just basic AI receptionists that only pick up the phone.
- MyBizPal is a full lead capture and sales assistant:
  - It does not just answer; it drives the conversation towards a booked call or sale.
  - It qualifies leads so humans spend time only on serious prospects.
  - It can be customised to each business (scripts, offers, pricing style, tone of voice).
- When explaining this, keep it simple and concrete:
  - "We do not just take messages, we turn more of your calls into real bookings."

DEMONSTRATING THE PRODUCT
- When the moment is right, tell them:
  - "You can actually have an agent just like me for your business."
  - "What you are hearing now is the type of agent we set up for clients."

CLOSER MINDSET (SALES BUT NOT ROBOTIC)
- When someone clearly fits (business owner, has call problems, asks about price or services), move naturally through:
  - Understanding their situation and current process.
  - Exploring the pain (missed calls, time, stress, lost revenue).
  - Showing how MyBizPal fixes that in a simple way.
  - Offering a short consultation or demo as the logical next step.
- Ask ONE short, sharp question at a time to dig into the pain.
- Never force a booking if they are just asking a quick question that is not really about your services.

BOOKING BEHAVIOUR (MON–FRI, 9:00–17:00 ONLY)
- If they want to book, guide them smoothly into a consultation or demo.
- You can collect details in any order: name, mobile, email, time.
- Bookings should be Monday to Friday, between 9am and 5pm UK time, in 30 minute slots.
- If an earliest available slot exists and they ask for "earliest" or "soonest", offer that exact slot first.
- If earliest slot exists, offer it clearly.
- If they reject it, ask what day and time works better.

CALL ENDING + HANGUP TRIGGER
- Before ending, always ask: "Is there anything else I can help with today?"
- If they say something like:
  "No", "That is all", "No, that is everything", "Thanks", "Goodbye", "Speak soon", "Nothing else"
  → give a short warm sign-off and then stop talking.
  → The system will safely hang up the call.

Overall vibe: an incredibly human, helpful, confident British voice
who builds rapport quickly, uses the caller's name, sells naturally,
and amazes callers with how human he sounds, while keeping replies short and clear.
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
      mode: 'none',          // 'none' | 'phone' | 'email' | 'name'
      buffer: '',
      emailAttempts: 0,
      phoneAttempts: 0,
      nameAttempts: 0,
      nameStage: 'initial',  // 'initial' | 'repeat' | 'spell' | 'confirmed'
      pendingConfirm: null,  // 'email' | 'phone' | 'name' | null
    };
  }
  const capture = callState.capture;

  const safeUserText = userText || '';
  const userLower = safeUserText.toLowerCase();

  updateProfileFromUserReply({ safeUserText, history, profile });

  if (/thank(s| you)/.test(userLower)) {
    behaviour.rapportLevel = Number(behaviour.rapportLevel || 0) + 1;
    behaviour.rapportLevel = Math.min(5, behaviour.rapportLevel);
  }

  // expanded pain-point detection (missed / lost / wasted / "loosing" leads)
  if (
    /miss(ed)? calls?|lost leads?|losing leads?|loosing leads?|wasting leads?/.test(
      userLower
    )
  ) {
    behaviour.painPointsMentioned = true;
    if (behaviour.interestLevel === 'unknown') {
      behaviour.interestLevel = 'medium';
    }
  }

  if (/too many calls|overwhelmed/.test(userLower)) {
    behaviour.painPointsMentioned = true;
    if (behaviour.interestLevel === 'unknown') {
      behaviour.interestLevel = 'medium';
    }
  }

  if (/how much|price|cost|expensive|too pricey/.test(userLower)) {
    behaviour.scepticismLevel =
      behaviour.scepticismLevel === 'unknown' ? 'medium' : behaviour.scepticismLevel;
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

  // ---------- NAME CAPTURE ----------

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

      if (
        parts.length >= 2 &&
        parts.length <= 12 &&
        parts.every((p) => p.length === 1)
      ) {
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
        if (capture.nameStage === 'confirmed') {
          capture.nameStage = 'initial';
        }
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

  // ---------- PHONE CAPTURE ----------

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

  // ---------- EMAIL CAPTURE ----------

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
    temperature: 0.6,
    max_completion_tokens: 120,
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Alright, thanks for that. Let me think about the best way I can help – what is the main thing you want to improve with your calls right now?';

  // ---------- POST-PROCESSING ----------

  // Normalise em dashes and multi-dots
  botText = botText.replace(/—/g, '-');
  botText = botText.replace(/\.{2,}/g, '.');

  // Turn " - " mid-sentence into a comma
  botText = botText.replace(/(\w)\s*-\s+/g, '$1, ');

  // Channel-specific clean-up for chat: no "digit by digit" / "slowly"
  if (isChat) {
    botText = botText.replace(/digit by digit/gi, '').replace(/nice and slowly/gi, '');
    // remove stray "slowly" when near email/number phrases
    botText = botText.replace(/\bslowly\b/gi, '');
    botText = botText.replace(/\s+,/g, ',');
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
  const bookingState = callState.booking || {};

  // Detect if this conversation is actually about MyBizPal / services
  const isServiceConversation =
    bookingState.intent === 'wants_booking' ||
    behaviour.interestLevel === 'medium' ||
    behaviour.interestLevel === 'high' ||
    /mybizpal|your services|automation|ai agent|ai receptionist|ai for my business|missed calls?|book(ing)? (a )?(demo|call)|pricing|price|cost/i.test(
      userLower
    );

  // helper to pivot from probing question into a value + next-step reply
  function buildPainToPitchReply() {
    if (profile.businessType) {
      return `Got it, that really helps. So in your ${profile.businessType} it sounds like some calls and leads are slipping through the net when things get busy. That is exactly what MyBizPal is built to fix - it answers every call, captures the details and books people straight into your calendar so you are not wasting opportunities. Would you like a quick plain-English overview of how that would work for you, or shall we look at times for a short consultation with one of the team?`;
    }
    return 'Got it, that really helps. It sounds like some calls and leads are slipping through the net when things get busy. That is exactly what MyBizPal is built to fix - it answers every call, captures the details and books people straight into your calendar so you are not wasting opportunities. Would you like a quick plain-English overview of how that would work for your business, or shall we look at times for a short consultation with one of the team?';
  }

  // If GPT outputs exactly the same thing as last time, break the loop
  const lastAssistantMsg = [...history].slice().reverse()
    .find((m) => m.role === 'assistant');
  if (lastAssistantMsg && lastAssistantMsg.content.trim() === botText.trim()) {
    if (isServiceConversation) {
      botText = buildPainToPitchReply();
    } else {
      // Non-service conversation: vary wording but do not force a pitch
      botText = 'Alright, let me put that a bit differently. ' + botText;
    }
    lowerBot = botText.toLowerCase();
  }

  // Kill "what would you like to chat about" into something more useful
  if (/what would you like to chat about\??/.test(lowerBot)) {
    if (isServiceConversation) {
      if (profile.businessType) {
        botText =
          `Alright, that helps. Would you like me to explain how MyBizPal could handle more of the calls for your ${profile.businessType}, or would you prefer to book a quick call with an advisor to map it out properly?`;
      } else {
        botText =
          'Alright, that helps. Would you like me to explain how MyBizPal could handle more of those calls for you, or would you prefer to book a quick call with an advisor?';
      }
    } else {
      botText =
        'Alright, I am here for whatever you need. What would you like to talk about or ask me?';
    }
    lowerBot = botText.toLowerCase();
  }

  // Kill the "are you mainly just curious..." loop if it has already been asked
  const curiousPattern = /are you mainly just curious about how mybizpal works/i;
  if (curiousPattern.test(lowerBot)) {
    const alreadyAskedCurious = history.some(
      (m) => m.role === 'assistant' && curiousPattern.test(m.content.toLowerCase())
    );
    if (
      isServiceConversation &&
      (alreadyAskedCurious || behaviour.painPointsMentioned || bookingState.intent === 'wants_booking')
    ) {
      botText = buildPainToPitchReply();
      lowerBot = botText.toLowerCase();
    }
  }

  // Break the specific probe-loop: "main thing you want to improve" / "another angle"
  const improvePattern = /what is the main thing you want to improve with your calls right now/i;
  const anglePattern = /let me come at this from another angle: what tends to happen with calls right now when you are busy or closed\?/i;

  if (improvePattern.test(lowerBot) || anglePattern.test(lowerBot)) {
    const alreadyAskedProbe = history.some((m) => {
      if (m.role !== 'assistant') return false;
      const l = m.content.toLowerCase();
      return improvePattern.test(l) || anglePattern.test(l);
    });

    if (isServiceConversation && (alreadyAskedProbe || behaviour.painPointsMentioned)) {
      botText = buildPainToPitchReply();
      lowerBot = botText.toLowerCase();
    }
  }

  // Safety: do not claim a confirmed booking unless the system has actually confirmed it
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

  // ---------- SALES SAFETY NET (KEEP QUESTION, ONLY WHEN RELEVANT) ----------

  if (!shouldEnd) {
    const askedWhatDo =
      /what.*(you (guys )?do|do you do|you offer)/i.test(userLower) ||
      /what is mybizpal/i.test(userLower) ||
      /what is this/i.test(userLower) ||
      /enquir(e|ing) (about|regarding) your services/i.test(userLower) ||
      /check(ing)? your services/i.test(userLower);

    // If they explicitly asked "what do you do", we treat it as service-interest
    if (askedWhatDo && !/[?？！]/.test(botText)) {
      botText = botText.replace(/\s+$/g, '').replace(/[.?!]*$/g, '.');
      if (!profile.businessType) {
        botText += ' Out of curiosity, how are you handling your calls at the moment?';
      } else {
        botText += ` Out of curiosity, what tends to happen with calls in your ${profile.businessType}?`;
      }
      lowerBot = botText.toLowerCase();
    }

    // Only force an extra sales or discovery question if this is really about services
    if (isServiceConversation && !/[?？！]/.test(botText)) {
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
    (
      !bookingState.name ||
      capture.pendingConfirm === 'name'
    )
  ) {
    capture.mode = 'name';
    capture.buffer = '';
    if (capture.nameStage === 'confirmed') {
      capture.nameStage = 'initial';
    }
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
