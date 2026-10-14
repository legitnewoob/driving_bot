/**
 * Route optimiser – crowded-day stress tests (real Google Routes API)
 * ─────────────────────────────────────────────────────────────────────────────
 * Every scenario starts from a day that already has several learners booked
 * across real Stoke-on-Trent area towns. Every time the optimiser offers is
 * then re-checked independently against real drive times: the instructor must
 * be able to get from the previous lesson to the new learner, and on to the
 * next lesson, within the allowed lateness.
 *
 *  1. Every other hour booked: only learners near both neighbours fit
 *  2. Packed 45-minute lessons with 15-minute gaps
 *  3. Filling a day one learner at a time (optimised vs first free slot)
 *  4. Clustering: a second learner from the same town goes next to the first
 *  5. A cancellation on a crowded day opens up options
 *  6. A crowded week: full days skipped, a day with a nearby lesson preferred
 *  7. Stress: 10 lessons across 10 towns, 07:00–20:00
 *
 * Only the database and Google Calendar's event list are faked.
 * Requires GOOGLE_MAPS_API_KEY in envs/.env.test
 * Run:  npm run test:e2e -- routeCrowded
 */

const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 60000;

const { calendar } = require("../../src/config/google");
const { getDrivingMatrix, clearCache } = require("../../src/services/distanceMatrixService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const settings = require("../../src/services/instructorSettings");
const timezoneUtils = require("../../src/utils/timezoneUtils");
const Booking = require("../../src/models/bookingModel");

// ── Real places ──────────────────────────────────────────────────────────────
const T = {
  base: { lat: 53.0168, lng: -2.2191 },       // Stoke centre (instructor's home)
  hanley: { lat: 53.0254, lng: -2.1768 },
  newcastle: { lat: 53.0109, lng: -2.2276 },
  longton: { lat: 52.9874, lng: -2.1318 },
  fenton: { lat: 53.0062, lng: -2.1641 },
  burslem: { lat: 53.0444, lng: -2.1952 },
  tunstall: { lat: 53.0606, lng: -2.2114 },
  kidsgrove: { lat: 53.0864, lng: -2.2378 },
  meir: { lat: 52.9750, lng: -2.1050 },
  trentham: { lat: 52.9667, lng: -2.1987 },
  stone: { lat: 52.9033, lng: -2.1468 },
  werrington: { lat: 53.0186, lng: -2.1048 },
  biddulph: { lat: 53.1170, lng: -2.1750 },
  leek: { lat: 53.1065, lng: -1.9835 },
  leekEast: { lat: 53.1050, lng: -2.0150 },   // another Leek address
  hanleyStreet: { lat: 53.0262, lng: -2.1785 }, // a street away from Hanley
};
const db = (p) => ({ latitude: p.lat, longitude: p.lng });
const loc = (p) => ({ lat: p.lat, long: p.lng });

// ── Dates (next week, so traffic-aware routing uses future departures) ───────
const TODAY = timezoneUtils.getCurrentDateString();
const isWeekday = (d) => !["0", "6"].includes(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "d"));
const DAY = (() => {
  for (let i = 7; i < 14; i++) {
    const d = timezoneUtils.addDays(TODAY, i);
    if (timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "d") === "3") return d;
  }
  return timezoneUtils.addDays(TODAY, 7);
})();

const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => `${String(from + i).padStart(2, "0")}:00`);
const HOURS = hours(8, 17);

function instructor({ route = {}, bot = {}, workingHours = HOURS } = {}) {
  const wh = { mon: workingHours, tue: workingHours, wed: workingHours, thu: workingHours, fri: workingHours, sat: [], sun: [] };
  return {
    phoneNumberId: "e2e-crowded",
    name: "Sam",
    baseLocation: db(T.base),
    routeSettings: { preset: "balanced", ...route },
    botSettings: { workingHours: wh, ...bot },
  };
}

// lessons: [["08:00", T.hanley], ...]
const toBookings = (lessons, date = DAY) =>
  lessons.map(([time, place]) => ({ time, date, status: "confirmed", instructorId: "e2e-crowded", location: db(place) }));

let bookingsByDate;
function setUp() {
  clearCache();
  bookingsByDate = {};
  jest.spyOn(calendar.events, "list").mockResolvedValue({ data: { items: [] } });
  jest.spyOn(Booking, "find").mockImplementation(async ({ date }) => bookingsByDate[date] || []);
  jest.spyOn(Booking, "countDocuments").mockResolvedValue(0);
}

async function planFor(inst, lessons, learner, date = DAY) {
  bookingsByDate[date] = toBookings(lessons, date);
  return routeOptimizer.planDay({
    date, instructor: inst, availableSlots: settings.timesForDate(inst, date), userLoc: loc(learner),
  });
}

const minutes = (t) => routeOptimizer.timeToMinutes(t);

// Independent checks fetch one journey at a time (traffic-aware), while the
// optimiser may have fetched a big matrix without traffic; allow for that.
const NOISE_MIN = 2;

// Real drive time a → b, using the same departure hour the optimiser used
async function drive(a, b, departure) {
  const [[m]] = await getDrivingMatrix([a], [b], departure);
  return m;
}

/**
 * Re-checks one offered time against real drive times: the instructor must make
 * it from the previous lesson and on to the next one within the allowed lateness.
 */
async function assertReachable(inst, lessons, learner, slot) {
  const route = settings.resolveRouteSettings(inst);
  const dur = route.lessonDurationMin;
  const grace = route.travelGraceMin;
  const departure = timezoneUtils.createDateInTimezone(DAY, settings.timesForDate(inst, DAY)[0]);
  const s = minutes(slot);
  const sorted = [...lessons].sort((a, b) => minutes(a[0]) - minutes(b[0]));
  const prev = [...sorted].reverse().find(([t]) => minutes(t) + dur <= s);
  const next = sorted.find(([t]) => minutes(t) >= s + dur);

  for (const [t] of sorted) {
    const overlap = s < minutes(t) + dur && s + dur > minutes(t);
    if (overlap) throw new Error(`${slot} overlaps the ${t} lesson`);
  }
  if (prev) {
    const d = await drive(prev[1], learner, departure);
    const allowed = s - (minutes(prev[0]) + dur) + grace;
    if (d > allowed + NOISE_MIN) throw new Error(`${slot}: ${d.toFixed(1)} min from the ${prev[0]} lesson, only ${allowed} allowed`);
  }
  if (next) {
    const d = await drive(learner, next[1], departure);
    const allowed = minutes(next[0]) - (s + dur) + grace;
    if (d > allowed + NOISE_MIN) throw new Error(`${slot}: ${d.toFixed(1)} min to the ${next[0]} lesson, only ${allowed} allowed`);
  }
}

async function assertAllReachable(inst, lessons, learner, offered) {
  for (const slot of offered) await assertReachable(inst, lessons, learner, slot);
}

const show = (label, day) =>
  console.log(`  ${label}: [${day.offered.join(", ")}]${day.usedFallback ? " (best few — none within the drive limit)" : ""}`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Every other hour booked
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – every other hour booked", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  // 60-minute lessons with a free hour between: a new learner sits exactly
  // between two lessons, so both drives must fit in the 10-minute allowance.
  const DAY_LESSONS = [
    ["08:00", T.hanley], ["10:00", T.fenton], ["12:00", T.longton], ["14:00", T.newcastle], ["16:00", T.burslem],
  ];

  it.each([
    ["a learner a street from Hanley", T.hanleyStreet],
    ["a learner in Fenton", T.fenton],
    ["a learner in Tunstall", T.tunstall],
    ["a learner in Stone", T.stone],
    ["a learner in Leek", T.leek],
  ])("%s is only offered times the instructor can really reach", async (label, learner) => {
    const inst = instructor();
    const day = await planFor(inst, DAY_LESSONS, learner);
    show(label, day);
    ["08:00", "10:00", "12:00", "14:00", "16:00"].forEach((t) => expect(day.offered).not.toContain(t));
    await assertAllReachable(inst, DAY_LESSONS, learner, day.offered);
  }, TIMEOUT);

  it("learners near the booked towns get more of the gaps than learners far away", async () => {
    const inst = instructor();
    const near = await planFor(inst, DAY_LESSONS, T.hanleyStreet);
    const far = await planFor(inst, DAY_LESSONS, T.leek);
    expect(near.offered.length).toBeGreaterThanOrEqual(far.offered.length);
    // The far learner can't fit between two lessons, so anything offered is after the last one
    far.offered.forEach((t) => expect(minutes(t)).toBeGreaterThanOrEqual(minutes("17:00")));
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Packed 45-minute lessons
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – packed 45-minute lessons", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  // 45-minute lessons on the hour leave 15 min + 10 min lateness = 25 min per gap
  const inst = () => instructor({ route: { lessonDurationMin: 45 } });
  const DAY_LESSONS = [
    ["08:00", T.tunstall], ["09:00", T.burslem], ["10:00", T.hanley],
    ["12:00", T.fenton], ["13:00", T.longton], ["15:00", T.trentham], ["16:00", T.newcastle],
  ];

  it.each([
    ["Hanley", T.hanleyStreet],
    ["Meir", T.meir],
    ["Kidsgrove", T.kidsgrove],
    ["Biddulph", T.biddulph],
  ])("a learner in %s: offered times are only the open gaps, all reachable", async (label, learner) => {
    const day = await planFor(inst(), DAY_LESSONS, learner);
    show(label, day);
    day.offered.forEach((t) => expect(["11:00", "14:00", "17:00"]).toContain(t));
    await assertAllReachable(inst(), DAY_LESSONS, learner, day.offered);
  }, TIMEOUT);

  it("11:00 (between Hanley and Fenton lessons) suits a Hanley learner better than a Biddulph one", async () => {
    const hanley = await planFor(inst(), DAY_LESSONS, T.hanleyStreet);
    const biddulph = await planFor(inst(), DAY_LESSONS, T.biddulph);
    const at11 = (day) => day.evaluations.find((e) => e.slot === "11:00");
    expect(at11(hanley).feasible).toBe(true);
    if (at11(biddulph).feasible) expect(at11(hanley).addedDrive).toBeLessThan(at11(biddulph).addedDrive);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Filling a day one learner at a time
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – filling a day one learner at a time", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  const START = [["09:00", T.hanley], ["13:00", T.longton], ["16:00", T.kidsgrove]];
  const ARRIVALS = [T.fenton, T.tunstall, T.meir, T.newcastle, T.burslem, T.trentham, T.werrington, T.biddulph];

  // Every pair of back-to-back lessons must be drivable within the allowance
  async function assertDayDrivable(inst, lessons) {
    const route = settings.resolveRouteSettings(inst);
    const departure = timezoneUtils.createDateInTimezone(DAY, settings.timesForDate(inst, DAY)[0]);
    const sorted = [...lessons].sort((a, b) => minutes(a[0]) - minutes(b[0]));
    for (let i = 0; i < sorted.length - 1; i++) {
      const [t1, p1] = sorted[i];
      const [t2, p2] = sorted[i + 1];
      const gap = minutes(t2) - (minutes(t1) + route.lessonDurationMin);
      expect(gap).toBeGreaterThanOrEqual(0);
      const d = await drive(p1, p2, departure);
      if (d > gap + route.travelGraceMin + NOISE_MIN) {
        throw new Error(`${t1} → ${t2}: ${d.toFixed(1)} min drive, only ${gap + route.travelGraceMin} allowed`);
      }
    }
  }

  async function dayDriving(lessons) {
    const stops = [T.base, ...[...lessons].sort((a, b) => minutes(a[0]) - minutes(b[0])).map(([, p]) => p), T.base];
    const m = await getDrivingMatrix(stops, stops);
    return stops.slice(1).reduce((sum, _, i) => sum + (m[i][i + 1] ?? 0), 0);
  }

  async function fill(choose) {
    const inst = instructor();
    const lessons = [...START];
    const turnedAway = [];
    for (const learner of ARRIVALS) {
      const day = await planFor(inst, lessons, learner);
      const time = choose(day);
      if (time) {
        await assertReachable(inst, lessons, learner, time);
        lessons.push([time, learner]);
      } else {
        turnedAway.push(learner);
      }
      await assertDayDrivable(inst, lessons);
    }
    return { lessons, turnedAway };
  }

  it("every booking keeps the whole day drivable, and the optimiser doesn't drive more than first-free", async () => {
    const optimised = await fill((day) => day.evaluations.find((e) => e.feasible && day.offered.includes(e.slot))?.slot);
    const naive = await fill((day) => day.evaluations.filter((e) => e.feasible).map((e) => e.slot).sort()[0]);

    const optMin = await dayDriving(optimised.lessons);
    const naiveMin = await dayDriving(naive.lessons);
    const fmt = (r) => [...r.lessons].sort((a, b) => minutes(a[0]) - minutes(b[0])).map(([t]) => t).join(" ");
    console.log(`  🚗 Optimised:  ${optimised.lessons.length} lessons, ${optMin.toFixed(0)} min driving — ${fmt(optimised)}`);
    console.log(`  🚗 First-free: ${naive.lessons.length} lessons, ${naiveMin.toFixed(0)} min driving — ${fmt(naive)}`);

    expect(optimised.lessons.length).toBeGreaterThanOrEqual(naive.lessons.length - 1);
    const perLesson = (min, r) => min / r.lessons.length;
    expect(perLesson(optMin, optimised)).toBeLessThanOrEqual(perLesson(naiveMin, naive) + 2);
  }, TIMEOUT * 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Clustering
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – clustering learners from the same town", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  it("a second Leek learner is best placed right next to the first Leek lesson", async () => {
    const lessons = [["09:00", T.hanley], ["11:00", T.newcastle], ["14:00", T.leek]];
    const day = await planFor(instructor({ route: { preset: "relaxed" } }), lessons, T.leekEast);
    const best = day.evaluations.find((e) => e.feasible && day.offered.includes(e.slot));
    console.log(`  🧲 Second Leek learner — best: ${best?.slot} (${best?.reason})`);
    expect(["13:00", "15:00"]).toContain(best.slot);
  }, TIMEOUT);

  it("a learner a street from an existing lesson costs almost no extra driving next to it", async () => {
    const lessons = [["09:00", T.hanley], ["12:00", T.longton], ["15:00", T.kidsgrove]];
    const day = await planFor(instructor(), lessons, T.hanleyStreet);
    const at10 = day.evaluations.find((e) => e.slot === "10:00");
    expect(at10.feasible).toBe(true);
    expect(at10.travelIn).toBeLessThan(5);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Cancellation on a crowded day
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – a cancellation opens up options", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  it("removing a lesson frees its time (and its neighbours) for a nearby learner", async () => {
    const full = [["08:00", T.hanley], ["09:00", T.fenton], ["10:00", T.longton], ["11:00", T.meir], ["13:00", T.newcastle], ["15:00", T.tunstall]];
    const afterCancel = full.filter(([t]) => t !== "10:00");
    const before = await planFor(instructor(), full, T.longton);
    const after = await planFor(instructor(), afterCancel, T.longton);
    show("Before cancelling 10:00", before);
    show("After cancelling 10:00", after);
    expect(before.offered).not.toContain("10:00");
    expect(after.offered).toContain("10:00");
    await assertAllReachable(instructor(), afterCancel, T.longton, after.offered);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. A crowded week
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – a busy week of suggestions", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  it("skips full days and suggests the day with a lesson near the learner first", async () => {
    const inst = instructor({ bot: { maxLessonsPerDay: 3 }, route: { lookAheadDays: 5 } });
    const days = settings.upcomingBookableDates(inst, 5);
    const [full1, full2, nearby] = days;
    bookingsByDate[full1] = toBookings([["09:00", T.leek], ["12:00", T.stone], ["15:00", T.kidsgrove]], full1);
    bookingsByDate[full2] = toBookings([["09:00", T.meir], ["12:00", T.biddulph], ["15:00", T.trentham]], full2);
    bookingsByDate[nearby] = toBookings([["10:00", T.hanley]], nearby);

    const suggestions = await routeOptimizer.suggestBestDays(inst, { userLoc: loc(T.hanleyStreet), limit: 5 });
    console.log("  📅", suggestions.map((s) => `${s.date} ${s.time} (+${Math.round(s.addedDrive)} min)`).join(" · "));

    const dates = suggestions.map((s) => s.date);
    expect(dates).not.toContain(full1);
    expect(dates).not.toContain(full2);
    expect(suggestions[0].date).toBe(nearby);
    expect(["09:00", "11:00"]).toContain(suggestions[0].time);
  }, TIMEOUT * 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Stress: a long, busy day
// ═══════════════════════════════════════════════════════════════════════════

describeE2E(E2E_KEYS.MAPS, "E2E crowded – stress: 10 lessons across 10 towns", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  const LONG_DAY = hours(7, 20);
  const inst = () => instructor({ workingHours: LONG_DAY, route: { lessonDurationMin: 45 } });
  const LESSONS = [
    ["07:00", T.kidsgrove], ["08:00", T.tunstall], ["09:00", T.burslem], ["10:00", T.hanley],
    ["12:00", T.werrington], ["13:00", T.meir], ["15:00", T.longton], ["16:00", T.trentham],
    ["18:00", T.newcastle], ["19:00", T.base],
  ];

  it.each([["Fenton", T.fenton], ["Stone", T.stone], ["Biddulph", T.biddulph], ["Leek", T.leek]])(
    "%s: plans quickly with one real matrix, and every offer is reachable",
    async (label, learner) => {
      const started = Date.now();
      const day = await planFor(inst(), LESSONS, learner);
      const took = Date.now() - started;
      show(`${label} (${took} ms)`, day);
      expect(took).toBeLessThan(15000);
      day.offered.forEach((t) => expect(["11:00", "14:00", "17:00", "20:00"]).toContain(t));
      await assertAllReachable(inst(), LESSONS, learner, day.offered);
    },
    TIMEOUT
  );

  it("results are stable: planning the same busy day twice gives the same answer", async () => {
    const first = await planFor(inst(), LESSONS, T.fenton);
    const second = await planFor(inst(), LESSONS, T.fenton);
    expect(second.offered).toEqual(first.offered);
  }, TIMEOUT);
});
