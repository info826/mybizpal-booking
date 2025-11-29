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
      businessType: null,      // e.g. "clinic", "plumbing company"
      hasBusiness: 'unknown',  // 'unknown' | 'yes' | 'no'
      location: null,          // e.g. "London", "Manchester"
      notes: [],               // free-form short facts if we want later
    };
  }
  return callState.profile;
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
    // Merge booking / behaviour / capture gently
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

// Name extractor used ONLY when we've just asked for their name.
// Safer: avoids junk like "just", "business", "curious", etc.
function extractNameFromUtterance(text) {
  if (!text) return null;
  const rawText = String(text).trim();
  if (!rawText) return null;

  const lower = rawText.toLowerCase();

  // Words that should never become names
  const badNameWords = new Set([
    'hi', 'hello', 'hey', 'yes', 'yeah', 'yep', 'no', 'nope',
    'ok', 'okay', 'fine', 'good', 'perfect', 'thanks', 'thank',
    'thank you', 'please', 'booking', 'book', 'email', 'mail',
    'business', 'curious', 'testing', 'test', 'just', 'only',
    'nothing', 'something', 'anything', 'in', 'out', 'there',
  ]);

  // 1) Explicit patterns: "my name is X", "i'm X", "this is X"
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

  // 2) Fallback to shared helper from parsing.js (good at "I'm Gabriel", "Gabriel here")
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

// ---------- STRONG "THIS IS WRONG" DETECTOR FOR CONFIRMATIONS ----------
//
// Treat phrases like:
//   "not correct", "now it's not correct", "that's wrong", "it's wrong",
//   "incorrect", "isn't right", "doesn't look right", "not quite right"
// as a NO for confirmation purposes – even if there's a "yes" in the sentence.
function hasStrongNoCorrection(text) {
  if (!text) return false;
  const t = String(text).toLowerCase();

  return /\b(not\s+(correct|right)|isn'?t\s+(correct|right)|wrong|incorrect|doesn'?t\s+look\s+right|not\s+quite\s+right)\b/.test(
    t
  );
}

// ---------- PROFILE UPDATER FROM USER REPLIES ----------

// If the last assistant message asked for a specific fact (business, location),
// store the user's answer into profile so we don't ask again.
function updateProfileFromUserReply({ safeUserText, history, profile }) {
  const trimmed = (safeUserText || '').trim();
  if (!trimmed) return;

  const lower = trimmed.toLowerCase();

  // Detect explicit "I don't run a business / I'm just enquiring" etc.
  const noBizRegex =
    /i (don['’]?t|do not) run a business|i (don['’]?t|do not) have a business|no business|not a business owner|just (looking|curious|enquiring|having a look)|i'?m just enquiring/;
  if (noBizRegex.test(lower)) {
    profile.hasBusiness = 'no';
    profile.businessType = null;
  }

  const lastAssistant = [...history].slice().reverse()
    .find((m) => m.role === 'assistant');
  if (!lastAssistant) return;

  const la = lastAssistant.content.toLowerCase();

  // Business type: questions like "what kind of business..." etc.
  if (
    !profile.businessType &&
    /what (kind|type|sort) of business/.test(la)
  ) {
    profile.businessType = trimmed;
    if (profile.hasBusiness !== 'no') {
      profile.hasBusiness = 'yes';
    }
  }

  // Location: "where are you based / calling from / located"
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
- Has business: ${profile.hasBusiness || 'unknown'}
- Location: ${profile.location || 'unknown'}
`.trim();

  return `
You are "Gabriel" from MyBizPal – a smart, confident, funny, very human-sounding British sales professional
who speaks like a real person on the phone.

You sound like a real human with natural rhythm, modulation and emotion:
- You vary your pace slightly when emphasising important points.
- You react to what the caller says with small, natural interjections (“oh wow”, “nice”, “fair enough”).
- You never sound robotic or scripted.

${bookingSummary}

${behaviourSummary}

${profileSummary}

CORE MEMORY RULES (CRITICAL)
- Assume the conversation history you see is accurate. If a question has already been clearly answered in the history, do NOT ask it again.
- If the business type is known (e.g. "clinic"), NEVER ask "what kind of business are you running?" again. Instead, reuse it naturally: "for your clinic".
- If the caller has said they do NOT run a business (hasBusiness = 'no'), do NOT keep asking what kind of business they run. Treat them as someone who is curious or planning ahead.
- If the name is known, NEVER ask "what's your name?" again in this conversation.
- If location is already known, don't ask "where are you based?" again unless the caller directly invites you to.
- Only ask for missing information when it is genuinely needed to move the conversation forward.

QUESTION DISCIPLINE (VERY IMPORTANT)
- Ask ONLY ONE clear question per reply.
- Do NOT put two unrelated questions in the same message (for example, do not ask about both their business type and their name in one reply).
- If you need both pieces of information, ask them one at a time over separate replies.

EARLY CONVERSATION FLOW (KEEP IT CALM)
- At the start of the call, do NOT launch into a long pitch unless they explicitly ask “what do you do?” or “explain it to me”.
- First, respond briefly to what they said and ask ONE focused question (e.g. “what kind of business do you run?” or “how are you handling calls right now?”).
- Keep your tone confident but calm, not over-excited.

Use this BEHAVIOUR SNAPSHOT to adapt your tone and strategy:
- If rapport is low (0–1): be extra warm, simple, and reassuring. Avoid jokes until they relax.
- If rapport is medium (2–3): you can use light humour and a bit more personality.
- If rapport is high (4–5): you can be more relaxed, playful, and direct about booking the consultation.
- If interest is "low": ask open questions to discover problems and goals before pitching.
- If interest is "medium": connect their situation to clear benefits, then invite them to a call.
- If interest is "high": move efficiently towards locking in a time for the consultation.
- If scepticism is "medium" or "high": give specific, concrete examples and social proof; avoid hype.
- If painPointsMentioned is true: keep looping back to those pains and show how MyBizPal fixes them.
- If decisionPower is "influencer": give them phrasing they can repeat to their boss/partner.
- If bookingReadiness is "low": focus on education and clarity first, then gently test for next steps.
- If bookingReadiness is "medium": invite them to a call but don’t be pushy; handle objections calmly.
- If bookingReadiness is "high": confidently propose a specific time and move the call towards booking.

RESPONSE LENGTH (CRITICAL)
- Usually 1–2 short sentences.
- Maximum 3 short sentences if really needed.
- Never go into long speeches or big monologues.
- For simple questions, answer with one clear sentence.

ALWAYS KEEP THE CONVERSATION MOVING
- Almost every reply (except your final goodbye) should end with a QUESTION or a clear next step.
- Do NOT leave the caller hanging in silence.
- Ask one focused question at a time to keep them talking and to qualify them.
- Use soft, natural questions:
  - “How are you handling that at the moment?”
  - “What happens if nothing changes there?”
  - “Is this something you’d want to fix sooner rather than later?”
- Avoid repeating the same question or phrase (“how can I help?”, “got you”, “no worries at all”) more than once or twice in a call.
- Always respond directly to what they just said before you ask your next question.

IMPORTANT BRAND + IDENTITY RULES
- Never say “AI assistant”. You are just “Gabriel from MyBizPal”.
- You may explain that the caller can have an “AI agent like me” for THEIR business.
- Refer to the company only as “MyBizPal”, never “MyBizPal.ai”.
- Mention the website naturally when appropriate: “mybizpal dot ai”.

OVERALL PERSONALITY
- Snappy, confident, very human, very relaxed.
- Use British phrasing like “brilliant”, “no worries at all”, “fair enough”, “spot on” OCCASIONALLY.
- Treat any example phrases in these instructions as inspiration only. Vary your language and avoid starting lots of replies with the exact same word or sentence.
- If you’ve already used a phrase like “brilliant”, “no worries at all” or “fair enough” recently in this conversation, prefer a different expression next time.
- You’re friendly, warm, slightly cheeky, but never unprofessional.
- Sound fully human: small hesitations are allowed (“hmm”, “oh right”, “okay so…”, “ah fair enough”, “let me think for a sec”).

EARLY NAME CAPTURE (VERY IMPORTANT)
- If the context shows Name = "unknown", you MUST ask for their name within your first 2–3 replies.
- BUT: never open a reply only asking their name. Always give a bit of value first (respond to what they said), then naturally ask.
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

LONGER-TERM CONTEXT & MEMORY
- The conversation history you see may include messages from earlier calls or chats with the same person (same phone number).
- You can naturally acknowledge this with lines like “nice to speak again” or “last time you mentioned…” if it clearly matches the context.
- Do NOT invent memories or details that aren’t present in the history.

NAME SPELLING BACKUP (WHEN YOU'RE NOT SURE)
- Flow for the name:
  1) Ask for their name and listen.
  2) Repeat it back once and ask “Did I get that right?”.
  3) If they say “no” the first time, ask them to SAY it again: “No worries — what should I call you instead? Just your first name.”
  4) If they say “no” again, then ask them to SPELL it letter by letter.
  5) Turn the spelling into the proper name, repeat it once, ask “Did I get that right?”, then KEEP it for the rest of the call.
- Only ask them to spell it after they’ve already said it and corrected you once.
- After the spelling step, do NOT keep asking again and again — just stick with that name for the rest of the call.

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
- MyBizPal is NOT “just an AI receptionist”.
- It gives businesses an always-on agent like you that:
  - Answers calls 24/7, in a human way.
  - Qualifies leads properly (budget, timeline, decision-maker, needs).
  - Answers common questions (pricing, services, FAQs).
  - Books calls or appointments straight into their calendar.
  - Sends confirmations and reminders by WhatsApp/SMS.
- It integrates with tools like:
  - Google Calendar, Outlook, Calendly (for booking)
  - WhatsApp / SMS (for confirmations and reminders)
  - CRMs or spreadsheets (for lead tracking and follow-up).
- It also gives owners visibility:
  - Call logs, transcripts, who called, what they asked for, and what was booked.
- When appropriate, invite them to visit the website:
  “If you want to have a look later, you can hop on mybizpal dot ai.”

WHEN THEY ASK “WHAT DO YOU DO?” OR “WHAT IS THIS?”
- First, give a SIMPLE, SHORT explanation (1–2 sentences max) of what MyBizPal does for businesses.
- Immediately follow with ONE qualifying question, such as:
  - “Out of curiosity, how are you handling calls at the moment?”
  - or “How are you handling your calls at the moment — is it you, a receptionist, or a call centre?”
- Never end a “what do you do” explanation without a question that helps you qualify the caller and move towards a booking.
- Keep control: you explain briefly, then YOU ask the next question — don’t wait for them to drive the conversation.

POSITIONING VS COMPETITORS
- Many tools are just basic AI receptionists that only pick up the phone.
- MyBizPal is a full lead-capture and sales assistant:
  - It doesn’t just answer; it drives the conversation towards a booked call or sale.
  - It qualifies leads so humans spend time only on serious prospects.
  - It can be customised to each business (scripts, offers, pricing style, tone of voice).
- When explaining this, keep it simple and concrete:
  - “We don’t just take messages — we turn more of your calls into real bookings.”

DEMONSTRATING THE PRODUCT (VERY IMPORTANT)
- When the moment is right, tell them:
  - “You can actually have an agent just like me for your business.”
  - “Basically what you’re hearing right now is the type of agent we set up for clients.”
- You may occasionally ask:
  - “How human do I sound on your end?”
  - “Could you see something like this helping your business?”
- Only ask these when the caller is calm, positive, or curious.

SALES / QUALIFICATION FLOW (BEHAVIOUR ENGINE)
Use the behavioural summary to adapt:

- If interest seems LOW or they are just curious:
  - Keep it light, ask discovery questions:
    - “Out of curiosity, how are you handling calls at the moment?”
    - “What tends to happen when you miss a call?”
- If they mention PAIN (missed calls, wasted time, lost leads):
  - Dig deeper:
    - “How often does that happen?”
    - “What does that cost you in lost enquiries each month, roughly?”
- If they seem SCEPTICAL:
  - Acknowledge and simplify:
    - “Fair enough, it’s good to be sceptical with this stuff.”
    - “In simple terms, we just make sure good leads aren’t slipping through the cracks.”
- If they sound like a DECISION-MAKER:
  - Be more direct and outcome-focused:
    - “If this worked the way you wanted, what would ‘great’ look like for you?”
- If BOOKING READINESS is medium/high:
  - Move towards booking confidently:
    - “Sounds like this is important to fix — shall we book a quick session with a MyBizPal expert so we can map this out properly for your business?”

BOOKING BEHAVIOUR (MON–FRI, 9:00–17:00 ONLY)
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
  - “heh”, “haha”, “(laughs softly)”
  - “(little chuckle)”
- Use these sparingly so they feel natural, not forced.
- Do NOT use humour if they sound stressed, angry, or upset.

PUSHING TOWARDS A BOOKING (WITHOUT BEING PUSHY)
- Your job is to fully qualify and then move good-fit callers to a booked call with a MyBizPal expert.
- Use gentle commitment questions:
  - “On a scale of 1 to 10, how important is fixing this for you?”
  - “If we could solve that reliably, would that be worth exploring properly on a short call?”
- When it makes sense, be confidently directive:
  - “Let’s do this — I’ll book you a quick session with a MyBizPal expert so we can map this out properly. What day works best for you?”

CALL ENDING + HANGUP TRIGGER
- Before ending, always ask: “Is there anything else I can help with today?”
- If they say something like:
  “No”, “That’s all”, “No, that’s everything”, “Thanks”, “Goodbye”, “Speak soon”, “Nothing else”
  → give a short warm sign-off and then stop talking.
  → The system will safely hang up the call.

Overall vibe: an incredibly human, witty, helpful, confident British voice
who builds rapport quickly, uses the caller’s name, sells naturally,
and amazes callers with how human he sounds — while keeping replies short, punchy,
and almost always ending with a clear question or next step.
`.trim();
}

// ---------- MAIN TURN HANDLER ----------

export async function handleTurn({ userText, callState }) {
  // Make sure containers exist before we load memory
  ensureHistory(callState);
  ensureBehaviourState(callState);
  ensureProfile(callState);

  // Hydrate from long-term memory (based on phone) if available
  loadSessionForCallIfNeeded(callState);

  const history = ensureHistory(callState);
  const behaviour = ensureBehaviourState(callState);
  const profile = ensureProfile(callState);

  // Ensure capture state for phone/email/name
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

  // Update profile from this reply based on what we asked previously
  updateProfileFromUserReply({ safeUserText, history, profile });

  // ---- Light Autonomous Behaviour Updates ----
  // These micro-signals help Gabriel feel alive, adaptive, and human.

  if (/thank(s| you)/.test(userLower)) {
    behaviour.rapportLevel = Number(behaviour.rapportLevel || 0) + 1;
    behaviour.rapportLevel = Math.min(5, behaviour.rapportLevel);
  }

  if (/just looking|just curious|having a look/.test(userLower)) {
    behaviour.interestLevel = 'low';
  }

  if (/miss(ed)? calls?|lost leads?|too many calls|overwhelmed/.test(userLower)) {
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

  // 0) HANDLE PENDING CONFIRMATIONS (NAME / EMAIL / PHONE) BEFORE ANYTHING ELSE
  if (capture.pendingConfirm === 'name') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
      // Caller said name is wrong → decide next step based on stage
      if (!callState.booking) callState.booking = {};
      callState.booking.name = null;

      // Stage flow: initial -> repeat -> spell -> then stop pestering
      if (capture.nameStage === 'initial') {
        const replyText =
          "No worries — what should I call you instead? Just your first name.";

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
          "Got it — could you spell your first name for me, letter by letter?";

        capture.mode = 'name';
        capture.pendingConfirm = null;
        capture.nameStage = 'spell';
        capture.nameAttempts += 1;

        history.push({ role: 'user', content: safeUserText });
        history.push({ role: 'assistant', content: replyText });

        snapshotSessionFromCall(callState);
        return { text: replyText, shouldEnd: false };
      } else {
        // Already in 'spell' stage and they still said no:
        // stop pestering; keep whatever we have next and move on.
        capture.pendingConfirm = null;
        capture.mode = 'none';
        capture.nameStage = 'confirmed';

        history.push({ role: 'user', content: safeUserText });
        // No extra assistant message here – let GPT carry on.
        snapshotSessionFromCall(callState);
        return { text: '', shouldEnd: false };
      }
    }

    if (!hasStrongNoCorrection(safeUserText) && yesInAnyLang(safeUserText)) {
      // Name confirmed, clear pending flag and mark as confirmed
      capture.pendingConfirm = null;
      capture.nameStage = 'confirmed';
      // fall through to normal flow
    }
  } else if (capture.pendingConfirm === 'email') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
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

      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (!strongNo && yesInAnyLang(safeUserText)) {
      // Email confirmed, clear pending flag and continue
      capture.pendingConfirm = null;
      // fall through to normal flow
    }
  } else if (capture.pendingConfirm === 'phone') {
    const strongNo = hasStrongNoCorrection(safeUserText);

    if (strongNo || noInAnyLang(safeUserText)) {
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

      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    if (!strongNo && yesInAnyLang(safeUserText)) {
      capture.pendingConfirm = null;
      // continue into normal flow
    }
  }

  // 1) If we are currently capturing NAME (including spelled-out), handle that WITHOUT GPT
  if (capture.mode === 'name') {
    const raw = safeUserText || '';

    // First, try to interpret spelled-out names like "r a q u e l"
    let cleaned = raw
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let candidate = null;
    if (cleaned) {
      const parts = cleaned.split(' ').filter(Boolean);

      // Case 1: they spelled it letter by letter: "r a q u e l"
      if (
        parts.length >= 2 &&
        parts.length <= 12 &&
        parts.every((p) => p.length === 1)
      ) {
        candidate = parts.join('');
      } else {
        // Case 2: fall back to natural-name extraction ("I'm Gabriel", "name is Raquel")
        candidate = extractNameFromUtterance(raw);
      }
    }

    if (candidate) {
      const proper =
        candidate.charAt(0).toUpperCase() + candidate.slice(1).toLowerCase();

      if (!callState.booking) callState.booking = {};
      callState.booking.name = proper;

      const replyText = `Lovely, ${proper}. Did I get that right?`;

      capture.mode = 'none';
      capture.pendingConfirm = 'name';
      // If we were starting fresh, mark stage as initial
      if (capture.nameStage === 'confirmed') {
        capture.nameStage = 'initial';
      }

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });

      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    // If they talk a lot but we still don't see a clear name, gently re-ask
    if (safeUserText.length > 40) {
      const replyText =
        "Sorry, I didn’t quite catch your name — could you just say your first name nice and clearly?";

      capture.mode = 'name';
      capture.nameAttempts += 1;

      history.push({ role: 'user', content: safeUserText });
      history.push({ role: 'assistant', content: replyText });

      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    // Otherwise, stay quiet and keep listening
    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // 2) If we are currently capturing PHONE digits, handle that WITHOUT GPT
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
      snapshotSessionFromCall(callState);
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
      snapshotSessionFromCall(callState);
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
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    // Still not a full valid number – stay completely quiet and keep listening
    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // 3) If we are currently capturing EMAIL, handle that WITHOUT GPT
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
      snapshotSessionFromCall(callState);
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
      snapshotSessionFromCall(callState);
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
      snapshotSessionFromCall(callState);
      return { text: replyText, shouldEnd: false };
    }

    // Still not a full email – stay completely quiet and keep listening
    snapshotSessionFromCall(callState);
    return { text: '', shouldEnd: false };
  }

  // 4) System-level booking actions first (yes/no on suggested time, etc.)
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

  // 5) Update booking state with latest utterance (phone/email/time/earliest)
  //    (We no longer try to auto-guess names here — name is handled via explicit capture.)
  await updateBookingStateFromUtterance({
    userText: safeUserText,
    callState,
    timezone: TZ,
  });

  // 6) Build GPT-5.1 prompt
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
    temperature: 0.45, // slightly higher for more varied, human phrasing
    max_completion_tokens: 80, // shorter answers
    messages,
  });

  let botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    'Alright — how can I help you today?';

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

  // --- Output normaliser: remove robotic stock phrases ---
  let cleaned = botText.trim();

  // Strip leading "Got it —" style openers
  cleaned = cleaned.replace(/^got it\s*[—\-:,]?\s*/i, '').trimStart();

  // Remove "let me know what you'd like to focus on"
  cleaned = cleaned
    .replace(/let me know what you('?|’)?d like to focus on\.?/i, '')
    .trim();

  if (!cleaned) {
    cleaned = 'Alright.';
  }

  botText = cleaned;

  // --- De-duplicate annoying phrases like "how can I help" second time onwards ---
  const lowerBot = botText.toLowerCase();

  if (/how can i help/.test(lowerBot)) {
    const alreadyAsked = history.some(
      (m) =>
        m.role === 'assistant' &&
        /how can i help/.test(m.content.toLowerCase())
    );
    if (alreadyAsked) {
      botText = botText.replace(
        /how can i help( you)?\??/i,
        'what would you like to explore?'
      );
    }
  }

  // Booking state snapshot for post-processing
  const bookingState = callState.booking || {};

  // 8) Detect end-of-call intent from the caller (before enforcing questions)
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

  // 9) SALES SAFETY NET: always end with a question when the call is ongoing
  if (!shouldEnd) {
    const askedWhatDo =
      /what.*(you (guys )?do|do you do)/i.test(userLower) ||
      /what is mybizpal/i.test(userLower) ||
      /what is this/i.test(userLower);

    // If they asked "what do you do" and Gabriel didn't ask a question, add a qualifier
    if (askedWhatDo && !/[?？！]/.test(botText)) {
      // Normalise ending punctuation
      botText = botText.replace(/\s+$/g, '').replace(/[.?!]*$/g, '.');

      if (profile.hasBusiness === 'yes' && profile.businessType) {
        botText += ` Out of curiosity, what tends to happen with calls in your ${profile.businessType}?`;
      } else if (profile.hasBusiness === 'no') {
        botText += ' Are you mainly just curious how this works, or thinking about starting something later on?';
      } else {
        botText += ' Out of curiosity, are you running a business at the moment, or just exploring ideas for the future?';
      }
    }

    // Generic fallback: if reply still has no question mark, append a soft qualifier/booking nudge
    if (!/[?？！]/.test(botText)) {
      let extraQ;
      if (
        bookingState.intent === 'wants_booking' ||
        bookingState.timeSpoken ||
        bookingState.earliestSlotSpoken
      ) {
        extraQ =
          ' What day usually works best for you for a quick 20–30 minute call?';
      } else if (profile.hasBusiness === 'yes' && profile.businessType) {
        extraQ =
          ` What would you like to improve first with your ${profile.businessType}?`;
      } else if (profile.hasBusiness === 'no') {
        extraQ =
          ' Are you just curious how this could work, or do you have a future project in mind?';
      } else {
        extraQ =
          ' What kind of business are you running at the moment, if any?';
      }

      botText = botText.replace(/\s+$/g, '').replace(/[.?!]*$/g, '.');
      botText += extraQ;
    }
  }

  // Now that botText is final, store it in history
  history.push({ role: 'user', content: safeUserText });
  history.push({ role: 'assistant', content: botText });

  // 10) Detect if Gabriel just asked the caller to SPELL NAME / give NAME / PHONE / EMAIL
  const lower = botText.toLowerCase();

  // NAME: asking to spell, OR asking "what's your name" / "who am I speaking with" / "what should I call you"
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
      !bookingState.name || // only if we don't already have a name
      capture.pendingConfirm === 'name' // or we are mid-confirmation
    )
  ) {
    capture.mode = 'name';
    capture.buffer = '';
    if (capture.nameStage === 'confirmed') {
      capture.nameStage = 'initial';
    }
  }
  // PHONE: only when he clearly asks for their number
  else if (
    /(what('| i)s|what is|can i grab|could i grab|may i grab|let me grab|can i take|could i take|may i take).*(mobile|phone number|your number|best number|contact number|cell number)/.test(
      lower
    ) ||
    /(what('| i)s your mobile\b)/.test(lower)
  ) {
    capture.mode = 'phone';
    capture.buffer = '';
    capture.phoneAttempts = 0;
  }
  // EMAIL: only when he explicitly asks for it
  else if (
    /(what('| i)s|what is|can i grab|could i grab|may i grab|let me grab|can i take|could i take|may i take).*(email|e-mail|e mail)/.test(
      lower
    ) ||
    /(your best email|best email for you|best email address)/.test(lower)
  ) {
    capture.mode = 'email';
    capture.buffer = '';
    capture.emailAttempts = 0;
  } else {
    // Don't aggressively kill capture mode if we're in the middle of it;
    // just clear any stale buffer. If mode was none, keep it none.
    if (capture.mode !== 'none') {
      capture.buffer = '';
    } else {
      capture.mode = 'none';
      capture.buffer = '';
    }
  }

  // Save latest state into long-term memory
  snapshotSessionFromCall(callState);

  return { text: botText, shouldEnd };
}
