const routeOptimizer = require("./routeOptimizer");
const { isFullyProvisioned } = require("./phoneNumberService");
const { isDbReady } = require("../utils/db");

const plain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

/**
 * Where an instructor is in their setup.
 *
 * `required` / `complete`: what they have to fill in before they can request a
 * WhatsApp number: home/base address (located on the map), working days and
 * hours, and at least one active lesson type with a price.
 *
 * `ready`: whether Donna can be switched on. That also needs the WhatsApp
 * number and a working Google Calendar connection; `blockers` lists what's
 * still in the way, in the order to do it. If Google access expires Donna
 * pauses until it's reconnected (`calendarExpired`).
 */
async function getSetupStatus(instructor) {
  const bot = plain(instructor?.botSettings) || {};
  const hours = plain(bot.workingHours);
  const hasTimes = !!hours && Object.values(hours).some((times) => Array.isArray(times) && times.length > 0);
  const dayHours = plain(bot.dayHours);
  const hasDayHours = !!dayHours && Object.values(dayHours).some(Boolean);
  const hasHours = bot.scheduleMode === "packed" ? hasDayHours || hasTimes : hasTimes;

  let lessonTypes = 0;
  if (isDbReady()) {
    const LessonType = require("../models/lessonTypeModel");
    lessonTypes = await LessonType.countDocuments({ instructorId: instructor?.phoneNumberId, active: true });
  }

  const required = [
    { key: "address", label: "Your home or base address", done: !!routeOptimizer.homePoint(instructor), link: "/settings#route" },
    { key: "workingHours", label: "Your working days and lesson times", done: hasHours, link: "/settings#availability" },
    { key: "lessonTypes", label: "At least one lesson type with a price", done: lessonTypes > 0, link: "/lesson-types" },
  ];

  const hasNumber = !!instructor && !!isFullyProvisioned(instructor);
  const calendarConnected = !!instructor?.googleRefreshToken;
  const calendarExpired = calendarConnected && !!instructor?.calendarTokenExpired;

  const blockers = [
    ...required.filter((r) => !r.done).map(({ key, label, link }) => ({ key, label, link })),
    ...(hasNumber ? [] : [{ key: "number", label: "Get your WhatsApp number", link: "/dashboard" }]),
    ...(calendarConnected ? [] : [{ key: "calendar", label: "Connect your Google Calendar", link: "/dashboard" }]),
    ...(calendarExpired ? [{ key: "calendarExpired", label: "Reconnect your Google Calendar (access has expired)", link: "/dashboard" }] : []),
  ];

  return {
    complete: required.every((r) => r.done),
    required,
    missing: required.filter((r) => !r.done).map((r) => r.label),
    hasNumber,
    calendarConnected,
    calendarExpired,
    ready: blockers.length === 0,
    blockers,
  };
}

module.exports = { getSetupStatus };
