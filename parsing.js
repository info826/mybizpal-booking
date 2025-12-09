// parsing.js
// Lightweight NLP helpers: name, phone, email, natural date, yes/no

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// ---------- NAME PARSING ----------

// Words that are clearly not names when we see them after "my name is" etc.
const NAME_GREETING_STOP_WORDS = new Set([
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank',
  'thankyou',
  'booking',
  'book',
  'good',
  'morning',
  'afternoon',
  'evening',
  'please',
  'would',
  'yes',
  'yeah',
  'yep',
  'ok',
  'okay',
  'sure',
  'fine',
  'perfect',
  // extra safety – commonly mis-heard as a "name"
  'slot',
  'business',
  'consultation',
  'appointment',
  'meeting',
  'call',
]);

// Extra block-list for single-word "names" like "slot", "excellent", etc.
const SINGLE_WORD_NON_NAMES = new Set([
  ...NAME_GREETING_STOP_WORDS,
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
  'business',
  'test',
  'testing',
  'both',
  'all',
  'thanks',
  'thankyou',
  'ok',
  'okay',
  'yes',
  'no',
  'sure',
  'great',
  'nice',
  'perfect',
  'excellent',
]);

export function extractName(text) {
  if (!text) return null;
  const t = text.trim();

  // Normalise spaces
  const normalised = t.replace(/\s+/g, ' ');

  // 1) Explicit phrases:
  // "I'm Gabriel", "I am Gabriel", "this is John", "my name is Raquel", "no my name is Gabriel"
  let m = normalised.match(
    /\b(?:no[, ]+)?(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z '-]{1,40})\b/i
  );
  if (m) {
    const full = m[1].trim().replace(/\s+/g, ' ');
    // Use only first token as the name ("Gabriel" from "Gabriel De Ornelas")
    const first = full.split(' ')[0];
    const candidate = first.replace(/[^A-Za-z'-]/g, '');
    const down = candidate.toLowerCase();
    if (!candidate || candidate.length < 2) return null;
    if (SINGLE_WORD_NON_NAMES.has(down)) return null;
    return candidate;
  }

  // 2) Short direct answer like: "Gabriel" or "Gabriel Soares"
  const words = normalised.split(' ').filter(Boolean);

  // Only treat it as a name if the caller basically ONLY said their name
  if (words.length <= 2) {
    const rawFirst = words[0] || '';
    const candidateRaw = rawFirst.replace(/[^\w'-]/g, '');
    const down = candidateRaw.toLowerCase();

    if (!candidateRaw || candidateRaw.length < 2) return null;
    if (SINGLE_WORD_NON_NAMES.has(down)) return null;

    const candidate = candidateRaw.replace(/[^A-Za-z'-]/g, '');
    if (candidate.length >= 3 && candidate.length <= 20) {
      return candidate;
    }
  }

  // Otherwise, don't guess
  return null;
}

// ---------- PHONE PARSING ----------

export function parseUkPhone(spoken) {
  if (!spoken) return null;

  let s = ` ${spoken.toLowerCase()} `;

  // Strip filler sounds
  s = s.replace(/\b(uh|uhh|uhm|um|umm|erm)\b/g, '');

  // Handle "plus forty four"
  s = s.replace(/\bplus\s*four\s*four\b/g, '+44');
  s = s.replace(/\bplus\b/g, '+');

  // Map words → digits (handles "oh" / "o" as 0)
  s = s.replace(/\b(oh|o|zero|naught)\b/g, '0');
  s = s
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/\bthree\b/g, '3')
    .replace(/\bfour\b/g, '4')
    .replace(/\bfive\b/g, '5')
    .replace(/\bsix\b/g, '6')
    .replace(/\bseven\b/g, '7')
    .replace(/\beight\b/g, '8')
    .replace(/\bnine\b/g, '9');

  // Keep only digits and +
  s = s.replace(/[^\d+]/g, '');

  // Normalise to E.164 +44…
  if (s.startsWith('+44')) {
    const rest = s.slice(3);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('44')) {
    const rest = s.slice(2);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('0') && /^\d{11}$/.test(s)) {
    return { e164: `+44${s.slice(1)}`, national: s };
  } else if (/^\d{10}$/.test(s)) {
    // No leading 0 but 10 digits → assume UK, add 0
    return { e164: `+44${s}`, national: `0${s}` };
  }

  // If it does not look like a UK mobile or landline, return null
  return null;
}

export function isLikelyUkNumberPair(p) {
  return !!(p && /^0\d{10}$/.test(p.national) && /^\+44\d{10}$/.test(p.e164));
}

// ---------- EMAIL PARSING ----------

// Map spelled-out digits → actual digits
const DIGIT_WORDS = {
  zero: '0',
  oh: '0',
  o: '0',
  one: '1',
  two: '2',
  to: '2',
  too: '2',
  three: '3',
  four: '4',
  for: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  ate: '8',
  nine: '9',
};

// General fillers that can be safely dropped
const GENERAL_FILLERS = new Set([
  'so',
  'ok',
  'okay',
  'um',
  'uh',
  'eh',
  'ah',
  'right',
  'like',
  'well',
  'yeah',
  'you',
  'know',
  'just',
  'please',
  'the',
  'address',
  'email',
  'zip',
  'account',
]);

// Extra email-specific fillers that often appear before the real address
const EMAIL_LEAD_IN_FILLERS = new Set([
  'yes',
  'yeah',
  'yep',
  'sure',
  'so',
  'ok',
  'okay',
  'right',
  'well',
  'my',
  'email',
  'mail',
  'is',
  "it's",
  'its',
  'here',
  'there',
  'the',
  'best',
  'one',
  'would',
  'be',
  'i',
  'this',
  'that',
  'it',
]);

function isEmailFiller(word) {
  const w = word.toLowerCase();
  return GENERAL_FILLERS.has(w) || EMAIL_LEAD_IN_FILLERS.has(w);
}

export function extractEmailSmart(raw) {
  if (!raw) return null;

  let text = raw
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Fix common "g mail" / "g male" → "gmail"
  text = text.replace(/\bg\s+mail\b/g, 'gmail');
  text = text.replace(/\bg\s+male\b/g, 'gmail');

  // Tokenise
  let tokens = text.split(' ');

  // Drop leading fillers like "yes / so / my email is / it is / ok"
  while (tokens.length && isEmailFiller(tokens[0])) {
    tokens.shift();
  }

  // Remove general fillers anywhere in the string
  tokens = tokens.filter((w) => !GENERAL_FILLERS.has(w));

  // Convert spelled digits
  tokens = tokens.map((w) => DIGIT_WORDS[w] || w);

  // Fix "gmail mail" (and similar) → "gmail"
  const compactTokens = [];
  for (let i = 0; i < tokens.length; i++) {
    const w = tokens[i];
    const next = tokens[i + 1];
    if (
      (w === 'gmail' || w === 'hotmail' || w === 'outlook' || w === 'yahoo') &&
      next === 'mail'
    ) {
      compactTokens.push(w);
      i += 1; // skip "mail"
      continue;
    }
    compactTokens.push(w);
  }
  tokens = compactTokens;

  // Re-join into a string
  text = tokens.join(' ');

  // Normalise “at …” phrases → "@"
  text = text.replace(/\bat\s+sign\b/g, '@');
  text = text.replace(/\bat\s+symbol\b/g, '@');
  text = text.replace(/\barroba\b/g, '@');
  text = text.replace(/\bat\b/g, '@');

  // Handle common "dot something" phrases before generic "dot"
  text = text.replace(/\bdot\s+co\s+dot\s+uk\b/g, '.co.uk');
  text = text.replace(/\bdot\s+com\b/g, '.com');
  text = text.replace(/\bdot\s+co\b/g, '.co');
  text = text.replace(/\bdot\b/g, '.');

  // Collapse spaced letters: "j w" → "jw", do this repeatedly for longer sequences
  let last;
  do {
    last = text;
    text = text.replace(/\b([a-z])\s+([a-z])\b/g, '$1$2');
  } while (text !== last);

  // Build a compact version with no spaces
  const compact = text.replace(/\s+/g, '');

  // Find the first email-shaped substring inside the compact text
  const match = compact.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (!match) return null;

  let email = match[0];

  // Split into local + domain so we can fix the domain separately
  const [localPart, domainPartRaw] = email.split('@');
  let domainPart = domainPartRaw || '';

  // Fix common ASR glitches on the domain side
  const domainFixes = {
    'g.com': 'gmail.com',
    'gmai.com': 'gmail.com',
    'gmaill.com': 'gmail.com',
    'gmailmail.com': 'gmail.com',

    'hotmai.com': 'hotmail.com',
    'hotmaill.com': 'hotmail.com',
    'hotmailmail.com': 'hotmail.com',

    'outllok.com': 'outlook.com',
    'outlookmail.com': 'outlook.com',

    'yahoomail.com': 'yahoo.com',
    'googlemailmail.com': 'googlemail.com',
  };

  if (domainFixes[domainPart]) {
    domainPart = domainFixes[domainPart];
  }

  // Generic safety: if the domain starts with a known host but has junk after,
  // normalise to the clean ".com" domain.
  const lowerDomain = domainPart.toLowerCase();
  if (lowerDomain.startsWith('gmail')) {
    domainPart = 'gmail.com';
  } else if (lowerDomain.startsWith('hotmail')) {
    domainPart = 'hotmail.com';
  } else if (lowerDomain.startsWith('outlook')) {
    domainPart = 'outlook.com';
  } else if (lowerDomain.startsWith('yahoo')) {
    domainPart = 'yahoo.com';
  } else if (lowerDomain.startsWith('googlemail')) {
    domainPart = 'googlemail.com';
  }

  email = `${localPart}@${domainPart}`;

  // Extra safety for any leftover "gmailmail." style glitches
  email = email.replace(/gmailmail(\.)/g, 'gmail$1');
  email = email.replace(/gmaill(\.)/g, 'gmail$1');
  email = email.replace(/gmai(\.)/g, 'gmail$1');

  return email;
}

// For backwards compatibility if anything still calls extractEmail()
export function extractEmail(spoken) {
  return extractEmailSmart(spoken);
}

// ---------- DATE PARSING ----------

export function parseNaturalDate(utterance, tz = DEFAULT_TZ) {
  if (!utterance) return null;

  const parsed = chrono.parseDate(utterance, new Date(), { forwardDate: true });
  if (!parsed) return null;

  const zoned = toZonedTime(parsed, tz);
  const iso = fromZonedTime(zoned, tz).toISOString();
  const spoken = formatSpokenDateTime(iso, tz);
  return { iso, spoken };
}

export function formatSpokenDateTime(iso, tz = DEFAULT_TZ) {
  const d = new Date(iso);
  const day = formatInTimeZone(d, tz, 'eeee');
  const date = formatInTimeZone(d, tz, 'd');
  const month = formatInTimeZone(d, tz, 'LLLL');
  const mins = formatInTimeZone(d, tz, 'mm');
  const hour = formatInTimeZone(d, tz, 'h');
  const mer = formatInTimeZone(d, tz, 'a').toLowerCase();
  const time = mins === '00' ? `${hour} ${mer}` : `${hour}:${mins} ${mer}`;
  return `${day} ${date} ${month at ${time}`; // NOTE: if you see a typo here, fix to "month} at ${time}"
}

// ---------- YES / NO HELPERS ----------

export function yesInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return (
    /\b(yes|yeah|yep|sure|ok|okay|si|sí|sim|oui)\b/.test(t) ||
    /^(mm+|mhm+|uh-?huh|uhu|ah['’]?a|uhhu)$/i.test(t)
  );
}

export function noInAnyLang(text) {
  const t = (text || '').toLowerCase().trim();
  return (
    /\b(no|nope|nah|pas maintenant|não|nao)\b/.test(t) ||
    /^(nn)$/i.test(t)
  );
}
