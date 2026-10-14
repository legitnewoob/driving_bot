/**
 * Route optimiser – real-world E2E tests (real Google Geocoding + Routes APIs)
 * ─────────────────────────────────────────────────────────────────────────────
 * Only the database and Google Calendar are faked (instructor/lessons are given
 * in each test; free times come from the instructor's working hours).
 *
 *  1. Real drive-time matrix: completeness, symmetry, plausibility, traffic, cache
 *  2. Donna Settings on real addresses: presets, home legs, lateness, service area, priority
 *  3. Dashboard "Try it" preview (POST /api/dashboard/route-preview) end to end
 *  4. Bot availability from a typed pickup address
 *  5. Does it save driving? Optimised vs first-free-slot booking over a day
 *
 * Places (Stoke-on-Trent area). Straight-line distance from Stoke centre:
 *   Hanley ~3 km · Newcastle ~1 km · Longton ~7 km · Fenton ~4 km
 *   Burslem ~3 km · Kidsgrove ~8 km · Leek ~19 km (≈11.6 miles)
 *
 * Requires GOOGLE_MAPS_API_KEY in envs/.env.test
 * Run:  npm run test:e2e -- routeOptimizerRealWorld
 */

const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 45000;

const { getDrivingMatrix, clearCache } = require("../../src/services/distanceMatrixService");
const { getCoordinatesFromPostalCode } = require("../../src/services/mapsService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const settings = require("../../src/services/instructorSettings");
const calendarService = require("../../src/services/calendarService");
const haversine = require("../../src/utils/haversine");
const timezoneUtils = require("../../src/utils/timezoneUtils");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const Instructor = require("../../src/models/instructorSchema");

const P = {
  base: { lat: 53.0168, lng: -2.2191 },      // Stoke centre (instructor's home)
  hanley: { lat: 53.0254, lng: -2.1768 },
  newcastle: { lat: 53.0109, lng: -2.2276 },
  longton: { lat: 52.9874, lng: -2.1318 },
  fenton: { lat: 53.0062, lng: -2.1641 },
  burslem: { lat: 53.0444, lng: -2.1952 },
  kidsgrove: { lat: 53.0864, lng: -2.2378 },
  leek: { lat: 53.1065, lng: -1.9835 },
};
const loc = (p) => ({ lat: p.lat, long: p.lng });
const dbLoc = (p) => ({ latitude: p.lat, longitude: p.lng });

// Next week's Wednesday, so traffic-aware routing gets a future departure time
function nextWednesday() {
  const today = timezoneUtils.getCurrentDateString();
  for (let i = 7; i < 14; i++) {
    const d = timezoneUtils.addDays(today, i);
    if (timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "d") === "3") return d;
  }
  return timezoneUtils.addDays(today, 7);
}
const DAY = nextWednesday();
const HOURS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
const WEEKDAYS = { mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: [], sun: [] };

function instructor({ route = {}, bot = {}, home = P.base } = {}) {
  return {
    phoneNumberId: "e2e-route-real",
    name: "Sam",
    email: "sam@e2e.test",
    active: true,
    ...(home ? { baseLocation: dbLoc(home) } : {}),
    routeSettings: route,
    botSettings: { workingHours: WEEKDAYS, ...bot },
  };
}
const lesson = (time, place) => ({ time, date: DAY, status: "confirmed", instructorId: "e2e-route-real", location: dbLoc(place) });

async function plan(inst, learner, lessons = [], extra = {}) {
  Booking.find.mockResolvedValue(lessons);
  return routeOptimizer.planDay({
    date: DAY, instructor: inst, availableSlots: settings.timesForDate(inst, DAY), userLoc: loc(learner), ...extra,
  });
}

function fakeDatabaseAndCalendar() {
  jest.spyOn(Booking, "find").mockResolvedValue([]);
  jest.spyOn(Booking, "countDocuments").mockResolvedValue(0);
  // Free times = the instructor's working hours (empty Google Calendar)
  jest.spyOn(calendarService, "getAvailableTimeSlotsForDate").mockImplementation(async (date, inst) => settings.timesForDate(inst, date));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Real drive-time matrix
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Real drive-time matrix", () => {
  const towns = [P.base, P.hanley, P.newcastle, P.longton, P.burslem, P.kidsgrove];
  let matrix;

  beforeAll(async () => {
    clearCache();
    matrix = await getDrivingMatrix(towns, towns);
  }, TIMEOUT);

  it("returns a drive time for every pair of towns", () => {
    towns.forEach((_, i) => towns.forEach((__, j) => {
      if (i !== j) expect(typeof matrix[i][j]).toBe("number");
    }));
  });

  it("driving there and back take roughly the same time", () => {
    towns.forEach((_, i) => towns.forEach((__, j) => {
      if (i >= j) return;
      const there = matrix[i][j];
      const back = matrix[j][i];
      expect(Math.abs(there - back)).toBeLessThanOrEqual(Math.max(5, 0.6 * Math.max(there, back)));
    }));
  });

  it("times are physically plausible for the distance", () => {
    towns.forEach((a, i) => towns.forEach((b, j) => {
      if (i === j) return;
      const km = haversine(a.lat, a.lng, b.lat, b.lng);
      expect(matrix[i][j]).toBeGreaterThanOrEqual(km * 0.5);  // no faster than ~120 km/h
      expect(matrix[i][j]).toBeLessThanOrEqual(km * 6 + 15);  // no slower than a crawl
    }));
  });

  it(
    "traffic-aware: rush hour isn't quicker than late evening",
    async () => {
      const rush = timezoneUtils.createDateInTimezone(DAY, "08:15");
      const night = timezoneUtils.createDateInTimezone(DAY, "22:30");
      clearCache();
      const [[atRush]] = await getDrivingMatrix([P.longton], [P.kidsgrove], rush);
      const [[atNight]] = await getDrivingMatrix([P.longton], [P.kidsgrove], night);
      console.log(`  🚦 Longton → Kidsgrove: ${atRush?.toFixed(1)} min at 08:15, ${atNight?.toFixed(1)} min at 22:30`);
      expect(atRush).toBeGreaterThan(0);
      expect(atNight).toBeGreaterThan(0);
      expect(atRush).toBeGreaterThanOrEqual(atNight * 0.9);
    },
    TIMEOUT
  );

  it(
    "asking for the same journeys again is served from the cache",
    async () => {
      // (earlier tests clear the cache) — fill it, then ask again
      const first = await getDrivingMatrix(towns, towns);
      const started = Date.now();
      const again = await getDrivingMatrix(towns, towns);
      expect(Date.now() - started).toBeLessThan(50);
      expect(again).toEqual(first);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Donna Settings on real addresses
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Donna Settings on real addresses", () => {
  beforeEach(fakeDatabaseAndCalendar);
  afterEach(() => jest.restoreAllMocks());

  const DAY_LESSONS = () => [lesson("09:00", P.hanley), lesson("13:00", P.newcastle)];

  it.each([["Burslem", P.burslem], ["Leek", P.leek]])(
    "%s: tighter presets never offer more times than looser ones",
    async (_name, learner) => {
      const order = ["off", "relaxed", "balanced", "tight"];
      const days = {};
      for (const preset of order) days[preset] = await plan(instructor({ route: { preset } }), learner, DAY_LESSONS());
      console.log(`  🎚️ ${_name}:`, Object.fromEntries(order.map((p) => [p, days[p].offered.join(" ")])));

      for (let i = 1; i < order.length; i++) {
        const looser = days[order[i - 1]];
        const tighter = days[order[i]];
        if (tighter.usedFallback) {
          // Nothing within the tighter limit: it offers only the few best reachable times
          expect(tighter.offered.length).toBeLessThanOrEqual(3);
        } else {
          expect(tighter.offered.every((t) => looser.offered.includes(t))).toBe(true);
        }
      }
    },
    TIMEOUT
  );

  it(
    "counting the drive from home limits a far-from-home learner on an empty day",
    async () => {
      const ignored = await plan(instructor({ route: { preset: "tight", homeLegWeight: "off" } }), P.leek);
      const counted = await plan(instructor({ route: { preset: "tight", homeLegWeight: "full" } }), P.leek);
      expect(ignored.offered).toEqual(HOURS);
      expect(counted.offered.length).toBeLessThanOrEqual(3);
    },
    TIMEOUT
  );

  it(
    "allowed lateness decides whether a real back-to-back drive works",
    async () => {
      // Longton → Fenton is a short real drive (well under 30 min) but not zero
      const strict = await plan(instructor({ route: { preset: "custom", travelGraceMin: 0, maxAddedDriveMin: 60 } }), P.fenton, [lesson("09:00", P.longton)]);
      const lenient = await plan(instructor({ route: { preset: "custom", travelGraceMin: 30, maxAddedDriveMin: 60 } }), P.fenton, [lesson("09:00", P.longton)]);
      const at10 = (day) => day.evaluations.find((e) => e.slot === "10:00");
      console.log(`  ⏱️ 10:00 in Fenton after a Longton lesson: ${at10(strict).reason}`);
      expect(at10(strict).feasible).toBe(false);
      expect(at10(lenient).feasible).toBe(true);
    },
    TIMEOUT
  );

  it.each([
    [{ radius: 10, unit: "miles" }, false],
    [{ radius: 15, unit: "miles" }, true],
    [{ radius: 15, unit: "km" }, false],
    [{ radius: 25, unit: "km" }, true],
  ])("service area %j for a Leek learner → inside: %s", (serviceArea, inside) => {
    const result = routeOptimizer.checkServiceArea(instructor({ route: { serviceArea } }), loc(P.leek));
    expect(result.inside).toBe(inside);
    if (!inside) expect(result.reason).toMatch(new RegExp(`${serviceArea.unit} away`));
  });

  it(
    "priority learners get more options than normal ones under 'tight'",
    async () => {
      const normal = await plan(instructor({ route: { preset: "tight" } }), P.leek, DAY_LESSONS());
      const priority = await plan(instructor({ route: { preset: "tight" } }), P.leek, DAY_LESSONS(), { prefs: { priority: true } });
      expect(priority.offered.length).toBeGreaterThan(normal.offered.length);
      const unreachable = priority.evaluations.filter((e) => !e.feasible).map((e) => e.slot);
      expect(priority.offered.some((s) => unreachable.includes(s))).toBe(false);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Dashboard "Try it" preview, end to end
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Settings preview (POST /route-preview)", () => {
  const express = require("express");
  let server;
  let url;
  let current;

  beforeAll((done) => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || "e2e-secret";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { email: "sam@e2e.test" }; next(); });
    app.use("/api/dashboard", require("../../src/routes/dashboard"));
    server = app.listen(0, () => {
      url = `http://127.0.0.1:${server.address().port}/api/dashboard/route-preview`;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    fakeDatabaseAndCalendar();
    current = instructor();
    jest.spyOn(Instructor, "findOne").mockImplementation(() => ({ lean: async () => current }));
    Booking.find.mockResolvedValue([lesson("09:00", P.hanley), lesson("13:00", P.newcastle)]);
  });
  afterEach(() => jest.restoreAllMocks());

  const preview = (body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ date: DAY, ...body }) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

  it(
    "geocodes a real place and returns real drive minutes per time",
    async () => {
      const { status, body } = await preview({ address: "Fenton, Stoke-on-Trent" });
      expect(status).toBe(200);
      expect(body.data.location).toMatch(/Stoke|Fenton/i);
      const feasible = body.data.slots.filter((s) => s.feasible);
      expect(feasible.length).toBeGreaterThan(0);
      feasible.forEach((s) => expect(typeof s.addedDriveMin).toBe("number"));
      // only reachable times are offered, in time order
      expect(body.data.offered.every((t) => feasible.some((s) => s.slot === t))).toBe(true);
      expect([...body.data.offered]).toEqual([...body.data.offered].sort());
    },
    TIMEOUT
  );

  it(
    "unsaved settings change the answer (Off vs Tight for a far learner)",
    async () => {
      const off = await preview({ address: "Leek, Staffordshire", routeSettings: { preset: "off" } });
      const tight = await preview({ address: "Leek, Staffordshire", routeSettings: { preset: "tight" } });
      expect(off.body.data.offered.length).toBeGreaterThan(tight.body.data.offered.length);
    },
    TIMEOUT
  );

  it(
    "a draft service area in km flags a learner outside it",
    async () => {
      const { body } = await preview({ address: "Leek, Staffordshire", routeSettings: { serviceArea: { radius: 10, unit: "km" } } });
      expect(body.data.serviceArea.inside).toBe(false);
      expect(body.data.serviceArea.reason).toMatch(/km away/);
    },
    TIMEOUT
  );

  it(
    "an address that doesn't exist is rejected clearly",
    async () => {
      const { status, body } = await preview({ address: "qwzx nowhere 99999 zzzz" });
      expect([400, 503]).toContain(status);
      expect(body.success).toBe(false);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Bot availability from a typed pickup address
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Bot availability from a typed pickup", () => {
  const aiService = require("../../src/services/gemini/aiService");
  const PHONE = "447000000099";

  beforeEach(() => {
    fakeDatabaseAndCalendar();
    jest.spyOn(User, "findOne").mockResolvedValue({ phone: PHONE, location: {}, schedulingPrefs: {} });
    Booking.find.mockResolvedValue([lesson("09:00", P.hanley), lesson("13:00", P.newcastle)]);
    delete aiService.pendingContext[PHONE];
  });
  afterEach(() => jest.restoreAllMocks());

  it(
    "geocodes the pickup the learner typed and plans the day around it",
    async () => {
      aiService.pendingContext[PHONE] = { pickupAddress: "Burslem, Stoke-on-Trent" };
      const info = await aiService.getAvailabilityInfo(DAY, "10:00", instructor(), PHONE);
      expect(aiService.pendingContext[PHONE].pickupCoords.lat).toBeCloseTo(P.burslem.lat, 1);
      expect(info.availableSlotsForDate.length).toBeGreaterThan(0);
      expect(info.availableSlotsForDate).not.toContain("09:00"); // booked
    },
    TIMEOUT
  );

  it(
    "a far pickup gets only the best few times under 'tight'",
    async () => {
      aiService.pendingContext[PHONE] = { pickupAddress: "Leek, Staffordshire" };
      const info = await aiService.getAvailabilityInfo(DAY, null, instructor({ route: { preset: "tight" } }), PHONE);
      expect(info.availableSlotsForDate.length).toBeLessThanOrEqual(3);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Does it save driving?
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E – Optimised vs first-free-slot booking", () => {
  beforeEach(fakeDatabaseAndCalendar);
  afterEach(() => jest.restoreAllMocks());

  // Total real driving for a day: home → each lesson in time order → home
  async function dayDriving(lessons) {
    const stops = [P.base, ...[...lessons].sort((a, b) => a.time.localeCompare(b.time)).map((l) => l.place), P.base];
    const matrix = await getDrivingMatrix(stops, stops);
    let total = 0;
    for (let i = 0; i < stops.length - 1; i++) total += matrix[i][i + 1] ?? 0;
    return total;
  }

  async function bookDay(chooser) {
    const inst = instructor({ route: { preset: "balanced", homeLegWeight: "full" } });
    const booked = [{ time: "09:00", place: P.hanley }, { time: "14:00", place: P.longton }];
    for (const learner of [P.longton, P.hanley, P.kidsgrove, P.fenton]) {
      const day = await plan(inst, learner, booked.map((b) => lesson(b.time, b.place)));
      const time = chooser(day);
      if (time) booked.push({ time, place: learner });
    }
    return booked;
  }

  it(
    "booking the best route fit drives no more than taking the first free time",
    async () => {
      const optimised = await bookDay((day) => day.evaluations.find((e) => e.feasible && day.offered.includes(e.slot))?.slot);
      const naive = await bookDay((day) => day.evaluations.filter((e) => e.feasible).map((e) => e.slot).sort()[0]);

      const optimisedMin = await dayDriving(optimised);
      const naiveMin = await dayDriving(naive);
      console.log(`  🚗 Day's driving — optimised: ${optimisedMin.toFixed(0)} min, first-free: ${naiveMin.toFixed(0)} min`);
      console.log("     optimised:", optimised.map((b) => b.time).sort().join(", "));
      console.log("     first-free:", naive.map((b) => b.time).sort().join(", "));

      expect(optimised.length).toBeGreaterThanOrEqual(naive.length - 1); // doesn't sacrifice bookings
      expect(optimisedMin).toBeLessThanOrEqual(naiveMin + 2);
    },
    TIMEOUT * 2
  );
});
