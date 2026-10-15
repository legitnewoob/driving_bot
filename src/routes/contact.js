const express = require("express");
const ContactRequest = require("../models/contactRequestModel");
const { sendContactRequest } = require("../utils/emailNotifier");
const logger = require("../utils/logger-advanced");

const router = express.Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * POST /api/contact
 * Public — the website's "Contact us" form: a name, an email and a short question.
 * Emails the team (reply goes straight to the person) and keeps a copy.
 */
router.post("/", async (req, res) => {
  try {
    const { name, email, message, website } = req.body || {};
    // Hidden field only bots fill in: pretend it worked
    if (website) return res.json({ success: true });

    const clean = {
      name: String(name || "").trim().slice(0, 100),
      email: String(email || "").trim().toLowerCase().slice(0, 200),
      message: String(message || "").trim().slice(0, 1000),
    };
    if (!clean.name) return res.status(400).json({ success: false, error: "Please tell us your name" });
    if (!EMAIL.test(clean.email)) return res.status(400).json({ success: false, error: "Please enter a valid email address" });

    const saved = await ContactRequest.create(clean);
    const emailed = await sendContactRequest(clean).catch(() => false);
    if (emailed) await ContactRequest.updateOne({ _id: saved._id }, { emailed: true }).catch(() => {});
    else logger.warn(`Contact request ${saved._id} saved but not emailed`);

    res.status(201).json({ success: true });
  } catch (err) {
    logger.error(`Contact form error: ${err.message}`);
    res.status(500).json({ success: false, error: "Couldn't send your message. Please email us instead." });
  }
});

module.exports = router;
