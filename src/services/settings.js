const Setting = require("../models/settingModel");

/**
 * App-wide settings changed from the admin panel, cached for 30 seconds.
 * Unsaved keys fall back to these defaults (launch.mode can also come from
 * LAUNCH_MODE, so a fresh environment stays open unless told otherwise).
 */
const CACHE_MS = 30 * 1000;
let _cache = null;
let _cachedAt = 0;

const LAUNCH_MODES = ["waitlist", "invite", "open"];

function defaults() {
  const envMode = String(process.env.LAUNCH_MODE || "").toLowerCase();
  return {
    "launch.mode": LAUNCH_MODES.includes(envMode) ? envMode : "open",
    "launch.date": null,
    "launch.message": "",
    "launch.invitePromoCode": null,
    "referral.maxFreeMonths": 12,
    // Internal: the UK day the team's waitlist digest last went out (survives restarts)
    "waitlist.digestDay": null,
  };
}

async function getAll() {
  if (_cache && Date.now() - _cachedAt < CACHE_MS) return _cache;
  const saved = await Setting.find({}).lean().catch(() => []);
  const values = defaults();
  for (const s of saved || []) if (s.key in values) values[s.key] = s.value;
  _cache = values;
  _cachedAt = Date.now();
  return values;
}

async function get(key) {
  return (await getAll())[key];
}

/** Save several keys at once ({ "launch.mode": "open", ... }). */
async function setMany(values, by = null) {
  await Promise.all(
    Object.entries(values).map(([key, value]) =>
      Setting.findOneAndUpdate({ key }, { key, value, by }, { upsert: true, new: true })
    )
  );
  clearCache();
  return getAll();
}

function clearCache() {
  _cache = null;
  _cachedAt = 0;
}

module.exports = { LAUNCH_MODES, getAll, get, setMany, clearCache, defaults };
