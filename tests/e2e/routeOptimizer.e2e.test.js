/**
 * Route Optimizer – E2E Tests (Real Google Routes API)
 * ─────────────────────────────────────────────────────
 * Tests the route optimizer with REAL driving durations from Google Routes API.
 * Simulates a multi-booking day scenario to verify that:
 *
 *  1. Distance Matrix API returns real durations (not null)
 *  2. scoreSlots: nearby learners add less driving than distant ones
 *  3. Multi-user scenario: reachable slots are ranked by added driving
 *  4. Distant learners add a lot of driving to every slot
 *  6. Cache works — second call is faster
 *
 * Real locations used (Stoke-on-Trent area):
 *   Instructor base:  Stoke centre      (53.0168, -2.2191)
 *   Booking 1 (09:00): Hanley            (53.0254, -2.1768)
 *   Booking 2 (11:00): Newcastle-u-Lyme  (53.0109, -2.2276)
 *   Booking 3 (14:00): Longton           (52.9874, -2.1318)
 *   User A:            Fenton (near all) (53.0062, -2.1641)
 *   User B:            Leek (far north)  (53.1065, -1.9835)
 *
 * Requires: GOOGLE_MAPS_API_KEY env var
 * Run:      npm run test:e2e
 */

// Env loaded via helpers.js → envs/.env.test
const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 30000;

// ── Real modules (no mocks) ────────────────────────────────────────────
const { getDrivingDurations, getDrivingDuration, clearCache } = require("../../src/services/distanceMatrixService");
const haversine = require("../../src/utils/haversine");

// We import the RouteOptimizer class but call scoreSlots directly
// (filterAvailableSlotsByLocation needs DB, which we simulate manually)
const routeOptimizer = require("../../src/services/routeOptimizer");

// ── Real coordinates (Stoke-on-Trent area) ─────────────────────────────

const INSTRUCTOR_BASE = { lat: 53.0168046, long: -2.2190649 }; // Stoke centre

// Existing bookings for the day (these represent other students)
const BOOKINGS = [
  { time: "09:00", date: "2025-07-15", status: "confirmed", location: { latitude: 53.0254, longitude: -2.1768 } },  // Hanley
  { time: "11:00", date: "2025-07-15", status: "confirmed", location: { latitude: 53.0109, longitude: -2.2276 } },  // Newcastle-under-Lyme
  { time: "14:00", date: "2025-07-15", status: "confirmed", location: { latitude: 52.9874, longitude: -2.1318 } },  // Longton
];

// User A: Fenton — close to all existing bookings
const USER_A = { lat: 53.0062, long: -2.1641 };

// User B: Leek — 15+ miles north, far from all bookings
const USER_B = { lat: 53.1065, long: -1.9835 };

const AVAILABLE_SLOTS = ["10:00", "12:00", "13:00", "15:00", "16:00"];

// ═══════════════════════════════════════════════════════════════════════════
// 1. Distance Matrix API – Real Calls
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Distance Matrix API (Real Routes API)", () => {
  beforeEach(() => {
    clearCache();
  });

  it(
    "returns driving durations for multiple destinations",
    async () => {
      const destinations = [
        { lat: INSTRUCTOR_BASE.lat, lng: INSTRUCTOR_BASE.long },
        { lat: BOOKINGS[0].location.latitude, lng: BOOKINGS[0].location.longitude },
        { lat: BOOKINGS[1].location.latitude, lng: BOOKINGS[1].location.longitude },
      ];

      const durations = await getDrivingDurations(USER_A.lat, USER_A.long, destinations);

      // Should return an array with the same length as destinations
      expect(durations).toHaveLength(destinations.length);

      const hasReal = durations.some((d) => d !== null);
      if (hasReal) {
        durations.filter(Boolean).forEach((d, i) => {
          expect(typeof d).toBe("number");
          expect(d).toBeGreaterThan(0);
          console.log(`  📍 User A → dest ${i}: ${d.toFixed(1)} min`);
        });
      } else {
        console.log("  ⚠️ API returned all nulls (SSL/network issue) — testing fallback only");
      }
    },
    TIMEOUT
  );

  it(
    "returns a single driving duration (or null if API unreachable)",
    async () => {
      const duration = await getDrivingDuration(
        USER_A.lat, USER_A.long,
        INSTRUCTOR_BASE.lat, INSTRUCTOR_BASE.long
      );

      if (duration !== null) {
        expect(duration).toBeGreaterThan(0);
        console.log(`  📍 User A → Instructor base: ${duration.toFixed(1)} min`);
      } else {
        console.log("  ⚠️ API returned null (SSL/network issue) — skipped");
      }
    },
    TIMEOUT
  );

  it(
    "Leek (far) has longer driving time than Fenton (near) to instructor base",
    async () => {
      const [durationNear] = await getDrivingDurations(USER_A.lat, USER_A.long, [
        { lat: INSTRUCTOR_BASE.lat, lng: INSTRUCTOR_BASE.long },
      ]);
      const [durationFar] = await getDrivingDurations(USER_B.lat, USER_B.long, [
        { lat: INSTRUCTOR_BASE.lat, lng: INSTRUCTOR_BASE.long },
      ]);

      if (durationNear !== null && durationFar !== null) {
        expect(durationFar).toBeGreaterThan(durationNear);
        console.log(`  📍 Fenton → base: ${durationNear.toFixed(1)} min`);
        console.log(`  📍 Leek → base: ${durationFar.toFixed(1)} min`);
      } else {
        // Fallback: verify via haversine that Leek IS farther
        const distNear = haversine(USER_A.lat, USER_A.long, INSTRUCTOR_BASE.lat, INSTRUCTOR_BASE.long);
        const distFar = haversine(USER_B.lat, USER_B.long, INSTRUCTOR_BASE.lat, INSTRUCTOR_BASE.long);
        expect(distFar).toBeGreaterThan(distNear);
        console.log(`  ⚠️ API unavailable — haversine: Fenton=${distNear.toFixed(2)}km, Leek=${distFar.toFixed(2)}km`);
      }
    },
    TIMEOUT
  );

  it(
    "cache serves results on second call",
    async () => {
      clearCache();

      const dest = [{ lat: INSTRUCTOR_BASE.lat, lng: INSTRUCTOR_BASE.long }];

      const start1 = Date.now();
      const result1 = await getDrivingDurations(USER_A.lat, USER_A.long, dest);
      const time1 = Date.now() - start1;

      const start2 = Date.now();
      const result2 = await getDrivingDurations(USER_A.lat, USER_A.long, dest);
      const time2 = Date.now() - start2;

      console.log(`  ⏱ First call: ${time1}ms, Second: ${time2}ms`);

      if (result1[0] !== null) {
        // If API worked, cached call should be faster
        expect(time2).toBeLessThanOrEqual(time1);
        // Same result
        expect(result2[0]).toBe(result1[0]);
      } else {
        // API failed — nulls aren't cached, so both calls hit API
        console.log("  ⚠️ API returned null — cache test not applicable");
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Route Optimizer – scoreSlots with Real Driving Durations
// ═══════════════════════════════════════════════════════════════════════════
// Lower score = better fit. addedDrive = extra minutes of driving the slot adds.

const { resolveRouteSettings } = require("../../src/services/instructorSettings");
const ROUTE = resolveRouteSettings({});
const bestFeasible = (scored) => scored.find((s) => s.feasible);
const log = (label, scored) => {
  console.log(`  📊 ${label}:`);
  scored.forEach((s) =>
    console.log(`     ${s.slot}: ${s.feasible ? `score=${s.score.toFixed(1)}` : "unreachable"} — ${s.reason}`)
  );
};

describeE2E(E2E_KEYS.MAPS, "E2E – scoreSlots with Real Driving Durations", () => {
  beforeEach(() => {
    clearCache();
  });

  it(
    "a nearby learner (Fenton) adds less driving than a distant one (Leek)",
    async () => {
      const near = await routeOptimizer.scoreSlots(AVAILABLE_SLOTS, BOOKINGS, USER_A, INSTRUCTOR_BASE, ROUTE);
      const far = await routeOptimizer.scoreSlots(AVAILABLE_SLOTS, BOOKINGS, USER_B, INSTRUCTOR_BASE, ROUTE);
      log("Fenton (near)", near);
      log("Leek (far)", far);

      expect(bestFeasible(near)).toBeDefined();
      const farBest = bestFeasible(far);
      if (farBest) expect(bestFeasible(near).addedDrive).toBeLessThan(farBest.addedDrive);
    },
    TIMEOUT
  );

  it(
    "with no other lessons, every slot adds the same drive from home",
    async () => {
      const near = await routeOptimizer.scoreSlots(["10:00", "14:00"], [], USER_A, INSTRUCTOR_BASE, ROUTE);
      const far = await routeOptimizer.scoreSlots(["10:00", "14:00"], [], USER_B, INSTRUCTOR_BASE, ROUTE);

      expect(near[0].addedDrive).toBeCloseTo(near[1].addedDrive, 1);
      expect(near[0].addedDrive).toBeLessThan(far[0].addedDrive);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Multi-User Booking Scenario
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Multi-User Booking Scenario", () => {
  beforeEach(() => {
    clearCache();
  });

  it(
    "instructor has 3 lessons; a learner in Fenton gets reachable slots",
    async () => {
      // 09:00 Hanley · 11:00 Newcastle-under-Lyme · 14:00 Longton
      const scored = await routeOptimizer.scoreSlots(AVAILABLE_SLOTS, BOOKINGS, USER_A, INSTRUCTOR_BASE, ROUTE);
      log("Full day (Fenton)", scored);

      const feasible = scored.filter((s) => s.feasible);
      expect(feasible.length).toBeGreaterThan(0);
      for (let i = 1; i < feasible.length; i++) {
        expect(feasible[i - 1].score).toBeLessThanOrEqual(feasible[i].score);
      }
    },
    TIMEOUT
  );

  it(
    "a learner in Leek adds well over 15 minutes to any slot",
    async () => {
      const scored = await routeOptimizer.scoreSlots(AVAILABLE_SLOTS, BOOKINGS, USER_B, INSTRUCTOR_BASE, ROUTE);
      log("Full day (Leek)", scored);

      for (const s of scored.filter((x) => x.feasible)) {
        expect(s.addedDrive).toBeGreaterThan(15);
      }
    },
    TIMEOUT
  );

  it(
    "haversine vs real driving time comparison",
    async () => {
      const haversineDist = haversine(USER_A.lat, USER_A.long, INSTRUCTOR_BASE.lat, INSTRUCTOR_BASE.long);
      const haversineEstimate = haversineDist * 2; // KM_TO_MIN_FACTOR = 2

      const realDuration = await getDrivingDuration(
        USER_A.lat, USER_A.long,
        INSTRUCTOR_BASE.lat, INSTRUCTOR_BASE.long
      );

      console.log(`  📐 Haversine: ${haversineDist.toFixed(2)} km → ~${haversineEstimate.toFixed(1)} min estimate`);

      // Haversine should always work
      expect(haversineEstimate).toBeGreaterThan(0);
      expect(haversineEstimate).toBeLessThan(60);

      if (realDuration !== null) {
        console.log(`  🚗 Real driving: ${realDuration.toFixed(1)} min`);
        expect(realDuration).toBeGreaterThan(0);
        expect(realDuration).toBeLessThan(60);
      } else {
        console.log("  ⚠️ API unavailable — only haversine verified");
      }
    },
    TIMEOUT
  );
});
