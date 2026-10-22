const express = require("express");
const router = express.Router();
const moment = require("moment-timezone");

const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const ChatLog = require("../models/chatLogModel");
const Instructor = require("../models/instructorSchema");
const Payment = require("../models/paymentModel");
const LessonType = require("../models/lessonTypeModel");
const { getSetupStatus } = require("../services/setupStatus");
const { schoolAllowsDonna } = require("../services/donnaStatus");
const schoolService = require("../services/schoolService");
const Notification = require("../models/notificationModel");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const calendarService = require("../services/calendarService");
const routeOptimizer = require("../services/routeOptimizer");
const settings = require("../services/instructorSettings");
const { validateSettingsUpdate, validatePreferencesUpdate } = require("../services/settingsValidation");
const { getCoordinatesFromPostalCode } = require("../services/mapsService");
const { invalidateInstructorCache } = require("../models/instructorModel");
const { learnerSummaries } = require("../services/learnerSummary");

const DEFAULT_LESSON_RATE = parseFloat(process.env.DEFAULT_LESSON_RATE) || 50;
const MONTHLY_REVENUE_TARGET = parseFloat(process.env.MONTHLY_REVENUE_TARGET) || 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────

function getInstructorTimezone(instructor) {
  return instructor?.timezone || timezoneUtils.timezone || "Europe/London";
}

// What a school owner or manager may change for one of their instructors
const MANAGEABLE_PATHS = [/^\/lesson-types(\/[^/]+)?$/, /^\/learners\/[^/]+\/notes$/];

async function resolveInstructor(req) {
  const jwtSecret = process.env.JWT_SECRET;

  if (jwtSecret) {
    // When JWT auth is configured, the dashboard must be user-authenticated.
    if (!req.user?.email) return null;

    const instructor = await Instructor.findOne({ email: req.user.email, active: true }).lean();
    if (!instructor) return null;

    // A school owner can look at one of their instructors (?instructor=<id>). They
    // can also change that instructor's lesson types and prices and learner notes;
    // every other change always applies to the signed-in instructor.
    if (req.query.instructor) {
      if (req.method === "GET") return schoolService.viewableInstructor(instructor, req.query.instructor);
      if (MANAGEABLE_PATHS.some((r) => r.test(req.path))) {
        const member = await schoolService.manageableInstructor(instructor, req.query.instructor);
        if (member && String(member._id) !== String(instructor._id)) {
          require("../services/auditLog")
            .audit(instructor.email, "school.manage", member.email, { method: req.method, path: req.path })
            .catch(() => {});
        }
        return member;
      }
    }
    return instructor;
  }

  // Dev fallback: allow an instructorId query parameter in development only.
  if (process.env.NODE_ENV === "development" && req.query.instructorId) {
    return Instructor.findOne({
      $or: [
        { phoneNumberId: req.query.instructorId },
        { phone: req.query.instructorId },
      ],
      active: true,
    }).lean();
  }

  return null;
}

function makeUserInfo(instructor) {
  const name = instructor?.name || "Instructor";
  const firstName = name.split(" ")[0];
  const initials = name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return {
    name,
    firstName,
    initials,
    email: instructor?.email || "",
    phoneNumberId: instructor?.phoneNumberId || "",
    calendarConnected: Boolean(instructor?.googleRefreshToken),
  };
}

function getRangeBounds(range, tz) {
  const now = moment.tz(tz);
  let from;
  let to;
  let prevFrom;
  let prevTo;

  switch (range) {
    case "Today":
      from = now.clone().startOf("day");
      to = now.clone().endOf("day");
      prevFrom = now.clone().subtract(1, "day").startOf("day");
      prevTo = prevFrom.clone().endOf("day");
      break;
    case "This month":
      from = now.clone().startOf("month");
      to = now.clone().endOf("month");
      prevFrom = now.clone().subtract(1, "month").startOf("month");
      prevTo = prevFrom.clone().endOf("month");
      break;
    case "This year":
      from = now.clone().startOf("year");
      to = now.clone().endOf("year");
      prevFrom = now.clone().subtract(1, "year").startOf("year");
      prevTo = prevFrom.clone().endOf("year");
      break;
    case "This week":
    default:
      // ISO week: Monday to Sunday
      from = now.clone().startOf("isoWeek");
      to = from.clone().add(6, "days").endOf("day");
      prevFrom = from.clone().subtract(7, "days");
      prevTo = prevFrom.clone().add(6, "days").endOf("day");
      break;
  }

  return { from, to, prevFrom, prevTo, now };
}

function formatTime12(time24) {
  if (!time24) return "";
  return moment(time24, "HH:mm").format("h:mm A");
}

function pctChange(curr, prev) {
  if (prev === 0) {
    return curr > 0 ? "+100%" : "0%";
  }
  const change = ((curr - prev) / prev) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

function absoluteChange(curr, prev) {
  const diff = curr - prev;
  const sign = diff >= 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}%`;
}

async function fetchUserMap(phones, instructorId) {
  const users = await User.find({
    phone: { $in: phones },
    instructorId: instructorId || { $exists: true },
  })
    .select("phone name")
    .lean();

  const map = {};
  users.forEach((u) => {
    map[u.phone] = u.name || u.phone;
  });
  return map;
}

// ─── Stats ────────────────────────────────────────────────────────────────

async function buildStats(instructor, range) {
  const tz = getInstructorTimezone(instructor);
  const { from, to, prevFrom, prevTo } = getRangeBounds(range, tz);

  const baseFilter = { instructorId: instructor.phoneNumberId };
  const dateFilter = { date: { $gte: from.format("YYYY-MM-DD"), $lte: to.format("YYYY-MM-DD") } };
  const prevDateFilter = { date: { $gte: prevFrom.format("YYYY-MM-DD"), $lte: prevTo.format("YYYY-MM-DD") } };

  const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;

  const [
    currentBookings,
    previousBookings,
    allStudents,
    currentDistinctStudents,
    previousDistinctStudents,
    currentMessages,
    previousMessages,
  ] = await Promise.all([
    Booking.find({ ...baseFilter, ...dateFilter }).lean(),
    Booking.find({ ...baseFilter, ...prevDateFilter }).lean(),
    Booking.distinct("userPhone", baseFilter),
    Booking.distinct("userPhone", { ...baseFilter, ...dateFilter }),
    Booking.distinct("userPhone", { ...baseFilter, ...prevDateFilter }),
    ChatLog.countDocuments({
      instructor: instructor.phoneNumberId,
      date: { $gte: from.format("YYYY-MM-DD"), $lte: to.format("YYYY-MM-DD") },
    }),
    ChatLog.countDocuments({
      instructor: instructor.phoneNumberId,
      date: { $gte: prevFrom.format("YYYY-MM-DD"), $lte: prevTo.format("YYYY-MM-DD") },
    }),
  ]);

  const currentLessons = currentBookings.length;
  const previousLessons = previousBookings.length;

  const currentConfirmed = currentBookings.filter(
    (b) => b.status === "confirmed" || b.status === "rescheduled"
  );
  const previousConfirmed = previousBookings.filter(
    (b) => b.status === "confirmed" || b.status === "rescheduled"
  );

  const currentRevenue = currentConfirmed.length * rate;
  const previousRevenue = previousConfirmed.length * rate;

  const currentCancelled = currentBookings.filter((b) => b.status === "cancelled").length;
  const previousCancelled = previousBookings.filter((b) => b.status === "cancelled").length;

  const cancelRate = currentLessons ? (currentCancelled / currentLessons) * 100 : 0;
  const previousCancelRate = previousLessons ? (previousCancelled / previousLessons) * 100 : 0;

  const avgValue = currentLessons ? currentRevenue / currentLessons : 0;
  const previousAvgValue = previousLessons ? previousRevenue / previousLessons : 0;

  return [
    {
      title: "Total Students",
      value: String(allStudents.length),
      change: pctChange(currentDistinctStudents.length, previousDistinctStudents.length),
      icon: "Users",
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Lessons",
      value: String(currentLessons),
      change: pctChange(currentLessons, previousLessons),
      icon: "Calendar",
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Messages",
      value: String(currentMessages),
      change: pctChange(currentMessages, previousMessages),
      icon: "MessageSquare",
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      title: "Revenue",
      value: `£${currentRevenue.toLocaleString()}`,
      change: pctChange(currentRevenue, previousRevenue),
      icon: "TrendingUp",
      color: "text-orange-600",
      bgColor: "bg-orange-50",
    },
    {
      title: "Cancel Rate",
      value: `${cancelRate.toFixed(1)}%`,
      change: absoluteChange(cancelRate, previousCancelRate),
      icon: "Clock",
      color: "text-red-600",
      bgColor: "bg-red-50",
    },
    {
      title: "Avg. Value",
      value: `£${Math.round(avgValue)}`,
      change: pctChange(avgValue, previousAvgValue),
      icon: "BarChart3",
      color: "text-indigo-600",
      bgColor: "bg-indigo-50",
    },
  ];
}

// ─── Schedule & Upcoming ─────────────────────────────────────────────────

async function buildTodaySchedule(instructor) {
  const tz = getInstructorTimezone(instructor);
  const today = moment.tz(tz).format("YYYY-MM-DD");

  const bookings = await Booking.find({
    instructorId: instructor.phoneNumberId,
    date: today,
  })
    .sort({ time: 1 })
    .lean();

  const userMap = await fetchUserMap(
    bookings.map((b) => b.userPhone),
    instructor.phoneNumberId
  );

  return bookings.map((b) => ({
    student: userMap[b.userPhone] || b.userPhone,
    time: formatTime12(b.time),
    duration: "1h",
    status: b.status === "cancelled" ? "cancelled" : "confirmed",
  }));
}

function dayLabelForBooking(dateStr, tz) {
  const today = moment.tz(tz).format("YYYY-MM-DD");
  const tomorrow = moment.tz(tz).add(1, "day").format("YYYY-MM-DD");

  if (dateStr === today) return "Today";
  if (dateStr === tomorrow) return "Tomorrow";
  return moment.tz(dateStr, "YYYY-MM-DD", tz).format("ddd");
}

async function buildUpcomingLessons(instructor) {
  const tz = getInstructorTimezone(instructor);
  const today = moment.tz(tz).format("YYYY-MM-DD");

  const bookings = await Booking.find({
    instructorId: instructor.phoneNumberId,
    date: { $gte: today },
    status: { $in: ["confirmed", "rescheduled"] },
  })
    .sort({ date: 1, time: 1 })
    .limit(6)
    .lean();

  const userMap = await fetchUserMap(
    bookings.map((b) => b.userPhone),
    instructor.phoneNumberId
  );

  return bookings.map((b) => ({
    student: userMap[b.userPhone] || b.userPhone,
    time: `${dayLabelForBooking(b.date, tz)}, ${formatTime12(b.time)}`,
    status: "confirmed",
  }));
}

// ─── Charts ───────────────────────────────────────────────────────────────

async function buildRevenueData(instructor) {
  const tz = getInstructorTimezone(instructor);
  const startOfWeek = moment.tz(tz).startOf("isoWeek");
  const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;

  const days = [];
  const counts = await Promise.all(
    Array.from({ length: 7 }, (_, i) => {
      const day = startOfWeek.clone().add(i, "days");
      return Booking.countDocuments({
        instructorId: instructor.phoneNumberId,
        date: day.format("YYYY-MM-DD"),
        status: { $in: ["confirmed", "rescheduled"] },
      }).then((count) => ({
        name: day.format("ddd"),
        revenue: count * rate,
      }));
    })
  );

  return counts;
}

async function buildLessonData(instructor) {
  const bookings = await Booking.find({
    instructorId: instructor.phoneNumberId,
  }).lean();

  let booked = 0;
  let completed = 0;
  let cancelled = 0;

  bookings.forEach((b) => {
    if (b.status === "completed") {
      completed += 1;
    } else if (b.status === "cancelled") {
      cancelled += 1;
    } else {
      // confirmed or rescheduled count as booked
      booked += 1;
    }
  });

  return [
    { name: "Booked", value: booked, color: "#3b82f6" },
    { name: "Completed", value: completed, color: "#10b981" },
    { name: "Cancelled", value: cancelled, color: "#f59e0b" },
  ];
}

async function buildStudentGrowth(instructor) {
  const tz = getInstructorTimezone(instructor);
  const months = [];

  for (let i = 3; i >= 0; i--) {
    const m = moment.tz(tz).subtract(i, "months");
    const start = m.clone().startOf("month").format("YYYY-MM-DD");
    const end = m.clone().endOf("month").format("YYYY-MM-DD");

    const count = (
      await Booking.distinct("userPhone", {
        instructorId: instructor.phoneNumberId,
        date: { $gte: start, $lte: end },
      })
    ).length;

    months.push({ name: m.format("MMM"), students: count });
  }

  return months;
}

// ─── Activity ───────────────────────────────────────────────────────────

async function buildActivity(instructor) {
  const recentBookings = await Booking.find({
    instructorId: instructor.phoneNumberId,
  })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  if (!recentBookings.length) return [];

  // Identify the first booking for each learner
  const firstBookings = await Booking.aggregate([
    { $match: { instructorId: instructor.phoneNumberId } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$userPhone", firstId: { $first: "$_id" } } },
  ]);

  const firstIds = new Set(firstBookings.map((b) => b.firstId.toString()));

  const userMap = await fetchUserMap(
    recentBookings.map((b) => b.userPhone),
    instructor.phoneNumberId
  );

  const activity = [];

  for (const b of recentBookings) {
    const student = userMap[b.userPhone] || b.userPhone;

    if (firstIds.has(b._id.toString())) {
      activity.push({
        text: `New student signup: ${student}`,
        time: moment(b.createdAt).fromNow(),
        icon: "Users",
      });
      continue;
    }

    if (b.status === "cancelled") {
      activity.push({
        text: `Lesson cancelled by ${student}`,
        time: moment(b.createdAt).fromNow(),
        icon: "Clock",
      });
      continue;
    }

    if (b.status === "rescheduled") {
      activity.push({
        text: `${student} rescheduled a lesson`,
        time: moment(b.createdAt).fromNow(),
        icon: "Calendar",
      });
      continue;
    }

    activity.push({
      text: `${student} booked a lesson`,
      time: moment(b.createdAt).fromNow(),
      icon: "Calendar",
    });
  }

  // If we have fewer than 4 items, pad with a static route-optimization hint
  if (activity.length < 4) {
    activity.push({
      text: "Route optimized for tomorrow",
      time: "1 hour ago",
      icon: "Route",
    });
  }

  return activity.slice(0, 4);
}

// ─── Revenue Goal ────────────────────────────────────────────────────────

async function buildRevenueGoal(instructor) {
  const tz = getInstructorTimezone(instructor);
  const monthStart = moment.tz(tz).startOf("month").format("YYYY-MM-DD");
  const monthEnd = moment.tz(tz).endOf("month").format("YYYY-MM-DD");
  const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;

  const confirmedThisMonth = await Booking.countDocuments({
    instructorId: instructor.phoneNumberId,
    date: { $gte: monthStart, $lte: monthEnd },
    status: { $in: ["confirmed", "rescheduled"] },
  });

  const target = MONTHLY_REVENUE_TARGET;
  const current = confirmedThisMonth * rate;

  return { current, target };
}

// ─── Routes ─────────────────────────────────────────────────────────────

router.get("/me", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);

    if (!instructor) {
      return res.status(401).json({ success: false, error: "Instructor not found" });
    }

    res.json({ success: true, data: makeUserInfo(instructor) });
  } catch (err) {
    logger.error(`Dashboard /me error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch instructor profile" });
  }
});

router.get("/", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);

    if (!instructor) {
      return res.status(401).json({
        success: false,
        error: "Instructor not found. Provide a valid JWT or instructorId.",
      });
    }

    const range = req.query.range || "This week";

    const [
      user,
      stats,
      todaySchedule,
      upcomingLessons,
      revenueData,
      lessonData,
      studentGrowth,
      activity,
      revenueGoal,
    ] = await Promise.all([
      Promise.resolve(makeUserInfo(instructor)),
      buildStats(instructor, range),
      buildTodaySchedule(instructor),
      buildUpcomingLessons(instructor),
      buildRevenueData(instructor),
      buildLessonData(instructor),
      buildStudentGrowth(instructor),
      buildActivity(instructor),
      buildRevenueGoal(instructor),
    ]);

    res.json({
      success: true,
      data: {
        user,
        stats,
        todaySchedule,
        upcomingLessons,
        revenueData,
        lessonData,
        studentGrowth,
        activity,
        revenueGoal,
      },
    });
  } catch (err) {
    logger.error(`Dashboard error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch dashboard data" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Learners
// ═══════════════════════════════════════════════════════════════════════════

router.get("/learners", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const learners = await learnerSummaries(instructor);

    const search = (req.query.search || "").toLowerCase();
    const filtered = search
      ? learners.filter((l) => (l.name || "").toLowerCase().includes(search) || l.phone.includes(search))
      : learners;

    res.json({ success: true, data: filtered });
  } catch (err) {
    logger.error(`Dashboard /learners error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch learners" });
  }
});

router.get("/learners/:phone", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const instructorId = instructor.phoneNumberId;
    const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;
    const phone = req.params.phone;

    const [user, bookings, payments] = await Promise.all([
      User.findOne({ phone, instructorId }).lean(),
      Booking.find({ userPhone: phone, instructorId }).sort({ date: -1, time: -1 }).lean(),
      Payment.find({ userPhone: phone, instructorId }).sort({ date: -1 }).lean(),
    ]);

    if (!user) return res.status(404).json({ success: false, error: "Learner not found" });

    const completed = bookings.filter((b) => b.status === "completed");
    const lessonsCompleted = completed.length;
    const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0);
    const totalCharged = completed.reduce((sum, b) => sum + (b.price ?? rate), 0);

    res.json({
      success: true,
      data: {
        phone: user.phone,
        name: user.name || null,
        age: user.age || null,
        dob: user.dob || null,
        postalCode: user.postalCode || null,
        instructorNotes: user.instructorNotes || "",
        schedulingPrefs: prefsPayload(user.schedulingPrefs),
        createdAt: user.createdAt || null,
        lessonsCompleted,
        totalPaid,
        totalCharged,
        outstanding: Math.max(0, totalCharged - totalPaid),
        credit: Math.max(0, totalPaid - totalCharged),
        lessons: bookings.map((b) => ({
          bookingId: b.bookingId,
          date: b.date,
          time: b.time,
          status: b.status,
          topicsCovered: b.topicsCovered || [],
          rating: b.rating,
          progressNotes: b.progressNotes || "",
          paymentReceived: b.paymentReceived,
          paymentAmount: b.paymentAmount,
          lessonTypeName: b.lessonTypeName || "",
          price: b.price ?? null,
          lateCancellation: !!b.lateCancellation,
        })),
        payments: payments.map((p) => ({
          paymentId: p.paymentId,
          amount: p.amount,
          method: p.method,
          date: p.date,
          note: p.note || "",
        })),
      },
    });
  } catch (err) {
    logger.error(`Dashboard /learners/:phone error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch learner" });
  }
});

router.patch("/learners/:phone/notes", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { notes } = req.body;
    if (typeof notes !== "string") return res.status(400).json({ success: false, error: "notes must be a string" });
    if (notes.length > 5000) return res.status(400).json({ success: false, error: "Notes can be up to 5,000 characters" });

    const user = await User.findOneAndUpdate(
      { phone: req.params.phone, instructorId: instructor.phoneNumberId },
      { instructorNotes: notes },
      { new: true }
    );

    if (!user) return res.status(404).json({ success: false, error: "Learner not found" });

    res.json({ success: true });
  } catch (err) {
    logger.error(`Dashboard /learners/:phone/notes error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to update notes" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Learner scheduling preferences
// ═══════════════════════════════════════════════════════════════════════════

const PREFS_DEFAULTS = {
  priority: false,
  maxAddedDriveMin: null,
  savedPlaces: [],
  preferredDays: [],
  preferredTimes: [],
  unavailable: [],
  defaultLessonTypeId: null,
  maxLessonsPerWeek: null,
  donnaPaused: false,
};

function prefsPayload(prefs) {
  const p = { ...PREFS_DEFAULTS, ...(prefs || {}) };
  return {
    ...p,
    defaultLessonTypeId: p.defaultLessonTypeId ? String(p.defaultLessonTypeId) : null,
    savedPlaces: (p.savedPlaces || []).map((s) => ({
      label: s.label,
      address: s.address,
      located: typeof s.latitude === "number",
    })),
  };
}

router.patch("/learners/:phone/preferences", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { errors, value } = validatePreferencesUpdate(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const user = await User.findOne({ phone: req.params.phone, instructorId: instructor.phoneNumberId });
    if (!user) return res.status(404).json({ success: false, error: "Learner not found" });

    if (value.defaultLessonTypeId) {
      const owned = await LessonType.exists({ _id: value.defaultLessonTypeId, instructorId: instructor.phoneNumberId });
      if (!owned) return res.status(400).json({ success: false, error: "That lesson type doesn't exist" });
    }

    const current = user.schedulingPrefs?.toObject ? user.schedulingPrefs.toObject() : user.schedulingPrefs || {};

    if (value.savedPlaces) {
      const known = new Map((current.savedPlaces || []).map((p) => [p.address.toLowerCase(), p]));
      const located = [];
      for (const place of value.savedPlaces) {
        const prev = known.get(place.address.toLowerCase());
        if (prev && typeof prev.latitude === "number") {
          located.push({ ...place, latitude: prev.latitude, longitude: prev.longitude });
          continue;
        }
        try {
          const geo = await getCoordinatesFromPostalCode(place.address);
          located.push({ ...place, latitude: geo.lat, longitude: geo.lng });
        } catch (err) {
          const f = geocodeFailure(err, `Couldn't find "${place.address}". Check the address or postcode.`);
          return res.status(f.status).json({ success: false, error: f.error });
        }
      }
      value.savedPlaces = located;
    }

    user.schedulingPrefs = { ...current, ...value };
    await user.save();

    res.json({ success: true, data: prefsPayload(user.schedulingPrefs.toObject ? user.schedulingPrefs.toObject() : user.schedulingPrefs) });
  } catch (err) {
    logger.error(`Dashboard /learners/:phone/preferences error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to update preferences" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Donna settings (route & bot behaviour)
// ═══════════════════════════════════════════════════════════════════════════

// Google refusing the request (bad key, billing off, quota) isn't the user's
// address being wrong, so say so instead of "couldn't find".
function geocodeFailure(err, notFoundMessage) {
  const msg = err?.message || "";
  if (/REQUEST_DENIED|OVER_QUERY_LIMIT|OVER_DAILY_LIMIT/.test(msg)) {
    logger.error(`Geocoding unavailable: ${msg}`);
    return { status: 503, error: "Address lookup isn't working right now (Google Maps setup problem). Please try again later." };
  }
  return { status: 400, error: notFoundMessage };
}

function plainObj(v) {
  if (!v) return {};
  return typeof v.toObject === "function" ? v.toObject() : v;
}

function settingsPayload(instructor) {
  const route = plainObj(instructor.routeSettings);
  return {
    baseAddress: instructor.baseAddress || "",
    hasBaseLocation: !!routeOptimizer.homePoint(instructor),
    routeSettings: {
      ...settings.ROUTE_DEFAULTS,
      ...route,
      serviceArea: (() => {
        const area = { ...settings.ROUTE_DEFAULTS.serviceArea, ...(route.serviceArea || {}) };
        const { radius, unit } = settings.serviceRadius(area);
        return { radius, unit, postcodeDistricts: area.postcodeDistricts };
      })(),
    },
    botSettings: {
      ...settings.resolveBotSettings(instructor),
      workingHours: settings.workingHoursFor(instructor),
      dayHours: settings.dayHoursFor(instructor),
    },
    presets: settings.ROUTE_PRESETS,
  };
}

const toMinutes = (t) => settings.toMinutes(t);

// The lunch window has to be long enough for the lunch itself
function lunchProblem(lunch) {
  if (!lunch?.enabled) return null;
  if (toMinutes(lunch.windowTo) - toMinutes(lunch.windowFrom) < lunch.durationMin) {
    return `Lunch window ${lunch.windowFrom}–${lunch.windowTo} is shorter than a ${lunch.durationMin}-minute lunch`;
  }
  return null;
}

router.get("/notifications", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
    if (isNaN(since.getTime())) return res.status(400).json({ success: false, error: "Invalid since" });

    const items = await Notification.find({ instructorId: instructor.phoneNumberId, createdAt: { $gt: since } })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json({
      success: true,
      data: items.map((n) => ({
        id: n.clientId,
        type: n.type,
        message: n.message,
        bookingId: n.bookingId,
        learnerPhone: n.learnerPhone,
        createdAt: n.createdAt,
      })),
    });
  } catch (err) {
    logger.error(`Dashboard /notifications error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to load notifications" });
  }
});

// What's still needed before the instructor can request a WhatsApp number
router.get("/setup-status", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    res.json({ success: true, data: await getSetupStatus(instructor) });
  } catch (err) {
    logger.error(`Dashboard /setup-status error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to load setup status" });
  }
});

// Settings plus setup progress. Donna only counts as on once setup is finished:
// until then she can't really work, so the switch shows off rather than a false "on".
// Their driving school can also switch her off for everyone.
async function withSetup(payload, setup, instructor) {
  const schoolOff = !(await schoolAllowsDonna(instructor));
  return {
    ...payload,
    botSettings: { ...payload.botSettings, donnaEnabled: payload.botSettings.donnaEnabled && setup.complete && !schoolOff },
    donnaOffBySchool: schoolOff,
    setup,
  };
}

/**
 * GET /api/dashboard/referral
 * Their "give a month, get a month" link and how it's going.
 */
router.get("/referral", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    res.json({ success: true, data: await require("../services/launchService").referralFor(instructor) });
  } catch (err) {
    logger.error(`Dashboard /referral error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to load your referral link" });
  }
});

router.get("/settings", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    res.json({ success: true, data: await withSetup(settingsPayload(instructor), await getSetupStatus(instructor), instructor) });
  } catch (err) {
    logger.error(`Dashboard /settings error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to load settings" });
  }
});

router.patch("/settings", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { errors, baseAddress, routeSettings, botSettings } = validateSettingsUpdate(req.body || {});
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const doc = await Instructor.findById(instructor._id);
    if (!doc) return res.status(404).json({ success: false, error: "Instructor not found" });

    if (baseAddress !== undefined) {
      if (!baseAddress) {
        doc.baseAddress = "";
        doc.baseLocation = undefined;
      } else {
        try {
          const geo = await getCoordinatesFromPostalCode(baseAddress);
          doc.baseAddress = geo.formattedAddress || baseAddress;
          doc.baseLocation = { latitude: geo.lat, longitude: geo.lng };
        } catch (err) {
          const f = geocodeFailure(err, "Couldn't find that address. Check it and try again.");
          return res.status(f.status).json({ success: false, error: f.error });
        }
      }
    }

    if (routeSettings) {
      const cur = plainObj(doc.routeSettings);
      doc.routeSettings = {
        ...cur,
        ...routeSettings,
        serviceArea: { ...(cur.serviceArea || {}), ...(routeSettings.serviceArea || {}) },
      };
    }

    if (botSettings) {
      const cur = plainObj(doc.botSettings);
      const holiday = { ...plainObj(cur.holiday), ...(botSettings.holiday || {}) };
      if (holiday.enabled && (!holiday.from || !holiday.to)) {
        return res.status(400).json({ success: false, error: "Holiday mode needs a start and end date" });
      }
      const notifications = { ...plainObj(cur.notifications), ...(botSettings.notifications || {}) };
      const lunch = { ...settings.LUNCH_DEFAULTS, ...plainObj(cur.lunch), ...(botSettings.lunch || {}) };
      const badLunch = lunchProblem(lunch);
      if (badLunch) return res.status(400).json({ success: false, error: badLunch });
      doc.botSettings = { ...cur, ...botSettings, holiday, notifications, lunch };
      // Switching to packed mode for the first time: keep the same working days
      // by starting from the hours the start-time chips imply
      if (botSettings.scheduleMode === "packed" && !cur.dayHours && botSettings.dayHours === undefined) {
        doc.botSettings.dayHours = settings.dayHoursFor({ ...doc.toObject(), botSettings: { ...cur, dayHours: null } });
      }
    }

    // Turning Donna on needs the basics filled in first, and the school's switch on
    if (botSettings?.donnaEnabled === true && !(await schoolAllowsDonna(doc))) {
      return res.status(409).json({
        success: false,
        code: "SCHOOL_DONNA_OFF",
        error: "Your driving school has switched Donna off for everyone. Ask your school to turn her back on.",
      });
    }
    if (botSettings?.donnaEnabled === true) {
      const setup = await getSetupStatus(doc);
      if (!setup.complete) {
        return res.status(409).json({
          success: false,
          code: "SETUP_INCOMPLETE",
          error: "Finish setting up before turning Donna on.",
          missing: setup.missing,
          required: setup.required,
        });
      }
    }

    await doc.save();
    invalidateInstructorCache(doc.phoneNumberId);

    const saved = doc.toObject();
    res.json({ success: true, data: await withSetup(settingsPayload(saved), await getSetupStatus(saved), saved) });
  } catch (err) {
    logger.error(`Dashboard PATCH /settings error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to save settings" });
  }
});

router.post("/route-preview", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { date, address, routeSettings: draft } = req.body || {};
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: "Pick a date" });
    }
    if (typeof address !== "string" || !address.trim()) {
      return res.status(400).json({ success: false, error: "Enter a postcode or address" });
    }

    let previewInstructor = instructor;
    if (draft !== undefined) {
      const { errors, routeSettings } = validateSettingsUpdate({ routeSettings: draft });
      if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });
      const cur = plainObj(instructor.routeSettings);
      previewInstructor = {
        ...instructor,
        routeSettings: { ...cur, ...routeSettings, serviceArea: { ...(cur.serviceArea || {}), ...(routeSettings.serviceArea || {}) } },
      };
    }

    let geo;
    try {
      geo = await getCoordinatesFromPostalCode(address.trim());
    } catch (err) {
      const f = geocodeFailure(err, "Couldn't find that postcode or address");
      return res.status(f.status).json({ success: false, error: f.error });
    }
    const userLoc = { lat: geo.lat, long: geo.lng };

    const base = {
      date,
      location: geo.formattedAddress || address.trim(),
      hasBaseLocation: !!routeOptimizer.homePoint(previewInstructor),
      serviceArea: routeOptimizer.checkServiceArea(previewInstructor, userLoc, address.trim()),
    };

    if (!settings.isWorkingDay(previewInstructor, date)) {
      return res.json({ success: true, data: { ...base, closedReason: "not_working_day", freeSlots: [], offered: [], slots: [] } });
    }
    if (settings.isOnHoliday(previewInstructor, date)) {
      return res.json({ success: true, data: { ...base, closedReason: "holiday", freeSlots: [], offered: [], slots: [] } });
    }

    const freeSlots = await calendarService.getAvailableTimeSlotsForDate(date, previewInstructor);
    const day = await routeOptimizer.planDay({ date, instructor: previewInstructor, availableSlots: freeSlots, userLoc });

    const byTime = (a, b) => routeOptimizer.timeToMinutes(a.slot) - routeOptimizer.timeToMinutes(b.slot);
    const slots = day.evaluations.length
      ? day.evaluations.map((e) => ({
          slot: e.slot,
          feasible: e.feasible,
          addedDriveMin: e.addedDrive == null ? null : Math.round(e.addedDrive),
          reason: e.reason,
          offered: day.offered.includes(e.slot),
        }))
      : freeSlots.map((slot) => ({ slot, feasible: true, addedDriveMin: null, reason: "", offered: day.offered.includes(slot) }));

    res.json({
      success: true,
      data: {
        ...base,
        closedReason: day.blockedReason || null,
        freeSlots,
        offered: day.offered,
        usedFallback: !!day.usedFallback,
        slots: slots.sort(byTime),
      },
    });
  } catch (err) {
    logger.error(`Dashboard /route-preview error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to preview route" });
  }
});

/**
 * POST /api/dashboard/day-preview
 * How many lessons of each type fit in a day with these (draft) settings,
 * assuming every drive takes the full X: the guaranteed minimum.
 * Body: { bufferMin?, dayHours?: { start, end }, lunch?, durationMins? }
 */
router.post("/day-preview", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const body = req.body || {};
    const draft = {};
    if (body.bufferMin !== undefined) draft.routeSettings = { bufferMin: body.bufferMin };
    if (body.lunch !== undefined) draft.botSettings = { lunch: body.lunch };
    const { errors, routeSettings, botSettings } = validateSettingsUpdate(draft);
    if (errors.length) return res.status(400).json({ success: false, error: errors[0], errors });

    const bot = settings.resolveBotSettings(instructor);
    const lunch = { ...bot.lunch, ...(botSettings?.lunch || {}) };
    const badLunch = lunchProblem(lunch);
    if (badLunch) return res.status(400).json({ success: false, error: badLunch });

    const X = routeSettings?.bufferMin ?? settings.resolveRouteSettings(instructor).bufferMin;
    let hours = body.dayHours;
    if (hours !== undefined) {
      const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!hours || !TIME.test(hours.start || "") || !TIME.test(hours.end || "") || hours.start >= hours.end) {
        return res.status(400).json({ success: false, error: "dayHours needs a start before its end" });
      }
    } else {
      // The instructor's longest working day
      const days = Object.values(settings.dayHoursFor(instructor)).filter(Boolean);
      hours = days.sort((a, b) => (toMinutes(b.end) - toMinutes(b.start)) - (toMinutes(a.end) - toMinutes(a.start)))[0]
        || { start: "09:00", end: "17:00" };
    }

    let lengths = Array.isArray(body.durationMins) ? body.durationMins : null;
    let types = [];
    if (!lengths) {
      types = await LessonType.find({ instructorId: instructor.phoneNumberId, active: true })
        .sort({ durationMin: 1 })
        .lean();
      lengths = types.filter((t) => t.durationMin).map((t) => t.durationMin);
      if (!lengths.length) lengths = [60, 90, 120];
    }
    lengths = [...new Set(lengths)].filter((d) => Number.isInteger(d) && d >= 30 && d <= 180).slice(0, 10);

    const lunchMin = lunch.enabled
      ? { durationMin: lunch.durationMin, from: toMinutes(lunch.windowFrom), to: toMinutes(lunch.windowTo) }
      : null;
    const dayPacker = require("../services/dayPacker");
    const days = lengths.map((d) => {
      const day = dayPacker.packEmptyDay({
        start: toMinutes(hours.start),
        end: toMinutes(hours.end),
        d,
        X,
        lunch: lunchMin,
        blocks: settings.breakBlocks(instructor),
      });
      const type = types.find((t) => t.durationMin === d);
      return {
        durationMin: d,
        name: type?.name || null,
        count: day.count,
        starts: day.starts.map(settings.toTime),
        lunch: day.lunch ? { from: settings.toTime(day.lunch.from), to: settings.toTime(day.lunch.to) } : null,
      };
    });

    res.json({ success: true, data: { bufferMin: X, dayHours: hours, lunch, days } });
  } catch (err) {
    logger.error(`Dashboard /day-preview error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to preview your day" });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Lesson Types
// ═══════════════════════════════════════════════════════════════════════════

// Another active lesson type with this length, if there is one
async function sameLengthType(instructorId, durationMin, exceptId = null) {
  return LessonType.findOne({
    instructorId,
    durationMin,
    active: true,
    ...(exceptId && { _id: { $ne: exceptId } }),
  }).lean();
}

function duplicateLengthMessage(other) {
  const { formatDuration } = require("../services/lessonTypes");
  return `"${other.name}" is already ${formatDuration(other.durationMin)} long. Each lesson type needs a different length.`;
}

router.get("/lesson-types", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const types = await LessonType.find({ instructorId: instructor.phoneNumberId })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean();

    res.json({ success: true, data: types });
  } catch (err) {
    logger.error(`Dashboard /lesson-types GET error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to fetch lesson types" });
  }
});

/** What's wrong with these lesson-type fields, if anything (only the ones given are checked). */
function lessonTypeProblem({ name, price, description, active, sortOrder, durationMin }) {
  if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 60)) return "Name must be 1–60 characters";
  if (durationMin !== undefined && !(Number.isInteger(durationMin) && durationMin >= 30 && durationMin <= 180 && durationMin % 15 === 0)) {
    return "Length must be 30 minutes to 3 hours, in 15-minute steps";
  }
  if (price !== undefined && !(typeof price === "number" && Number.isFinite(price) && price >= 0 && price <= 1000)) return "Price must be a number from 0 to 1000";
  if (description !== undefined && (typeof description !== "string" || description.length > 500)) return "Description can be up to 500 characters";
  if (active !== undefined && typeof active !== "boolean") return "active must be true or false";
  if (sortOrder !== undefined && !Number.isInteger(sortOrder)) return "sortOrder must be a whole number";
  return null;
}

router.post("/lesson-types", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { name, price, description, durationMin } = req.body;
    if (!name || price == null || durationMin == null) {
      return res.status(400).json({ success: false, error: "name, price and length are required" });
    }
    const bad = lessonTypeProblem({ name, price, description, durationMin });
    if (bad) return res.status(400).json({ success: false, error: bad });
    const clash = await sameLengthType(instructor.phoneNumberId, durationMin);
    if (clash) return res.status(409).json({ success: false, code: "DUPLICATE_LENGTH", error: duplicateLengthMessage(clash) });

    const maxSort = await LessonType.findOne({ instructorId: instructor.phoneNumberId })
      .sort({ sortOrder: -1 })
      .select("sortOrder")
      .lean();

    const lessonType = await LessonType.create({
      instructorId: instructor.phoneNumberId,
      name,
      price,
      durationMin,
      description: description || "",
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
    });

    res.status(201).json({ success: true, data: lessonType });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, code: "DUPLICATE_LENGTH", error: "Each lesson type needs a different length." });
    }
    logger.error(`Dashboard /lesson-types POST error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to create lesson type" });
  }
});

router.patch("/lesson-types/:id", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const updates = {};
    for (const key of ["name", "price", "description", "active", "sortOrder", "durationMin"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    const bad = lessonTypeProblem(updates);
    if (bad) return res.status(400).json({ success: false, error: bad });

    // Only active types need distinct lengths: check what this one would end up as
    if (updates.durationMin !== undefined || updates.active === true) {
      const current = await LessonType.findOne({ _id: req.params.id, instructorId: instructor.phoneNumberId }).lean();
      if (!current) return res.status(404).json({ success: false, error: "Lesson type not found" });
      const length = updates.durationMin ?? current.durationMin;
      const active = updates.active ?? current.active;
      if (active && length) {
        const clash = await sameLengthType(instructor.phoneNumberId, length, current._id);
        if (clash) return res.status(409).json({ success: false, code: "DUPLICATE_LENGTH", error: duplicateLengthMessage(clash) });
      }
    }

    const lessonType = await LessonType.findOneAndUpdate(
      { _id: req.params.id, instructorId: instructor.phoneNumberId },
      updates,
      { new: true }
    );

    if (!lessonType) return res.status(404).json({ success: false, error: "Lesson type not found" });

    res.json({ success: true, data: lessonType });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ success: false, code: "DUPLICATE_LENGTH", error: "Each lesson type needs a different length." });
    }
    logger.error(`Dashboard /lesson-types PATCH error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to update lesson type" });
  }
});

router.delete("/lesson-types/:id", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const lessonType = await LessonType.findOneAndDelete({
      _id: req.params.id,
      instructorId: instructor.phoneNumberId,
    });

    if (!lessonType) return res.status(404).json({ success: false, error: "Lesson type not found" });

    res.json({ success: true });
  } catch (err) {
    logger.error(`Dashboard /lesson-types DELETE error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to delete lesson type" });
  }
});

module.exports = router;
