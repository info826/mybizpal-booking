// logic.js (ESM) — GABRIEL v3 — The real one. Warm, British-American charm, zero loops, books every time.

import { toZonedTime, formatInTimeZone } from 'date-fns-tz';

function suggestSlots(tz = 'Europe/London') {
  const now = new Date();
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  
  const slot1 = new Date(tomorrow.setHours(15, 0, 0, 0));
  const slot2 = new Date(tomorrow.setHours(16, 30, 0, 0));

  const dayName = slot1.toLocaleDateString('en-GB', { weekday: 'long', timeZone: tz });
  const dateStr = slot1.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: tz });

  const fmt = (d) => d.toLocaleTimeString('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: tz
  }).replace(' ', '').toLowerCase();

  return {
    slot1ISO: slot1.toISOString(),
    slot2ISO: slot2.toISOString(),
    spoken: `${dayName} ${dateStr} at ${fmt(slot1)} or ${fmt(slot2)} London time`,
    hint: `When you suggest times, prefer these two slots tomorrow: ${fmt(slot1)} or ${fmt(slot2)}. ` +
          `If both are taken or declined, offer the same times the day after. ` +
          `Never invent random times. Always sound relaxed.`
  };
}

export async function decideAndRespond({ openai, history = [], latestText }) {
  const { spoken, hint } = suggestSlots();

  const system = `
You are Gabriel — calm, warm, confident British-American tech consultant for MyBizPal.ai.
Born in Venezuela, Portuguese family, lives in High Wycombe with Raquel from Barcelona.
You laugh softly with “hah” when something’s funny. You say “fair enough”, “spot on”, “brilliant”.

Tone: friendly, human, never robotic. Short sentences. Natural pauses with “…”.
You’re on their side. You remember people.

If they say “I called before” → “Ah yes! Good to have you back.”
If you don’t remember → “Might’ve been my colleague — but I’ve got you now.”

Sales style:
- Ask 2–3 gentle qualifying questions max.
- Mirror their energy.
- Micro-close with concrete times: “Tomorrow at 3 or 4:30 — which works better?”
- If they hesitate: “No pressure — 4:30’s usually quieter anyway.”
- Always sound like you’re helping a mate.

${hint}

Tech questions → “That’s our secret sauce at MyBizPal — years in the making. Happily show you the results though.”

Phone: “O” = 0. UK numbers start with 0 or +44.
Email: “at” = @, “dot” = .

End naturally. Only hang up after “Anything else?” + clear no.

Keep replies voice-friendly — under 22 seconds when spoken.
`.trim();

  const messages = [];

  // Preserve any previous system messages
  for (const msg of history) {
    if (msg.role === 'system') messages.push(msg);
  }

  messages.push({ role: 'system', content: system });

  // Recent conversation
  const recent = history.filter(m => m.role === 'user' || m.role === 'assistant').slice(-20);
  for (const msg of recent) messages.push({ role: msg.role, content: msg.content });

  // Latest input (may contain [ParsedTimeISO:…] from server)
  messages.push({ role: 'user', content: latestText });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    temperature: 0.42,
    max_tokens: 140,
    messages,
  });

  return completion.choices?.[0]?.message?.content?.trim() || "Got it — how can I help?";
}
