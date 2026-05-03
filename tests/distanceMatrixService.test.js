/**
 * Distance Matrix Service – Unit Tests
 * ──────────────────────────────────────
 * Covers:
 *  1. getDrivingDurations – API call, response parsing, batch support
 *  2. getDrivingDuration  – single-destination convenience wrapper
 *  3. Cache – TTL, hit/miss, clearCache, rounding
 *  4. Error handling – network errors, non-OK status, element failures
 *  5. departure_time / duration_in_traffic support
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

/** Build a mock Distance Matrix API response */
function mockApiResponse(elements) {
  return {
    data: {
      status: "OK",
      rows: [{ elements }],
    },
  };
}

function okElement(durationSeconds, trafficSeconds = null) {
  const el = {
    status: "OK",
    duration: { value: durationSeconds, text: `${Math.round(durationSeconds / 60)} mins` },
    distance: { value: durationSeconds * 15, text: "mock" },
  };
  if (trafficSeconds !== null) {
    el.duration_in_traffic = { value: trafficSeconds, text: `${Math.round(trafficSeconds / 60)} mins` };
  }
  return el;
}

function failedElement(status = "ZERO_RESULTS") {
  return { status };
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

describe("getDrivingDurations – API call basics", () => {
  it("returns durations in minutes for a single destination", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(600), // 10 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    expect(result).toEqual([10]);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get).toHaveBeenCalledWith(
      "https://maps.googleapis.com/maps/api/distancematrix/json",
      expect.objectContaining({
        params: expect.objectContaining({
          origins: `${ORIGIN.lat},${ORIGIN.lng}`,
          destinations: `${DEST_A.lat},${DEST_A.lng}`,
          mode: "driving",
          key: "test-api-key",
        }),
      })
    );
  });

  it("returns durations for multiple destinations in one batch call", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(600),  // 10 min
      okElement(1200), // 20 min
      okElement(2400), // 40 min
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B, DEST_C]);

    expect(result).toEqual([10, 20, 40]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    // Verify destinations are pipe-separated
    const callParams = axios.get.mock.calls[0][1].params;
    expect(callParams.destinations).toBe(
      `${DEST_A.lat},${DEST_A.lng}|${DEST_B.lat},${DEST_B.lng}|${DEST_C.lat},${DEST_C.lng}`
    );
  });

  it("returns empty array for empty destinations", async () => {
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, []);
    expect(result).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });

  it("returns empty array for null destinations", async () => {
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, null);
    expect(result).toEqual([]);
    expect(axios.get).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. getDrivingDuration – Single Destination Wrapper
// ═══════════════════════════════════════════════════════════════════════════

describe("getDrivingDuration – single destination", () => {
  it("returns duration in minutes for one origin-destination pair", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(900), // 15 min
    ]));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBe(15);
  });

  it("returns null when API element fails", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      failedElement("NOT_FOUND"),
    ]));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBeNull();
  });

  it("returns null when network error occurs", async () => {
    axios.get.mockRejectedValue(new Error("Network timeout"));

    const result = await getDrivingDuration(ORIGIN.lat, ORIGIN.lng, DEST_A.lat, DEST_A.lng);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cache Behaviour
// ═══════════════════════════════════════════════════════════════════════════

describe("Cache", () => {
  it("caches results and serves from cache on second call", async () => {
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));

    // First call – hits API
    const r1 = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(r1).toEqual([10]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    // Second call – should serve from cache (no API call)
    const r2 = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(r2).toEqual([10]);
    expect(axios.get).toHaveBeenCalledTimes(1); // still 1
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("served from cache")
    );
  });

  it("only calls API for uncached destinations in a batch", async () => {
    // First call: cache DEST_A
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    // Second call: DEST_A (cached) + DEST_B (uncached)
    axios.get.mockResolvedValue(mockApiResponse([okElement(1200)]));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([10, 20]); // DEST_A from cache, DEST_B from API
    expect(axios.get).toHaveBeenCalledTimes(2);

    // Only DEST_B should have been in the API call
    const lastCallParams = axios.get.mock.calls[1][1].params;
    expect(lastCallParams.destinations).toBe(`${DEST_B.lat},${DEST_B.lng}`);
  });

  it("clearCache removes all entries", async () => {
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(_cache.size).toBe(1);

    clearCache();
    expect(_cache.size).toBe(0);

    // Next call should hit API again
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("evicts expired cache entries (TTL)", async () => {
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    // Manually expire the cache entry
    const key = [..._cache.keys()][0];
    _cache.get(key).ts = Date.now() - 31 * 60 * 1000; // 31 min ago

    // Should hit API again because entry expired
    axios.get.mockResolvedValue(mockApiResponse([okElement(900)]));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([15]); // new value from API
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  it("rounds coordinates to 4 decimal places for cache key (increases hits)", async () => {
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));

    // Call with full precision
    await getDrivingDurations(53.01680461, -2.21906492, [{ lat: 53.03001, lng: -2.22001 }]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    // Call with slightly different precision (rounds to same 4 decimals)
    const result = await getDrivingDurations(53.01680499, -2.21906401, [{ lat: 53.03001, lng: -2.22001 }]);
    expect(result).toEqual([10]); // from cache
    expect(axios.get).toHaveBeenCalledTimes(1); // no new API call
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
    expect(axios.get).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("GOOGLE_MAPS_API_KEY not set")
    );
  });

  it("returns nulls when API returns non-OK top-level status", async () => {
    axios.get.mockResolvedValue({
      data: {
        status: "REQUEST_DENIED",
        error_message: "Invalid API key",
      },
    });

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    expect(result).toEqual([null]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("REQUEST_DENIED")
    );
  });

  it("returns null for failed elements, values for successful ones", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(600),                    // DEST_A: 10 min OK
      failedElement("ZERO_RESULTS"),     // DEST_B: failed
      okElement(2400),                   // DEST_C: 40 min OK
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B, DEST_C]);

    expect(result).toEqual([10, null, 40]);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("ZERO_RESULTS")
    );
  });

  it("returns nulls when network request fails (axios throws)", async () => {
    axios.get.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([null, null]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("ECONNREFUSED")
    );
  });

  it("returns partial results when some are cached and API fails", async () => {
    // Cache DEST_A first
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));
    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);

    // Now API fails for uncached DEST_B
    axios.get.mockRejectedValue(new Error("Quota exceeded"));
    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A, DEST_B]);

    expect(result).toEqual([10, null]); // DEST_A from cache, DEST_B null
  });

  it("handles missing rows in API response gracefully", async () => {
    axios.get.mockResolvedValue({
      data: { status: "OK", rows: [] },
    });

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([null]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Traffic-Aware (departure_time & duration_in_traffic)
// ═══════════════════════════════════════════════════════════════════════════

describe("Traffic-aware estimates", () => {
  it("sends departure_time when a future Date is provided", async () => {
    const futureDate = new Date(Date.now() + 3600 * 1000); // 1 hour from now
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], futureDate);

    const callParams = axios.get.mock.calls[0][1].params;
    expect(callParams.departure_time).toBeDefined();
    expect(callParams.departure_time).toBe(Math.floor(futureDate.getTime() / 1000));
  });

  it("does NOT send departure_time when Date is in the past", async () => {
    const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], pastDate);

    const callParams = axios.get.mock.calls[0][1].params;
    expect(callParams.departure_time).toBeUndefined();
  });

  it("prefers duration_in_traffic over duration when both are present", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(600, 900), // duration=10min, traffic=15min
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([15]); // Uses traffic duration
  });

  it("falls back to duration when duration_in_traffic is absent", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(600), // duration=10min, no traffic field
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([10]); // Falls back to regular duration
  });

  it("does not send departure_time when null", async () => {
    axios.get.mockResolvedValue(mockApiResponse([okElement(600)]));

    await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A], null);

    const callParams = axios.get.mock.calls[0][1].params;
    expect(callParams.departure_time).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Fractional Durations
// ═══════════════════════════════════════════════════════════════════════════

describe("Duration precision", () => {
  it("correctly converts seconds to fractional minutes", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(450), // 7.5 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([7.5]);
  });

  it("handles very short durations (< 1 minute)", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(30), // 0.5 minutes
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([0.5]);
  });

  it("handles very long durations", async () => {
    axios.get.mockResolvedValue(mockApiResponse([
      okElement(7200), // 120 minutes = 2 hours
    ]));

    const result = await getDrivingDurations(ORIGIN.lat, ORIGIN.lng, [DEST_A]);
    expect(result).toEqual([120]);
  });
});
