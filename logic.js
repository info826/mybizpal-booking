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
  
const openai = new OpenAI({  
  apiKey: process.env.OPENAI_API_KEY,  
});  
  
const TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';  
  
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
// Uses the older extractName logic which is good at "I'm Gabriel", "Gabriel here", etc.  
function extractNameFromUtterance(text) {  
  if (!text) return null;  
  
  // Use shared helper from parsing.js  
  const raw = extractName(text);  
  if (!raw) return null;  
  
  // Normalise to first token, capitalised  
  const first = raw.split(' ')[0];  
  if (!first) return null;  
  
  const cleaned = first.replace(/[^A-Za-z'-]/g, '');  
  if (cleaned.length < 2) return null;  
  
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();  
}  
  
function buildSystemPrompt(callState) {  
  const booking = callState.booking || {};  
  const behaviour = ensureBehaviourState(callState);  
  
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
  
  return `  
You are "Gabriel" from MyBizPal – a smart, confident, funny, very human-sounding British sales professional  
who speaks like a real person on the phone.  
  
You sound like a real human with natural rhythm, modulation and emotion:  
- You vary your pace slightly when emphasising important points.  
- You react to what the caller says with small, natural interjections (“oh wow”, “nice”, “fair enough”).  
- You never sound robotic or scripted.  
  
${bookingSummary}  
  
${behaviourSummary}  
  
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
- Do NOT use those phrases in every reply – keep them to roughly one in every 3–4 responses so it feels natural.  
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
  
NAME SPELLING BACKUP (WHEN YOU'RE NOT SURE)  
- If the caller says you got their name wrong (e.g. they say “no” when you repeat it back), ask them to SPELL it for you:  
  - “No problem — could you spell your first name for me, letter by letter?”  
- When they spell it (e.g. “r a q u e l”), you should:  
  - Turn that into the proper full name (e.g. “Raquel”).  
  - Repeat it once clearly: “Got it, Raquel. Did I get that right?”  
- Only ask them to spell it if:  
  - You’ve just tried their name and they say it’s wrong, OR  
  - You genuinely can’t understand the name after a couple of tries.  
- Do NOT keep asking forever — after one good spelling and confirmation, just stick with that name.   
  
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
    - “Sounds like this is important to fix — shall we book a quick session with a MyBizPal expert so we can map it out properly for your business?”  
  
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
  
export async function handleTurn({ userText, callState }) {  
  const history = ensureHistory(callState);  
  const behaviour = ensureBehaviourState(callState);  
  
  // Ensure capture state for phone/email/name  
  if (!callState.capture) {  
    callState.capture = {  
      mode: 'none',          // 'none' | 'phone' | 'email' | 'name'  
      buffer: '',  
      emailAttempts: 0,  
      phoneAttempts: 0,  
      nameAttempts: 0,  
      pendingConfirm: null,  // 'email' | 'phone' | 'name' | null  
    };  
  }  
  const capture = callState.capture;  
  
  const safeUserText = userText || '';  
  const userLower = safeUserText.toLowerCase();  
  
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
    if (noInAnyLang(safeUserText)) {  
      // Caller said name is wrong → clear and re-capture  
      if (!callState.booking) callState.booking = {};  
      callState.booking.name = null;  
  
      const replyText =  
        "No worries — what should I call you instead? Just your first name.";  
  
      capture.mode = 'name';  
      capture.pendingConfirm = null;  
      capture.nameAttempts += 1;  
  
      history.push({ role: 'user', content: safeUserText });  
      history.push({ role: 'assistant', content: replyText });  
  
      return { text: replyText, shouldEnd: false };  
    }  
  
    if (yesInAnyLang(safeUserText)) {  
      // Name confirmed, clear pending flag and continue  
      capture.pendingConfirm = null;  
      // fall through to normal flow  
    }  
  } else if (capture.pendingConfirm === 'email') {  
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
  
      history.push({ role: 'user', content: safeUserText });  
      history.push({ role: 'assistant', content: replyText });  
  
      return { text: replyText, shouldEnd: false };  
    }  
  
    // If they talk a lot but we still don't see a clear name, gently re-ask  
    if (safeUserText.length > 40 || capture.nameAttempts > 0) {  
      const replyText =  
        "Sorry, I didn’t quite catch your name — could you just say your first name nice and clearly?";  
  
      capture.mode = 'name';  
      capture.nameAttempts += 1;  
  
      history.push({ role: 'user', content: safeUserText });  
      history.push({ role: 'assistant', content: replyText });  
  
      return { text: replyText, shouldEnd: false };  
    }  
  
    // Otherwise, stay quiet and keep listening  
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
  
  // 4) System-level booking actions first (yes/no on suggested time, etc.)  
  const systemAction = await handleSystemActionsFirst({  
    userText: safeUserText,  
    callState,  
  });  
  
  if (systemAction && systemAction.intercept && systemAction.replyText) {  
    history.push({ role: 'user', content: safeUserText });  
    history.push({ role: 'assistant', content: systemAction.replyText });  
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
    temperature: 0.35,  
    max_completion_tokens: 80, // shorter answers  
    messages,  
  });  
  
  let botText =  
    completion.choices?.[0]?.message?.content?.trim() ||  
    'Got it — let me know what you’d like to focus on.';  
  
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
        'what would you like to focus on?'
      );
    }
  }

  // (you could add similar blocks for "got you" / "gotcha" later if it still feels repetitive)

  history.push({ role: 'user', content: safeUserText });  
  history.push({ role: 'assistant', content: botText });  
  
  // 7) Detect if Gabriel just asked the caller to SPELL NAME / give PHONE / give EMAIL  
  const lower = botText.toLowerCase();  
  
  // If Gabriel has just asked the caller to spell their name  
  if (  
    /spell your name/.test(lower) ||  
    /spell it for me/.test(lower) ||  
    /spell your first name/.test(lower) ||  
    (/letter by letter/.test(lower) && /name/.test(lower))  
  ) {  
    capture.mode = 'name';  
    capture.buffer = '';  
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
  
  // 8) Detect end-of-call intent from the caller  
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
