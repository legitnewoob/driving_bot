// Analytics for a driving school's owner and managers: how each instructor is
// doing, how their learners are getting on, and what Donna handles.
// See PLAN-school-analytics.md.

const Instructor = require("../models/instructorSchema");
const Booking = require("../models/bookingModel");
const Payment = require("../models/paymentModel");
const User = require("../models/userModel");
const ChatLog = require("../models/chatLogModel");
const settings = require("./instructorSettings");
const timezoneUtils = require("../utils/timezoneUtils");
const { schoolAllowsDonna } = require("./donnaStatus");

const DEFAULT_LESSON_RATE = parseFloat(process.env.DEFAULT_LESSON_RATE) || 50;
const SEAT_ROLES = ["member", "manager"];
const BOOKED = ["confirmed", "rescheduled", "completed"];
const AT_RISK_QUIET_DAYS = 21;
const MAX_DAYS = 366;
const CACHE_MS = 60 * 1000;
const HEATMAP_HOURS = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const cache = new Map(); // key -> { at, data }

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = (t) => {
  const [h, m] = String(t || "").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
const round1 = (n) => Math.round(n * 10) / 10;
const money = (n) => Math.round(n * 100) / 100;
const pct = (part, whole) => (whole ? round1((part / whole) * 100) : 0);
// Change against the previous period, as a percentage (null when there was nothing before)
const change = (now, before) => (before ? round1(((now - before) / before) * 100) : now ? null : 0);
const mean = (xs) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

function daysBetween(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length <= MAX_DAYS; d = timezoneUtils.addDays(d, 1)) out.push(d);
  return out;
}

function weekdayIndex(date) {
  // 0 = Monday
  const d = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "d"));
  return (d + 6) % 7;
}

/** The period asked for, and the one just before it of the same length. */
function periods(from, to) {
  if (!DATE.test(from || "") || !DATE.test(to || "") || from > to) {
    throw Object.assign(new Error("Choose a start date before the end date"), { userFacing: true, status: 400 });
  }
  const days = daysBetween(from, to);
  if (days.length > MAX_DAYS) {
    throw Object.assign(new Error("Choose a period of a year or less"), { userFacing: true, status: 400 });
  }
  const prevTo = timezoneUtils.addDays(from, -1);
  const prevFrom = timezoneUtils.addDays(prevTo, -(days.length - 1));
  return { from, to, prevFrom, prevTo, days };
}

const durationOf = (b, inst) => settings.bookingDuration(b, inst);
const valueOf = (b, inst) => (b.price != null ? b.price : inst?.rates?.basic ?? DEFAULT_LESSON_RATE);

/**
 * Minutes the instructor is working on a day: their hours less lunch and
 * breaks (packed mode), or their start times × lesson length (fixed mode).
 */
function workingMinutes(inst, date) {
  if (!settings.isWorkingDay(inst, date) || settings.isOnHoliday(inst, date)) return 0;
  if (settings.isPacked(inst)) {
    const w = settings.dayWindow(inst, date);
    if (!w) return 0;
    const lunch = settings.lunchWindow(inst);
    const breaks = settings
      .breakBlocks(inst)
      .reduce((sum, b) => sum + Math.max(0, Math.min(b.end, w.end) - Math.max(b.start, w.start)), 0);
    return Math.max(0, w.end - w.start - (lunch ? lunch.durationMin : 0) - breaks);
  }
  const length = settings.resolveRouteSettings(inst).lessonDurationMin;
  return settings.timesForDate(inst, date, length).length * length;
}

function donnaStatus(inst, schoolOn) {
  if (!schoolOn) return "off";
  if (inst.calendarTokenExpired) return "paused";
  return settings.resolveBotSettings(inst).donnaEnabled ? "on" : "off";
}

// Weekly buckets (Monday-start) for long periods, daily ones for up to two weeks
function buckets(days) {
  if (days.length <= 14) return days.map((d) => ({ key: d, label: timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "ddd D MMM"), from: d, to: d }));
  const out = [];
  for (const d of days) {
    const monday = timezoneUtils.addDays(d, -weekdayIndex(d));
    let b = out[out.length - 1];
    if (!b || b.key !== monday) {
      b = { key: monday, label: `w/c ${timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(monday, "12:00"), "D MMM")}`, from: d, to: d };
      out.push(b);
    }
    b.to = d;
  }
  return out;
}
const bucketOf = (bs, date) => bs.find((b) => date >= b.from && date <= b.to);

/**
 * Everything the analytics page shows, for the school's instructors (or the
 * ones picked) over [from, to].
 */
async function analytics(school, { from, to, instructorIds = [] } = {}) {
  const p = periods(from, to);
  const key = JSON.stringify([String(school._id), from, to, [...instructorIds].sort()]);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const members = await Instructor.find({ schoolId: school._id, schoolRole: { $in: SEAT_ROLES }, active: true }).lean();
  const picked = instructorIds.length ? members.filter((m) => instructorIds.includes(String(m._id))) : members;
  const ids = picked.map((m) => m.phoneNumberId);
  const byId = new Map(picked.map((m) => [m.phoneNumberId, m]));
  const today = timezoneUtils.getCurrentDateString();

  const [allBookings, payments, learners, chats, schoolOn] = await Promise.all([
    // Every lesson these instructors have: the period, the one before, and history for learners
    Booking.find({ instructorId: { $in: ids } }).lean(),
    Payment.find({ instructorId: { $in: ids }, date: { $gte: p.prevFrom, $lte: p.to } }).lean(),
    User.find({ instructorId: { $in: ids } }, { phone: 1, name: 1, instructorId: 1 }).lean(),
    ChatLog.aggregate([
      { $match: { instructor: { $in: ids }, role: "user", date: { $gte: p.prevFrom, $lte: p.to } } },
      { $group: { _id: { instructor: "$instructor", phone: "$phoneNumber", date: "$date" } } },
      { $group: { _id: { instructor: "$_id.instructor", current: { $gte: ["$_id.date", p.from] } }, n: { $sum: 1 } } },
    ]),
    schoolAllowsDonna({ schoolId: school._id }),
  ]);
  const bookings = (Array.isArray(allBookings) ? allBookings : []).filter((b) => byId.has(b.instructorId));
  const learnerName = new Map((learners || []).map((u) => [`${u.instructorId}|${u.phone}`, u.name || ""]));

  const inRange = (b, a, z) => b.date >= a && b.date <= z;
  const cur = bookings.filter((b) => inRange(b, p.from, p.to));
  const prev = bookings.filter((b) => inRange(b, p.prevFrom, p.prevTo));
  const pays = (payments || []).filter((x) => byId.has(x.instructorId));
  const curPay = pays.filter((x) => x.date >= p.from);
  const prevPay = pays.filter((x) => x.date < p.from);
  const paidBookingIds = new Set(pays.map((x) => x.bookingId).filter(Boolean));

  // First lesson ever per learner (per instructor), for "new" learners
  const firstLesson = new Map();
  for (const b of bookings) {
    if (!BOOKED.includes(b.status)) continue;
    const k = `${b.instructorId}|${b.userPhone}`;
    if (!firstLesson.has(k) || b.date < firstLesson.get(k)) firstLesson.set(k, b.date);
  }

  // Numbers for one set of bookings and payments (the period, or the one before)
  function summarise(list, pays, dayList, insts) {
    const booked = list.filter((b) => BOOKED.includes(b.status));
    const cancelled = list.filter((b) => b.status === "cancelled");
    const minutes = booked.reduce((s, b) => s + durationOf(b, byId.get(b.instructorId)), 0);
    const workMin = insts.reduce((s, inst) => s + dayList.reduce((t, d) => t + workingMinutes(inst, d), 0), 0);
    const learnersSeen = new Set(booked.map((b) => `${b.instructorId}|${b.userPhone}`));
    const fromDay = dayList[0];
    const toDay = dayList[dayList.length - 1];
    const fresh = [...learnersSeen].filter((k) => firstLesson.get(k) >= fromDay && firstLesson.get(k) <= toDay);
    const tracked = booked.filter((b) => b.source);
    return {
      lessons: booked.length,
      completed: booked.filter((b) => b.status === "completed").length,
      minutes,
      bookedValue: money(booked.reduce((s, b) => s + valueOf(b, byId.get(b.instructorId)), 0)),
      collected: money(pays.reduce((s, x) => s + (x.amount || 0), 0)),
      unpaid: money(
        booked
          .filter((b) => b.status === "completed" && !b.paymentReceived && !paidBookingIds.has(b.bookingId))
          .reduce((s, b) => s + valueOf(b, byId.get(b.instructorId)), 0)
      ),
      cancelled: cancelled.length,
      lateCancelled: cancelled.filter((b) => b.lateCancellation).length,
      cancelRate: pct(cancelled.length, booked.length + cancelled.length),
      activeLearners: learnersSeen.size,
      newLearners: fresh.length,
      workingMinutes: workMin,
      diaryFilled: pct(minutes, workMin),
      donnaBooked: tracked.filter((b) => b.source === "whatsapp").length,
      tracked: tracked.length,
      avgDrive: mean(booked.map((b) => b.driveInMin).filter((n) => Number.isFinite(n))),
      avgRating: mean(booked.map((b) => b.rating).filter((n) => Number.isFinite(n) && n > 0)),
    };
  }

  const prevDays = daysBetween(p.prevFrom, p.prevTo);
  const now = summarise(cur, curPay, p.days, picked);
  const before = summarise(prev, prevPay, prevDays, picked);
  const chatCount = (inst, current) =>
    (chats || []).filter((c) => (!inst || c._id.instructor === inst) && c._id.current === current).reduce((s, c) => s + c.n, 0);

  const cards = {
    lessons: { value: now.lessons, completed: now.completed, change: change(now.lessons, before.lessons) },
    hours: { value: round1(now.minutes / 60), change: change(now.minutes, before.minutes) },
    revenue: {
      booked: now.bookedValue,
      collected: now.collected,
      unpaid: now.unpaid,
      change: change(now.bookedValue, before.bookedValue),
    },
    learners: { active: now.activeLearners, new: now.newLearners, change: change(now.activeLearners, before.activeLearners) },
    cancellations: { rate: now.cancelRate, count: now.cancelled, late: now.lateCancelled, change: change(now.cancelRate, before.cancelRate) },
    diaryFilled: { value: now.diaryFilled, change: change(now.diaryFilled, before.diaryFilled) },
    donna: {
      conversations: chatCount(null, true),
      conversationsChange: change(chatCount(null, true), chatCount(null, false)),
      bookedShare: now.tracked ? pct(now.donnaBooked, now.tracked) : null,
      // Lessons booked before Donna started recording who booked them
      untracked: now.lessons - now.tracked,
    },
  };

  const instructors = picked.map((inst) => {
    const mine = cur.filter((b) => b.instructorId === inst.phoneNumberId);
    const minePrev = prev.filter((b) => b.instructorId === inst.phoneNumberId);
    const s = summarise(mine, curPay.filter((x) => x.instructorId === inst.phoneNumberId), p.days, [inst]);
    const sp = summarise(minePrev, prevPay.filter((x) => x.instructorId === inst.phoneNumberId), prevDays, [inst]);
    return {
      id: String(inst._id),
      name: inst.name,
      role: inst.schoolRole,
      lessons: s.lessons,
      lessonsChange: change(s.lessons, sp.lessons),
      hours: round1(s.minutes / 60),
      bookedValue: s.bookedValue,
      unpaid: s.unpaid,
      diaryFilled: s.diaryFilled,
      cancelRate: s.cancelRate,
      activeLearners: s.activeLearners,
      newLearners: s.newLearners,
      avgDrive: s.avgDrive,
      avgRating: s.avgRating,
      conversations: chatCount(inst.phoneNumberId, true),
      donna: donnaStatus(inst, schoolOn),
    };
  });

  // Charts
  const bs = buckets(p.days);
  const charts = {
    buckets: bs.map((b) => b.label),
    lessons: picked.map((inst) => ({
      id: String(inst._id),
      name: inst.name,
      values: bs.map((b) => cur.filter((x) => x.instructorId === inst.phoneNumberId && BOOKED.includes(x.status) && x.date >= b.from && x.date <= b.to).length),
    })),
    revenue: bs.map((b) => ({
      booked: money(cur.filter((x) => BOOKED.includes(x.status) && x.date >= b.from && x.date <= b.to).reduce((s, x) => s + valueOf(x, byId.get(x.instructorId)), 0)),
      collected: money(curPay.filter((x) => x.date >= b.from && x.date <= b.to).reduce((s, x) => s + (x.amount || 0), 0)),
    })),
    learners: bs.map((b) => {
      const seen = new Set(cur.filter((x) => BOOKED.includes(x.status) && x.date >= b.from && x.date <= b.to).map((x) => `${x.instructorId}|${x.userPhone}`));
      const fresh = [...seen].filter((k) => bucketOf(bs, firstLesson.get(k))?.key === b.key).length;
      return { new: fresh, returning: seen.size - fresh };
    }),
    heatmap: {
      days: DAY_LABELS,
      hours: HEATMAP_HOURS,
      counts: DAY_LABELS.map((_, wd) =>
        HEATMAP_HOURS.map((h) => cur.filter((x) => BOOKED.includes(x.status) && weekdayIndex(x.date) === wd && Math.floor(toMin(x.time) / 60) === h).length)
      ),
    },
  };

  // Learners: at risk (as of today), unpaid lessons, most hours in the period
  const history = new Map(); // key -> { last, next, lessons }
  for (const b of bookings) {
    if (!BOOKED.includes(b.status)) continue;
    const k = `${b.instructorId}|${b.userPhone}`;
    const h = history.get(k) || { last: null, next: null, lessons: 0 };
    if (b.date <= today) {
      h.lessons += 1;
      if (!h.last || b.date > h.last) h.last = b.date;
    } else if (!h.next || b.date < h.next) h.next = b.date;
    history.set(k, h);
  }
  const quietSince = timezoneUtils.addDays(today, -AT_RISK_QUIET_DAYS);
  const learnerRef = (k) => {
    const [instructorId, phone] = k.split("|");
    const inst = byId.get(instructorId);
    return { phone, name: learnerName.get(k) || phone, instructor: { id: String(inst?._id), name: inst?.name || "" } };
  };
  const atRisk = [...history.entries()]
    .filter(([, h]) => h.last && h.last < quietSince && !h.next)
    .map(([k, h]) => ({ ...learnerRef(k), lastLesson: h.last, lessons: h.lessons }))
    .sort((a, b) => (a.lastLesson < b.lastLesson ? 1 : -1));

  const unpaidLessons = cur
    .filter((b) => b.status === "completed" && !b.paymentReceived && !paidBookingIds.has(b.bookingId))
    .map((b) => ({
      bookingId: b.bookingId,
      date: b.date,
      time: b.time,
      amount: money(valueOf(b, byId.get(b.instructorId))),
      ...learnerRef(`${b.instructorId}|${b.userPhone}`),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));

  const hoursBy = new Map();
  for (const b of cur) {
    if (!BOOKED.includes(b.status)) continue;
    const k = `${b.instructorId}|${b.userPhone}`;
    hoursBy.set(k, (hoursBy.get(k) || 0) + durationOf(b, byId.get(b.instructorId)));
  }
  const topLearners = [...hoursBy.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([k, m]) => ({ ...learnerRef(k), hours: round1(m / 60) }));

  const data = {
    period: { from: p.from, to: p.to, prevFrom: p.prevFrom, prevTo: p.prevTo },
    allInstructors: members.map((m) => ({ id: String(m._id), name: m.name })),
    cards,
    instructors,
    charts,
    atRisk,
    unpaidLessons,
    topLearners,
  };
  cache.set(key, { at: Date.now(), data });
  return data;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  // Quote, and stop a cell being read as a spreadsheet formula
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");

function csv(data, section) {
  if (section === "instructors") {
    return toCsv(
      ["Instructor", "Lessons", "Hours", "Booked £", "Unpaid £", "Diary filled %", "Cancellations %", "Active learners", "New learners", "Avg drive (min)", "Avg rating", "Donna"],
      data.instructors.map((i) => [i.name, i.lessons, i.hours, i.bookedValue, i.unpaid, i.diaryFilled, i.cancelRate, i.activeLearners, i.newLearners, i.avgDrive ?? "", i.avgRating ?? "", i.donna])
    );
  }
  if (section === "at-risk") {
    return toCsv(
      ["Learner", "Phone", "Instructor", "Last lesson", "Lessons taken"],
      data.atRisk.map((l) => [l.name, l.phone, l.instructor.name, l.lastLesson, l.lessons])
    );
  }
  if (section === "unpaid") {
    return toCsv(
      ["Date", "Time", "Learner", "Phone", "Instructor", "Booking", "Amount £"],
      data.unpaidLessons.map((l) => [l.date, l.time, l.name, l.phone, l.instructor.name, l.bookingId, l.amount])
    );
  }
  return null;
}

function clearCache() {
  cache.clear();
}

module.exports = { analytics, csv, workingMinutes, periods, clearCache, AT_RISK_QUIET_DAYS };
