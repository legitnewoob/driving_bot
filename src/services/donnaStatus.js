// Whether a driving school lets Donna run for its instructors. The school owner
// has a master switch on top of each instructor's own; off means off for everyone.
const { isDbReady } = require("../utils/db");

const CACHE_MS = 30 * 1000;
const cache = new Map(); // schoolId -> { on, at }

async function schoolAllowsDonna(instructor) {
  const id = instructor?.schoolId && String(instructor.schoolId);
  if (!id || !isDbReady()) return true;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.on;
  const School = require("../models/schoolModel");
  const school = await School.findById(id).select("donnaEnabled").lean().catch(() => null);
  const on = school?.donnaEnabled !== false;
  cache.set(id, { on, at: Date.now() });
  return on;
}

function clearSchoolDonnaCache(schoolId) {
  if (schoolId) cache.delete(String(schoolId));
  else cache.clear();
}

module.exports = { schoolAllowsDonna, clearSchoolDonnaCache };
