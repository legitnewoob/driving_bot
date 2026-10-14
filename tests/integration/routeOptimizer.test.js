/**
 * RouteOptimizer – Unit & Integration Tests
 *
 * Scoring model (see PLAN-route-optimization.md §3):
 *  - addedDrive = t(prev → learner) + t(learner → next) − t(prev → next), home legs weighted
 *  - a slot is infeasible when the instructor can't arrive / leave in time
 *  - slots that make other free slots unbookable are penalised
 * Drive times come from a mocked Routes matrix; null elements fall back to
 * straight-line estimates (2 min per km).
 */

const haversine = require("../../src/utils/haversine");

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/services/distanceMatrixService", () => ({
  getDrivingMatrix: jest.fn(async (origins, destinations) =>
    origins.map(() => destinations.map(() => null))
  ),
  getDrivingDurations: jest.fn(async (_oLat, _oLng, destinations) => destinations.map(() => null)),
  getDrivingDuration: jest.fn(async () => null),
  clearCache: jest.fn(),
}));
jest.mock("../../src/services/calendarService", () => ({
  getAvailableTimeSlotsForDate: jest.fn(),
}));

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const logger = require("../../src/utils/logger-advanced");
const distanceMatrixService = require("../../src/services/distanceMatrixService");
const calendarService = require("../../src/services/calendarService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const { resolveRouteSettings } = require("../../src/services/instructorSettings");

const BASE = { lat: 53.0168046, long: -2.2190649 };
const ROUTE = resolveRouteSettings({});
const route = (overrides = {}) => ({ ...ROUTE, ...overrides });

function makeBooking(time, lat, long, status = "confirmed") {
  return {
    time,
    date: "2025-06-15",
    instructorId: "inst-1",
    status,
    location: { latitude: lat, longitude: long },
  };
}

/**
 * Mock the Routes matrix with an explicit table of drive times between named
 * points. Any pair not listed falls back to the straight-line estimate.
 */
function mockMatrix(table) {
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) =>
    origins.map((o) =>
      destinations.map((d) => {
        const key = `${o.lat},${o.lng}->${d.lat},${d.lng}`;
        return key in table ? table[key] : null;
      })
    )
  );
}
const leg = (a, b) => `${a.lat},${a.long ?? a.lng}->${b.lat},${b.long ?? b.lng}`;

beforeEach(() => {
  jest.clearAllMocks();
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) =>
    origins.map(() => destinations.map(() => null))
  );
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

describe("timeToMinutes", () => {
  it.each([
    ["00:00", 0],
    ["09:00", 540],
    ["12:00", 720],
    ["15:30", 930],
    ["23:59", 1439],
    ["9:05", 545],
  ])("%s → %i", (time, expected) => {
    expect(routeOptimizer.timeToMinutes(time)).toBe(expected);
  });
});

describe("hasValidLocation", () => {
  it("accepts legacy location, pickup only, or drop-off only", () => {
    expect(routeOptimizer.hasValidLocation(makeBooking("09:00", 53.02, -2.22))).toBe(true);
    expect(routeOptimizer.hasValidLocation({ pickupLocation: { latitude: 53.02, longitude: -2.22 } })).toBe(true);
    expect(routeOptimizer.hasValidLocation({ dropoffLocation: { latitude: 53.02, longitude: -2.22 } })).toBe(true);
  });

  it("accepts zero coordinates", () => {
    expect(routeOptimizer.hasValidLocation({ location: { latitude: 0, longitude: 0 } })).toBe(true);
  });

  it("rejects missing, NaN, string or partial coordinates", () => {
    expect(routeOptimizer.hasValidLocation({ location: null })).toBeFalsy();
    expect(routeOptimizer.hasValidLocation({})).toBeFalsy();
    expect(routeOptimizer.hasValidLocation({ location: { latitude: NaN, longitude: -2.22 } })).toBe(false);
    expect(routeOptimizer.hasValidLocation({ location: { latitude: "53.02", longitude: -2.22 } })).toBe(false);
    expect(routeOptimizer.hasValidLocation({ location: { latitude: 53.02 } })).toBe(false);
  });
});

describe("buildDayPlan", () => {
  it("starts each lesson at its pickup and ends it at its drop-off, sorted by time", () => {
    const plan = routeOptimizer.buildDayPlan(
      [
        {
          time: "14:00",
          pickupLocation: { latitude: 53.1, longitude: -2.4 },
          dropoffLocation: { latitude: 53.2, longitude: -2.5 },
        },
        { time: "09:00", location: { latitude: 53.03, longitude: -2.24 } },
      ],
      ROUTE
    );

    expect(plan.map((p) => p.label)).toEqual(["09:00", "14:00"]);
    expect(plan[1].startLoc).toEqual({ lat: 53.1, lng: -2.4 });
    expect(plan[1].endLoc).toEqual({ lat: 53.2, lng: -2.5 });
    expect(plan[1].endAt - plan[1].startAt).toBe(60);
  });

  it("falls back: missing drop-off ends at pickup, missing both uses legacy location", () => {
    const plan = routeOptimizer.buildDayPlan(
      [
        { time: "10:00", pickupLocation: { latitude: 53.05, longitude: -2.3 } },
        { time: "12:00", location: { latitude: 53.03, longitude: -2.24 } },
      ],
      ROUTE
    );
    expect(plan[0].endLoc).toEqual({ lat: 53.05, lng: -2.3 });
    expect(plan[1].startLoc).toEqual({ lat: 53.03, lng: -2.24 });
  });

  it("keeps lessons without a location so they still block their time", () => {
    const plan = routeOptimizer.buildDayPlan([{ time: "10:00", location: null }], ROUTE);
    expect(plan).toHaveLength(1);
    expect(plan[0].startLoc).toBeNull();
  });

  it("uses the configured lesson length", () => {
    const plan = routeOptimizer.buildDayPlan([makeBooking("10:00", 53, -2)], route({ lessonDurationMin: 90 }));
    expect(plan[0].endAt).toBe(600 + 90);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// scoreSlots — the insertion-cost model
// ═══════════════════════════════════════════════════════════════════════════

describe("scoreSlots", () => {
  const A = { lat: 53.06, long: -2.25 };
  const B = { lat: 53.10, long: -2.30 };
  const U = { lat: 53.03, long: -2.22 };

  it("counts the drive out to the next lesson, not just the drive in (P1)", async () => {
    // 09:00 at A, 13:00 at B. 10:00 is 2 min from A but 40 min from B;
    // the learner is equally placed for a 11:00 between... use one learner and
    // compare a slot with a far next lesson against one with home after.
    mockMatrix({
      [leg(A, U)]: 2,
      [leg(U, B)]: 40,
      [leg(A, B)]: 10,
      [leg(U, BASE)]: 4,
      [leg(B, BASE)]: 4,
    });
    const bookings = [makeBooking("09:00", A.lat, A.long), makeBooking("13:00", B.lat, B.long)];

    const scored = await routeOptimizer.scoreSlots(["10:00", "14:00"], bookings, U, BASE, ROUTE);
    const ten = scored.find((s) => s.slot === "10:00");

    // In 2 + out 40 − direct 10 = 32 extra minutes
    expect(ten.addedDrive).toBeCloseTo(32, 5);
    expect(ten.reason).toMatch(/between your 09:00 and 13:00 lessons/);
  });

  it("weights legs to and from home (P6)", async () => {
    mockMatrix({ [leg(BASE, U)]: 10, [leg(U, BASE)]: 10 });

    const half = await routeOptimizer.scoreSlots(["09:00"], [], U, BASE, ROUTE);
    expect(half[0].addedDrive).toBeCloseTo(10, 5); // 0.5×10 + 0.5×10

    const full = await routeOptimizer.scoreSlots(["09:00"], [], U, BASE, route({ homeLegWeight: 1 }));
    expect(full[0].addedDrive).toBeCloseTo(20, 5);

    const off = await routeOptimizer.scoreSlots(["09:00"], [], U, BASE, route({ homeLegWeight: 0 }));
    expect(off[0].addedDrive).toBe(0);
  });

  it("ignores home legs when the instructor has no base (P8)", async () => {
    const scored = await routeOptimizer.scoreSlots(["09:00"], [], U, null, ROUTE);
    expect(scored[0].addedDrive).toBe(0);
    expect(scored[0].reason).toBe("no other lessons that day");
  });

  it("rejects a back-to-back slot the instructor can't reach in time (P2)", async () => {
    mockMatrix({ [leg(A, U)]: 18 });
    const scored = await routeOptimizer.scoreSlots(["10:00"], [makeBooking("09:00", A.lat, A.long)], U, BASE, ROUTE);

    expect(scored[0].feasible).toBe(false);
    expect(scored[0].reason).toMatch(/can't get there in time after your 09:00 lesson \(18 min drive\)/);
  });

  it("allows a back-to-back slot within the grace period", async () => {
    mockMatrix({ [leg(A, U)]: 8 });
    const scored = await routeOptimizer.scoreSlots(["10:00"], [makeBooking("09:00", A.lat, A.long)], U, BASE, ROUTE);
    expect(scored[0].feasible).toBe(true);
  });

  it("rejects a slot that would make the instructor late for the next lesson", async () => {
    mockMatrix({ [leg(U, B)]: 25 });
    const scored = await routeOptimizer.scoreSlots(["12:00"], [makeBooking("13:00", B.lat, B.long)], U, BASE, ROUTE);
    expect(scored[0].feasible).toBe(false);
    expect(scored[0].reason).toMatch(/couldn't reach your 13:00 lesson/);
  });

  it("a bigger grace period lets the same slot through", async () => {
    mockMatrix({ [leg(A, U)]: 18 });
    const scored = await routeOptimizer.scoreSlots(
      ["10:00"], [makeBooking("09:00", A.lat, A.long)], U, BASE, route({ travelGraceMin: 20 })
    );
    expect(scored[0].feasible).toBe(true);
  });

  it("marks slots that overlap an existing lesson as infeasible", async () => {
    const scored = await routeOptimizer.scoreSlots(
      ["09:30"], [makeBooking("09:00", A.lat, A.long)], U, BASE, ROUTE
    );
    expect(scored[0].feasible).toBe(false);
    expect(scored[0].reason).toMatch(/overlaps your 09:00 lesson/);
  });

  it("penalises a slot that leaves another free slot unbookable (P4)", async () => {
    const far = { lat: 53.2, long: -2.45 };
    mockMatrix({ [leg(far, A)]: 90, [leg(BASE, far)]: 5, [leg(far, BASE)]: 5 });
    // Lesson at A at 12:00. Candidate 09:00 at "far" ends 10:00; the drive to A
    // (90 min) still makes 12:00 with grace. But a 10:00 lesson in between would
    // have only 10 + 70 = 80 min of slack for a 90-min drive, so it can't be sold.
    const scored = await routeOptimizer.scoreSlots(
      ["09:00", "10:00"],
      [makeBooking("12:00", A.lat, A.long)],
      far,
      BASE,
      ROUTE
    );
    const nine = scored.find((s) => s.slot === "09:00");
    expect(nine.feasible).toBe(true);
    expect(nine.newlyStranded).toBe(1);
    expect(nine.reason).toMatch(/leaves 1 free slot hard to fill/);
    expect(nine.score).toBeCloseTo(nine.addedDrive + 15, 5);
  });

  it("gives a small bonus to back-to-back slots so days stay compact", async () => {
    mockMatrix({ [leg(A, U)]: 3 });
    const scored = await routeOptimizer.scoreSlots(
      ["10:00", "16:00"], [makeBooking("09:00", A.lat, A.long)], U, BASE, ROUTE
    );
    const ten = scored.find((s) => s.slot === "10:00");
    const four = scored.find((s) => s.slot === "16:00");
    expect(ten.adjacent).toBe(true);
    expect(four.adjacent).toBe(false);
    expect(ten.score).toBeLessThan(four.score);
    expect(scored[0].slot).toBe("10:00");
  });

  it("treats lessons with no location as zero travel but still blocks their time", async () => {
    const scored = await routeOptimizer.scoreSlots(
      ["10:00", "11:00"], [{ time: "10:00", location: null }], U, BASE, ROUTE
    );
    const ten = scored.find((s) => s.slot === "10:00");
    const eleven = scored.find((s) => s.slot === "11:00");
    expect(ten.feasible).toBe(false);
    expect(eleven.feasible).toBe(true);
  });

  it("falls back to straight-line estimates when the Routes API returns nothing", async () => {
    const scored = await routeOptimizer.scoreSlots(["09:00"], [], U, BASE, ROUTE);
    const km = haversine(U.lat, U.long, BASE.lat, BASE.long);
    expect(scored[0].addedDrive).toBeCloseTo(km * 2, 5); // 0.5 × 2 legs × km × 2 min/km
  });

  it("falls back when the matrix call throws", async () => {
    distanceMatrixService.getDrivingMatrix.mockRejectedValueOnce(new Error("boom"));
    const scored = await routeOptimizer.scoreSlots(["09:00"], [], U, BASE, ROUTE);
    expect(scored[0].feasible).toBe(true);
    expect(scored[0].addedDrive).toBeGreaterThan(0);
  });

  it("sorts feasible slots first, then by score", async () => {
    mockMatrix({ [leg(A, U)]: 30 });
    const scored = await routeOptimizer.scoreSlots(
      ["10:00", "14:00", "15:00"], [makeBooking("09:00", A.lat, A.long)], U, BASE, ROUTE
    );
    expect(scored[scored.length - 1].slot).toBe("10:00");
    expect(scored[scored.length - 1].feasible).toBe(false);
    for (let i = 1; i < scored.length - 1; i++) {
      expect(scored[i - 1].score).toBeLessThanOrEqual(scored[i].score);
    }
  });

  it("makes one matrix call covering learner, home and every lesson start/end", async () => {
    const bookings = [
      { time: "09:00", pickupLocation: { latitude: 53.01, longitude: -2.21 }, dropoffLocation: { latitude: 53.05, longitude: -2.3 } },
      makeBooking("14:00", 53.02, -2.23),
    ];
    await routeOptimizer.scoreSlots(["11:00", "16:00"], bookings, U, BASE, ROUTE, new Date("2030-01-01T09:00:00Z"));

    expect(distanceMatrixService.getDrivingMatrix).toHaveBeenCalledTimes(1);
    const [origins, destinations, departure] = distanceMatrixService.getDrivingMatrix.mock.calls[0];
    // origins: learner, home, each lesson's END (09:00 drop-off, 14:00 location)
    expect(origins).toEqual([
      { lat: U.lat, lng: U.long },
      { lat: BASE.lat, lng: BASE.long },
      { lat: 53.05, lng: -2.3 },
      { lat: 53.02, lng: -2.23 },
    ]);
    // destinations: learner, home, each lesson's START (09:00 pickup, 14:00 location)
    expect(destinations).toEqual([
      { lat: U.lat, lng: U.long },
      { lat: BASE.lat, lng: BASE.long },
      { lat: 53.01, lng: -2.21 },
      { lat: 53.02, lng: -2.23 },
    ]);
    expect(departure).toEqual(new Date("2030-01-01T09:00:00Z"));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// filterAvailableSlotsByLocation / planDay
// ═══════════════════════════════════════════════════════════════════════════

const INST = { phoneNumberId: "inst-1", baseLocation: { latitude: BASE.lat, longitude: BASE.long } };

function mockUser(lat, long, schedulingPrefs = {}) {
  User.findOne.mockResolvedValue({
    phone: "447000000001",
    location: lat === undefined ? {} : { latitude: lat, longitude: long },
    schedulingPrefs,
  });
}

describe("filterAvailableSlotsByLocation", () => {
  it("returns empty / null input unchanged", async () => {
    expect(await routeOptimizer.filterAvailableSlotsByLocation([], "2025-06-15", INST, "4470")).toEqual([]);
    expect(await routeOptimizer.filterAvailableSlotsByLocation(null, "2025-06-15", INST, "4470")).toBeNull();
  });

  it("returns every slot when the learner has no location", async () => {
    mockUser();
    Booking.find.mockResolvedValue([]);
    const slots = ["09:00", "10:00", "11:00"];
    expect(await routeOptimizer.filterAvailableSlotsByLocation(slots, "2025-06-15", INST, "4470")).toEqual(slots);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("User location not found"));
  });

  it("returns every slot when the learner isn't found", async () => {
    User.findOne.mockResolvedValue(null);
    Booking.find.mockResolvedValue([]);
    const slots = ["09:00", "12:00"];
    expect(await routeOptimizer.filterAvailableSlotsByLocation(slots, "2025-06-15", INST, "4470")).toEqual(slots);
  });

  it("returns the input unchanged on unexpected errors", async () => {
    User.findOne.mockRejectedValue(new Error("DB connection lost"));
    const slots = ["09:00", "11:00"];
    expect(await routeOptimizer.filterAvailableSlotsByLocation(slots, "2025-06-15", INST, "4470")).toEqual(slots);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Route optimiser error"));
  });

  it("looks the learner up for this instructor only", async () => {
    // Changed from { phone } – a learner can have separate records per instructor.
    User.findOne.mockResolvedValue(null);
    Booking.find.mockResolvedValue([]);
    await routeOptimizer.filterAvailableSlotsByLocation(["09:00"], "2025-07-01", INST, "447123456789");
    expect(User.findOne).toHaveBeenCalledWith({ phone: "447123456789", instructorId: "inst-1" });
  });

  it("queries the instructor's active bookings for the date", async () => {
    mockUser(53.018, -2.22);
    Booking.find.mockResolvedValue([]);
    await routeOptimizer.filterAvailableSlotsByLocation(["09:00"], "2025-07-01", { ...INST, phoneNumberId: "inst-42" }, "4470");
    expect(Booking.find).toHaveBeenCalledWith({
      date: "2025-07-01",
      instructorId: "inst-42",
      status: { $in: ["confirmed", "rescheduled"] },
    });
  });

  it("offers every slot to a learner close to home on an empty day", async () => {
    mockUser(53.018, -2.22);
    Booking.find.mockResolvedValue([]);
    const slots = ["09:00", "10:00", "11:00", "14:00", "15:00"];
    expect(await routeOptimizer.filterAvailableSlotsByLocation(slots, "2025-06-15", INST, "4470")).toEqual(slots);
  });

  it("offers the 3 best slots when nothing is within the drive limit", async () => {
    mockUser(53.2, -2.45); // ~20 km → ~40 min each way
    Booking.find.mockResolvedValue([]);
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      ["09:00", "10:00", "11:00", "12:00", "14:00"], "2025-06-15", INST, "4470"
    );
    expect(result).toHaveLength(3);
  });

  it("uses the conversation's pickup instead of the profile location", async () => {
    mockUser(53.2, -2.45); // far profile location
    Booking.find.mockResolvedValue([]);
    const slots = ["09:00", "10:00", "11:00", "12:00"];
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      slots, "2025-08-01", INST, "4470", { lat: 53.018, long: -2.22 }
    );
    expect(result).toEqual(slots);
  });

  it("ignores an override with invalid types", async () => {
    mockUser(53.2, -2.45);
    Booking.find.mockResolvedValue([]);
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      ["09:00", "10:00", "11:00", "12:00"], "2025-08-01", INST, "4470", { lat: "53.02", long: -2.23 }
    );
    expect(result).toHaveLength(3); // fell back to the far profile location
  });

  it("returns results in chronological order", async () => {
    mockUser(53.017, -2.219);
    Booking.find.mockResolvedValue([makeBooking("15:00", 53.018, -2.22), makeBooking("09:00", 53.016, -2.218)]);
    const result = await routeOptimizer.filterAvailableSlotsByLocation(
      ["08:00", "10:00", "14:00", "16:00"], "2025-06-15", INST, "4470"
    );
    const minutes = result.map((t) => routeOptimizer.timeToMinutes(t));
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it("never offers slots the instructor can't reach, even as a fallback", async () => {
    mockUser(53.2, -2.45);
    Booking.find.mockResolvedValue([makeBooking("09:00", 53.0168, -2.2191), makeBooking("11:00", 53.0168, -2.2191)]);
    // 10:00 sits between two lessons 40 min away → unreachable
    const result = await routeOptimizer.filterAvailableSlotsByLocation(["10:00"], "2025-06-15", INST, "4470");
    expect(result).toEqual([]);
  });
});

describe("planDay – instructor settings", () => {
  it("never offers a time that clashes with a lesson already in the database", async () => {
    // e.g. a lesson with no Google Calendar event, so the calendar thinks 11:00 is free
    Booking.find.mockResolvedValue([{ time: "11:00", date: "2030-10-21", status: "confirmed" }]);
    const free = ["09:00", "10:00", "11:00", "14:00"];

    const unknownLocation = await routeOptimizer.planDay({ date: "2030-10-21", instructor: INST, availableSlots: free });
    expect(unknownLocation.offered).toEqual(["09:00", "10:00", "14:00"]); // 10:00–11:00 is back-to-back, fine
    expect(unknownLocation.booked).toEqual(["11:00"]);

    const routingOff = await routeOptimizer.planDay({
      date: "2030-10-21", instructor: { ...INST, routeSettings: { preset: "off" } }, availableSlots: free, userLoc: { lat: 53.2, long: -2.45 },
    });
    expect(routingOff.offered).not.toContain("11:00");
  });

  it("offers every free slot unscored when routing is off", async () => {
    Booking.find.mockResolvedValue([]);
    const inst = { ...INST, routeSettings: { preset: "off" } };
    const day = await routeOptimizer.planDay({
      date: "2025-06-15", instructor: inst, availableSlots: ["14:00", "09:00"], userLoc: { lat: 53.2, long: -2.45 },
    });
    expect(day.offered).toEqual(["09:00", "14:00"]);
    expect(day.evaluations).toEqual([]);
    expect(distanceMatrixService.getDrivingMatrix).not.toHaveBeenCalled();
  });

  it("'tight' offers fewer slots than 'relaxed' for a mid-distance learner", async () => {
    Booking.find.mockResolvedValue([]);
    const learner = { lat: 53.07, long: -2.30 }; // ~8 km → ~16 min
    const slots = ["09:00", "10:00", "11:00", "12:00", "14:00"];
    const tight = await routeOptimizer.planDay({
      date: "2025-06-15", instructor: { ...INST, routeSettings: { preset: "tight" } }, availableSlots: slots, userLoc: learner,
    });
    const relaxed = await routeOptimizer.planDay({
      date: "2025-06-15", instructor: { ...INST, routeSettings: { preset: "relaxed" } }, availableSlots: slots, userLoc: learner,
    });
    expect(relaxed.offered).toEqual(slots);
    expect(tight.offered).toHaveLength(3);
    expect(tight.usedFallback).toBe(true);
  });

  it("closes the day once the daily lesson limit is reached", async () => {
    Booking.find.mockResolvedValue([makeBooking("09:00", 53, -2), makeBooking("10:00", 53, -2)]);
    const day = await routeOptimizer.planDay({
      date: "2025-06-15",
      instructor: { ...INST, botSettings: { maxLessonsPerDay: 2 } },
      availableSlots: ["14:00"],
      userLoc: { lat: 53.02, long: -2.22 },
    });
    expect(day.offered).toEqual([]);
    expect(day.blockedReason).toBe("day_full");
  });
});

describe("planDay – learner preferences", () => {
  const far = { lat: 53.2, long: -2.45 };
  const slots = ["09:00", "10:00", "11:00", "12:00", "14:00"];

  it("priority learners get every reachable slot regardless of drive", async () => {
    Booking.find.mockResolvedValue([]);
    const day = await routeOptimizer.planDay({
      date: "2025-06-15", instructor: INST, availableSlots: slots, userLoc: far, prefs: { priority: true },
    });
    expect(day.offered).toEqual(slots);
  });

  it("a per-learner drive limit overrides the instructor's", async () => {
    Booking.find.mockResolvedValue([]);
    const day = await routeOptimizer.planDay({
      date: "2025-06-15", instructor: INST, availableSlots: slots, userLoc: far, prefs: { maxAddedDriveMin: 60 },
    });
    expect(day.offered).toEqual(slots);
  });

  it("removes the learner's unavailable times", async () => {
    Booking.find.mockResolvedValue([]);
    const day = await routeOptimizer.planDay({
      date: "2025-06-16", // Monday
      instructor: INST,
      availableSlots: slots,
      userLoc: { lat: 53.018, long: -2.22 },
      prefs: { unavailable: [{ days: [1], from: "09:00", to: "12:00" }] },
    });
    expect(day.offered).toEqual(["12:00", "14:00"]);
  });

  it("reports the learner's preferred slots", async () => {
    Booking.find.mockResolvedValue([]);
    const day = await routeOptimizer.planDay({
      date: "2025-06-16",
      instructor: INST,
      availableSlots: slots,
      userLoc: { lat: 53.018, long: -2.22 },
      prefs: { preferredTimes: ["10:00", "14:00"], preferredDays: [1] },
    });
    expect(day.preferred).toEqual(["10:00", "14:00"]);
  });

  it("closes the date when the learner's weekly limit is reached", async () => {
    Booking.find.mockResolvedValue([]);
    Booking.countDocuments.mockResolvedValue(2);
    const day = await routeOptimizer.planDay({
      date: "2025-06-18", // Wednesday
      instructor: INST,
      availableSlots: slots,
      userLoc: { lat: 53.018, long: -2.22 },
      prefs: { maxLessonsPerWeek: 2 },
      userPhone: "4470",
    });
    expect(day.blockedReason).toBe("weekly_limit");
    expect(Booking.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ userPhone: "4470", date: { $gte: "2025-06-16", $lte: "2025-06-22" } })
    );
  });

  it("uses a saved place when no pickup has been given", async () => {
    User.findOne.mockResolvedValue({
      location: { latitude: 53.2, longitude: -2.45 },
      schedulingPrefs: { savedPlaces: [{ label: "College", latitude: 53.018, longitude: -2.22 }] },
    });
    const ctx = await routeOptimizer.resolveUserContext(INST, "4470");
    expect(ctx.userLoc).toEqual({ lat: 53.018, long: -2.22 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-learner day simulation (Stoke-on-Trent area)
// ═══════════════════════════════════════════════════════════════════════════

const USERS = {
  alice: { lat: 53.03, long: -2.22 }, // ~1.5 km from base
  bob: { lat: 53.06, long: -2.25 }, // ~5 km
  charlie: { lat: 53.2, long: -2.45 }, // ~25 km
  diana: { lat: 53.02, long: -2.215 }, // ~0.5 km
  eve: { lat: 53.07, long: -2.16 }, // ~7 km
};
const DATE = "2025-06-20";
const ALL = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
const at = (time, who) => makeBooking(time, USERS[who].lat, USERS[who].long);

async function offer(who, bookings, free) {
  mockUser(USERS[who].lat, USERS[who].long);
  Booking.find.mockResolvedValue(bookings);
  return routeOptimizer.filterAvailableSlotsByLocation(free, DATE, INST, who);
}

describe("Multi-learner day simulation", () => {
  it("first learner of the day near home sees every slot", async () => {
    expect(await offer("alice", [], [...ALL])).toEqual(ALL);
  });

  it("a far learner on a sparse day gets the 3 best reachable slots", async () => {
    const result = await offer("charlie", [at("10:00", "alice")], ALL.filter((s) => s !== "10:00"));
    expect(result).toHaveLength(3);
    // Straight after Alice's lesson is unreachable from 25 km away
    expect(result).not.toContain("11:00");
  });

  it("a nearby learner can't be squeezed straight after a lesson 5 km away", async () => {
    // Changed: previously every afternoon slot was offered. Diana's 12:00
    // follows Bob's 11:00 lesson ~5 km away (~10 min) with zero travel time
    // between hourly lessons, which only just exceeds the 10-min grace.
    const result = await offer(
      "diana",
      [at("09:00", "charlie"), at("10:00", "alice"), at("11:00", "bob")],
      ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"]
    );
    expect(result).toEqual(["13:00", "14:00", "15:00", "16:00", "17:00"]);
  });

  it("a cluster of nearby lessons makes the slot right after it the best fit", async () => {
    const cluster = [makeBooking("09:00", 53.028, -2.218), makeBooking("10:00", 53.031, -2.221), makeBooking("11:00", 53.029, -2.219)];
    const free = ["12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
    expect(await offer("alice", cluster, free)).toEqual(free);

    const scored = await routeOptimizer.scoreSlots(free, cluster, USERS.alice, BASE, ROUTE);
    expect(scored[0].slot).toBe("12:00");
  });

  it("the last slot of the day is offered if it's reachable", async () => {
    const packed = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"].map((t) => at(t, "alice"));
    // 16:00 lesson ends at Alice's (~1.5 km) – reachable for Diana
    expect(await offer("diana", packed, ["17:00"])).toEqual(["17:00"]);
    // …but not for Charlie 25 km away with no gap
    expect(await offer("charlie", packed, ["17:00"])).toEqual([]);
  });

  it("every learner's options come back in time order", async () => {
    const bookings = [at("10:00", "alice"), at("14:00", "bob")];
    const free = ["09:00", "11:00", "12:00", "13:00", "15:00", "16:00", "17:00"];
    for (const who of Object.keys(USERS)) {
      const result = await offer(who, bookings, [...free]);
      const minutes = result.map((t) => routeOptimizer.timeToMinutes(t));
      expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Nearby days, single-slot evaluation, service area
// ═══════════════════════════════════════════════════════════════════════════

describe("suggestBestDays", () => {
  const realNow = Date.now;
  beforeAll(() => {
    // Monday 2025-06-16 08:00 UTC
    Date.now = () => new Date("2025-06-16T08:00:00Z").getTime();
  });
  afterAll(() => {
    Date.now = realNow;
  });

  it("returns the best-fitting slot per day, least added drive first", async () => {
    const near = makeBooking("10:00", 53.02, -2.215);
    Booking.find.mockImplementation(async ({ date }) => (date === "2025-06-19" ? [near] : []));
    calendarService.getAvailableTimeSlotsForDate.mockResolvedValue(["11:00", "15:00"]);

    const days = await routeOptimizer.suggestBestDays(
      { ...INST, routeSettings: { lookAheadDays: 5, homeLegWeight: "full" } },
      { userLoc: { lat: 53.021, long: -2.216 }, limit: 2 }
    );

    expect(days).toHaveLength(2);
    expect(days[0]).toMatchObject({ date: "2025-06-19", time: "11:00" });
    expect(days[0].addedDrive).toBeLessThan(days[1].addedDrive);
  });

  it("skips the date already being discussed", async () => {
    Booking.find.mockResolvedValue([]);
    calendarService.getAvailableTimeSlotsForDate.mockResolvedValue(["11:00"]);
    const days = await routeOptimizer.suggestBestDays(
      { ...INST, routeSettings: { lookAheadDays: 3 } },
      { userLoc: { lat: 53.02, long: -2.22 }, excludeDate: "2025-06-18", limit: 5 }
    );
    expect(days.map((d) => d.date)).not.toContain("2025-06-18");
    expect(days).toHaveLength(3);
  });

  it("returns nothing when suggestions are turned off", async () => {
    const days = await routeOptimizer.suggestBestDays(
      { ...INST, routeSettings: { suggestOtherDays: false } },
      { userLoc: { lat: 53.02, long: -2.22 } }
    );
    expect(days).toEqual([]);
    expect(calendarService.getAvailableTimeSlotsForDate).not.toHaveBeenCalled();
  });
});

describe("evaluateSlot", () => {
  it("returns the added drive and reason for one slot", async () => {
    Booking.find.mockResolvedValue([makeBooking("09:00", 53.03, -2.22)]);
    const result = await routeOptimizer.evaluateSlot("2025-06-15", "10:00", INST, { lat: 53.031, long: -2.221 });
    expect(result.feasible).toBe(true);
    expect(result.reason).toMatch(/after your 09:00 lesson/);
  });

  it("returns null without a learner location", async () => {
    expect(await routeOptimizer.evaluateSlot("2025-06-15", "10:00", INST, null)).toBeNull();
  });
});

describe("checkServiceArea", () => {
  it("everyone is inside when no area is set", () => {
    expect(routeOptimizer.checkServiceArea(INST, USERS.charlie, "ST5 1AB").inside).toBe(true);
  });

  it("uses the radius from home", () => {
    const inst = { ...INST, routeSettings: { serviceArea: { radiusMiles: 5 } } };
    expect(routeOptimizer.checkServiceArea(inst, USERS.alice).inside).toBe(true);
    const out = routeOptimizer.checkServiceArea(inst, USERS.charlie);
    expect(out.inside).toBe(false);
    expect(out.reason).toMatch(/miles away/);
  });

  it("works in km, and tells the learner in km", () => {
    // 8 km ≈ 5 miles: same people inside/outside as the 5-mile test
    const inst = { ...INST, routeSettings: { serviceArea: { radius: 8, unit: "km" } } };
    expect(routeOptimizer.checkServiceArea(inst, USERS.alice).inside).toBe(true);
    const out = routeOptimizer.checkServiceArea(inst, USERS.charlie);
    expect(out.inside).toBe(false);
    expect(out.reason).toMatch(/^about \d+ km away \(area is 8 km\)$/);
  });

  it("accepts listed postcode districts even outside the radius", () => {
    const inst = { ...INST, routeSettings: { serviceArea: { radiusMiles: 1, postcodeDistricts: ["st5", "ST4"] } } };
    expect(routeOptimizer.checkServiceArea(inst, USERS.charlie, "ST5 1AB").inside).toBe(true);
    expect(routeOptimizer.checkServiceArea(inst, USERS.charlie, "CW1 2AB").inside).toBe(false);
  });
});
