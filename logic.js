// logic.js (ESM)
export async function decideAndRespond({ openai, history = [], latestText }) {
  // Convert our stored history to OpenAI chat format (keep last ~12 turns)
  const messages = [];

  // Preserve any system messages first
  for (const h of history.slice(-24)) {
    if (h.role === 'system') messages.push({ role: 'system', content: h.content });
  }

  // Then user/assistant turns
  for (const h of history.slice(-24)) {
    if (h.role === 'user' || h.role === 'assistant') {
      messages.push({ role: h.role, content: h.content });
    }
  }

  // Add the latest user text
  messages.push({ role: 'user', content: latestText });

  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';

  const resp = await openai.chat.completions.create({
    model,
    temperature: 0.4,
    messages: [
      {
        role: 'system',
        content:
          "You are a concise, friendly receptionist. Use short sentences. " +
          "Offer to book/reschedule/cancel, send SMS confirmations, collect name/number if missing. " +
          "Never say you can’t help if we can take an action. Avoid long explanations."
      },
      ...messages
    ]
  });

  return resp.choices?.[0]?.message?.content?.trim() || "Got it.";
}
