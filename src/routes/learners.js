const express = require("express");
const router = express.Router();
const User = require("../models/userModel");
const whatsappService = require("../services/whatsappService");
const { steps } = require("../services/userDetailsService");
const { normalizePhone } = require("../utils/normalizePhone");
const instructorAuth = require("../middleware/instructorAuth");
const logger = require("../utils/logger-advanced");

router.use(instructorAuth);

/**
 * Parse pagination params from query string.
 * Defaults: page=1, limit=20
 */
function parsePagination(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;
  return { page, limit, skip };
}

/**
 * POST /api/learners
 * Pre-register a learner for the authenticated instructor and kick off
 * their WhatsApp onboarding via a welcome template.
 */
router.post("/", async (req, res) => {
  try {
    const { phone, name, lessonRate, targetHours, testDate, notes } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: "phone is required" });
    }

    const normalizedPhone = normalizePhone(phone);

    const existing = await User.findOne({ phone: normalizedPhone });
    if (existing) {
      return res.status(409).json({ success: false, error: "Learner already exists" });
    }

    const userData = {
      phone: normalizedPhone,
      instructorId: req.instructor.phoneNumberId,
      onboardingStarted: false,
      lessonRate,
      targetHours,
      testDate,
      notes,
    };

    if (name) {
      userData.name = name;
      userData.currentStep = steps[1]; // age
    } else {
      userData.currentStep = steps[0]; // name
    }

    const user = await User.create(userData);

    try {
      await whatsappService.sendTemplateMessage(
        normalizedPhone,
        "learner_welcome",
        [req.instructor.name],
        req.instructor
      );
    } catch (err) {
      logger.error(`Failed to send learner_welcome to ${normalizedPhone}: ${err.message}`);
    }

    res.status(201).json({ success: true, data: user });
  } catch (err) {
    logger.error(`Create learner error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to create learner" });
  }
});

/**
 * GET /api/learners
 * List/search learners for the authenticated instructor.
 * Optional query: search (matches name or phone), page, limit
 */
router.get("/", async (req, res) => {
  try {
    const filter = { instructorId: req.instructor.phoneNumberId };

    if (req.query.search) {
      const regex = new RegExp(req.query.search, "i");
      filter.$or = [{ name: regex }, { phone: regex }];
    }

    const { page, limit, skip } = parsePagination(req.query);

    const [learners, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      success: true,
      data: learners,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error(`List learners error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch learners" });
  }
});

/**
 * GET /api/learners/:phone
 * Fetch a single learner scoped to the authenticated instructor.
 */
router.get("/:phone", async (req, res) => {
  try {
    const user = await User.findOne({
      phone: normalizePhone(req.params.phone),
      instructorId: req.instructor.phoneNumberId,
    }).lean();

    if (!user) {
      return res.status(404).json({ success: false, error: "Learner not found" });
    }

    res.json({ success: true, data: user });
  } catch (err) {
    logger.error(`Get learner error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch learner" });
  }
});

module.exports = router;
