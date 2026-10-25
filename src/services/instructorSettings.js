const timezoneUtils = require("../utils/timezoneUtils");
const dayPacker = require("./dayPacker");

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
  // Packed mode: the usual gap between lessons (older instructors set it with
  // the old slider; Donna now works it out), the longest drive between two
  // lessons (the slider), and the margin added to a real drive for traffic.
  bufferMin: 20,
  maxDriveMin: 40,
  driveVarianceMin: 5,
};

const MIN_BUFFER = 10;
// Donna learns the usual gap once she has seen this many drives between lessons
const LEARN_AFTER_DRIVES = 10;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const roundUp5 = (m) => Math.ceil(m / 5) * 5;

/**
 * Packed mode: the longest drive between lessons (H) and the usual gap (X).
 * X comes from the instructor's own recent drives when there are enough,
 * else the gap they set with the old slider, else half of H.
 */
function packingRange(raw = {}) {
  const legacy = raw.maxDriveMin == null && raw.bufferMin != null;
  const H = raw.maxDriveMin ?? (legacy ? clamp(2 * raw.bufferMin, 12, 60) : ROUTE_DEFAULTS.maxDriveMin);
  const learned = raw.autoBufferMin != null && (raw.autoBufferSamples || 0) >= LEARN_AFTER_DRIVES;
  let X;
  let source;
  if (learned) {
    X = raw.autoBufferMin;
    source = "learned";
  } else if (legacy) {
    X = raw.bufferMin;
    source = "previous";
  } else {
    X = roundUp5(H / 2);
    source = "default";
  }
  return { maxDriveMin: H, bufferMin: clamp(X, Math.min(MIN_BUFFER, H), H), bufferSource: source, bufferSamples: raw.autoBufferSamples || 0 };
}

// In packed mode the slider replaces the preset: its value picks the band.
function presetForBuffer(bufferMin) {
  if (bufferMin < 20) return "tight";
  if (bufferMin < 30) return "balanced";
  return "relaxed";
}

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
  const raw = plain(instructor?.routeSettings) || {};
  const stored = { ...ROUTE_DEFAULTS, ...raw };
  const packed = isPacked(instructor);
  const range = packingRange(raw);
  let preset = ROUTE_PRESETS[stored.preset] ? stored.preset : stored.preset === "custom" ? "custom" : "balanced";
  if (packed) preset = presetForBuffer(range.bufferMin);
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
    packed,
    ...range,
    driveVarianceMin: stored.driveVarianceMin,
  };
}

// ── Bot behaviour settings ──────────────────────────────────────────────

const LUNCH_DEFAULTS = { enabled: true, durationMin: 45, windowFrom: "12:00", windowTo: "14:00" };

const BOT_DEFAULTS = {
  donnaEnabled: true,
  // "fixed": the instructor picks start times (workingHours).
  // "packed": Donna fits lessons between dayHours start and end.
  scheduleMode: "fixed",
  dayHours: null,
  lunch: LUNCH_DEFAULTS,
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
    lunch: { ...LUNCH_DEFAULTS, ...(plain(stored.lunch) || {}) },
    breaks: stored.breaks || [],
  };
}

function isPacked(instructor) {
  return plain(instructor?.botSettings)?.scheduleMode === "packed";
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

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

// Packed mode: each weekday's { start, end }. Without dayHours it's worked out
// from the start-time chips (first start to last lesson's end), so switching
// modes keeps the same days.
function dayHoursFor(instructor) {
  const stored = plain(resolveBotSettings(instructor).dayHours);
  const duration = resolveRouteSettings(instructor).lessonDurationMin;
  return Object.fromEntries(
    DAY_KEYS.map((key, day) => {
      if (stored && key in stored) {
        const h = plain(stored[key]);
        return [key, h && h.start && h.end ? { start: h.start, end: h.end } : null];
      }
      const times = rawTimesForDay(instructor, day);
      if (!times.length) return [key, null];
      return [key, { start: times[0], end: toTime(Math.min(toMinutes(times[times.length - 1]) + duration, 23 * 60 + 55)) }];
    })
  );
}

/** Packed mode: the day's window in minutes, or null if not a working day. */
function dayWindow(instructor, dateStr) {
  const h = dayHoursFor(instructor)[DAY_KEYS[dayIndex(dateStr)]];
  return h ? { start: toMinutes(h.start), end: toMinutes(h.end) } : null;
}

/** Packed mode: lunch as minutes ({ durationMin, from, to }), or null when off. */
function lunchWindow(instructor) {
  const { lunch } = resolveBotSettings(instructor);
  if (!lunch?.enabled) return null;
  return { durationMin: lunch.durationMin, from: toMinutes(lunch.windowFrom), to: toMinutes(lunch.windowTo) };
}

/** Fixed breaks as blocks for the packer. */
function breakBlocks(instructor) {
  return resolveBotSettings(instructor)
    .breaks.filter((b) => b?.from && b?.to)
    .map((b) => ({ start: toMinutes(b.from), end: toMinutes(b.to), kind: "block", label: "break" }));
}

/** Packed mode: the guaranteed-minimum day for a lesson length (every drive takes X). */
function packedDay(instructor, dateStr, durationMin) {
  const window = dayWindow(instructor, dateStr);
  if (!window) return { starts: [], lunch: null, count: 0 };
  const { bufferMin } = resolveRouteSettings(instructor);
  return dayPacker.packEmptyDay({
    start: window.start,
    end: window.end,
    d: durationMin,
    X: bufferMin,
    lunch: lunchWindow(instructor),
    blocks: breakBlocks(instructor),
  });
}

/** How long a booking lasts: its own length, or the old single length for older bookings. */
function bookingDuration(booking, instructor) {
  return booking?.durationMin || resolveRouteSettings(instructor).lessonDurationMin;
}

// Start times for a date. In packed mode these are the packed day for the
// given length (the starts Donna can promise before knowing where anyone is).
function timesForDate(instructor, dateStr, durationMin = null) {
  const duration = durationMin || resolveRouteSettings(instructor).lessonDurationMin;
  if (isPacked(instructor)) {
    return packedDay(instructor, dateStr, duration).starts.map(toTime);
  }
  const { breaks } = resolveBotSettings(instructor);
  return rawTimesForDay(instructor, dayIndex(dateStr)).filter((time) => {
    const start = toMinutes(time);
    const end = start + duration;
    return !breaks.some((b) => b?.from && b?.to && start < toMinutes(b.to) && end > toMinutes(b.from));
  });
}

// Every start time the instructor offers. Packed mode has no fixed list.
function allWorkingTimes(instructor) {
  if (isPacked(instructor)) return [];
  const set = new Set();
  for (let d = 0; d < 7; d++) rawTimesForDay(instructor, d).forEach((t) => set.add(t));
  return [...set].sort((a, b) => toMinutes(a) - toMinutes(b));
}

function workingDayIndexes(instructor) {
  if (isPacked(instructor)) {
    const hours = dayHoursFor(instructor);
    return [0, 1, 2, 3, 4, 5, 6].filter((d) => !!hours[DAY_KEYS[d]]);
  }
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => rawTimesForDay(instructor, d).length > 0);
}

function isWorkingDay(instructor, dateStr) {
  if (isPacked(instructor)) return !!dayWindow(instructor, dateStr);
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
  LUNCH_DEFAULTS,
  presetForBuffer,
  packingRange,
  LEARN_AFTER_DRIVES,
  isPacked,
  dayHoursFor,
  dayWindow,
  lunchWindow,
  breakBlocks,
  packedDay,
  bookingDuration,
  toTime,
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
