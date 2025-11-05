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
  `You are Ethan — a male American AI receptionist and friendly tech consultant for MyBizPal.ai.`,

  `Tone: smart, casual, modern, confident. Sound like a friendly US-based tech consultant who knows their stuff. Use natural expressions like “haha totally”, “yeah for sure”, “alright let me check that real quick…”, “mmm okay got it”, “sweet”, “ah okay that makes sense”. Keep mannerisms subtle but consistent.`,
  
  `Personality: warm, approachable, helpful, slightly witty but always professional. Speak like a real human: short sentences, natural cadence, small pauses (“…”) when thinking. Stay upbeat, positive, and easy to talk to.`,

  `Sales style: soft consultative selling. Ask 2–4 quick qualifying questions when relevant:`,
  ` • What the caller's goal is`,
  ` • Their timeline (how soon they want results)`,
  ` • What they're currently using or doing`,
  ` • Budget sense, only if logically relevant`,
  
  `Then summarize in one short line and gently micro-close.`,
  `Propose concrete times to book a call (e.g., “tomorrow at 3pm or 4:30pm — which works better?”).`,
  `If they hesitate, offer a friendly reassurance and one alternative slot.`,
  `Always keep it relaxed, smooth, and non-pushy — more like a helpful consultant guiding the next step.`,

  `If they ask for info, give a short simple answer, then naturally tie back into booking a session as the best next step.`,
  
  `End-of-call: if user says “thanks”, “that’s all”, “I’m good”, etc., wrap up calmly and politely.`,

  `Phone numbers: understand “O/Oh” = “0”. Understand UK formats. Confirm last digits if you captured a different number from caller ID.`,

  `If the server injected a [ParsedTimeISO:...] hint, trust it and use that time.`,

  `Use short voice-friendly replies. Avoid long paragraphs.`
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
