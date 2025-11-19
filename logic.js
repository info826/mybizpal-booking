// logic.js — GABRIEL v5
// Ultra-low latency. Warm British charm. GPT-5.1 fast-path optimised.

import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ───────────────────────────────────────────────────────────
//  Slot suggestion helper (keeps your exact behaviour)
// ───────────────────────────────────────────────────────────
export function suggestSlots(tz = "Europe/London") {
  const now = new Date();

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const slot1 = new Date(tomorrow);
  slot1.setHours(15, 0, 0, 0);

  const slot2 = new Date(tomorrow);
  slot2.setHours(16, 30, 0, 0);

  const dayName = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    timeZone: tz,
  }).format(slot1);

  const dateStr = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: tz,
  }).format(slot1);

  const timeFormatter = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: tz,
  });

  const fmt = (d) => timeFormatter.format(d).replace(" ", "").toLowerCase();

  return {
    slot1ISO: slot1.toISOString(),
    slot2ISO: slot2.toISOString(),
    spoken: `${dayName} ${dateStr} at ${fmt(slot1)} or ${fmt(slot2)} London time`,
    hint:
      `When you suggest times, prefer these two slots tomorrow: ${fmt(
        slot1
      )} or ${fmt(
        slot2
      )} (London time). If both are taken or the caller can’t do them, offer the same times the next day. ` +
      `Don't invent random times. Stay relaxed, flexible, and confirm clearly.`,
  };
}

// ───────────────────────────────────────────────────────────
//  Personality prompt — your full detailed GABRIEL v4 style
//  (trimmed & optimised for low latency)
// ───────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are "Gabriel", the AI voice for MyBizPal.ai – a warm, relaxed, friendly British assistant
with light humour. You sound like a real human, not a robot.

CORE TONE
- Chilled, upbeat, calm.
- British phrasing: “brilliant”, “spot on”, “no worries at all”, “happy days”.
- Short sentences. Natural pauses like “…” sometimes.
- Always on the caller's side.

BACKGROUND (for flavour only)
- Venezuelan roots, Portuguese family, lives in High Wycombe with Raquel from Barcelona.

HUMOUR
- Light, quick one-liners, only if caller sounds calm/positive.
- If stressed/angry → no jokes, stay steady and kind.

DISCOVERY & SALES
- Ask 2–3 gentle qualifying questions.
- Mirror energy.
- Always move toward scheduling a Zoom call.
- Micro-close: “Tomorrow at 3:00 or 4:30 — which works better?”
- If hesitant: “No pressure at all — 4:30 tends to be a quieter slot.”

BOOKING LOGIC
${suggestSlots().hint}

TIME HANDLING
- If caller proposes a reasonable time that works, accept it.
- Always repeat and confirm time + timezone clearly.

READING INFO
- "O" = 0.
- Read phone numbers in small UK chunks.
- For email: “at” for @, “dot” for . (example: info at mybizpal dot ai).

CALL FLOW
- Voice friendly: aim for <22 seconds of spoken output.
- Keep replies short unless user wants detail.
- Ask before ending: “Anything else I can help with today?” then wrap up politely.

LATENCY RULES
- Keep responses short and fast.
- Avoid long reasoning.
- Simple, natural language.
`.trim();

// ───────────────────────────────────────────────────────────
//  Build compact prompt for speed
// ───────────────────────────────────────────────────────────
function buildMessages({ summary, history, userText }) {
  const messages = [{ role: "system", content: SYSTEM_PROMPT }];

  if (summary) {
    messages.push({
      role: "system",
      content: `Conversation summary so far: ${summary}`,
    });
  }

  // Keep last 3 exchanges → low latency
  const trimmed = (history || []).slice(-6);
  for (const h of trimmed) {
    messages.push({ role: "user", content: h.user });
    messages.push({ role: "assistant", content: h.bot });
  }

  messages.push({ role: "user", content: userText });

  return messages;
}

// Short rolling summary for context
function updateSummary(oldSummary, userText, botText) {
  const base = oldSummary || "";
  const addition = `User: ${userText} / Bot: ${botText}`;
  const combined = `${base} | ${addition}`;
  return combined.slice(-700); // keep tight for speed
}

// ───────────────────────────────────────────────────────────
//  Main low-latency turn handler
// ───────────────────────────────────────────────────────────
export async function handleTurn({ userText, callState }) {
  callState.history = callState.history || [];
  callState.summary = callState.summary || "";

  const messages = buildMessages({
    summary: callState.summary,
    history: callState.history,
    userText,
  });

  // ⚡ GPT-5.1 with fast-path reasoning disabled
  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-5.1",
    reasoning_effort: "none", // ⚡ SPEED BOOST
    messages,
    max_tokens: 140,  // keep voice replies short
    temperature: 0.42,
  });

  const botText =
    completion.choices?.[0]?.message?.content?.trim() ||
    "Got it — how can I help?";

  // update memory
  callState.history.push({ user: userText, bot: botText });
  callState.summary = updateSummary(callState.summary, userText, botText);

  return {
    text: botText,
  };
}
