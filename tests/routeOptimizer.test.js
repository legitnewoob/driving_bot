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

const INST_OBJ = { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } };

describe("RouteOptimizer – Integration Tests (filterAvailableSlotsByLocation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns original slots when input is empty", async () => {
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      [],
      "2025-06-15",
      INST_OBJ,
      "447000000001"
    );

    expect(result).toEqual([]);
  });

  it("returns original slots when input is null", async () => {
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      null,
      "2025-06-15",
      INST_OBJ,
      "447000000001"
    );

    expect(result).toEqual(null);
  });

  it("returns all slots when user has no valid location", async () => {
    User.findOne.mockResolvedValue({ phone: "447000000001", location: {} });

    const slots = ["09:00", "10:00", "11:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      INST_OBJ,
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
      INST_OBJ,
      "447000000002"
    );

    expect(result).toEqual(slots);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("User location not found")
    );
  });

  it("close user gets all slots on empty day", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000001",
      location: { latitude: 53.018, longitude: -2.22 },
    });
    Booking.find.mockResolvedValue([]);

    const slots = ["09:00", "10:00", "11:00", "14:00", "15:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      INST_OBJ,
      "447000000001"
    );

    // Very close to base → all within threshold
    expect(result.length).toBe(slots.length);
  });

  it("far user gets top-3 fallback on empty day", async () => {
    User.findOne.mockResolvedValue({
      phone: "447000000002",
      location: { latitude: 53.2, longitude: -2.45 },
    });
    Booking.find.mockResolvedValue([]);

    const slots = ["09:00", "10:00", "11:00", "12:00", "14:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots,
      "2025-06-15",
      INST_OBJ,
      "447000000002"
    );

    // Far user with no bookings → top-3 fallback
    expect(result.length).toBe(3);
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
      { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      { phoneNumberId: "inst-1", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      { phoneNumberId: "inst-42", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } },
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
      INST_OBJ,
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

// ═══════════════════════════════════════════════════════════════════════════
// REAL-LIFE MULTI-USER SIMULATION TESTS
// ═══════════════════════════════════════════════════════════════════════════
//
// These simulate a realistic day where multiple users book one after another.
// Each test shows the schedule growing and checks how the optimizer adapts
// its slot suggestions for each new user based on existing bookings.
//
// Geography used (around Stoke-on-Trent / Newcastle-under-Lyme area):
//   Instructor base:    53.0168, -2.2191  (default env)
//   CLOSE user  (~2km): 53.0300, -2.2200  "Alice"  – nearby neighbourhood
//   MID user    (~6km): 53.0600, -2.2500  "Bob"    – next town over
//   FAR user   (~20km): 53.2000, -2.4500  "Charlie"– different city
//   CLOSE user2 (~1km): 53.0200, -2.2150  "Diana"  – right next to base
//   MID user2   (~7km): 53.0700, -2.1600  "Eve"    – east side of town

const USERS = {
  alice:   { phone: "447111000001", lat: 53.0300, long: -2.2200 },
  bob:     { phone: "447111000002", lat: 53.0600, long: -2.2500 },
  charlie: { phone: "447111000003", lat: 53.2000, long: -2.4500 },
  diana:   { phone: "447111000004", lat: 53.0200, long: -2.2150 },
  eve:     { phone: "447111000005", lat: 53.0700, long: -2.1600 },
};

const DATE = "2025-06-20";
const INST = { phoneNumberId: "inst-main", baseLocation: { latitude: 53.0168046, longitude: -2.2190649 } };
const ALL_SLOTS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];

/** Helper: mock User.findOne to return the right user by phone */
function mockUserLookup(userKey) {
  const u = USERS[userKey];
  User.findOne.mockResolvedValue({
    phone: u.phone,
    location: { latitude: u.lat, longitude: u.long },
  });
}

describe("RouteOptimizer – Multi-User Day Simulation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Scenario 1: First booking of the day (empty schedule) ──────────

  it("Scenario 1: Alice books first – close user gets all slots (empty day)", async () => {
    mockUserLookup("alice");
    Booking.find.mockResolvedValue([]); // no bookings yet

    const freeSlots = [...ALL_SLOTS];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.alice.phone
    );

    // Alice is ~2km from base → within 8km threshold → all slots offered
    expect(result.length).toBe(ALL_SLOTS.length);
    expect(result).toEqual(ALL_SLOTS); // chronological
  });

  // ── Scenario 2: Second user, schedule has 1 booking ────────────────

  it("Scenario 2: Bob books second – mid-distance user with Alice@10:00 already booked", async () => {
    mockUserLookup("bob");
    // Alice already confirmed at 10:00
    Booking.find.mockResolvedValue([
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
    ]);

    // 10:00 is taken, so calendar gives these
    const freeSlots = ["09:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.bob.phone
    );

    // Bob is ~6km from base → within 8km → should get slots
    expect(result.length).toBeGreaterThan(0);
    // Result must be chronological
    for (let i = 1; i < result.length; i++) {
      expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
        routeOptimizer.timeToMinutes(result[i - 1])
      );
    }
  });

  // ── Scenario 3: Far-away user when schedule is sparse ──────────────

  it("Scenario 3: Charlie (far user) – only gets top-3 fallback when schedule is sparse", async () => {
    mockUserLookup("charlie");
    // Only Alice@10:00 booked
    Booking.find.mockResolvedValue([
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
    ]);

    const freeSlots = ["09:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.charlie.phone
    );

    // Charlie is ~20km from base and ~20km from Alice → no slots within 8km
    // Should fallback to top-3 best-scored
    expect(result.length).toBe(3);
    // Still chronological
    for (let i = 1; i < result.length; i++) {
      expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
        routeOptimizer.timeToMinutes(result[i - 1])
      );
    }
  });

  // ── Scenario 4: Half-full schedule, close user ─────────────────────

  it("Scenario 4: Diana (very close) sees all remaining slots when day is half-booked", async () => {
    mockUserLookup("diana");
    // Morning is booked: Alice@10:00, Bob@11:00, Charlie@09:00
    Booking.find.mockResolvedValue([
      makeBooking("09:00", USERS.charlie.lat, USERS.charlie.long),
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("11:00", USERS.bob.lat, USERS.bob.long),
    ]);

    // Only afternoon free
    const freeSlots = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.diana.phone
    );

    // Diana is ~1km from base → everything is within threshold
    expect(result.length).toBe(6);
    expect(result).toEqual(freeSlots);
  });

  // ── Scenario 5: Busy schedule, mid-distance user ───────────────────

  it("Scenario 5: Eve (mid-distance) gets optimized slots on a busy day", async () => {
    mockUserLookup("eve");
    // 6 out of 9 slots booked, spread across the day
    Booking.find.mockResolvedValue([
      makeBooking("09:00", USERS.charlie.lat, USERS.charlie.long),
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("11:00", USERS.bob.lat, USERS.bob.long),
      makeBooking("13:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("14:00", USERS.alice.lat, USERS.alice.long), // Alice double-booked for test
      makeBooking("16:00", USERS.bob.lat, USERS.bob.long),
    ]);

    const freeSlots = ["12:00", "15:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.eve.phone
    );

    // Eve is ~7km from base → borderline threshold
    // She's closer to some bookings → should still get suggestions
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThanOrEqual(3);
  });

  // ── Scenario 6: Far user when schedule is packed with nearby bookings ─

  it("Scenario 6: Charlie (far) on a packed day – still gets top-3 fallback", async () => {
    mockUserLookup("charlie");
    // All close-range bookings
    Booking.find.mockResolvedValue([
      makeBooking("09:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("11:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("13:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("14:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("15:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("16:00", USERS.diana.lat, USERS.diana.long),
    ]);

    const freeSlots = ["12:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.charlie.phone
    );

    // Charlie is far from everyone → top-3 fallback (but only 2 slots available)
    expect(result.length).toBe(2);
    expect(result).toEqual(["12:00", "17:00"]);
  });

  // ── Scenario 7: Two users request simultaneously for same remaining slots ─

  it("Scenario 7: Alice and Charlie compete for last 2 slots – close user gets both, far user gets fallback", async () => {
    const existingBookings = [
      makeBooking("09:00", USERS.bob.lat, USERS.bob.long),
      makeBooking("10:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("11:00", USERS.eve.lat, USERS.eve.long),
      makeBooking("12:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("13:00", USERS.bob.lat, USERS.bob.long),
      makeBooking("14:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("16:00", USERS.eve.lat, USERS.eve.long),
    ];

    const lastSlots = ["15:00", "17:00"];

    // Alice's perspective (close)
    mockUserLookup("alice");
    Booking.find.mockResolvedValue(existingBookings);
    const aliceResult = await routeOptimizer.filterAvailableSlotsByLocation(
      [...lastSlots], DATE, INST, USERS.alice.phone
    );

    // Charlie's perspective (far)
    mockUserLookup("charlie");
    Booking.find.mockResolvedValue(existingBookings);
    const charlieResult = await routeOptimizer.filterAvailableSlotsByLocation(
      [...lastSlots], DATE, INST, USERS.charlie.phone
    );

    // Alice is close → should see both slots (within threshold)
    expect(aliceResult.length).toBe(2);

    // Charlie is far → still gets both (only 2 available, top-3 fallback returns all)
    expect(charlieResult.length).toBe(2);

    // Both should be chronological
    expect(aliceResult).toEqual(["15:00", "17:00"]);
    expect(charlieResult).toEqual(["15:00", "17:00"]);
  });

  // ── Scenario 8: Growing schedule simulation (sequential bookings) ──

  it("Scenario 8: progressive day – each booking narrows options for next user", async () => {
    const bookingSoFar = [];

    // Step 1: Alice books 10:00 (empty day)
    mockUserLookup("alice");
    Booking.find.mockResolvedValue([]);
    const aliceSlots = await routeOptimizer.filterAvailableSlotsByLocation(
      [...ALL_SLOTS], DATE, INST, USERS.alice.phone
    );
    expect(aliceSlots.length).toBe(ALL_SLOTS.length); // all available, she's close
    // Simulate: she picks 10:00
    bookingSoFar.push(makeBooking("10:00", USERS.alice.lat, USERS.alice.long));

    // Step 2: Bob books (10:00 taken)
    mockUserLookup("bob");
    Booking.find.mockResolvedValue([...bookingSoFar]);
    const bobFree = ALL_SLOTS.filter(s => s !== "10:00");
    const bobSlots = await routeOptimizer.filterAvailableSlotsByLocation(
      bobFree, DATE, INST, USERS.bob.phone
    );
    expect(bobSlots.length).toBeGreaterThan(0);
    // Simulate: he picks 11:00
    bookingSoFar.push(makeBooking("11:00", USERS.bob.lat, USERS.bob.long));

    // Step 3: Charlie books (10:00, 11:00 taken) – far away
    mockUserLookup("charlie");
    Booking.find.mockResolvedValue([...bookingSoFar]);
    const charlieFree = ALL_SLOTS.filter(s => !["10:00", "11:00"].includes(s));
    const charlieSlots = await routeOptimizer.filterAvailableSlotsByLocation(
      charlieFree, DATE, INST, USERS.charlie.phone
    );
    // Charlie is far → top-3 fallback
    expect(charlieSlots.length).toBe(3);
    // Simulate: he picks whatever is first offered
    bookingSoFar.push(makeBooking(charlieSlots[0], USERS.charlie.lat, USERS.charlie.long));

    // Step 4: Diana books (3 slots taken now)
    mockUserLookup("diana");
    Booking.find.mockResolvedValue([...bookingSoFar]);
    const takenSlots = ["10:00", "11:00", charlieSlots[0]];
    const dianaFree = ALL_SLOTS.filter(s => !takenSlots.includes(s));
    const dianaSlots = await routeOptimizer.filterAvailableSlotsByLocation(
      dianaFree, DATE, INST, USERS.diana.phone
    );
    // Diana is very close → gets all remaining within threshold
    expect(dianaSlots.length).toBe(dianaFree.length);

    // Step 5: Eve books (4 slots taken)
    const dianaPick = dianaSlots[Math.floor(dianaSlots.length / 2)]; // picks a middle slot
    bookingSoFar.push(makeBooking(dianaPick, USERS.diana.lat, USERS.diana.long));
    mockUserLookup("eve");
    Booking.find.mockResolvedValue([...bookingSoFar]);
    const eveFree = ALL_SLOTS.filter(s => ![...takenSlots, dianaPick].includes(s));
    const eveSlots = await routeOptimizer.filterAvailableSlotsByLocation(
      eveFree, DATE, INST, USERS.eve.phone
    );
    expect(eveSlots.length).toBeGreaterThan(0);
    expect(eveSlots.length).toBeLessThanOrEqual(eveFree.length);
  });

  // ── Scenario 9: Cluster effect – bookings in same area boost nearby slots ─

  it("Scenario 9: cluster of nearby bookings makes optimizer prefer adjacent time slots", async () => {
    mockUserLookup("alice");
    // Three bookings all close together in the morning, all near Alice
    Booking.find.mockResolvedValue([
      makeBooking("09:00", 53.028, -2.218),
      makeBooking("10:00", 53.031, -2.221),
      makeBooking("11:00", 53.029, -2.219),
    ]);

    const freeSlots = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      freeSlots, DATE, INST, USERS.alice.phone
    );

    // Alice is close to the cluster → all slots within threshold
    expect(result.length).toBe(freeSlots.length);

    // Now verify scoreSlots prefers 12:00 (right after the cluster) over 17:00
    const scored = routeOptimizer.scoreSlots(
      freeSlots,
      [
        makeBooking("09:00", 53.028, -2.218),
        makeBooking("10:00", 53.031, -2.221),
        makeBooking("11:00", 53.029, -2.219),
      ],
      { lat: USERS.alice.lat, long: USERS.alice.long },
      INSTRUCTOR_BASE
    );
    // 12:00 should score higher than 17:00 (closer in time to cluster)
    const score12 = scored.find(s => s.slot === "12:00").score;
    const score17 = scored.find(s => s.slot === "17:00").score;
    expect(score12).toBeGreaterThan(score17);
  });

  // ── Scenario 10: Only 1 slot left on the day ──────────────────────

  it("Scenario 10: last slot of the day – any user gets it regardless of distance", async () => {
    const packed = [
      makeBooking("09:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("10:00", USERS.bob.lat, USERS.bob.long),
      makeBooking("11:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("12:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("13:00", USERS.eve.lat, USERS.eve.long),
      makeBooking("14:00", USERS.bob.lat, USERS.bob.long),
      makeBooking("15:00", USERS.diana.lat, USERS.diana.long),
      makeBooking("16:00", USERS.alice.lat, USERS.alice.long),
    ];

    // Only 17:00 left – Charlie (far) requests it
    mockUserLookup("charlie");
    Booking.find.mockResolvedValue(packed);
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      ["17:00"], DATE, INST, USERS.charlie.phone
    );

    // Even though Charlie is far, only 1 slot → top-3 fallback returns it
    expect(result).toEqual(["17:00"]);
  });

  // ── Scenario 11: Mixed distances, verify ordering stays chronological ─

  it("Scenario 11: 5 users at different distances all get chronologically sorted results", async () => {
    const bookings = [
      makeBooking("10:00", USERS.alice.lat, USERS.alice.long),
      makeBooking("14:00", USERS.bob.lat, USERS.bob.long),
    ];
    const freeSlots = ["09:00", "11:00", "12:00", "13:00", "15:00", "16:00", "17:00"];

    for (const [name, userData] of Object.entries(USERS)) {
      mockUserLookup(name);
      Booking.find.mockResolvedValue(bookings);

      const result = await routeOptimizer.filterAvailableSlotsByLocation(
        [...freeSlots], DATE, INST, userData.phone
      );

      // Every user's result must be chronologically sorted
      for (let i = 1; i < result.length; i++) {
        expect(routeOptimizer.timeToMinutes(result[i])).toBeGreaterThanOrEqual(
          routeOptimizer.timeToMinutes(result[i - 1])
        );
      }
    }
  });
});
