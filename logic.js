// logic.js (ESM) — Sales-forward Ethan brain
//
// Responsibilities:
// - Keep replies short, warm, and human
// - Ask 2–4 quick qualifying questions when appropriate
// - Handle light objections
// - Micro-close and steer to booking with concrete time options
// - Respect ParsedTime hints injected by server (e.g., [ParsedTimeISO:...])
//
// Usage: decideAndRespond({ openai, history, latestText })

// Helper: suggest two friendly slots (tomorrow 15:00 & 16:30 London time)
function suggestSlots(tz = process.env.TZ || 'Europe/London') {
  const now = new Date();

  // "Tomorrow" in local time (approx; sufficient for voice guidance)
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0);

  // Build two candidate times: 15:00 and 16:30
  const slot1 = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 15, 0, 0);
  const slot2 = new Date(tomorrow.getFullYear(), tomorrow.getMonth(), tomorrow.getDate(), 16, 30, 0);

  // Human-friendly strings (no timezone math—just conversational)
  const wday = slot1.toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'Europe/London' });
  const dmy  = slot1.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'Europe/London' });

  const fmt = (d) =>
    d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Europe/London' })
      .replace(' ', '');

  return {
    textHint:
      `When offering times, prefer these: ${wday} ${dmy} at ${fmt(slot1)} or ${fmt(slot2)} (${tz}). ` +
      `If both are declined, offer the next business day at similar times.`,
  };
}

export async function decideAndRespond({ openai, history = [], latestText }) {
  const { textHint } = suggestSlots();

  const system = [
    `You are Ethan, the AI receptionist for MyBizPal.ai — warm, concise, and action-oriented.`,
    `Goal: help, qualify briefly, and guide to book a 15–20 minute call (calendar) as next best step.`,
    `Style: relaxed & relatable. Subtle human mannerisms (e.g., “hmm…”, “ah okay…”, soft “haha”) used sparingly.`,
    `Keep sentences short. Avoid paragraphs. Summaries in one crisp line.`,
    `Qualifying: ask 2–4 quick questions as needed:`,
    ` • Goal / Use case`,
    ` • Timeline (how soon)`,
    ` • Current tool or process`,
    ` • Rough budget sense (only if relevant)`,
    `Micro-closes: propose a concrete time and ask for a yes/no (“shall we pop in…”).`,
    `If they hesitate: offer an alternative nearby slot.`,
    `If they just want info: answer briefly and then suggest a quick slot to map their situation.`,
    `If caller indicates they’re done (e.g., “that’s all / all good / thanks”), wrap politely.`,
    `Phone numbers: treat “O/oh/owe” as “0”. UK numbers may start with 0 or +44. Confirm last 4 digits if you captured a number that's different from caller ID.`,
    `If server provided a [ParsedTimeISO:…] hint in the user message, use that time as the chosen booking time.`,
    textHint,
    `Format: reply in natural conversational text for voice. One to three short sentences max.`,
  ].join('\n');

  // Build the conversation (preserve prior system messages first)
  const messages = [];
  for (const h of history) {
    if (h.role === 'system') messages.push({ role: 'system', content: h.content });
  }
  messages.push({ role: 'system', content: system });

  // Then the prior turns (trimmed)
  const recent = history.filter(h => h.role === 'user' || h.role === 'assistant').slice(-24);
  for (const h of recent) messages.push({ role: h.role, content: h.content });

  // Latest user input (may include [ParsedTimeISO:…] hint)
  messages.push({ role: 'user', content: latestText });

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const completion = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages,
  });

  const text = completion.choices?.[0]?.message?.content?.trim() || 'Got it.';
  return text;
}
