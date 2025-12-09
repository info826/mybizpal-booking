// sessionStore.js
// Simple in-memory session store keyed by phone number, with TTL.
// Later we can swap this to Redis or Postgres without changing how the rest of the app uses it.

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Map<phone, { data: object, savedAt: number }>
const sessions = new Map();

function normalisePhone(phone) {
  return String(phone || '').trim();
}

export function getSessionForPhone(phone) {
  const key = normalisePhone(phone);
  if (!key) return null;

  const entry = sessions.get(key);
  if (!entry) return null;

  const now = Date.now();
  if (now - entry.savedAt > SESSION_TTL_MS) {
    // Expired – forget it
    sessions.delete(key);
    return null;
  }

  return entry.data;
}

export function saveSessionForPhone(phone, data) {
  const key = normalisePhone(phone);
  if (!key) return;

  sessions.set(key, {
    data: { ...(data || {}) },
    savedAt: Date.now(),
  });
}

// Optional background cleanup (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessions.entries()) {
    if (now - entry.savedAt > SESSION_TTL_MS) {
      sessions.delete(key);
    }
  }
}, 60 * 60 * 1000).unref();
