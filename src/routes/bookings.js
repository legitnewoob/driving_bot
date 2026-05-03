const express = require("express");
const router = express.Router();
const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const Instructor = require("../models/instructorSchema");
const logger = require("../utils/logger-advanced");

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Build a Mongoose filter object from common query params.
 * Supports: status, from (date >=), to (date <=)
 */
function buildFilter(query, extra = {}) {
  const filter = { ...extra };

  if (query.status) {
    filter.status = query.status;
  }

  if (query.from || query.to) {
    filter.date = {};
    if (query.from) filter.date.$gte = query.from;
    if (query.to) filter.date.$lte = query.to;
  }

  return filter;
}

/**
 * Parse pagination & sort params from query string.
 * Defaults: page=1, limit=20, sort=date, order=desc
 */
function parsePagination(query) {
  const page = Math.max(parseInt(query.page) || 1, 1);
  const limit = Math.min(Math.max(parseInt(query.limit) || 20, 1), 100);
  const skip = (page - 1) * limit;

  const sortField = query.sort || "date";
  const sortOrder = query.order === "asc" ? 1 : -1;

  return { page, limit, skip, sort: { [sortField]: sortOrder } };
}

/**
 * Execute a paginated booking query and return a standard response envelope.
 */
async function paginatedBookings(filter, pagination) {
  const [bookings, total] = await Promise.all([
    Booking.find(filter)
      .sort(pagination.sort)
      .skip(pagination.skip)
      .limit(pagination.limit)
      .lean(),
    Booking.countDocuments(filter),
  ]);

  return {
    success: true,
    data: bookings,
    pagination: {
      page: pagination.page,
      limit: pagination.limit,
      total,
      totalPages: Math.ceil(total / pagination.limit),
    },
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/bookings/stats
 * Aggregate statistics across all bookings.
 * Optional query: instructorId, from, to
 */
router.get("/stats", async (req, res) => {
  try {
    const matchStage = {};
    if (req.query.instructorId) matchStage.instructorId = req.query.instructorId;
    if (req.query.from || req.query.to) {
      matchStage.date = {};
      if (req.query.from) matchStage.date.$gte = req.query.from;
      if (req.query.to) matchStage.date.$lte = req.query.to;
    }

    const [statusStats, instructorStats, totalBookings] = await Promise.all([
      Booking.aggregate([
        { $match: matchStage },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]),
      Booking.aggregate([
        { $match: matchStage },
        {
          $group: {
            _id: "$instructorId",
            totalBookings: { $sum: 1 },
            confirmed: {
              $sum: { $cond: [{ $eq: ["$status", "confirmed"] }, 1, 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] },
            },
            rescheduled: {
              $sum: { $cond: [{ $eq: ["$status", "rescheduled"] }, 1, 0] },
            },
          },
        },
        { $sort: { totalBookings: -1 } },
      ]),
      Booking.countDocuments(matchStage),
    ]);

    // Look up instructor names
    const instructorIds = instructorStats.map((s) => s._id);
    const instructors = await Instructor.find(
      { phoneNumberId: { $in: instructorIds } },
      "phoneNumberId name"
    ).lean();
    const nameMap = {};
    instructors.forEach((i) => (nameMap[i.phoneNumberId] = i.name));

    const byStatus = {};
    statusStats.forEach((s) => (byStatus[s._id] = s.count));

    const byInstructor = instructorStats.map((s) => ({
      instructorId: s._id,
      instructorName: nameMap[s._id] || "Unknown",
      totalBookings: s.totalBookings,
      confirmed: s.confirmed,
      cancelled: s.cancelled,
      rescheduled: s.rescheduled,
    }));

    // Unique learners count
    const uniqueLearners = await Booking.distinct("userPhone", matchStage);

    res.json({
      success: true,
      data: {
        totalBookings,
        uniqueLearners: uniqueLearners.length,
        byStatus,
        byInstructor,
      },
    });
  } catch (err) {
    logger.error(`Bookings stats error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch booking stats" });
  }
});

/**
 * GET /api/bookings/user/:phone
 * All bookings for a specific learner (by phone number).
 */
router.get("/user/:phone", async (req, res) => {
  try {
    const filter = buildFilter(req.query, { userPhone: req.params.phone });
    const pagination = parsePagination(req.query);
    const result = await paginatedBookings(filter, pagination);
    res.json(result);
  } catch (err) {
    logger.error(`Bookings by user error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

/**
 * GET /api/bookings/instructor/:instructorId
 * All bookings for a specific instructor.
 */
router.get("/instructor/:instructorId", async (req, res) => {
  try {
    const filter = buildFilter(req.query, { instructorId: req.params.instructorId });
    const pagination = parsePagination(req.query);
    const result = await paginatedBookings(filter, pagination);
    res.json(result);
  } catch (err) {
    logger.error(`Bookings by instructor error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

/**
 * GET /api/bookings/instructor/:instructorId/user/:phone
 * Bookings for a specific learner under a specific instructor.
 */
router.get("/instructor/:instructorId/user/:phone", async (req, res) => {
  try {
    const filter = buildFilter(req.query, {
      instructorId: req.params.instructorId,
      userPhone: req.params.phone,
    });
    const pagination = parsePagination(req.query);
    const result = await paginatedBookings(filter, pagination);
    res.json(result);
  } catch (err) {
    logger.error(`Bookings by instructor+user error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

/**
 * GET /api/bookings/:bookingId
 * Fetch a single booking by its bookingId.
 */
router.get("/:bookingId", async (req, res) => {
  try {
    const booking = await Booking.findOne({ bookingId: req.params.bookingId }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: "Booking not found" });
    }

    // Enrich with user name and instructor name
    const [user, instructor] = await Promise.all([
      User.findOne({ phone: booking.userPhone }, "name phone postalCode").lean(),
      Instructor.findOne(
        { phoneNumberId: booking.instructorId },
        "name phoneNumberId email"
      ).lean(),
    ]);

    res.json({
      success: true,
      data: {
        ...booking,
        learner: user || null,
        instructor: instructor || null,
      },
    });
  } catch (err) {
    logger.error(`Booking lookup error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch booking" });
  }
});

/**
 * GET /api/bookings
 * All bookings with optional filters: status, from, to, page, limit, sort, order
 */
router.get("/", async (req, res) => {
  try {
    const filter = buildFilter(req.query);
    const pagination = parsePagination(req.query);
    const result = await paginatedBookings(filter, pagination);
    res.json(result);
  } catch (err) {
    logger.error(`Bookings list error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch bookings" });
  }
});

module.exports = router;
