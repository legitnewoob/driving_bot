/**
 * Distance Matrix Service
 * ────────────────────────
 * Wraps the Google Distance Matrix API to return driving durations (in minutes)
 * between an origin and one or more destinations.
 *
 * Features:
 *  - In-memory cache (TTL-based) to avoid redundant API calls
 *  - Batch support: one origin → many destinations in a single API call
 *  - Optional departure_time for traffic-aware estimates
 *  - Graceful fallback: returns null on error so callers can use haversine
 */

const axios = require("axios");
const logger = require("../utils/logger-advanced");

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
    logger.error("GOOGLE_MAPS_API_KEY not set — Distance Matrix unavailable");
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
    logger.info(`Distance Matrix: all ${destinations.length} result(s) served from cache`);
    return results;
  }

  // Build API request
  const origin = `${originLat},${originLng}`;
  const destString = uncachedDests.map((d) => `${d.lat},${d.lng}`).join("|");

  const params = {
    origins: origin,
    destinations: destString,
    mode: "driving",
    units: "metric",
    key: apiKey,
  };

  // Add departure_time for traffic-aware duration_in_traffic
  if (departureTime) {
    const epochSeconds = Math.floor(departureTime.getTime() / 1000);
    // Must be in the future for traffic estimates
    if (epochSeconds > Math.floor(Date.now() / 1000)) {
      params.departure_time = epochSeconds;
    }
  }

  try {
    const { data } = await axios.get(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      { params }
    );

    if (data.status !== "OK") {
      logger.error(`Distance Matrix API error: ${data.status} — ${data.error_message || ""}`);
      return results; // return partially-cached results, nulls for the rest
    }

    const elements = data.rows[0]?.elements || [];

    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      if (el.status === "OK") {
        // Prefer duration_in_traffic when available (requires departure_time)
        const seconds = el.duration_in_traffic?.value ?? el.duration?.value;
        const minutes = seconds / 60;
        const destIdx = uncachedIndices[i];

        results[destIdx] = minutes;

        // Cache the result
        const key = cacheKey(originLat, originLng, uncachedDests[i].lat, uncachedDests[i].lng);
        setCache(key, minutes);
      } else {
        logger.warn(`Distance Matrix element ${i}: ${el.status}`);
      }
    }

    logger.info(
      `Distance Matrix: ${elements.filter((e) => e.status === "OK").length}/${elements.length} OK, ` +
      `${destinations.length - uncachedDests.length} from cache`
    );

    return results;
  } catch (err) {
    logger.error(`Distance Matrix request failed: ${err.message}`);
    return results; // return what we have from cache, nulls for the rest
  }
}

/**
 * Clear the internal cache (useful for testing).
 */
function clearCache() {
  cache.clear();
}

module.exports = {
  getDrivingDuration,
  getDrivingDurations,
  clearCache,
  // Exposed for testing
  _cache: cache,
};
