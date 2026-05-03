/**
 * src/routes/mockWebhook.js
 * --------------------------
 * Dev-only route. Receives messages from the mock UI,
 * runs them through the real bot logic, and returns
 * the reply as JSON instead of calling WhatsApp API.
 *
 * Mount in app.js (dev only):
 *   if (process.env.NODE_ENV !== 'production') {
 *     const mockWebhookRoutes = require('./src/routes/mockWebhook');
 *     app.use('/mock-webhook', mockWebhookRoutes);
 *   }
 */

const express = require("express");
const router = express.Router();
const webhookController = require("../controllers/webhookController");

router.post("/", async (req, res) => {
  try {
    const body = req.body;
    // Parse the standard WhatsApp-shaped payload from the mock server
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message || message.type !== "text") {
      return res.status(400).json({ error: "Invalid or unsupported message format" });
    }

    const from = message.from;
    const text = message.text.body;
    const phoneNumberId = value?.metadata?.phone_number_id;

    console.log(`[mock-webhook] Message from ${from}: "${text}" (instructor: ${phoneNumberId})`);

    // Collect all replies the bot sends during this request
    const replies = [];

    // isMock = true tells handleIncomingMessage to capture replies
    // instead of firing them off to the real WhatsApp API
    await webhookController.handleIncomingMessage(from, text, phoneNumberId, true, (reply) => {
      replies.push(reply);
    });

    // Return all collected replies to the mock UI
    return res.json({
      reply: replies.length === 1 ? replies[0] : replies.length > 1 ? replies : "✅ (no reply generated)"
    });

  } catch (error) {
    console.error("[mock-webhook] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;