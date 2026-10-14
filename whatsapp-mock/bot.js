/**
 * bot.js — Your actual bot logic lives here.
 * ------------------------------------------------
 * The mock server calls `handleMessage(payload, sender)` exactly
 * the same way a real webhook handler would. Swap bot.js for your
 * real implementation; server.js never needs to change.
 *
 * @param {object} payload  - Full WhatsApp Cloud API webhook body
 * @param {object} sender   - Abstracted send interface (mockSender in dev,
 *                            real WhatsApp API client in prod)
 */
async function handleMessage(payload, sender) {
  // ── Parse the incoming message (works for real & mock payloads) ──
  const entry = payload.entry?.[0];
  const change = entry?.changes?.[0]?.value;
  const msg = change?.messages?.[0];

  if (!msg || msg.type !== "text") return; // ignore non-text for now

  const from = msg.from;
  const text = msg.text.body.trim().toLowerCase();

  console.log(`[bot] Processing message from ${from}: "${text}"`);

  // ── Your bot logic ────────────────────────────────────────────────
  if (text === "hi" || text === "hello") {
    await sender.sendText(from, "👋 Hey there! How can I help you today?");
  } else if (text === "help") {
    await sender.sendButtons(from, "What do you need help with?", [
      { id: "opt_1", title: "Track Order" },
      { id: "opt_2", title: "Speak to Agent" },
      { id: "opt_3", title: "FAQs" },
    ]);
  } else if (text.includes("order")) {
    await sender.sendText(from, "📦 Please send your order number and I'll look it up!");
  } else {
    await sender.sendText(
      from,
      `You said: "${msg.text.body}"\n\nI don't understand that yet. Try "help" to see options.`
    );
  }
}

module.exports = { handleMessage };