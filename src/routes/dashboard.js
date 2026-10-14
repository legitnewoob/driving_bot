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
const Notification = require("../models/notificationModel");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const calendarService = require("../services/calendarService");
const routeOptimizer = require("../services/routeOptimizer");
const settings = require("../services/instructorSettings");
const { validateSettingsUpdate, validatePreferencesUpdate } = require("../services/settingsValidation");
const { getCoordinatesFromPostalCode } = require("../services/mapsService");
const { invalidateInstructorCache } = require("../models/instructorModel");

const DEFAULT_LESSON_RATE = parseFloat(process.env.DEFAULT_LESSON_RATE) || 50;
const MONTHLY_REVENUE_TARGET = parseFloat(process.env.MONTHLY_REVENUE_TARGET) || 3000;

// ─── Helpers ─────────────────────────────────────────────────────────────

function getInstructorTimezone(instructor) {
  return instructor?.timezone || timezoneUtils.timezone || "Europe/London";
}

async function resolveInstructor(req) {
  const jwtSecret = process.env.JWT_SECRET;

  if (jwtSecret) {
    // When JWT auth is configured, the dashboard must be user-authenticated.
    if (!req.user?.email) return null;

    const instructor = await Instructor.findOne({ email: req.user.email, active: true }).lean();
    return instructor || null;
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

    const instructorId = instructor.phoneNumberId;
    const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;
    const today = moment.tz(getInstructorTimezone(instructor)).format("YYYY-MM-DD");

    const [users, bookings, payments] = await Promise.all([
      User.find({ instructorId }).lean(),
      Booking.find({ instructorId }).lean(),
      Payment.find({ instructorId }).lean(),
    ]);

    const learners = users
      .filter((u) => u.detailsCompleted)
      .map((u) => {
        const userBookings = bookings.filter((b) => b.userPhone === u.phone);
        const userPayments = payments.filter((p) => p.userPhone === u.phone);

        const completed = userBookings.filter((b) => b.status === "completed");
        const lessonsCompleted = completed.length;

        const nextBooking = userBookings
          .filter((b) => b.date >= today && (b.status === "confirmed" || b.status === "rescheduled"))
          .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];

        const totalPaid = userPayments.reduce((sum, p) => sum + p.amount, 0);
        const totalCharged = completed.reduce((sum, b) => sum + (b.price ?? rate), 0);
        const outstanding = Math.max(0, totalCharged - totalPaid);
        // Paid ahead, e.g. a block of lessons bought upfront
        const credit = Math.max(0, totalPaid - totalCharged);

        let progressLevel = "new";
        if (lessonsCompleted >= 7) progressLevel = "test-ready";
        else if (lessonsCompleted > 0) progressLevel = "active";

        return {
          phone: u.phone,
          name: u.name || null,
          age: u.age || null,
          postalCode: u.postalCode || null,
          instructorNotes: u.instructorNotes || "",
          createdAt: u.createdAt || null,
          lessonsCompleted,
          nextLesson: nextBooking ? { date: nextBooking.date, time: nextBooking.time } : null,
          totalPaid,
          totalCharged,
          outstanding,
          credit,
          paymentStatus: outstanding <= 0 ? "paid" : "owes",
          progressLevel,
          priority: !!u.schedulingPrefs?.priority,
          donnaPaused: !!u.schedulingPrefs?.donnaPaused,
        };
      });

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
    },
    presets: settings.ROUTE_PRESETS,
  };
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

router.get("/settings", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    res.json({ success: true, data: { ...settingsPayload(instructor), setup: await getSetupStatus(instructor) } });
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
      doc.botSettings = { ...cur, ...botSettings, holiday, notifications };
    }

    await doc.save();
    invalidateInstructorCache(doc.phoneNumberId);

    const saved = doc.toObject();
    res.json({ success: true, data: { ...settingsPayload(saved), setup: await getSetupStatus(saved) } });
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

// ═══════════════════════════════════════════════════════════════════════════
// Lesson Types
// ═══════════════════════════════════════════════════════════════════════════

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

router.post("/lesson-types", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const { name, price, description } = req.body;
    if (!name || price == null) return res.status(400).json({ success: false, error: "name and price are required" });

    const maxSort = await LessonType.findOne({ instructorId: instructor.phoneNumberId })
      .sort({ sortOrder: -1 })
      .select("sortOrder")
      .lean();

    const lessonType = await LessonType.create({
      instructorId: instructor.phoneNumberId,
      name,
      price,
      description: description || "",
      sortOrder: (maxSort?.sortOrder ?? -1) + 1,
    });

    res.status(201).json({ success: true, data: lessonType });
  } catch (err) {
    logger.error(`Dashboard /lesson-types POST error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to create lesson type" });
  }
});

router.patch("/lesson-types/:id", async (req, res) => {
  try {
    const instructor = await resolveInstructor(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });

    const updates = {};
    for (const key of ["name", "price", "description", "active", "sortOrder"]) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const lessonType = await LessonType.findOneAndUpdate(
      { _id: req.params.id, instructorId: instructor.phoneNumberId },
      updates,
      { new: true }
    );

    if (!lessonType) return res.status(404).json({ success: false, error: "Lesson type not found" });

    res.json({ success: true, data: lessonType });
  } catch (err) {
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
