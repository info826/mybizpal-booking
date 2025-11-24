// parsing.js
// Lightweight NLP helpers: name, phone, email, natural date, yes/no

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// ---------- NAME PARSING ----------

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
]);

export function extractName(text) {
  if (!text) return null;
  const t = text.trim();

  // Normalise spaces
  const normalised = t.replace(/\s+/g, ' ');

  // "I'm Gabriel", "I am Gabriel", "this is John", "my name is Raquel", "no my name is Gabriel"
  let m = normalised.match(
    /\b(?:no[, ]+)?(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z '-]{1,40})\b/i
  );
  if (m) {
    const full = m[1].trim().replace(/\s+/g, ' ');
    // Use only first token as the name ("Gabriel" from "Gabriel De Ornelas")
    return full.split(' ')[0];
  }

  // Fallback: first reasonable-looking word that is not a greeting/stop word and ≥ 3 letters
  const words = normalised.split(' ');
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z'-]/g, '');
    const lower = clean.toLowerCase();
    if (clean.length >= 3 && !NAME_GREETING_STOP_WORDS.has(lower)) {
      return clean;
    }
  }

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

  // Map words → digits
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

  // If it doesn't look like a UK mobile/landline, return null
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

// General fillers
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
]);

function isEmailFiller(word) {
  const w = word.toLowerCase();
  return GENERAL_FILLERS.has(w) || EMAIL_LEAD_IN_FILLERS.has(w);
}

// Converts sequences like “four two two seven” → “4227”
function normaliseDigits(words) {
  return words.map((w) => DIGIT_WORDS[w] || w).join('');
}

export function extractEmailSmart(raw) {
  if (!raw) return null;

  let text = raw
    .toLowerCase()
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Tokenise
  let tokens = text.split(' ');

  // Drop leading fillers like "yes / so / my email is / it's / ok"
  while (tokens.length && isEmailFiller(tokens[0])) {
    tokens.shift();
  }

  // Remove filler words anywhere
  tokens = tokens.filter((w) => !GENERAL_FILLERS.has(w));

  // Convert spelled digits
  tokens = tokens.map((w) => DIGIT_WORDS[w] || w);

  // Re-join
  text = tokens.join(' ');

  // normalise “at” phrases → “@”
  text = text.replace(/\b(at sign|at symbol)\b/g, '@');
  text = text.replace(/\barroba\b/g, '@');
  text = text.replace(/\bat\b/g, '@');

  // normalise “dot” → “.”
  text = text.replace(/\b(dot com|dot)\b/g, '.');

  // collapse spaced letters: "j w" → "jw"
  text = text.replace(/\b([a-z])\s+([a-z])\b/g, '$1$2');

  // collapse spaces
  text = text.replace(/\s+/g, '');

  // Classic email regex
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (emailRegex.test(text)) return text;

  return null;
}

// Kept for backwards compatibility if something still calls extractEmail()
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
  return `${day} ${date} ${month} at ${time}`;
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
