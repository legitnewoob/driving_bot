const express = require("express");
const router = express.Router();
const phoneNumberService = require("../services/phoneNumberService");
const Instructor = require("../models/instructorSchema");
const { getSetupStatus } = require("../services/setupStatus");
const { notifyNumberPoolEmpty } = require("../utils/emailNotifier");

router.get("/my-number", async (req, res) => {
  try {
    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    const assigned = await phoneNumberService.getAssignedNumber(instructor._id);
    if (!assigned) {
      return res.json({
        success: true,
        assigned: false,
        phoneNumber: null,
        phoneNumberId: null,
        assignedAt: null,
      });
    }

    res.json({
      success: true,
      assigned: true,
      phoneNumber: assigned.phoneNumber,
      phoneNumberId: assigned.phoneNumberId,
      assignedAt: assigned.assignedAt,
    });
  } catch (err) {
    console.error("[phone-numbers] my-number error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch number" });
  }
});

router.post("/request", async (req, res) => {
  try {
    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    // Donna needs these before she can take bookings on a real number
    const setup = await getSetupStatus(instructor);
    if (!setup.complete && !setup.hasNumber) {
      return res.status(400).json({
        success: false,
        error: `Finish setting up Donna first: ${setup.missing.join(", ").toLowerCase()}.`,
        code: "SETUP_INCOMPLETE",
        setup,
      });
    }

    const region = req.body.region || "GB";
    const result = await phoneNumberService.assignNumber(instructor._id, { region });

    if (!result) {
      notifyNumberPoolEmpty(instructor).catch(() => {});
      return res.status(409).json({
        success: false,
        code: "NO_NUMBERS",
        error: "We're setting up more WhatsApp numbers right now. We've been notified and will email you as soon as yours is ready.",
      });
    }

    res.json({
      success: true,
      phoneNumber: result.phoneNumber,
      phoneNumberId: result.phoneNumberId,
      assignedAt: result.assignedAt,
    });
  } catch (err) {
    console.error("[phone-numbers] request error:", err);
    res.status(500).json({ success: false, error: "Failed to assign number" });
  }
});

module.exports = router;
