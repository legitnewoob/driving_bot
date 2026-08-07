const express = require("express");
const router = express.Router();
const User = require("../models/userModel");
const Booking = require("../models/bookingModel");
const logger = require("../utils/logger-advanced");

// ─── GET /api/learners ────────────────────────────────────────────────────
// Returns all users (learners) for the instructor identified by the API key.

router.get("/", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const filter = { instructorId };
    const [users, total] = await Promise.all([
      User.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    // Map to a shape the Portal expects
    const data = users.map((u) => ({
      phone: u.phone,
      name: u.name || null,
      age: u.age || null,
      dob: u.dob || null,
      postalCode: u.postalCode || null,
      location: u.location || null,
      detailsCompleted: Boolean(u.detailsCompleted),
      onboardingStarted: Boolean(u.phone), // if the user doc exists, onboarding started
      currentStep: u.currentStep || null,
      createdAt: u.createdAt || null,
    }));

    res.json({
      success: true,
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    logger.error(`GET /api/learners error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch learners" });
  }
});

// ─── POST /api/learners ───────────────────────────────────────────────────
// Creates or updates a user/learner for the instructor.

router.post("/", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const { name, phone } = req.body;

    if (!phone) {
      return res.status(400).json({ success: false, error: "Phone number is required" });
    }

    // Normalize: strip spaces
    const normalizedPhone = phone.replace(/\s+/g, "");

    // Check if this learner already exists for this instructor
    let user = await User.findOne({ phone: normalizedPhone, instructorId });

    if (user) {
      // Update existing
      if (name) user.name = name;
      await user.save();
      return res.json({ success: true, data: user.toObject(), created: false });
    }

    // Create new user
    user = await User.create({
      phone: normalizedPhone,
      instructorId,
      name: name || null,
      detailsCompleted: false,
      currentStep: "start",
    });

    res.status(201).json({ success: true, data: user.toObject(), created: true });
  } catch (err) {
    logger.error(`POST /api/learners error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to create learner" });
  }
});

// ─── GET /api/learners/bookings ───────────────────────────────────────────
// Returns recent bookings for this instructor, used by the Portal's
// DonnaTab (activity feed) and CalendarTab.

router.get("/bookings", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const from = req.query.from; // YYYY-MM-DD
    const to = req.query.to;     // YYYY-MM-DD

    const filter = { instructorId };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = from;
      if (to) filter.date.$lte = to;
    }

    const bookings = await Booking.find(filter)
      .sort({ date: -1, time: -1 })
      .limit(limit)
      .lean();

    // Look up user names
    const phones = [...new Set(bookings.map((b) => b.userPhone))];
    const users = await User.find({ phone: { $in: phones } }).select("phone name").lean();
    const nameMap = {};
    users.forEach((u) => (nameMap[u.phone] = u.name || u.phone));

    const data = bookings.map((b) => ({
      bookingId: b.bookingId || b._id,
      userPhone: b.userPhone,
      studentName: nameMap[b.userPhone] || b.userPhone,
      date: b.date,
      time: b.time,
      status: b.status,
      location: b.location || null,
      pickupLocation: b.pickupLocation || null,
      dropoffLocation: b.dropoffLocation || null,
      createdAt: b.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err) {
    logger.error(`GET /api/learners/bookings error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

// ─── GET /api/learners/activity ───────────────────────────────────────────
// Builds a Donna-style activity feed from recent bookings.

router.get("/activity", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 30, 1), 100);

    const bookings = await Booking.find({ instructorId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Look up names
    const phones = [...new Set(bookings.map((b) => b.userPhone))];
    const users = await User.find({ phone: { $in: phones } }).select("phone name").lean();
    const nameMap = {};
    users.forEach((u) => (nameMap[u.phone] = u.name || u.phone));

    // Identify first booking per learner (for "new student" events)
    const firstBookings = await Booking.aggregate([
      { $match: { instructorId } },
      { $sort: { createdAt: 1 } },
      { $group: { _id: "$userPhone", firstId: { $first: "$_id" } } },
    ]);
    const firstIds = new Set(firstBookings.map((b) => b.firstId.toString()));

    const activity = bookings.map((b) => {
      const studentName = nameMap[b.userPhone] || b.userPhone;
      const isFirst = firstIds.has(b._id.toString());

      let type = "booked";
      let summary = `Lesson booked for ${b.date} at ${b.time}`;

      if (isFirst && b.status !== "cancelled") {
        type = "booked";
        summary = `${studentName} — first lesson booked for ${b.date} at ${b.time}`;
      } else if (b.status === "cancelled") {
        type = "cancelled";
        summary = `Lesson on ${b.date} at ${b.time} cancelled`;
      } else if (b.status === "rescheduled") {
        type = "rescheduled";
        summary = `Lesson rescheduled to ${b.date} at ${b.time}`;
      } else if (b.status === "completed") {
        type = "lesson_completed";
        summary = `Lesson on ${b.date} completed`;
      }

      return {
        type,
        studentId: null, // Portal maps by phone, not mongo id
        studentName,
        lessonDate: b.date,
        lessonTime: b.time,
        duration: null,
        timestamp: b.createdAt || b.updatedAt || new Date().toISOString(),
        reason: null,
        summary,
      };
    });

    res.json({ success: true, data: activity });
  } catch (err) {
    logger.error(`GET /api/learners/activity error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch activity" });
  }
});

module.exports = router;
