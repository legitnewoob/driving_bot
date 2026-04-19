/**
 * RouteOptimizer – Unit & Integration Tests
 *
 * Unit tests: timeToMinutes, hasValidLocation, scoreSlots, getNearestReferenceDistance
 * Integration tests: filterAvailableSlotsByLocation (Mongoose mocked)
 */

const haversine = require("../src/utils/haversine");

// ── We need a FRESH RouteOptimizer class (not the singleton) so we can
//    control constructor defaults without env vars leaking between tests.
//    Jest's module cache is reset per-file, but we also jest.mock the DB models.

jest.mock("../src/models/bookingModel");
jest.mock("../src/models/userModel");
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Booking = require("../src/models/bookingModel");
const User = require("../src/models/userModel");
const logger = require("../src/utils/logger-advanced");

// Import the singleton – its constructor has already run with default env
const routeOptimizer = require("../src/services/routeOptimizer");

// ── Helpers ────────────────────────────────────────────────────────────────

const INSTRUCTOR_BASE = { lat: 53.0168046, long: -2.2190649 }; // default

/** Build a fake booking object that matches the Mongoose shape */
function makeBooking(time, lat, long, status = "confirmed") {
  return {
    time,
    date: "2025-06-15",
    instructorId: "inst-1",
    status,
    location: { latitude: lat, longitude: long },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIT TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("RouteOptimizer – Unit Tests", () => {
  // ── timeToMinutes ──────────────────────────────────────────────────────

  describe("timeToMinutes", () => {
    it("converts midnight correctly", () => {
      expect(routeOptimizer.timeToMinutes("00:00")).toBe(0);
    });

    it("converts morning time correctly", () => {
      expect(routeOptimizer.timeToMinutes("09:00")).toBe(540);
    });

    it("converts noon correctly", () => {
      expect(routeOptimizer.timeToMinutes("12:00")).toBe(720);
    });

    it("converts afternoon time correctly", () => {
      expect(routeOptimizer.timeToMinutes("15:30")).toBe(930);
    });

    it("converts end-of-day time correctly", () => {
      expect(routeOptimizer.timeToMinutes("23:59")).toBe(1439);
    });

    it("handles single-digit hours", () => {
      expect(routeOptimizer.timeToMinutes("9:05")).toBe(545);
    });
  });

  // ── hasValidLocation ───────────────────────────────────────────────────

  describe("hasValidLocation", () => {
    it("returns true for a booking with valid lat/long", () => {
      const booking = makeBooking("09:00", 53.02, -2.22);
      expect(routeOptimizer.hasValidLocation(booking)).toBe(true);
    });

    it("returns false when location is null", () => {
      expect(routeOptimizer.hasValidLocation({ location: null })).toBeFalsy();
    });

    it("returns false when location is undefined", () => {
      expect(routeOptimizer.hasValidLocation({})).toBeFalsy();
    });

    it("returns false when latitude is NaN", () => {
      expect(
        routeOptimizer.hasValidLocation({
          location: { latitude: NaN, longitude: -2.22 },
        })
      ).toBe(false);
    });

    it("returns false when longitude is NaN", () => {
      expect(
        routeOptimizer.hasValidLocation({
          location: { latitude: 53.02, longitude: NaN },
        })
      ).toBe(false);
    });

    it("returns false when latitude is a string", () => {
      expect(
        routeOptimizer.hasValidLocation({
          location: { latitude: "53.02", longitude: -2.22 },
        })
      ).toBe(false);
    });

    it("returns false when longitude is missing", () => {
      expect(
        routeOptimizer.hasValidLocation({
          location: { latitude: 53.02 },
        })
      ).toBe(false);
    });

    it("returns true for zero coordinates (valid edge case)", () => {
      expect(
        routeOptimizer.hasValidLocation({
          location: { latitude: 0, longitude: 0 },
        })
      ).toBe(true);
    });
  });

  // ── scoreSlots ─────────────────────────────────────────────────────────

  describe("scoreSlots", () => {
    const userLocation = { lat: 53.02, long: -2.23 };

    it("scores purely on base distance when no bookings exist", () => {
      const scored = routeOptimizer.scoreSlots(
        ["09:00", "12:00", "15:00"],
        [],
        userLocation,
        INSTRUCTOR_BASE
      );

      expect(scored).toHaveLength(3);
      // All should have the same score (distance from base is identical for all slots)
      expect(scored[0].score).toBeCloseTo(scored[1].score, 5);
      expect(scored[0].reason).toMatch(/km from base/);
    });

    it("prefers slots nearer in time and distance to existing bookings", () => {
      // One booking at 10:00 very close to the user
      const bookings = [makeBooking("10:00", 53.021, -2.231)];

      const scored = routeOptimizer.scoreSlots(
        ["09:00", "11:00", "16:00"],
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      // 11:00 is 1 hour after the 10:00 booking and close → should score highest
      // 09:00 is 1 hour before → should also score well
      // 16:00 is 6 hours after → should score lowest
      const slotOrder = scored.map((s) => s.slot);
      expect(slotOrder.indexOf("16:00")).toBeGreaterThan(
        slotOrder.indexOf("11:00")
      );
    });

    it("returns scores in descending order (best first)", () => {
      const bookings = [makeBooking("10:00", 53.021, -2.231)];
      const scored = routeOptimizer.scoreSlots(
        ["09:00", "10:00", "11:00", "15:00"],
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      for (let i = 1; i < scored.length; i++) {
        expect(scored[i - 1].score).toBeGreaterThanOrEqual(scored[i].score);
      }
    });

    it("ignores bookings without valid locations", () => {
      const bookings = [
        { time: "10:00", location: null }, // invalid
        makeBooking("14:00", 53.025, -2.24), // valid
      ];

      const scored = routeOptimizer.scoreSlots(
        ["09:00", "15:00"],
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      // Should still produce scores (only the 14:00 booking used)
      expect(scored).toHaveLength(2);
      scored.forEach((s) => expect(s.score).toBeGreaterThan(0));
    });

    it("handles a single available slot", () => {
      const scored = routeOptimizer.scoreSlots(
        ["12:00"],
        [],
        userLocation,
        INSTRUCTOR_BASE
      );
      expect(scored).toHaveLength(1);
      expect(scored[0].slot).toBe("12:00");
    });

    it("handles multiple bookings building a timeline", () => {
      const bookings = [
        makeBooking("09:00", 53.01, -2.21),
        makeBooking("11:00", 53.03, -2.25),
        makeBooking("14:00", 53.02, -2.23),
      ];

      const scored = routeOptimizer.scoreSlots(
        ["10:00", "12:00", "15:00"],
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      expect(scored).toHaveLength(3);
      // 15:00 is right after the 14:00 booking at the user's exact location → best
      expect(scored[0].slot).toBe("15:00");
    });
  });

  // ── getNearestReferenceDistance ─────────────────────────────────────────

  describe("getNearestReferenceDistance", () => {
    const userLocation = { lat: 53.02, long: -2.23 };

    it("returns distance from base when no bookings", () => {
      const dist = routeOptimizer.getNearestReferenceDistance(
        "12:00",
        [],
        userLocation,
        INSTRUCTOR_BASE
      );

      const expected = haversine(
        userLocation.lat,
        userLocation.long,
        INSTRUCTOR_BASE.lat,
        INSTRUCTOR_BASE.long
      );
      expect(dist).toBeCloseTo(expected, 5);
    });

    it("returns distance from nearest booking when one is closer than base", () => {
      const nearbyBooking = makeBooking("10:00", 53.021, -2.231);
      const dist = routeOptimizer.getNearestReferenceDistance(
        "11:00",
        [nearbyBooking],
        userLocation,
        INSTRUCTOR_BASE
      );

      const distToBooking = haversine(53.02, -2.23, 53.021, -2.231);
      expect(dist).toBeCloseTo(distToBooking, 5);
    });

    it("returns base distance when all bookings are farther than base", () => {
      const farBooking = makeBooking("10:00", 54.0, -3.0); // very far
      const dist = routeOptimizer.getNearestReferenceDistance(
        "11:00",
        [farBooking],
        userLocation,
        INSTRUCTOR_BASE
      );

      const distToBase = haversine(
        userLocation.lat,
        userLocation.long,
        INSTRUCTOR_BASE.lat,
        INSTRUCTOR_BASE.long
      );
      expect(dist).toBeCloseTo(distToBase, 5);
    });

    it("skips bookings with invalid locations", () => {
      const bookings = [
        { time: "10:00", location: null },
        makeBooking("12:00", 53.021, -2.231),
      ];

      const dist = routeOptimizer.getNearestReferenceDistance(
        "13:00",
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      const distToValidBooking = haversine(53.02, -2.23, 53.021, -2.231);
      expect(dist).toBeCloseTo(distToValidBooking, 5);
    });

    it("picks the closest among multiple bookings", () => {
      const bookings = [
        makeBooking("09:00", 53.5, -2.5),   // far
        makeBooking("11:00", 53.021, -2.231), // close
        makeBooking("14:00", 53.3, -2.4),    // medium
      ];

      const dist = routeOptimizer.getNearestReferenceDistance(
        "12:00",
        bookings,
        userLocation,
        INSTRUCTOR_BASE
      );

      const closest = haversine(53.02, -2.23, 53.021, -2.231);
      expect(dist).toBeCloseTo(closest, 5);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION TESTS  (filterAvailableSlotsByLocation – Mongoose mocked)
// ═══════════════════════════════════════════════════════════════════════════

describe("RouteOptimizer – Integration Tests (filterAvailableSlotsByLocation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns original slots when input is empty", async () => {
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      [],
      "2025-06-15",
      "inst-1",
      "447000000001"
    );
    expect(result).toEqual([]);
  });

  it("returns original slots when input is null", async () => {
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      null,
      "2025-06-15",
      "inst-1",
      "447000000001"
    );
    expect(result).toBeNull();
  });

  it("returns all slots when user has no location", async () => {
    User.findOne.mockResolvedValue({ phone: "447000000001", location: {} });

    const slots = ["09:00", "10:00", "11:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000001"
    );

    expect(result).toEqual(slots);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("User location not found")
    );
  });

  it("returns all slots when user is not found in DB", async () => {
    User.findOne.mockResolvedValue(null);

    const slots = ["09:00", "12:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000001"
    );

    expect(result).toEqual(slots);
  });

  it("filters slots within threshold when nearby bookings exist", async () => {
    // User is very close to base (within 8km)
    User.findOne.mockResolvedValue({
      phone: "447000000001",
      location: { latitude: 53.02, longitude: -2.22 },
    });

    // No existing bookings → distance check is from base
    Booking.find.mockResolvedValue([]);

    const slots = ["09:00", "10:00", "11:00", "14:00", "15:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000001"
    );

    // User is ~0.5km from base → all slots should be within threshold
    expect(result.length).toBe(5);
    // Should be in chronological order
    expect(result).toEqual(["09:00", "10:00", "11:00", "14:00", "15:00"]);
  });

  it("returns top-3 by score when user is far from all reference points", async () => {
    // User is far away (>8km from base and all bookings)
    User.findOne.mockResolvedValue({
      phone: "447000000002",
      location: { latitude: 53.2, longitude: -2.5 }, // ~25km away
    });

    Booking.find.mockResolvedValue([]);

    const slots = ["09:00", "10:00", "11:00", "12:00", "14:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000002"
    );

    // Far from base → no slots within 8km → fallback to top 3
    expect(result.length).toBe(3);
    // Should be sorted chronologically
    for (let i = 1; i < result.length; i++) {
      expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
        routeOptimizer.timeToMinutes(result[i - 1])
      );
    }
  });

  it("uses nearby bookings to filter when bookings exist close to user", async () => {
    // User close to base
    User.findOne.mockResolvedValue({
      phone: "447000000003",
      location: { latitude: 53.018, longitude: -2.22 },
    });

    // One confirmed booking at 10:00, very close to user
    Booking.find.mockResolvedValue([
      makeBooking("10:00", 53.019, -2.221),
    ]);

    const slots = ["09:00", "11:00", "14:00", "16:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000003"
    );

    // User is close to base AND close to booking → all within threshold
    expect(result.length).toBeGreaterThan(0);
    // Result should be chronologically sorted
    for (let i = 1; i < result.length; i++) {
      expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
        routeOptimizer.timeToMinutes(result[i - 1])
      );
    }
  });

  it("preserves chronological order in the result", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000004",
      location: { latitude: 53.017, longitude: -2.219 },
    });

    Booking.find.mockResolvedValue([
      makeBooking("15:00", 53.018, -2.22),
      makeBooking("09:00", 53.016, -2.218),
    ]);

    const slots = ["08:00", "10:00", "14:00", "16:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000004"
    );

    for (let i = 1; i < result.length; i++) {
      expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
        routeOptimizer.timeToMinutes(result[i - 1])
      );
    }
  });

  it("returns unfiltered slots on unexpected error (graceful fallback)", async () => {
    User.findOne.mockRejectedValue(new Error("DB connection lost"));

    const slots = ["09:00", "11:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000005"
    );

    expect(result).toEqual(slots);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Route optimiser error")
    );
  });

  it("handles Booking.find returning empty array", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000006",
      location: { latitude: 53.018, longitude: -2.22 },
    });
    Booking.find.mockResolvedValue([]);

    const slots = ["09:00", "12:00", "15:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000006"
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(slots.length);
  });

  it("handles bookings with mixed valid/invalid locations", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000007",
      location: { latitude: 53.018, longitude: -2.22 },
    });

    Booking.find.mockResolvedValue([
      makeBooking("09:00", 53.019, -2.221),
      { time: "11:00", location: null, status: "confirmed" },   // invalid
      { time: "13:00", location: { latitude: NaN, longitude: -2.22 }, status: "confirmed" }, // invalid
      makeBooking("15:00", 53.02, -2.23),
    ]);

    const slots = ["10:00", "12:00", "14:00", "16:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      "inst-1",
      "447000000007"
    );

    // Should still work, using only the two valid bookings
    expect(result.length).toBeGreaterThan(0);
  });

  it("queries Booking with correct filters", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000008",
      location: { latitude: 53.018, longitude: -2.22 },
    });
    Booking.find.mockResolvedValue([]);

    await routeOptimizer.filterAvailableSlotsByLocation(
      ["09:00"],
      "2025-07-01",
      "inst-42",
      "447000000008"
    );

    expect(Booking.find).toHaveBeenCalledWith({
      date: "2025-07-01",
      instructorId: "inst-42",
      status: { $in: ["confirmed", "rescheduled"] },
    });
  });

  it("queries User with correct phone number", async () => {
    User.findOne.mockResolvedValue(null);

    await routeOptimizer.filterAvailableSlotsByLocation(
      ["09:00"],
      "2025-07-01",
      "inst-1",
      "447123456789"
    );

    expect(User.findOne).toHaveBeenCalledWith({ phone: "447123456789" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGE CASE TESTS
// ═══════════════════════════════════════════════════════════════════════════

describe("RouteOptimizer – Edge Cases", () => {
  describe("scoreSlots edge cases", () => {
    it("handles user at exact same location as instructor base", () => {
      const scored = routeOptimizer.scoreSlots(
        ["09:00", "12:00"],
        [],
        INSTRUCTOR_BASE,
        INSTRUCTOR_BASE
      );

      // Distance is 0 → score = 1/(1+0) = 1
      expect(scored[0].score).toBeCloseTo(1, 5);
    });

    it("handles user at exact same location as an existing booking", () => {
      const bookingLoc = { lat: 53.05, long: -2.25 };
      const bookings = [makeBooking("10:00", bookingLoc.lat, bookingLoc.long)];

      const scored = routeOptimizer.scoreSlots(
        ["11:00"],
        bookings,
        bookingLoc,
        INSTRUCTOR_BASE
      );

      // Distance from ref is 0, gap is 60min → score = 1 * (1/2) = 0.5
      expect(scored[0].score).toBeCloseTo(0.5, 1);
    });

    it("handles very large number of slots", () => {
      const slots = [];
      for (let h = 8; h <= 18; h++) {
        for (let m = 0; m < 60; m += 15) {
          slots.push(`${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`);
        }
      }

      const scored = routeOptimizer.scoreSlots(
        slots,
        [],
        { lat: 53.02, long: -2.23 },
        INSTRUCTOR_BASE
      );

      expect(scored).toHaveLength(slots.length);
    });
  });

  describe("getNearestReferenceDistance edge cases", () => {
    it("returns 0 when user is at the base", () => {
      const dist = routeOptimizer.getNearestReferenceDistance(
        "12:00",
        [],
        INSTRUCTOR_BASE,
        INSTRUCTOR_BASE
      );
      expect(dist).toBeCloseTo(0, 5);
    });

    it("returns 0 when user is at an existing booking location", () => {
      const loc = { lat: 53.05, long: -2.25 };
      const bookings = [makeBooking("10:00", loc.lat, loc.long)];

      const dist = routeOptimizer.getNearestReferenceDistance(
        "11:00",
        bookings,
        loc,
        INSTRUCTOR_BASE
      );
      expect(dist).toBeCloseTo(0, 5);
    });
  });

  describe("haversine sanity checks (used by RouteOptimizer)", () => {
    it("returns 0 for same coordinates", () => {
      expect(haversine(53.0, -2.0, 53.0, -2.0)).toBeCloseTo(0, 5);
    });

    it("returns correct known distance (London to Manchester ~260km)", () => {
      const dist = haversine(51.5074, -0.1278, 53.4808, -2.2426);
      expect(dist).toBeGreaterThan(250);
      expect(dist).toBeLessThan(270);
    });
  });
});
