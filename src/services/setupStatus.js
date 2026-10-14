const routeOptimizer = require("./routeOptimizer");
const { isFullyProvisioned } = require("./phoneNumberService");
const { isDbReady } = require("../utils/db");

const plain = (v) => (v && typeof v.toObject === "function" ? v.toObject() : v);

/**
 * What an instructor still has to fill in before they can request a WhatsApp
 * number, plus where they are in the setup (number, calendar).
 *
 * Required: home/base address (located on the map), working days and lesson
 * times, and at least one active lesson type with a price.
 */
async function getSetupStatus(instructor) {
  const hours = plain(instructor?.botSettings?.workingHours);
  const hasHours = !!hours && Object.values(hours).some((times) => Array.isArray(times) && times.length > 0);

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

  return {
    complete: required.every((r) => r.done),
    required,
    missing: required.filter((r) => !r.done).map((r) => r.label),
    hasNumber: !!instructor && !!isFullyProvisioned(instructor),
    calendarConnected: !!instructor?.googleRefreshToken,
  };
}

module.exports = { getSetupStatus };
