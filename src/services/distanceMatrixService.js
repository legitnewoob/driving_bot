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
 *  - In-memory cache (TTL-based) to avoid redundant API calls
 *  - Batch support: one origin → many destinations in a single API call
 *  - Optional departureTime for traffic-aware estimates
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
