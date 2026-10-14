/**
 * Donna Settings → route optimisation, E2E with real Google Maps
 * ─────────────────────────────────────────────────────────────────────────────
 * The same scenarios as tests/integration/routeSettingsPipeline.test.js, but with
 * REAL drive times (Routes API) and REAL geocoding, through the real pipeline:
 *
 *   instructor settings → calendarService (working hours, breaks, lesson length)
 *     → routeOptimizer (presets, limits, home legs, learner prefs, real drive times)
 *     → aiService.getAvailabilityInfo + generateSystemMessage (what Donna is told)
 *
 * Faked: the database (lessons/learners given per test) and Google Calendar's
 * event list (empty), so free times come purely from Donna Settings.
 *
 * Instructor lives in Stoke centre. Learners:
 *   NEAR  = Hanley area   (a few minutes away)
 *   MID   = Kidsgrove     (~15–20 min)
 *   FAR   = Leek          (~25–35 min, ≈11.6 miles / 18.7 km)
 *
 * Requires GOOGLE_MAPS_API_KEY in envs/.env.test
 * Run:  npm run test:e2e -- routeSettings
 */

const { describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 45000;

const { calendar } = require("../../src/config/google");
const { clearCache } = require("../../src/services/distanceMatrixService");
const aiService = require("../../src/services/gemini/aiService");
const timezoneUtils = require("../../src/utils/timezoneUtils");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");

const db = (lat, lng) => ({ latitude: lat, longitude: lng });
const BASE = db(53.0168, -2.2191);       // Stoke centre
const HANLEY = db(53.0254, -2.1768);
const NEWCASTLE = db(53.0109, -2.2276);
const LONGTON = db(52.9874, -2.1318);
const FENTON = db(53.0062, -2.1641);
const NEAR = db(53.0262, -2.1785);       // a street away from Hanley
const MID = db(53.0864, -2.2378);        // Kidsgrove
const FAR = db(53.1065, -1.9835);        // Leek

const PHONE = "447000000077";
const HOURS = ["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00"];
const WEEKDAYS = { mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: [], sun: [] };

const TODAY = timezoneUtils.getCurrentDateString();
const weekday = (d) => timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(d, "12:00"), "d");
// Next week's Wednesday: far enough for any notice setting, and a future departure for traffic
const DAY = (() => {
  for (let i = 7; i < 14; i++) {
    const d = timezoneUtils.addDays(TODAY, i);
    if (weekday(d) === "3") return d;
  }
  return timezoneUtils.addDays(TODAY, 7);
})();
const WED = Number(weekday(DAY)); // 3

let bookingsByDate;

function instructor({ route = {}, bot = {}, home = BASE } = {}) {
  return {
    phoneNumberId: "e2e-settings-instructor",
    name: "Sam",
    ...(home ? { baseLocation: home } : {}),
    routeSettings: route,
    botSettings: { workingHours: WEEKDAYS, ...bot },
  };
}

function learnerAt(location, schedulingPrefs = {}, extra = {}) {
  User.findOne.mockResolvedValue({ phone: PHONE, instructorId: "e2e-settings-instructor", location: location || {}, schedulingPrefs, ...extra });
}

function lessonAt(time, location, date = DAY) {
  (bookingsByDate[date] ||= []).push({ time, date, status: "confirmed", instructorId: "e2e-settings-instructor", location });
}

async function ask(inst, { date = DAY, time = null } = {}) {
  const info = await aiService.getAvailabilityInfo(date, time, inst, PHONE);
  const note = aiService.generateSystemMessage({ finalDate: date, finalTime: time }, info, inst);
  return { info, note, offered: info.availableSlotsForDate || [] };
}

function setUp() {
  clearCache();
  bookingsByDate = {};
  delete aiService.pendingContext[PHONE];
  jest.spyOn(calendar.events, "list").mockResolvedValue({ data: { items: [] } }); // empty Google Calendar
  jest.spyOn(Booking, "find").mockImplementation(async ({ date }) => bookingsByDate[date] || []);
  jest.spyOn(Booking, "countDocuments").mockResolvedValue(0);
  jest.spyOn(User, "findOne").mockResolvedValue(null);
}

// ═══════════════════════════════════════════════════════════════════════════
describeE2E(E2E_KEYS.MAPS, "E2E – Donna Settings: availability", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  it("working hours decide which start times exist", async () => {
    learnerAt(NEAR);
    const { offered } = await ask(instructor({ bot: { workingHours: { ...WEEKDAYS, wed: ["10:00", "14:00"] } } }));
    expect(offered).toEqual(["10:00", "14:00"]);
  }, TIMEOUT);

  it("a day off is reported as not a working day", async () => {
    learnerAt(NEAR);
    const { note } = await ask(instructor({ bot: { workingHours: { ...WEEKDAYS, wed: [] } } }));
    expect(note).toMatch(/isn't one of Sam's working days/);
  }, TIMEOUT);

  it("breaks remove times whose lesson would run into them", async () => {
    learnerAt(NEAR);
    const { offered } = await ask(instructor({ bot: { breaks: [{ from: "12:00", to: "13:00" }] } }));
    expect(offered).not.toContain("12:00");
    expect(offered).toContain("11:00");
  }, TIMEOUT);

  it("with 2-hour lessons the same break also rules out 11:00", async () => {
    learnerAt(NEAR);
    const { offered } = await ask(instructor({ route: { lessonDurationMin: 120 }, bot: { breaks: [{ from: "12:00", to: "13:00" }] } }));
    expect(offered).not.toContain("11:00");
    expect(offered).not.toContain("12:00");
  }, TIMEOUT);

  it("lesson length decides which times clash with a booked lesson", async () => {
    learnerAt(NEAR);
    lessonAt("11:00", HANLEY);
    const hour = await ask(instructor({ route: { lessonDurationMin: 60 } }));
    const twoHours = await ask(instructor({ route: { lessonDurationMin: 120 } }));
    expect(hour.offered).toContain("10:00");
    expect(twoHours.offered).not.toContain("10:00");
  }, TIMEOUT);

  it("max lessons per day closes a full day", async () => {
    learnerAt(NEAR);
    lessonAt("09:00", HANLEY);
    lessonAt("14:00", NEWCASTLE);
    const { info, offered } = await ask(instructor({ bot: { maxLessonsPerDay: 2 } }));
    expect(info.blockedReason).toBe("day_full");
    expect(offered).toEqual([]);
  }, TIMEOUT);

  it("minimum notice blocks days too soon", async () => {
    learnerAt(NEAR);
    const { note } = await ask(instructor({ bot: { minNoticeHours: 72 } }), { date: timezoneUtils.addDays(TODAY, 1), time: "10:00" });
    expect(note).toMatch(/cannot be booked less than 72 hours in advance/);
  }, TIMEOUT);

  it("the booking window blocks days too far ahead", async () => {
    learnerAt(NEAR);
    const { note } = await ask(instructor({ bot: { bookingWindowDays: 14 } }), { date: timezoneUtils.addDays(DAY, 21), time: "10:00" });
    expect(note).toMatch(/only be made up to 14 days ahead/);
  }, TIMEOUT);

  it("holiday mode blocks the dates and passes on the instructor's message", async () => {
    learnerAt(NEAR);
    const { note } = await ask(instructor({
      bot: { holiday: { enabled: true, from: timezoneUtils.addDays(DAY, -1), to: timezoneUtils.addDays(DAY, 1), message: "Back soon!" } },
    }), { time: "10:00" });
    expect(note).toMatch(/Sam is away from/);
    expect(note).toMatch(/Back soon!/);
  }, TIMEOUT);
});

// ═══════════════════════════════════════════════════════════════════════════
describeE2E(E2E_KEYS.MAPS, "E2E – Donna Settings: route & travel (real drive times)", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  const busyDay = () => { lessonAt("09:00", HANLEY); lessonAt("13:00", NEWCASTLE); };

  it("'off' offers every free time even to a far learner", async () => {
    learnerAt(FAR);
    busyDay();
    const { offered } = await ask(instructor({ route: { preset: "off" } }));
    expect(offered).toEqual(HOURS.filter((t) => t !== "09:00" && t !== "13:00"));
  }, TIMEOUT);

  it("'tight' offers a far learner only the best few times", async () => {
    learnerAt(FAR);
    busyDay();
    const { offered } = await ask(instructor({ route: { preset: "tight" } }));
    console.log(`  🎯 Leek under 'tight': ${offered.join(", ")}`);
    expect(offered.length).toBeLessThanOrEqual(3);
  }, TIMEOUT);

  it("distance matters: under 'balanced' a nearby learner keeps most options, a far one gets the best few", async () => {
    busyDay();
    learnerAt(NEAR);
    const near = await ask(instructor({ route: { preset: "balanced" } }));
    learnerAt(FAR);
    const far = await ask(instructor({ route: { preset: "balanced" } }));
    console.log(`  📍 'balanced' — Hanley: ${near.offered.join(", ")} | Leek: ${far.offered.join(", ")}`);
    expect(near.offered.length).toBeGreaterThan(3);
    expect(far.offered.length).toBeLessThanOrEqual(3);
  }, TIMEOUT);

  it("'tight' only allows 5 min lateness, so even close back-to-back lessons rarely fit", async () => {
    busyDay();
    learnerAt(NEAR);
    const tight = await ask(instructor({ route: { preset: "tight" } }));
    const balanced = await ask(instructor({ route: { preset: "balanced" } }));
    console.log(`  🔒 Hanley learner — tight: ${tight.offered.join(", ")} | balanced: ${balanced.offered.join(", ")}`);
    expect(tight.offered.length).toBeLessThanOrEqual(balanced.offered.length);
  }, TIMEOUT);

  it("a custom drive limit is respected", async () => {
    learnerAt(MID);
    lessonAt("09:00", LONGTON);
    const generous = await ask(instructor({ route: { preset: "custom", maxAddedDriveMin: 60 } }));
    const strict = await ask(instructor({ route: { preset: "custom", maxAddedDriveMin: 5 } }));
    console.log(`  📏 Kidsgrove — limit 60: ${generous.offered.length} times, limit 5: ${strict.offered.length}`);
    expect(strict.offered.length).toBeLessThan(generous.offered.length);
  }, TIMEOUT);

  it("allowed lateness decides whether a real back-to-back drive works", async () => {
    learnerAt(FENTON);
    lessonAt("09:00", LONGTON);
    const strict = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, maxAddedDriveMin: 60 } }), { time: "10:00" });
    const lenient = await ask(instructor({ route: { preset: "custom", travelGraceMin: 30, maxAddedDriveMin: 60 } }), { time: "10:00" });
    console.log(`  ⏱️ Fenton 10:00 after Longton, no lateness allowed: ${strict.info.requestedSlotReason}`);
    expect(strict.info.requestedSlotAvailable).toBe(false);
    expect(strict.info.requestedSlotReason).toMatch(/can't get there in time after your 09:00 lesson/);
    expect(lenient.info.requestedSlotAvailable).toBe(true);
  }, TIMEOUT);

  it("counting the drive from home limits a far-from-home learner on an empty day", async () => {
    learnerAt(FAR);
    const ignored = await ask(instructor({ route: { preset: "tight", homeLegWeight: "off" } }));
    const counted = await ask(instructor({ route: { preset: "tight", homeLegWeight: "full" } }));
    expect(ignored.offered).toEqual(HOURS);
    expect(counted.offered.length).toBeLessThanOrEqual(3);
  }, TIMEOUT);

  it("without a home address, home legs are ignored", async () => {
    learnerAt(FAR);
    const { offered } = await ask(instructor({ home: null, route: { preset: "tight", homeLegWeight: "full" } }));
    expect(offered).toEqual(HOURS);
  }, TIMEOUT);

  it.each([
    [{ radius: 10, unit: "miles" }, false],
    [{ radius: 15, unit: "miles" }, true],
    [{ radius: 15, unit: "km" }, false],
    [{ radius: 25, unit: "km" }, true],
  ])("service area %j for a new learner in Leek → can book: %s", async (serviceArea, inside) => {
    learnerAt(FAR);
    const { info } = await ask(instructor({ route: { serviceArea } }), { time: "10:00" });
    if (inside) {
      expect(info.outsideServiceArea).toBeNull();
    } else {
      expect(info.requestedSlotAvailable).toBe(false);
      expect(info.outsideServiceArea).toMatch(new RegExp(`${serviceArea.unit} away \\(area is ${serviceArea.radius} ${serviceArea.unit}\\)`));
    }
  }, TIMEOUT);

  it("a postcode district on the always-cover list overrides the radius", async () => {
    learnerAt(FAR, {}, { postalCode: "ST13 5AA" });
    const { info } = await ask(instructor({ route: { serviceArea: { radius: 5, unit: "km", postcodeDistricts: ["ST13"] } } }), { time: "10:00" });
    expect(info.outsideServiceArea).toBeNull();
  }, TIMEOUT);

  it("existing learners are never turned away by the service area", async () => {
    learnerAt(FAR);
    Booking.countDocuments.mockResolvedValue(3);
    const { info } = await ask(instructor({ route: { serviceArea: { radius: 1, unit: "miles" } } }), { time: "10:00" });
    expect(info.outsideServiceArea).toBeNull();
  }, TIMEOUT);

  it("'suggest days that fit your route' adds other days when the asked time doesn't work", async () => {
    learnerAt(FENTON);
    lessonAt("09:00", LONGTON);
    const on = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, suggestOtherDays: true, lookAheadDays: 5 } }), { time: "10:00" });
    const off = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, suggestOtherDays: false } }), { time: "10:00" });
    console.log("  📅 Suggested instead:", on.info.bestDays.map((d) => `${d.date} ${d.time} (+${Math.round(d.addedDrive)} min)`).join(", "));
    expect(on.info.bestDays.length).toBeGreaterThan(0);
    expect(on.info.bestDays.every((d) => d.date !== DAY)).toBe(true);
    expect(off.info.bestDays).toEqual([]);
  }, TIMEOUT * 2);
});

// ═══════════════════════════════════════════════════════════════════════════
describeE2E(E2E_KEYS.MAPS, "E2E – Per-learner scheduling (real drive times)", () => {
  beforeEach(setUp);
  afterEach(() => jest.restoreAllMocks());

  it("times they can't do are never offered", async () => {
    learnerAt(NEAR, { unavailable: [{ days: [WED], from: "08:00", to: "12:00" }] });
    const { offered } = await ask(instructor());
    ["08:00", "09:00", "10:00", "11:00"].forEach((t) => expect(offered).not.toContain(t));
    expect(offered).toContain("12:00");
  }, TIMEOUT);

  it("preferred times are flagged for Donna to mention first", async () => {
    learnerAt(NEAR, { preferredDays: [WED], preferredTimes: ["15:00"] });
    const { info } = await ask(instructor());
    expect(info.preferredSlots).toEqual(["15:00"]);
  }, TIMEOUT);

  it("the weekly lesson limit closes the rest of their week", async () => {
    learnerAt(NEAR, { maxLessonsPerWeek: 1 });
    Booking.countDocuments.mockImplementation(async (q) => (q.userPhone ? 1 : 0));
    const { info, offered } = await ask(instructor());
    expect(info.blockedReason).toBe("weekly_limit");
    expect(offered).toEqual([]);
  }, TIMEOUT);

  it("priority learners get every reachable time even under 'tight'", async () => {
    lessonAt("09:00", HANLEY);
    lessonAt("13:00", NEWCASTLE);
    learnerAt(FAR);
    const normal = await ask(instructor({ route: { preset: "tight" } }));
    learnerAt(FAR, { priority: true });
    const priority = await ask(instructor({ route: { preset: "tight" } }));
    console.log(`  ⭐ Leek under 'tight' — normal: ${normal.offered.join(", ")} | priority: ${priority.offered.join(", ")}`);
    expect(priority.offered.length).toBeGreaterThan(normal.offered.length);
  }, TIMEOUT);

  it("their own drive limit overrides the instructor's", async () => {
    lessonAt("09:00", HANLEY);
    learnerAt(MID);
    const instructorLimit = await ask(instructor({ route: { preset: "tight" } }));
    learnerAt(MID, { maxAddedDriveMin: 120 });
    const ownLimit = await ask(instructor({ route: { preset: "tight" } }));
    expect(ownLimit.offered.length).toBeGreaterThan(instructorLimit.offered.length);
  }, TIMEOUT);

  it("a saved pickup place is used instead of their home postcode", async () => {
    lessonAt("09:00", HANLEY);
    // Lives in Leek, but their saved "College" is next to the 09:00 lesson in Hanley
    learnerAt(FAR, { savedPlaces: [{ label: "College", address: "Hanley", latitude: NEAR.latitude, longitude: NEAR.longitude }] });
    const { info } = await ask(instructor({ route: { preset: "tight" } }), { time: "10:00" });
    expect(info.requestedSlotAvailable).toBe(true);
  }, TIMEOUT);

  it("a pickup typed in the chat (geocoded for real) beats both", async () => {
    lessonAt("09:00", HANLEY);
    learnerAt(NEAR);
    aiService.pendingContext[PHONE] = { pickupAddress: "Leek, Staffordshire" };
    const { info } = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0 } }), { time: "10:00" });
    expect(aiService.pendingContext[PHONE].pickupCoords.lat).toBeCloseTo(FAR.latitude, 1);
    expect(info.requestedSlotAvailable).toBe(false);
  }, TIMEOUT);
});
