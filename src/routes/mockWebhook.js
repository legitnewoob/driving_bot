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
const Instructor = require("../models/instructorSchema");

// GET /mock-webhook/instructors — list instructors with assigned phone numbers
router.get("/instructors", async (req, res) => {
  try {
    const instructors = await Instructor.find({
      active: true,
      phoneNumberId: { $exists: true, $ne: null, $not: /^signup_/ },
      phone: { $exists: true, $nin: [null, ""] },
    })
      .select("name email phoneNumberId phone")
      .lean();

    return res.json({
      instructors: instructors.map((i) => ({
        id: i._id,
        name: i.name,
        email: i.email,
        phoneNumberId: i.phoneNumberId,
        phoneNumber: i.phone || null,
      })),
    });
  } catch (error) {
    console.error("[mock-webhook] Error listing instructors:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

// POST /mock-webhook — send a message to the bot
// Accepts two formats:
//   1. Simple: { from, text, phoneNumberId }
//   2. WhatsApp-shaped: { entry: [{ changes: [{ value: { metadata: { phone_number_id }, messages: [...] } }] }] }
router.post("/", async (req, res) => {
  try {
    const body = req.body;
    let from, text, phoneNumberId;

    // Simple format — flat fields
    if (body.from && body.text) {
      from = body.from;
      text = body.text;
      phoneNumberId = body.phoneNumberId;
    } else {
      // WhatsApp-shaped format
      const value = body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      if (!message || message.type !== "text") {
        return res.status(400).json({ error: "Invalid or unsupported message format" });
      }

      from = message.from;
      text = message.text.body;
      phoneNumberId = value?.metadata?.phone_number_id;
    }

    if (!from || !text) {
      return res.status(400).json({ error: "Missing required fields: from, text" });
    }

    // If no phoneNumberId provided, fall back to first active instructor
    if (!phoneNumberId) {
      const defaultInstructor = await Instructor.findOne({
        active: true,
        phoneNumberId: { $exists: true, $not: /^signup_/ },
      }).lean();
      phoneNumberId = defaultInstructor?.phoneNumberId;
    }

    if (!phoneNumberId) {
      return res.status(400).json({ error: "No phoneNumberId provided and no active instructor found" });
    }

    console.log(`[mock-webhook] Message from ${from}: "${text}" (instructor: ${phoneNumberId})`);

    const replies = [];

    await webhookController.handleIncomingMessage(from, text, phoneNumberId, true, (reply) => {
      replies.push(reply);
    });

    return res.json({
      phoneNumberId,
      reply: replies.length === 1 ? replies[0] : replies.length > 1 ? replies : "✅ (no reply generated)",
    });
  } catch (error) {
    console.error("[mock-webhook] Error:", error.message);
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
