const express = require("express");
const router = express.Router();
const User = require("../models/userModel");
const Booking = require("../models/bookingModel");
const Payment = require("../models/paymentModel");
const { getCoordinatesFromPostalCode } = require("../services/mapsService");
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
    const { name, phone, age, dob, postalCode } = req.body;

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
      if (age != null) user.age = age;
      if (dob) user.dob = dob;
      if (postalCode && postalCode !== user.postalCode) {
        user.postalCode = postalCode;
        try {
          const { lat, lng } = await getCoordinatesFromPostalCode(postalCode);
          user.location = { latitude: lat, longitude: lng };
        } catch (err) {
          logger.warn(`Geocoding failed for "${postalCode}": ${err.message}`);
        }
      }
      await user.save();
      return res.json({ success: true, data: user.toObject(), created: false });
    }

    // Geocode postal code if provided
    let location = null;
    if (postalCode) {
      try {
        const { lat, lng } = await getCoordinatesFromPostalCode(postalCode);
        location = { latitude: lat, longitude: lng };
      } catch (err) {
        logger.warn(`Geocoding failed for "${postalCode}": ${err.message}`);
      }
    }

    // Create new user
    user = await User.create({
      phone: normalizedPhone,
      instructorId,
      name: name || null,
      age: age || null,
      dob: dob || null,
      postalCode: postalCode || null,
      location: location || undefined,
      detailsCompleted: Boolean(name && phone),
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
      topicsCovered: b.topicsCovered || [],
      rating: b.rating || null,
      progressNotes: b.progressNotes || "",
      paymentReceived: b.paymentReceived || false,
      paymentAmount: b.paymentAmount || 0,
      completedAt: b.completedAt || null,
      createdAt: b.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err) {
    logger.error(`GET /api/learners/bookings error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

// ─── POST /api/learners/bookings ──────────────────────────────────────────
// Creates a new booking from the Portal.

router.post("/bookings", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const { userPhone, date, time, postalCode, pickupLocation, dropoffLocation, notes } = req.body;

    if (!userPhone || !date || !time) {
      return res.status(400).json({ success: false, error: "userPhone, date, and time are required" });
    }

    const normalizedPhone = userPhone.replace(/\s+/g, "");

    // Generate a unique bookingId
    const bookingId = `DL-${Date.now().toString(36).toUpperCase()}`;

    const booking = await Booking.create({
      bookingId,
      userPhone: normalizedPhone,
      instructorId,
      date,
      time,
      postalCode: postalCode || "",
      pickupLocation: pickupLocation ? { address: pickupLocation } : undefined,
      dropoffLocation: dropoffLocation ? { address: dropoffLocation } : undefined,
      progressNotes: notes || "",
      status: "confirmed",
    });

    // Look up student name
    const user = await User.findOne({ phone: normalizedPhone }).select("name").lean();

    res.status(201).json({
      success: true,
      data: {
        bookingId: booking.bookingId,
        userPhone: booking.userPhone,
        studentName: user?.name || normalizedPhone,
        date: booking.date,
        time: booking.time,
        status: booking.status,
        postalCode: booking.postalCode,
        pickupLocation: booking.pickupLocation || null,
        dropoffLocation: booking.dropoffLocation || null,
        createdAt: booking.createdAt,
      },
    });
  } catch (err) {
    logger.error(`POST /api/learners/bookings error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to create booking" });
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
        id: b.bookingId || b._id.toString(),
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

// ─── GET /api/learners/payments ──────────────────────────────────────────
// Returns all payments for the instructor.

router.get("/payments", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 100, 1), 500);

    const payments = await Payment.find({ instructorId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const phones = [...new Set(payments.map((p) => p.userPhone))];
    const users = await User.find({ phone: { $in: phones } }).select("phone name").lean();
    const nameMap = {};
    users.forEach((u) => (nameMap[u.phone] = u.name || u.phone));

    const data = payments.map((p) => ({
      paymentId: p.paymentId,
      userPhone: p.userPhone,
      studentName: nameMap[p.userPhone] || p.userPhone,
      bookingId: p.bookingId || null,
      amount: p.amount,
      method: p.method,
      date: p.date,
      note: p.note || "",
      createdAt: p.createdAt,
    }));

    res.json({ success: true, data });
  } catch (err) {
    logger.error(`GET /api/learners/payments error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch payments" });
  }
});

// ─── POST /api/learners/payments ─────────────────────────────────────────
// Records a new payment from the Portal.

router.post("/payments", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const { paymentId, userPhone, bookingId, amount, method, date, note } = req.body;

    if (!paymentId || !userPhone || !amount || !date) {
      return res.status(400).json({ success: false, error: "Missing required fields: paymentId, userPhone, amount, date" });
    }

    const existing = await Payment.findOne({ paymentId });
    if (existing) {
      return res.json({ success: true, data: { paymentId: existing.paymentId }, duplicate: true });
    }

    const payment = await Payment.create({
      paymentId,
      instructorId,
      userPhone,
      bookingId: bookingId || null,
      amount: Number(amount),
      method: method || "cash",
      date,
      note: note || "",
    });

    logger.info(`Payment ${paymentId} recorded: £${amount} from ${userPhone}`);
    res.status(201).json({ success: true, data: { paymentId: payment.paymentId } });
  } catch (err) {
    logger.error(`POST /api/learners/payments error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to record payment" });
  }
});

// ─── DELETE /api/learners/payments/:paymentId ────────────────────────────
// Deletes a payment record.

router.delete("/payments/:paymentId", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const { paymentId } = req.params;

    const result = await Payment.findOneAndDelete({ paymentId, instructorId });
    if (!result) {
      return res.status(404).json({ success: false, error: "Payment not found" });
    }

    logger.info(`Payment ${paymentId} deleted`);
    res.json({ success: true });
  } catch (err) {
    logger.error(`DELETE /api/learners/payments error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to delete payment" });
  }
});

// ─── PATCH /api/learners/bookings/:bookingId/complete ────────────────────
// Marks a booking as completed with lesson details from the Portal.

router.patch("/bookings/:bookingId/complete", async (req, res) => {
  try {
    const instructorId = req.instructor.phoneNumberId;
    const { bookingId } = req.params;
    const { topicsCovered, rating, progressNotes, paymentReceived, paymentAmount } = req.body;

    const booking = await Booking.findOne({ bookingId, instructorId });
    if (!booking) {
      return res.status(404).json({ success: false, error: "Booking not found" });
    }

    booking.status = "completed";
    booking.topicsCovered = topicsCovered || [];
    booking.rating = rating || null;
    booking.progressNotes = progressNotes || "";
    booking.paymentReceived = !!paymentReceived;
    booking.paymentAmount = Number(paymentAmount) || 0;
    booking.completedAt = new Date();
    await booking.save();

    // If payment was received, also create a Payment record
    if (paymentReceived && paymentAmount > 0) {
      const paymentId = `PAY-${bookingId}`;
      const exists = await Payment.findOne({ paymentId });
      if (!exists) {
        await Payment.create({
          paymentId,
          instructorId,
          userPhone: booking.userPhone,
          bookingId,
          amount: Number(paymentAmount),
          method: "cash",
          date: booking.date,
          note: "Received at lesson",
        });
      }
    }

    logger.info(`Booking ${bookingId} completed by instructor`);
    res.json({ success: true, data: { bookingId } });
  } catch (err) {
    logger.error(`PATCH /api/learners/bookings/:bookingId/complete error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to complete booking" });
  }
});

module.exports = router;
