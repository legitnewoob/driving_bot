const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISTRICT = /^[A-Z]{1,2}\d[A-Z\d]?$/;
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Walks an object against a spec of { field: validator }. Validators return
 * { value } or { error }. Unknown fields are reported, not silently dropped.
 */
function check(input, spec, path, errors) {
  const out = {};
  if (!isObj(input)) {
    errors.push(`${path} must be an object`);
    return out;
  }
  for (const [key, raw] of Object.entries(input)) {
    const validator = spec[key];
    const label = path ? `${path}.${key}` : key;
    if (!validator) {
      errors.push(`Unknown setting: ${label}`);
      continue;
    }
    const result = validator(raw, label, errors);
    if (result && "error" in result) errors.push(result.error);
    else if (result) out[key] = result.value;
  }
  return out;
}

const oneOf = (options) => (v, label) =>
  options.includes(v) ? { value: v } : { error: `${label} must be one of: ${options.join(", ")}` };

const bool = () => (v, label) => (typeof v === "boolean" ? { value: v } : { error: `${label} must be true or false` });

const int = (min, max, { step = 1, nullable = false } = {}) => (v, label) => {
  if (nullable && (v === null || v === "")) return { value: null };
  if (!Number.isInteger(v) || v < min || v > max || (v - min) % step !== 0) {
    const stepNote = step > 1 ? ` in steps of ${step}` : "";
    return { error: `${label} must be a whole number from ${min} to ${max}${stepNote}${nullable ? ", or empty" : ""}` };
  }
  return { value: v };
};

const text = (max) => (v, label) =>
  typeof v === "string" && v.length <= max
    ? { value: v.trim() }
    : { error: `${label} must be text of at most ${max} characters` };

const timeList = (max) => (v, label) => {
  if (!Array.isArray(v) || v.length > max || !v.every((t) => typeof t === "string" && TIME.test(t))) {
    return { error: `${label} must be a list of up to ${max} times like "09:00"` };
  }
  return { value: [...new Set(v)].sort() };
};

const ROUTE_SPEC = {
  preset: oneOf(["off", "relaxed", "balanced", "tight", "custom"]),
  lessonDurationMin: int(30, 180, { step: 15 }),
  travelGraceMin: int(0, 30),
  maxAddedDriveMin: int(5, 60),
  homeLegWeight: oneOf(["off", "half", "full"]),
  fragmentationPenalty: oneOf(["off", "low", "medium", "high"]),
  serviceArea: (v, label, errors) => {
    const value = check(v, {
      radius: int(1, 80, { nullable: true }),
      unit: oneOf(["miles", "km"]),
      radiusMiles: int(1, 50, { nullable: true }),
      postcodeDistricts: (list, l) => {
        if (!Array.isArray(list) || list.length > 50) return { error: `${l} must be a list of up to 50 districts` };
        const upper = list.map((d) => String(d).trim().toUpperCase()).filter(Boolean);
        const bad = upper.find((d) => !DISTRICT.test(d));
        return bad ? { error: `${l}: "${bad}" isn't a postcode district like ST5` } : { value: [...new Set(upper)] };
      },
    }, label, errors);
    if (value && "radius" in value) {
      // 50 miles ≈ 80 km
      if (value.radius != null && value.unit !== "km" && value.radius > 50) {
        errors.push(`${label}.radius must be a whole number from 1 to 50 miles`);
      }
      value.radiusMiles = null; // the new radius replaces the old miles-only one
    }
    return { value };
  },
  suggestOtherDays: bool(),
  lookAheadDays: int(5, 20),
  bufferMin: int(12, 45),
  // null: work it out from the older usual-gap setting
  maxDriveMin: int(12, 60, { nullable: true }),
  driveVarianceMin: int(0, 15),
};

const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const BOT_SPEC = {
  donnaEnabled: bool(),
  scheduleMode: oneOf(["fixed", "packed"]),
  dayHours: (v, label, errors) => {
    if (v === null) return { value: null };
    const day = (h, l) => {
      if (h === null) return { value: null };
      if (!isObj(h) || !TIME.test(h.start || "") || !TIME.test(h.end || "")) {
        return { error: `${l} needs a start and end time like "09:00", or empty for a day off` };
      }
      if (toMin(h.end) - toMin(h.start) < 30) return { error: `${l} must end at least 30 minutes after it starts` };
      return { value: { start: h.start, end: h.end } };
    };
    const days = check(v, Object.fromEntries(DAY_KEYS.map((d) => [d, day])), label, errors);
    return { value: Object.fromEntries(DAY_KEYS.map((d) => [d, days[d] ?? null])) };
  },
  lunch: (v, label, errors) => {
    const l = check(v, {
      enabled: bool(),
      durationMin: int(15, 90, { step: 5 }),
      windowFrom: (t, lb) => (TIME.test(t || "") ? { value: t } : { error: `${lb} must be a time like "12:00"` }),
      windowTo: (t, lb) => (TIME.test(t || "") ? { value: t } : { error: `${lb} must be a time like "14:00"` }),
    }, label, errors);
    return { value: l };
  },
  workingHours: (v, label, errors) => {
    if (v === null) return { value: null };
    const days = check(v, Object.fromEntries(DAY_KEYS.map((d) => [d, timeList(24)])), label, errors);
    return { value: Object.fromEntries(DAY_KEYS.map((d) => [d, days[d] || []])) };
  },
  breaks: (v, label) => {
    if (!Array.isArray(v) || v.length > 5) return { error: `${label} must be a list of up to 5 breaks` };
    for (const b of v) {
      if (!isObj(b) || !TIME.test(b.from || "") || !TIME.test(b.to || "") || b.from >= b.to) {
        return { error: `${label}: each break needs a "from" time before its "to" time` };
      }
    }
    return { value: v.map((b) => ({ from: b.from, to: b.to })) };
  },
  maxLessonsPerDay: int(1, 15, { nullable: true }),
  minNoticeHours: int(0, 168),
  bookingWindowDays: int(7, 180),
  holiday: (v, label, errors) => {
    const h = check(v, {
      enabled: bool(),
      from: (d, l) => (d === null || DATE.test(d) ? { value: d } : { error: `${l} must be a date like 2025-08-01` }),
      to: (d, l) => (d === null || DATE.test(d) ? { value: d } : { error: `${l} must be a date like 2025-08-01` }),
      message: text(300),
    }, label, errors);
    if (h.enabled && (!h.from || !h.to)) errors.push(`${label} needs both a start and end date when it's on`);
    if (h.from && h.to && h.from > h.to) errors.push(`${label} must end on or after it starts`);
    return { value: h };
  },
  acceptingNewLearners: bool(),
  allowCancel: bool(),
  allowReschedule: bool(),
  tone: oneOf(["friendly", "professional", "brief"]),
  emojis: bool(),
  customGreeting: text(300),
  aboutLessons: text(1000),
  cancellationNoticeHours: int(0, 168),
  lateCancellationFee: (v, label) => {
    if (v === null || v === "") return { value: null };
    return typeof v === "number" && v >= 0 && v <= 500
      ? { value: Math.round(v * 100) / 100 }
      : { error: `${label} must be an amount from 0 to 500, or empty` };
  },
  reminders: oneOf(["off", "24h", "24h+2h"]),
  notifications: (v, label, errors) => ({
    value: check(v, { booked: bool(), cancelled: bool(), rescheduled: bool(), email: bool() }, label, errors),
  }),
  handover: bool(),
};

// Worked out by Donna, never set by the instructor. A dashboard can send them
// back with the rest of its route settings (an older tab, say): ignore them
// rather than refuse the save, and never let one be overwritten.
const ROUTE_READ_ONLY = ["autoBufferMin", "autoBufferSamples", "autoBufferAt"];

function withoutReadOnly(route) {
  if (!route || typeof route !== "object" || Array.isArray(route)) return route;
  const rest = { ...route };
  ROUTE_READ_ONLY.forEach((k) => delete rest[k]);
  return rest;
}

function validateSettingsUpdate(body) {
  const errors = [];
  const result = check(
    body,
    {
      baseAddress: text(200),
      routeSettings: (v, label, errs) => ({ value: check(withoutReadOnly(v), ROUTE_SPEC, label, errs) }),
      botSettings: (v, label, errs) => ({ value: check(v, BOT_SPEC, label, errs) }),
    },
    "",
    errors
  );
  return { errors, ...result };
}

const PREFS_SPEC = {
  priority: bool(),
  maxAddedDriveMin: int(5, 120, { nullable: true }),
  savedPlaces: (v, label) => {
    if (!Array.isArray(v) || v.length > 5) return { error: `${label} must be a list of up to 5 places` };
    for (const p of v) {
      if (!isObj(p) || typeof p.label !== "string" || !p.label.trim() || p.label.length > 30) {
        return { error: `${label}: each place needs a name of up to 30 characters` };
      }
      if (typeof p.address !== "string" || !p.address.trim() || p.address.length > 200) {
        return { error: `${label}: "${p.label}" needs an address or postcode` };
      }
    }
    return { value: v.map((p) => ({ label: p.label.trim(), address: p.address.trim() })) };
  },
  preferredDays: (v, label) =>
    Array.isArray(v) && v.length <= 7 && v.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
      ? { value: [...new Set(v)].sort() }
      : { error: `${label} must be a list of weekday numbers (0 = Sunday … 6 = Saturday)` },
  preferredTimes: timeList(24),
  unavailable: (v, label) => {
    if (!Array.isArray(v) || v.length > 10) return { error: `${label} must be a list of up to 10 rules` };
    for (const u of v) {
      const daysOk = Array.isArray(u?.days) && u.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      if (!isObj(u) || !daysOk || !TIME.test(u.from || "") || !TIME.test(u.to || "") || u.from >= u.to) {
        return { error: `${label}: each rule needs days and a "from" time before its "to" time` };
      }
    }
    return { value: v.map((u) => ({ days: [...new Set(u.days)].sort(), from: u.from, to: u.to })) };
  },
  defaultLessonTypeId: (v, label) =>
    v === null || (typeof v === "string" && /^[a-f\d]{24}$/i.test(v))
      ? { value: v }
      : { error: `${label} must be a lesson type id or empty` },
  maxLessonsPerWeek: int(1, 14, { nullable: true }),
  donnaPaused: bool(),
};

function validatePreferencesUpdate(body) {
  const errors = [];
  const value = check(body, PREFS_SPEC, "", errors);
  return { errors, value };
}

module.exports = { validateSettingsUpdate, validatePreferencesUpdate };
