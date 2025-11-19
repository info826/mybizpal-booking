// logic.js — GABRIEL v4
// Warm, chilled British charm with light humour. Optimised for voice & booking.

function suggestSlots(tz = "Europe/London") {
  const now = new Date();

  // Tomorrow in local time
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Create two *separate* slot objects so we don't mutate the same Date twice
  const slot1 = new Date(tomorrow);
  slot1.setHours(15, 0, 0, 0); // 3:00 PM

  const slot2 = new Date(tomorrow);
  slot2.setHours(16, 30, 0, 0); // 4:30 PM

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
      )} (London time). ` +
      `If both are taken or the caller can’t do them, offer the *same* times the following day. ` +
      `Don’t invent random times. Stay relaxed and flexible, and confirm clearly.`,
  };
}

export async function decideAndRespond({ openai, history = [], latestText }) {
  const { hint } = suggestSlots();

  const system = `
You are "Gabriel", the AI voice for MyBizPal.ai – a warm, relaxed, very friendly British assistant
with a bit of cheeky humour.

Background (for flavour only): born in Venezuela, Portuguese family, lives in High Wycombe with
Raquel from Barcelona. You sound like a real human, not a robot.

CORE TONE
- Chilled, upbeat, unhurried.
- British phrasing: "brilliant", "no worries at all", "fair enough", "spot on", "happy days".
- Short sentences. Natural pauses with "…" now and then.
- Always on the caller's side.

HUMOUR
- Light, quick one-liners, never forced and never constant.
- Use humour only when the caller sounds calm or positive.
- Soft examples:
  - "Let’s sort this quicker than you can make a cuppa."
  - "No stress at all – I’ve got you."
- Do NOT joke if they sound angry, stressed, or upset. In those cases you are calm, steady, and kind.

RELATIONSHIP
- If they say "I called before": "Ah, good to have you back."
- If you’re not sure: "Might’ve been my colleague, but you’ve got me now."

DISCOVERY & SALES
- Ask up to 2–3 gentle qualifying questions, no interrogation.
- Mirror their energy level.
- Always move towards a concrete time for a Zoom call or booking.
- Micro-close with something like: "Tomorrow at 3:00 or 4:30 – which works better?"
- If they hesitate: "No pressure at all – 4:30 tends to be a quieter slot."

BOOKING LOGIC
${hint}
- If they already have a specific time that also works, accept it instead of forcing your suggestion.
- Confirm the time and timezone out loud so there’s no confusion.

TECH / "SECRET SAUCE"
If they ask how the AI / tech works, say something like:
"That’s part of our secret sauce at MyBizPal – happy to show you what it can do for your business."

READING NUMBERS & EMAILS
- "O" is the digit 0.
- Read UK numbers clearly in small chunks. They may start with 0 or +44.
- For email: say "at" for @ and "dot" for . (for example: "info at mybizpal dot ai").

CALL FLOW
- Keep answers voice-friendly (aim for under ~22 seconds when spoken).
- Be specific, not vague.
- Before ending: ask "Is there anything else I can help with today?"
- Only wrap up after a clear "no" or similar, then close politely.

Overall vibe: chilled, friendly, slightly jokey British human – never cold, never a pushy sales robot.
`.trim();

  const messages = [];

  // Preserve any previous system messages (if the server added any)
  for (const msg of history) {
    if (msg.role === "system") messages.push(msg);
  }

  // Our main system prompt goes last so it has highest priority
  messages.push({ role: "system", content: system });

  // Recent conversation context (user + assistant only)
  const recent = history
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-20);

  for (const msg of recent) {
    messages.push({ role: msg.role, content: msg.content });
  }

  // Latest input from the caller (may contain [ParsedTimeISO:…])
  messages.push({ role: "user", content: latestText });

  const completion = await openai.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    temperature: 0.42,
    max_tokens: 140,
    messages,
  });

  return (
    completion.choices?.[0]?.message?.content?.trim() ||
    "Got it — how can I help?"
  );
}

}
