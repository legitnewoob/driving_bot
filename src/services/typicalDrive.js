// Packed mode: Donna learns the usual gap between an instructor's lessons
// (X) from their real drives, so the instructor only sets the longest drive.
// See DRIVE-RANGE-PLAN.md.

const Booking = require("../models/bookingModel");
const Instructor = require("../models/instructorSchema");
const { invalidateInstructorCache } = require("../models/instructorModel");
const settings = require("./instructorSettings");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

const LOOK_BACK_DAYS = 28;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** The usual gap for these drives: median drive + variance, rounded up to 5. */
function usualGap(drives, varianceMin = 5) {
  if (!drives.length) return null;
  return Math.ceil((median(drives) + varianceMin) / 5) * 5;
}

/**
 * Recalculates the usual gap from drives between lessons (driveInMin is only
 * stored when there was a lesson before) over the last 4 weeks and saves it.
 * Never throws: a booking mustn't fail because of this.
 */
async function refresh(instructor) {
  try {
    if (!instructor?.phoneNumberId || !settings.isPacked(instructor) || !isDbReady()) return null;
    const since = timezoneUtils.addDays(timezoneUtils.getCurrentDateString(), -LOOK_BACK_DAYS);
    const rows = await Booking.find(
      {
        instructorId: instructor.phoneNumberId,
        date: { $gte: since },
        status: { $in: ["confirmed", "rescheduled", "completed"] },
        driveInMin: { $ne: null },
      },
      { driveInMin: 1 }
    ).lean();
    const drives = (rows || []).map((r) => r.driveInMin).filter((n) => Number.isFinite(n) && n >= 0);
    const { driveVarianceMin } = settings.resolveRouteSettings(instructor);
    const gap = usualGap(drives, driveVarianceMin);

    await Instructor.updateOne(
      { phoneNumberId: instructor.phoneNumberId },
      {
        $set: {
          "routeSettings.autoBufferMin": gap,
          "routeSettings.autoBufferSamples": drives.length,
          "routeSettings.autoBufferAt": new Date(),
        },
      }
    );
    invalidateInstructorCache(instructor.phoneNumberId);
    return { gap, samples: drives.length };
  } catch (err) {
    logger.warn(`Usual drive not updated for ${instructor?.phoneNumberId}: ${err.message}`);
    return null;
  }
}

module.exports = { refresh, usualGap, median, LOOK_BACK_DAYS };
