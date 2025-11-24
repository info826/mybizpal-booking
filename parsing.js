// parsing.js
// Lightweight NLP helpers: name, phone, email, natural date, yes/no

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

// ---------- SMART EMAIL NORMALISER ----------

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

// Filler words we want to ignore around the email
const FILLERS = new Set([
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

export function extractEmailSmart(raw) {
  if (!raw) return null;

  let text = raw.toLowerCase();

  // Normalise some odd STT quirks like "gmail mail"
  text = text.replace(/gmail\s+mail/g, 'gmail');
  text = text.replace(/hotmail\s+mail/g, 'hotmail');
  text = text.replace(/outlook\s+mail/g, 'outlook');

  // Replace common separators with spaces so we can process tokens
  text = text
    .replace(/-/g, ' ')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into words, drop fillers, map digit words → digits
  let words = text.split(' ').filter(Boolean);

  words = words
    .filter((w) => !FILLERS.has(w))
    .map((w) => DIGIT_WORDS[w] || w);

  text = words.join(' ');

  // Map how people say "@"
  text = text
    .replace(/\bat sign\b/g, '@')
    .replace(/\bat symbol\b/g, '@')
    .replace(/\barroba\b/g, '@')
    .replace(/\ba t\b/g, '@')
    .replace(/\bat\b/g, '@');

  // Map how people say "."
  text = text
    .replace(/\bdot com\b/g, '.com')
    .replace(/\bdot\b/g, '.')
    .replace(/\bpunto\b/g, '.')
    .replace(/\bponto\b/g, '.')
    .replace(/\bpoint\b/g, '.');

  // Collapse spaced letters around local part: "j w" → "jw"
  text = text.replace(/\b([a-z0-9])\s+([a-z0-9])\b/g, '$1$2');

  // Finally, remove ALL remaining spaces so:
  // "4 2 2 7 4 3 5 j w @ gmail dot com" → "4227435jw@gmail.com"
  text = text.replace(/\s+/g, '');

  // Classic email validation
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
  if (emailRegex.test(text)) {
    return text;
  }

  return null;
}

// ---------- NAME ----------

export function extractName(text) {
  if (!text) return null;
  const t = text.trim();

  // "I'm Gabriel", "my name is Raquel", "this is John"
  let m = t.match(
    /\b(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z '-]{1,30})\b/i
  );
  if (m) {
    return m[1].trim().replace(/\s+/g, ' ').split(' ')[0];
  }

  // Fallback: first reasonable-looking word
  m = t.match(/\b([A-Za-z][A-Za-z'-]{1,30})\b/);
  return m ? m[1] : null;
}

// ---------- PHONE (UK-FOCUSED, BUT FLEXIBLE) ----------

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

// ---------- BASIC EMAIL (LEGACY) ----------
// Still here in case any existing code uses extractEmail directly.

export function extractEmail(spoken) {
  if (!spoken) return null;

  let s = ` ${spoken.toLowerCase()} `;

  // Map how people say "@"
  s = s
    .replace(/\bat(-|\s)?sign\b/g, '@')
    .replace(/\bat symbol\b/g, '@')
    .replace(/\barroba\b/g, '@')
    .replace(/\bat\b/g, '@');

  // Map how people say "."
  s = s
    .replace(/\bdot\b/g, '.')
    .replace(/\bpunto\b/g, '.')
    .replace(/\bponto\b/g, '.')
    .replace(/\bpoint\b/g, '.');

  // Normalise spaces around @ and .
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');

  // Remove ALL remaining spaces so "4 2 2 7 4 3 5 j w at gmail dot com"
  // becomes "4227435jw@gmail.com"
  s = s.replace(/\s+/g, '');

  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

// ---------- DATES & YES/NO ----------

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
