/**
 * Distance Matrix Service
 * ────────────────────────
 * Wraps the Google Routes API (computeRouteMatrix) to return driving
 * durations (in minutes) between an origin and one or more destinations.
 *
 * Uses the modern Routes API instead of the legacy Distance Matrix API.
 * Endpoint: POST https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix
 *
 * Features:
 *  - In-memory cache (TTL-based) plus a 30-day database store, so the same
 *    two places are only paid for once a month
 *  - Only missing pairs are requested; a daily element limit guards the bill
 *  - Batch support: one origin → many destinations in a single API call
 *  - Optional departureTime for traffic-aware estimates
 *  - Graceful fallback: returns null on error so callers can use haversine
 */

const axios = require("axios");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

// ── Cache ────────────────────────────────────────────────────────────────

const cache = new Map();
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Build a cache key from two coordinate pairs.
 * Rounds to 4 decimal places (~11 m precision) to increase cache hits.
 */
function cacheKey(originLat, originLng, destLat, destLng) {
  return `${originLat.toFixed(4)},${originLng.toFixed(4)}|${destLat.toFixed(4)},${destLng.toFixed(4)}`;
}

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  cache.set(key, { value, ts: Date.now() });
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Get driving duration from one origin to one destination.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destLat
 * @param {number} destLng
 * @param {Date|null} departureTime - optional, for traffic-aware estimate
 * @returns {Promise<number|null>} duration in minutes, or null on failure
 */
async function getDrivingDuration(originLat, originLng, destLat, destLng, departureTime = null) {
  const results = await getDrivingDurations(
    originLat,
    originLng,
    [{ lat: destLat, lng: destLng }],
    departureTime
  );
  return results?.[0] ?? null;
}

/**
 * Get driving durations from one origin to many destinations in a single API call.
 * Uses Google Routes API computeRouteMatrix.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {{lat:number, lng:number}[]} destinations
 * @param {Date|null} departureTime
 * @returns {Promise<(number|null)[]>} array of durations in minutes (null for failed elements)
 */
async function getDrivingDurations(originLat, originLng, destinations, departureTime = null) {
  if (!destinations || destinations.length === 0) return [];

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.error("GOOGLE_MAPS_API_KEY not set — Routes API unavailable");
    return destinations.map(() => null);
  }

  // Check cache first — only call API for uncached destinations
  const results = new Array(destinations.length).fill(null);
  const uncachedIndices = [];
  const uncachedDests = [];

  for (let i = 0; i < destinations.length; i++) {
    const key = cacheKey(originLat, originLng, destinations[i].lat, destinations[i].lng);
    const cached = getCached(key);
    if (cached !== null) {
      results[i] = cached;
    } else {
      uncachedIndices.push(i);
      uncachedDests.push(destinations[i]);
    }
  }

  // If everything was cached, return immediately
  if (uncachedDests.length === 0) {
    logger.info(`Routes API: all ${destinations.length} result(s) served from cache`);
    return results;
  }

  // Build Routes API request body
  const requestBody = {
    origins: [{
      waypoint: {
        location: {
          latLng: { latitude: originLat, longitude: originLng },
        },
      },
    }],
    destinations: uncachedDests.map((d) => ({
      waypoint: {
        location: {
          latLng: { latitude: d.lat, longitude: d.lng },
        },
      },
    })),
    travelMode: "DRIVE",
  };

  // Add departureTime for traffic-aware estimates
  if (departureTime) {
    const epochSeconds = Math.floor(departureTime.getTime() / 1000);
    if (epochSeconds > Math.floor(Date.now() / 1000)) {
      requestBody.departureTime = departureTime.toISOString();
      requestBody.routingPreference = "TRAFFIC_AWARE";
    }
  }

  try {
    const { data } = await axios.post(
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
        },
      }
    );

    // Routes API returns an array of route matrix elements
    const elements = Array.isArray(data) ? data : [];

    let okCount = 0;
    for (const el of elements) {
      if (el.condition === "ROUTE_EXISTS" && el.duration) {
        // duration is a string like "1234s"
        const seconds = parseInt(el.duration.replace("s", ""), 10);
        if (!isNaN(seconds)) {
          const minutes = seconds / 60;
          const destIdx = uncachedIndices[el.destinationIndex];

          results[destIdx] = minutes;

          // Cache the result
          const dest = uncachedDests[el.destinationIndex];
          const key = cacheKey(originLat, originLng, dest.lat, dest.lng);
          setCache(key, minutes);
          okCount++;
        }
      } else if (el.condition && el.condition !== "ROUTE_EXISTS") {
        logger.warn(`Routes API element [${el.originIndex}→${el.destinationIndex}]: ${el.condition}`);
      }
    }

    logger.info(
      `Routes API: ${okCount}/${uncachedDests.length} OK, ` +
      `${destinations.length - uncachedDests.length} from cache`
    );

    return results;
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    logger.error(`Routes API request failed: ${errMsg}`);
    return results; // return what we have from cache, nulls for the rest
  }
}

// Routes API limits on origins × destinations per request.
const MAX_ELEMENTS = 625;
const MAX_ELEMENTS_TRAFFIC = 100;

// Live traffic is Google's "Pro" tier ($10 per 1,000 elements, 5,000 free a
// month); without it is "Essentials" ($5 per 1,000, 10,000 free). Traffic only
// matters for lessons soon, so further ahead we ask without it.
const TRAFFIC_WINDOW_MS = 36 * 3600 * 1000;

// Safety net against a runaway bill: past this many elements in a day, callers
// get straight-line estimates instead (they already fall back on null).
const DAILY_LIMIT = () => Number(process.env.MAPS_DAILY_ELEMENT_LIMIT) || 3000;

const usage = { day: null, elements: 0, warned: false, blocked: false };

function _today() {
  return new Date().toISOString().slice(0, 10);
}

// Reserves n elements from today's allowance; false when it would go over.
function takeBudget(n) {
  if (usage.day !== _today()) Object.assign(usage, { day: _today(), elements: 0, warned: false, blocked: false });
  const limit = DAILY_LIMIT();
  if (usage.elements + n > limit) {
    if (!usage.blocked) logger.error(`Routes matrix: daily limit of ${limit} elements reached; using straight-line estimates until midnight`);
    usage.blocked = true;
    return false;
  }
  usage.elements += n;
  if (!usage.warned && usage.elements >= limit * 0.8) {
    usage.warned = true;
    logger.warn(`Routes matrix: ${usage.elements} of ${limit} daily elements used`);
  }
  return true;
}

/** Elements sent to Google today, for the logs and admin. */
function getUsage() {
  if (usage.day !== _today()) return { day: _today(), elements: 0, limit: DAILY_LIMIT() };
  return { day: usage.day, elements: usage.elements, limit: DAILY_LIMIT() };
}

function toWaypoint(p) {
  return { waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } } };
}

// Pairs already being fetched, so parallel checks (e.g. "Suggest days" planning
// 15 days at once) share one request instead of each paying for the same legs.
const inFlight = new Map();

// The 30-day store. Skipped when there's no database (unit tests, startup).
async function loadStored(keys) {
  if (!keys.length || !isDbReady()) return new Map();
  try {
    const DriveTime = require("../models/driveTimeModel");
    const docs = await DriveTime.find({ _id: { $in: keys } }).lean();
    return new Map(docs.map((d) => [d._id, d.minutes]));
  } catch (err) {
    logger.warn(`Drive-time store unavailable: ${err.message}`);
    return new Map();
  }
}

async function saveStored(entries, traffic) {
  if (!entries.length || !isDbReady()) return;
  try {
    const DriveTime = require("../models/driveTimeModel");
    const now = new Date();
    await DriveTime.bulkWrite(
      entries.map(([key, minutes]) => ({
        updateOne: { filter: { _id: key }, update: { $set: { minutes, traffic, fetchedAt: now } }, upsert: true },
      })),
      { ordered: false }
    );
  } catch (err) {
    logger.warn(`Drive-time store write failed: ${err.message}`);
  }
}

// One Routes request (already sized to the limit). Returns Map(key → minutes).
async function requestMatrix(origins, dests, departureTime, apiKey) {
  const found = new Map();
  const body = {
    origins: origins.map(toWaypoint),
    destinations: dests.map(toWaypoint),
    travelMode: "DRIVE",
  };
  if (departureTime) {
    body.departureTime = departureTime.toISOString();
    body.routingPreference = "TRAFFIC_AWARE";
  }
  try {
    const { data } = await axios.post(
      "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix",
      body,
      {
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
        },
      }
    );
    for (const el of Array.isArray(data) ? data : []) {
      if (el.condition !== "ROUTE_EXISTS" || !el.duration) continue;
      const seconds = parseInt(el.duration.replace("s", ""), 10);
      if (isNaN(seconds)) continue;
      const o = origins[el.originIndex];
      const d = dests[el.destinationIndex];
      if (!o || !d) continue;
      found.set(cacheKey(o.lat, o.lng, d.lat, d.lng), seconds / 60);
    }
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    logger.error(`Routes matrix request failed: ${errMsg}`);
  }
  return found;
}

/**
 * Driving durations (minutes) for a list of { from, to } pairs.
 *
 * Each pair is looked up in memory, then in the 30-day store, and only the
 * pairs still missing go to Google. Origins missing the same destinations
 * share a request. Traffic-aware only for departures in the next 36 hours.
 * Pairs another call is already fetching are shared, not paid for twice.
 *
 * @param {{from:{lat,lng}, to:{lat,lng}}[]} pairs
 * @param {Date|null} departureTime
 * @returns {Promise<(number|null)[]>} minutes per pair (null when unknown)
 */
async function getDrivingPairs(pairs, departureTime = null) {
  const out = pairs.map(() => null);
  if (!pairs.length) return out;

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    logger.error("GOOGLE_MAPS_API_KEY not set — Routes API unavailable");
    return out;
  }

  const ahead = departureTime ? departureTime.getTime() - Date.now() : -1;
  const useTraffic = ahead > 0 && ahead <= TRAFFIC_WINDOW_MS;
  const pointKey = (p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  const keys = pairs.map(({ from, to }) => cacheKey(from.lat, from.lng, to.lat, to.lng));

  // 1. Memory
  let missing = [];
  keys.forEach((key, n) => {
    const cached = getCached(key);
    if (cached !== null) out[n] = cached;
    else missing.push(n);
  });
  if (!missing.length) {
    logger.info(`Routes matrix: all ${pairs.length} element(s) served from cache`);
    return out;
  }

  // 2. Pairs another call is already looking up; claim the rest straight away
  // (before any await) so parallel checks share them instead of paying twice
  const waits = [];
  const settle = new Map();
  missing = missing.filter((n) => {
    const key = keys[n];
    const pending = inFlight.get(key);
    if (pending && !settle.has(key)) {
      waits.push(pending.then((v) => { if (v !== null) out[n] = v; }));
      return false;
    }
    if (!settle.has(key)) {
      let resolve;
      inFlight.set(key, new Promise((res) => { resolve = res; }));
      settle.set(key, resolve);
    }
    return true;
  });

  const results = new Map();
  let fromStore = 0;
  let fetched = 0;
  try {
    // 3. The 30-day store
    const stored = await loadStored([...settle.keys()]);
    fromStore = stored.size;
    for (const [key, minutes] of stored) results.set(key, minutes);
    missing = missing.filter((n) => !stored.has(keys[n]));

    // 4. Google, for the rest. Origins needing the same destinations share a request.
    if (missing.length) {
      const points = new Map();
      const byOrigin = new Map(); // origin point key → Set of destination point keys
      for (const n of missing) {
        const { from, to } = pairs[n];
        const ok = pointKey(from);
        const dk = pointKey(to);
        points.set(ok, from);
        points.set(dk, to);
        if (!byOrigin.has(ok)) byOrigin.set(ok, new Set());
        byOrigin.get(ok).add(dk);
      }
      const groups = new Map();
      for (const [ok, dset] of byOrigin) {
        const ds = [...dset].sort();
        const sig = ds.join(";");
        if (!groups.has(sig)) groups.set(sig, { ds, os: [] });
        groups.get(sig).os.push(ok);
      }

      const limit = useTraffic ? MAX_ELEMENTS_TRAFFIC : MAX_ELEMENTS;
      const requests = [];
      for (const { os, ds } of groups.values()) {
        const destChunk = Math.min(ds.length, limit);
        const originChunk = Math.max(1, Math.floor(limit / destChunk));
        for (let a = 0; a < os.length; a += originChunk) {
          for (let b = 0; b < ds.length; b += destChunk) {
            requests.push({ os: os.slice(a, a + originChunk), ds: ds.slice(b, b + destChunk) });
          }
        }
      }

      const fresh = [];
      for (const r of requests) {
        const size = r.os.length * r.ds.length;
        if (!takeBudget(size)) continue;
        const found = await requestMatrix(
          r.os.map((k) => points.get(k)),
          r.ds.map((k) => points.get(k)),
          useTraffic ? departureTime : null,
          apiKey
        );
        for (const entry of found) {
          results.set(entry[0], entry[1]);
          fresh.push(entry);
        }
        fetched += size;
      }
      await saveStored(fresh, useTraffic);
    }
  } finally {
    for (const [key, resolve] of settle) {
      const value = results.has(key) ? results.get(key) : null;
      if (value !== null) setCache(key, value);
      inFlight.delete(key);
      resolve(value);
    }
  }

  keys.forEach((key, n) => {
    if (out[n] === null && results.has(key)) out[n] = results.get(key);
  });
  if (waits.length) await Promise.all(waits);

  logger.info(
    `Routes matrix: ${pairs.length} element(s), ${fetched} fetched${useTraffic ? " (traffic-aware)" : ""}, ` +
    `${fromStore} from store; ${getUsage().elements} today`
  );
  return out;
}

/**
 * Driving durations (minutes) between every origin and every destination.
 * See getDrivingPairs: only the pairs not already known are paid for.
 *
 * @param {{lat:number, lng:number}[]} origins
 * @param {{lat:number, lng:number}[]} destinations
 * @param {Date|null} departureTime
 * @returns {Promise<(number|null)[][]>} matrix[originIdx][destIdx]
 */
async function getDrivingMatrix(origins, destinations, departureTime = null) {
  if (!origins.length || !destinations.length) return origins.map(() => []);
  const pairs = [];
  for (const from of origins) for (const to of destinations) pairs.push({ from, to });
  const flat = await getDrivingPairs(pairs, departureTime);
  return origins.map((_, i) => flat.slice(i * destinations.length, (i + 1) * destinations.length));
}

/**
 * Clear the internal cache (useful for testing).
 */
function clearCache() {
  cache.clear();
  inFlight.clear();
  Object.assign(usage, { day: null, elements: 0, warned: false, blocked: false });
}

module.exports = {
  getDrivingDuration,
  getDrivingDurations,
  getDrivingMatrix,
  getDrivingPairs,
  getUsage,
  clearCache,
  // Exposed for testing
  _cache: cache,
};
