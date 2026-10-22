const LessonType = require("../models/lessonTypeModel");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

/** "1h", "1h 30m", "45 min" */
function formatDuration(min) {
  if (!min) return "";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Gives an instructor the default lessons (Beginner 2h, Moderate 1.5h,
 * Novice 1h), skipping any length they already have an active type for.
 */
async function ensureDefaultLessonTypes(instructorId) {
  if (!isDbReady()) return [];
  try {
    const existing = await LessonType.find({ instructorId }).lean();
    const takenLengths = new Set(existing.filter((t) => t.active && t.durationMin).map((t) => t.durationMin));
    const takenNames = new Set(existing.map((t) => t.name.toLowerCase()));
    let sortOrder = existing.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), -1) + 1;
    const missing = LessonType.DEFAULTS.filter(
      (d) => !takenLengths.has(d.durationMin) && !takenNames.has(d.name.toLowerCase())
    );
    if (!missing.length) return [];
    return await LessonType.insertMany(missing.map((d) => ({ ...d, instructorId, sortOrder: sortOrder++ })));
  } catch (err) {
    logger.warn(`Default lesson types not created for ${instructorId}: ${err.message}`);
    return [];
  }
}

module.exports = { formatDuration, ensureDefaultLessonTypes };
