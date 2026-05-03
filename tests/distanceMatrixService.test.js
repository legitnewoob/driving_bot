/**
 * Distance Matrix Service – Unit Tests
 * ──────────────────────────────────────
 * Tests the Google Routes API (computeRouteMatrix) wrapper.
 *
 * Covers:
 *  1. getDrivingDurations – API call, response parsing, batch support
 *  2. getDrivingDuration  – single-destination convenience wrapper
 *  3. Cache – TTL, hit/miss, clearCache, rounding
 *  4. Error handling – network errors, failed routes, API errors
 *  5. departureTime / traffic-aware routing
 *  6. Missing API key
 *  7. Empty destinations
 */

jest.mock("axios");
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const axios = require("axios");
const logger = require("../src/utils/logger-advanced");
const {
  getDrivingDuration,
  getDrivingDurations,
  clearCache,
  _cache,
} = require("../src/services/distanceMatrixService");

// ── Helpers ──────────────────────────────────────────────────────────────

const ORIGIN = { lat: 53.0168, lng: -2.2191 };
const DEST_A = { lat: 53.03, lng: -2.22 };
const DEST_B = { lat: 53.06, lng: -2.25 };
const DEST_C = { lat: 53.20, lng: -2.45 };

const ROUTES_API_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";

/**
 * Build a mock Routes API response (array of route matrix elements).
 * Each element has: originIndex, destinationIndex, duration ("Ns"), condition.
 */
function mockRoutesResponse(elements) {
  return { data: elements };
}

function routeElement(destIndex, durationSeconds) {
  return {
    originIndex: 0,
    destinationIndex: destIndex,
    duration: `${durationSeconds}s`,
    condition: "ROUTE_EXISTS",
  };
}

function failedRouteElement(destIndex, condition = "ROUTE_NOT_FOUND") {
  return {
    originIndex: 0,
    destinationIndex: destIndex,
    condition,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Setup / Teardown
// ═══════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  jest.clearAllMocks();
  clearCache();
  process.env.GOOGLE_MAPS_API_KEY = "test-api-key";
});

afterAll(() => {
  delete process.env.GOOGLE_MAPS_API_KEY;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. getDrivingDurations – Basic API Call
// ═══════════════════════════════════════════════════════════════════════════

describe("getDrivingDurations – Routes API call basics", () => {
  it("returns durations in minutes for a single destination", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 600), // 10 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    expect(result).toEqual([10]);
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post).toHaveBeenCalledWith(
      ROUTES_API_URL,
      expect.objectContaining({
        origins: [{ waypoint: { location: { latLng: { latitude: ORIGIN.lat, longitude: ORIGIN.lng } } } }],
        destinations: [{ waypoint: { location: { latLng: { latitude: DEST_A.lat, longitude: DEST_A.lng } } } }],
        travelMode: "DRIVE",
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Goog-Api-Key": "test-api-key",
          "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition",
        }),
      })
    );
  });

  it("returns durations for multiple destinations in one batch call", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 600),  // 10 min
      routeElement(1, 1200), // 20 min
      routeElement(2, 2400), // 40 min
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B, DEST_C]);

    expect(result).toEqual([10, 20, 40]);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Verify all destinations are in the request body
    const requestBody = axios.post.mock.calls[0][1];
    expect(requestBody.destinations).toHaveLength(3);
  });

  it("returns empty array for empty destinations", async () => {
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, []);
    expect(result).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it("returns empty array for null destinations", async () => {
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, null);
    expect(result).toEqual([]);
    expect(axios.post).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. getDrivingDuration – Single Destination Wrapper
// ═══════════════════════════════════════════════════════════════════════════

describe("getDrivingDuration – single destination", () => {
  it("returns duration in minutes for one origin-destination pair", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 900), // 15 min
    ]));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBe(15);
  });

  it("returns null when route not found", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      failedRouteElement(0, "ROUTE_NOT_FOUND"),
    ]));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBeNull();
  });

  it("returns null when network error occurs", async () => {
    axios.post.mockRejectedValue(new Error("Network timeout"));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cache Behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe("Cache", () => {
  it("caches results and serves from cache on second call", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));

    // First call – hits API
    const r1 = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(r1).toEqual([10]);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Second call – should serve from cache (no API call)
    const r2 = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(r2).toEqual([10]);
    expect(axios.post).toHaveBeenCalledTimes(1); // still 1
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("served from cache")
    );
  });

  it("only calls API for uncached destinations in a batch", async () => {
    // First call: cache DEST_A
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Second call: DEST_A (cached) + DEST_B (uncached)
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 1200)]));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([10, 20]); // DEST_A from cache, DEST_B from API
    expect(axios.post).toHaveBeenCalledTimes(2);

    // Only DEST_B should have been in the API call
    const lastRequestBody = axios.post.mock.calls[1][1];
    expect(lastRequestBody.destinations).toHaveLength(1);
    expect(lastRequestBody.destinations[0].waypoint.location.latLng.latitude).toBe(DEST_B.lat);
  });

  it("clearCache removes all entries", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(_cache.size).toBe(1);

    clearCache();
    expect(_cache.size).toBe(0);

    // Next call should hit API again
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it("evicts expired cache entries (TTL)", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Manually expire the cache entry
    const key = [..._cache.keys()][0];
    _cache.get(key).ts = Date.now() - 31 * 60 * 1000; // 31 min ago

    // Should hit API again because entry expired
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 900)]));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([15]); // new value from API
    expect(axios.post).toHaveBeenCalledTimes(2);
  });

  it("rounds coordinates to 4 decimal places for cache key (increases hits)", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));

    // Call with full precision
    await getDrivingDurations(53.01680461, -2.21906492, [{ lat: 53.03001, lng: -2.22001 }]);
    expect(axios.post).toHaveBeenCalledTimes(1);

    // Call with slightly different precision (rounds to same 4 decimals)
    const result = await getDrivingDurations(53.01680499, -2.21906401, [{ lat: 53.03001, lng: -2.22001 }]);
    expect(result).toEqual([10]); // from cache
    expect(axios.post).toHaveBeenCalledTimes(1); // no new API call
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe("Error handling", () => {
  it("returns all nulls when API key is missing", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([null, null]);
    expect(axios.post).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_MAPS_API_KEY not set")
    );
  });

  it("returns nulls when API returns error response", async () => {
    axios.post.mockRejectedValue({
      response: {
        data: {
          error: { message: "API key not valid" },
        },
      },
      message: "Request failed with status code 403",
    });

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    expect(result).toEqual([null]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("API key not valid")
    );
  });

  it("returns null for failed routes, values for successful ones", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 600),                        // DEST_A: 10 min OK
      failedRouteElement(1, "ROUTE_NOT_FOUND"),    // DEST_B: failed
      routeElement(2, 2400),                       // DEST_C: 40 min OK
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B, DEST_C]);

    expect(result).toEqual([10, null, 40]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ROUTE_NOT_FOUND")
    );
  });

  it("returns nulls when network request fails (axios throws)", async () => {
    axios.post.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([null, null]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED")
    );
  });

  it("returns partial results when some are cached and API fails", async () => {
    // Cache DEST_A first
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    // Now API fails for uncached DEST_B
    axios.post.mockRejectedValue(new Error("Quota exceeded"));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([10, null]); // DEST_A from cache, DEST_B null
  });

  it("handles empty array API response gracefully", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([null]);
  });

  it("handles non-array API response gracefully", async () => {
    axios.post.mockResolvedValue({ data: "unexpected" });

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([null]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Traffic-Aware (departureTime & routingPreference)
// ═══════════════════════════════════════════════════════════════════════════

describe("Traffic-aware estimates", () => {
  it("sends departureTime and TRAFFIC_AWARE when a future Date is provided", async () => {
    const futureDate = new Date(Date.now() + 3600 * 1000); // 1 hour from now
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], futureDate);

    const requestBody = axios.post.mock.calls[0][1];
    expect(requestBody.departureTime).toBe(futureDate.toISOString());
    expect(requestBody.routingPreference).toBe("TRAFFIC_AWARE");
  });

  it("does NOT send departureTime when Date is in the past", async () => {
    const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], pastDate);

    const requestBody = axios.post.mock.calls[0][1];
    expect(requestBody.departureTime).toBeUndefined();
    expect(requestBody.routingPreference).toBeUndefined();
  });

  it("does not send departureTime when null", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([routeElement(0, 600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], null);

    const requestBody = axios.post.mock.calls[0][1];
    expect(requestBody.departureTime).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Duration Precision
// ═══════════════════════════════════════════════════════════════════════════

describe("Duration precision", () => {
  it("correctly converts seconds to fractional minutes", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 450), // 7.5 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([7.5]);
  });

  it("handles very short durations (< 1 minute)", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 30), // 0.5 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([0.5]);
  });

  it("handles very long durations", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(0, 7200), // 120 minutes = 2 hours
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([120]);
  });

  it("handles duration string with trailing 's' correctly", async () => {
    axios.post.mockResolvedValue(mockRoutesResponse([{
      originIndex: 0,
      destinationIndex: 0,
      duration: "300s",
      condition: "ROUTE_EXISTS",
    }]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([5]); // 300s = 5 min
  });

  it("returns out-of-order destination results in correct positions", async () => {
    // Routes API may return elements out of order
    axios.post.mockResolvedValue(mockRoutesResponse([
      routeElement(2, 2400), // DEST_C first in response
      routeElement(0, 600),  // DEST_A second
      routeElement(1, 1200), // DEST_B third
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B, DEST_C]);

    // Results should be in the order of the destinations array
    expect(result).toEqual([10, 20, 40]);
  });
});
