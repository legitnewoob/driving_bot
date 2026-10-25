/**
 * Smart day packing – real-world E2E (real Google Routes API)
 * ─────────────────────────────────────────────────────────────────────────────
 * Only the database and Google Calendar are faked. Real drive times between
 * Stoke-on-Trent places decide how soon after a lesson a learner can start.
 *
 *   Next door (same address) → 5 minutes after the last lesson
 *   Close (Hanley ↔ Fenton)  → the real drive + 5, well under X
 *   Far (Hanley ↔ Leek)      → over X, so not offered next to that lesson
 *
 * Requires GOOGLE_MAPS_API_KEY in envs/.env.test
 * Run:  npm run test:e2e -- packedDayRealWorld
 */

const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 45000;

const { getDrivingMatrix, clearCache } = require("../../src/services/distanceMatrixService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const calendarService = require("../../src/services/calendarService");
const timezoneUtils = require("../../src/utils/timezoneUtils");
const Booking = require("../../src/models/bookingModel");

const P = {
  base: { lat: 53.0168, lng: -2.2191 },
  hanley: { lat: 53.0254, lng: -2.1768 },
  fenton: { lat: 53.0062, lng: -2.1641 },
  leek: { lat: 53.1065, lng: -1.9835 },
};
const loc = (p) => ({ lat: p.lat, long: p.lng });
const dbLoc = (p) => ({ latitude: p.lat, longitude: p.lng });

function nextWednesday() {
  const today = timezoneUtils.getCurrentDateString();
  for (let i = 7; i < 14; i++) {
    const d = timezoneUtils.addDays(today, i);
    if (timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "d") === "3") return d;
  }
  return timezoneUtils.addDays(today, 7);
}
const DAY = nextWednesday();
const HOURS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { start: "08:00", end: "18:00" }]));

const instructor = (X = 20) => ({
  phoneNumberId: "e2e-packed-real",
  name: "Sam",
  active: true,
  baseLocation: dbLoc(P.base),
  botSettings: { scheduleMode: "packed", dayHours: HOURS, lunch: { enabled: false } },
  routeSettings: { bufferMin: X, driveVarianceMin: 5 },
});
const lesson = (time, place) => ({
  bookingId: `DL-${time.replace(":", "")}`,
  time,
  date: DAY,
  status: "confirmed",
  instructorId: "e2e-packed-real",
  durationMin: 60,
  pickupLocation: dbLoc(place),
  dropoffLocation: dbLoc(place),
});
const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

async function plan(inst, learner, lessons) {
  Booking.find.mockResolvedValue(lessons);
  return routeOptimizer.planDay({ date: DAY, instructor: inst, availableSlots: null, userLoc: loc(learner), durationMin: 60 });
}

describeE2E(E2E_KEYS.MAPS, "E2E – Smart day packing with real drive times", () => {
  let drive;

  beforeAll(async () => {
    clearCache();
    const departure = timezoneUtils.createDateInTimezone(DAY, "08:00"); // the optimiser asks for the start of the day
    const [[toFenton, toLeek]] = await getDrivingMatrix([P.hanley], [P.fenton, P.leek], departure);
    drive = { toFenton, toLeek };
    console.log(`Real drives from Hanley: Fenton ${toFenton} min, Leek ${toLeek} min`);
  }, TIMEOUT);

  beforeEach(() => {
    jest.spyOn(Booking, "find").mockResolvedValue([]);
    jest.spyOn(Booking, "countDocuments").mockResolvedValue(0);
    jest.spyOn(calendarService, "getBusyBlocks").mockResolvedValue([]);
  });
  afterEach(() => jest.restoreAllMocks());

  it("the Routes API gives drive times that make sense", () => {
    expect(drive.toFenton).toBeGreaterThan(0);
    expect(drive.toFenton).toBeLessThan(15);
    expect(drive.toLeek).toBeGreaterThan(drive.toFenton);
  });

  it("a learner at the same address starts 5 minutes after the last lesson", async () => {
    const day = await plan(instructor(), P.hanley, [lesson("09:00", P.hanley)]);
    expect(day.free).toContain("10:05");
  }, TIMEOUT);

  it("a close learner starts after the real drive + 5, sooner than X", async () => {
    const day = await plan(instructor(30), P.fenton, [lesson("09:00", P.hanley)]);
    const first = day.free.filter((t) => t >= "10:00").map(toMin)[0];
    const need = Math.ceil((drive.toFenton + 5) / 5) * 5;
    expect(first - toMin("10:00")).toBe(need);
    expect(need).toBeLessThan(30);
  }, TIMEOUT);

  it("a learner too far to reach within X isn't offered next to that lesson", async () => {
    const X = Math.max(12, Math.floor(drive.toLeek)); // drive + 5 is always over this X
    const day = await plan(instructor(X), P.leek, [lesson("12:00", P.hanley)]);
    expect(day.free).toEqual([]);
  }, TIMEOUT);

  it("the same far learner is offered when X allows the drive", async () => {
    const X = Math.min(45, Math.ceil(drive.toLeek + 5) + 2); // a little slack for traffic changes between calls
    if (drive.toLeek + 5 > 45) return; // can't be allowed within the slider's range
    const day = await plan(instructor(X), P.leek, [lesson("12:00", P.hanley)]);
    expect(day.free.length).toBeGreaterThan(0);
    expect(await routeOptimizer.isPackedStartAvailable({ date: DAY, time: day.free[0], instructor: instructor(X), durationMin: 60, userLoc: loc(P.leek) })).toBe(true);
  }, TIMEOUT);
});
