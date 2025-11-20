// parsing.js
// Lightweight NLP helpers: name, phone, email, natural date, yes/no

import * as chrono from 'chrono-node';
import { toZonedTime, fromZonedTime, formatInTimeZone } from 'date-fns-tz';

const DEFAULT_TZ = process.env.BUSINESS_TIMEZONE || 'Europe/London';

export function extractName(text) {
  if (!text) return null;
  const t = text.trim();
  let m = t.match(
    /\b(?:i am|i'm|this is|my name is)\s+([A-Za-z][A-Za-z '-]{1,30})\b/i
  );
  if (m) return m[1].trim().replace(/\s+/g, ' ').split(' ')[0];

  m = t.match(/\b([A-Za-z][A-Za-z'-]{1,30})\b/);
  return m ? m[1] : null;
}

export function parseUkPhone(spoken) {
  if (!spoken) return null;

  // Normalise speechy stuff into digits
  let s = ` ${spoken.toLowerCase()} `;

  // Remove filler sounds
  s = s.replace(/\b(uh|uhh|uhm|um|umm|erm)\b/gi, '');

  // Map "oh / o / zero / naught" to 0
  s = s.replace(/\b(oh|o|zero|naught)\b/gi, '0');

  // Map number words to digits
  s = s
    .replace(/\bone\b/gi, '1')
    .replace(/\btwo\b/gi, '2')
    .replace(/\bthree\b/gi, '3')
    .replace(/\bfour\b/gi, '4')
    .replace(/\bfive\b/gi, '5')
    .replace(/\bsix\b/gi, '6')
    .replace(/\bseven\b/gi, '7')
    .replace(/\beight\b/gi, '8')
    .replace(/\bnine\b/gi, '9');

  // Basic handling of "double three", "triple five" etc
  s = s.replace(/\bdouble\s+(\d)\b/gi, '$1$1');
  s = s.replace(/\btriple\s+(\d)\b/gi, '$1$1$1');

  // Strip everything except digits and +
  s = s.replace(/[^\d+]/g, '');

  if (s.startsWith('+44')) {
    const rest = s.slice(3);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('44')) {
    const rest = s.slice(2);
    if (/^\d{10}$/.test(rest)) return { e164: `+44${rest}`, national: `0${rest}` };
  } else if (s.startsWith('0') && /^\d{11}$/.test(s)) {
    return { e164: `+44${s.slice(1)}`, national: s };
  } else if (/^\d{10}$/.test(s)) {
    return { e164: `+44${s}`, national: `0${s}` };
  }

  return null;
}

export function isLikelyUkNumberPair(p) {
  return !!(p && /^0\d{10}$/.test(p.national) && /^\+44\d{10}$/.test(p.e164));
}

export function extractEmail(spoken) {
  if (!spoken) return null;
  let s = ` ${spoken.toLowerCase()} `;

  s = s
    .replace(/\bat(-|\s)?sign\b/gi, '@')
    .replace(/\bat symbol\b/gi, '@')
    .replace(/\barroba\b/gi, '@')
    .replace(/\bat\b/gi, '@');

  s = s
    .replace(/\bdot\b/gi, '.')
    .replace(/\bpunto\b/gi, '.')
    .replace(/\bponto\b/gi, '.')
    .replace(/\bpoint\b/gi, '.');

  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, ' ').trim();

  const m = s.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i);
  return m ? m[0] : null;
}

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
