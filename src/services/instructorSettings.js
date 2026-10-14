const timezoneUtils = require("../utils/timezoneUtils");

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DEFAULT_TIMES = ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"];

// ── Route settings ──────────────────────────────────────────────────────

const ROUTE_PRESETS = {
  off: { enabled: false },
  relaxed: { maxAddedDriveMin: 30, travelGraceMin: 15, fragmentationPenalty: "low" },
  balanced: { maxAddedDriveMin: 20, travelGraceMin: 10, fragmentationPenalty: "medium" },
  tight: { maxAddedDriveMin: 12, travelGraceMin: 5, fragmentationPenalty: "high" },
};

const FRAGMENTATION_MINUTES = { off: 0, low: 8, medium: 15, high: 25 };
const HOME_LEG_WEIGHTS = { off: 0, half: 0.5, full: 1 };
const ADJACENCY_BONUS_MIN = 5;

const ROUTE_DEFAULTS = {
  preset: "balanced",
  lessonDurationMin: 60,
  travelGraceMin: 10,
  maxAddedDriveMin: 20,
  homeLegWeight: "half",
  fragmentationPenalty: "medium",
  serviceArea: { radius: null, unit: "miles", radiusMiles: null, postcodeDistricts: [] },
  suggestOtherDays: true,
  lookAheadDays: 10,
};

const KM_PER_MILE = 1.609344;

// The radius in the instructor's own unit, plus radiusMiles for distance checks.
// Older settings only have radiusMiles.
function serviceRadius(area = {}) {
  if (area.radius != null) {
    const unit = area.unit === "km" ? "km" : "miles";
    return { radius: area.radius, unit, radiusMiles: unit === "km" ? area.radius / KM_PER_MILE : area.radius };
  }
  if (area.radiusMiles != null) return { radius: area.radiusMiles, unit: "miles", radiusMiles: area.radiusMiles };
  return { radius: null, unit: area.unit === "km" ? "km" : "miles", radiusMiles: null };
}

function resolveRouteSettings(instructor) {
  const stored = { ...ROUTE_DEFAULTS, ...(plain(instructor?.routeSettings) || {}) };
  const preset = ROUTE_PRESETS[stored.preset] ? stored.preset : stored.preset === "custom" ? "custom" : "balanced";
  const fromPreset = preset === "custom" ? {} : ROUTE_PRESETS[preset];
  const merged = { ...stored, ...fromPreset };

  return {
    preset,
    enabled: merged.enabled !== false,
    lessonDurationMin: merged.lessonDurationMin,
    travelGraceMin: merged.travelGraceMin,
    maxAddedDriveMin: merged.maxAddedDriveMin,
    homeLegWeight: HOME_LEG_WEIGHTS[merged.homeLegWeight] ?? HOME_LEG_WEIGHTS.half,
    fragmentationPenaltyMin: FRAGMENTATION_MINUTES[merged.fragmentationPenalty] ?? FRAGMENTATION_MINUTES.medium,
    adjacencyBonusMin: ADJACENCY_BONUS_MIN,
    serviceArea: {
      ...serviceRadius(merged.serviceArea),
      postcodeDistricts: (merged.serviceArea?.postcodeDistricts || []).map((d) => d.toUpperCase()),
    },
    suggestOtherDays: merged.suggestOtherDays !== false,
    lookAheadDays: merged.lookAheadDays,
  };
}

// ── Bot behaviour settings ──────────────────────────────────────────────

const BOT_DEFAULTS = {
  workingHours: null,
  breaks: [],
  maxLessonsPerDay: null,
  minNoticeHours: 24,
  bookingWindowDays: 90,
  holiday: { enabled: false, from: null, to: null, message: "" },
  acceptingNewLearners: true,
  allowCancel: true,
  allowReschedule: true,
  tone: "friendly",
  emojis: true,
  customGreeting: "",
  aboutLessons: "",
  cancellationNoticeHours: 48,
  lateCancellationFee: null,
  reminders: "24h",
  notifications: { booked: true, cancelled: true, rescheduled: true, email: true },
  handover: true,
};

function resolveBotSettings(instructor) {
  const stored = plain(instructor?.botSettings) || {};
  return {
    ...BOT_DEFAULTS,
    ...stored,
    holiday: { ...BOT_DEFAULTS.holiday, ...(plain(stored.holiday) || {}) },
    notifications: { ...BOT_DEFAULTS.notifications, ...(plain(stored.notifications) || {}) },
    breaks: stored.breaks || [],
  };
}

function toMinutes(time) {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

function dayIndex(dateStr) {
  return Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(dateStr, "12:00"), "d"));
}

// Raw working times for a weekday, before breaks. Without a workingHours
// setting this is the legacy rule: availableTimes on Mon–Fri, nothing at weekends.
function rawTimesForDay(instructor, day) {
  const hours = plain(resolveBotSettings(instructor).workingHours);
  if (hours && Array.isArray(hours[DAY_KEYS[day]])) {
    return [...hours[DAY_KEYS[day]]].sort((a, b) => toMinutes(a) - toMinutes(b));
  }
  if (day === 0 || day === 6) return [];
  return instructor?.availableTimes?.length ? [...instructor.availableTimes] : [...DEFAULT_TIMES];
}

function timesForDate(instructor, dateStr) {
  const { breaks } = resolveBotSettings(instructor);
  const duration = resolveRouteSettings(instructor).lessonDurationMin;
  return rawTimesForDay(instructor, dayIndex(dateStr)).filter((time) => {
    const start = toMinutes(time);
    const end = start + duration;
    return !breaks.some((b) => b?.from && b?.to && start < toMinutes(b.to) && end > toMinutes(b.from));
  });
}

function allWorkingTimes(instructor) {
  const set = new Set();
  for (let d = 0; d < 7; d++) rawTimesForDay(instructor, d).forEach((t) => set.add(t));
  return [...set].sort((a, b) => toMinutes(a) - toMinutes(b));
}

function workingDayIndexes(instructor) {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => rawTimesForDay(instructor, d).length > 0);
}

function isWorkingDay(instructor, dateStr) {
  return rawTimesForDay(instructor, dayIndex(dateStr)).length > 0;
}

function describeWorkingDays(instructor) {
  const days = workingDayIndexes(instructor);
  if (days.length === 0) return "no days currently";
  const mondayFirst = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const isRun = mondayFirst.every((d, i) => i === 0 || ((mondayFirst[i - 1] % 7) + 1) % 7 === d);
  if (isRun && mondayFirst.length > 2) {
    return `${DAY_NAMES[mondayFirst[0]]}–${DAY_NAMES[mondayFirst[mondayFirst.length - 1]]}`;
  }
  return mondayFirst.map((d) => DAY_NAMES[d]).join(", ");
}

function isOnHoliday(instructor, dateStr) {
  const { holiday } = resolveBotSettings(instructor);
  if (!holiday.enabled || !holiday.from || !holiday.to) return false;
  return dateStr >= holiday.from && dateStr <= holiday.to;
}

// Day-level notice rule: the whole day is blocked if it starts before
// now + minNoticeHours. With the default 24h this matches the original
// timezoneUtils.isDayRestricted behaviour exactly.
function isWithinNotice(instructor, dateStr) {
  const { minNoticeHours } = resolveBotSettings(instructor);
  const startOfDay = timezoneUtils.createDateInTimezone(dateStr, "00:00").getTime();
  return startOfDay < Date.now() + minNoticeHours * 3600 * 1000;
}

function isBeyondWindow(instructor, dateStr) {
  const { bookingWindowDays } = resolveBotSettings(instructor);
  const last = timezoneUtils.addDays(timezoneUtils.getCurrentDateString(), bookingWindowDays);
  return dateStr > last;
}

// Dates a booking may be made on, ignoring the notice rule (enforced in the
// conversation layer), matching the original getAvailableDates contract.
function bookableDates(instructor) {
  const { bookingWindowDays } = resolveBotSettings(instructor);
  const today = timezoneUtils.getCurrentDateString();
  const dates = [];
  for (let i = 1; i <= bookingWindowDays; i++) {
    const d = timezoneUtils.addDays(today, i);
    if (isWorkingDay(instructor, d) && !isOnHoliday(instructor, d)) dates.push(d);
  }
  return dates;
}

// Upcoming dates a learner could actually book, in order.
function upcomingBookableDates(instructor, limit) {
  const result = [];
  for (const d of bookableDates(instructor)) {
    if (isWithinNotice(instructor, d)) continue;
    result.push(d);
    if (result.length >= limit) break;
  }
  return result;
}

// Each weekday's working times as the instructor would edit them (no breaks applied).
function workingHoursFor(instructor) {
  return Object.fromEntries(DAY_KEYS.map((key, day) => [key, rawTimesForDay(instructor, day)]));
}

function plain(value) {
  if (!value) return value;
  if (typeof value.toObject === "function") return value.toObject();
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

module.exports = {
  DAY_KEYS,
  serviceRadius,
  ROUTE_PRESETS,
  ROUTE_DEFAULTS,
  BOT_DEFAULTS,
  FRAGMENTATION_MINUTES,
  HOME_LEG_WEIGHTS,
  resolveRouteSettings,
  resolveBotSettings,
  timesForDate,
  allWorkingTimes,
  isWorkingDay,
  describeWorkingDays,
  isOnHoliday,
  isWithinNotice,
  isBeyondWindow,
  bookableDates,
  upcomingBookableDates,
  toMinutes,
  workingHoursFor,
};
