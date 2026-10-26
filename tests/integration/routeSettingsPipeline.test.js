/**
 * Donna Settings → route optimisation, through the real pipeline:
 *
 *   instructor settings → calendarService (working hours, breaks, lesson length)
 *     → routeOptimizer.planDay (presets, drive limits, home legs, learner prefs)
 *     → aiService.getAvailabilityInfo + generateSystemMessage (what Donna is told)
 *
 * Only Google (Calendar + Routes), the database and the AI are faked. Drive times
 * fall back to straight-line estimates (2 min per km), so distances below are
 * approximate: ALICE ~1.5 km, BOB ~5 km, CHARLIE ~25 km from the instructor's base.
 *
 * "Now" is Monday 2025-06-16 09:00 London. The day asked about is Thursday 19th.
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/config/gemini", () => ({ model: null, fastModel: null }));
jest.mock("../../src/config/google", () => ({
  oauth2Client: { setCredentials: jest.fn() },
  calendar: { events: { list: jest.fn() } },
}));
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/services/mapsService", () => ({ getCoordinatesFromPostalCode: jest.fn() }));
jest.mock("../../src/utils/emailNotifier", () => ({ notifyInvalidGrant: jest.fn(), notifyInstructorReauth: jest.fn() }));
jest.mock("../../src/services/distanceMatrixService", () => ({
  getDrivingMatrix: jest.fn(async (o, d) => o.map(() => d.map(() => null))),
}));

const { calendar } = require("../../src/config/google");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const aiService = require("../../src/services/gemini/aiService");

const BASE = { latitude: 53.0168046, longitude: -2.2190649 };
const ALICE = { latitude: 53.03, longitude: -2.22 };
const BOB = { latitude: 53.06, longitude: -2.25 };
const CHARLIE = { latitude: 53.2, longitude: -2.45 };
const DAY = "2025-06-19"; // Thursday
const PHONE = "447000000001";
const HOURS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00"];
const WEEKDAYS = { mon: HOURS, tue: HOURS, wed: HOURS, thu: HOURS, fri: HOURS, sat: [], sun: [] };

const realNow = Date.now;
beforeAll(() => { Date.now = () => new Date("2025-06-16T08:00:00Z").getTime(); });
afterAll(() => { Date.now = realNow; });

let bookingsByDate;
beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(aiService.pendingContext).forEach((k) => delete aiService.pendingContext[k]);
  calendar.events.list.mockResolvedValue({ data: { items: [] } }); // empty Google Calendar
  bookingsByDate = {};
  Booking.find.mockImplementation(async ({ date }) => bookingsByDate[date] || []);
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

function instructor({ route = {}, bot = {}, base = BASE } = {}) {
  return {
    phoneNumberId: "inst-1",
    name: "Sam",
    ...(base ? { baseLocation: base } : {}),
    routeSettings: route,
    botSettings: { workingHours: WEEKDAYS, ...bot },
  };
}

function learnerAt(loc, schedulingPrefs = {}) {
  User.findOne.mockResolvedValue({ phone: PHONE, instructorId: "inst-1", location: loc || {}, schedulingPrefs });
}

const lessonAt = (time, loc, date = DAY) => {
  (bookingsByDate[date] ||= []).push({ time, date, status: "confirmed", instructorId: "inst-1", location: loc });
};

// What Donna is offered for a date (and optionally a requested time), plus the note she reads
async function ask(inst, { date = DAY, time = null } = {}) {
  const info = await aiService.getAvailabilityInfo(date, time, inst, PHONE);
  const note = aiService.generateSystemMessage({ finalDate: date, finalTime: time }, info, inst);
  return { info, note, offered: info.availableSlotsForDate || [] };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("Availability settings", () => {
  it("working hours decide which start times exist", async () => {
    learnerAt(ALICE);
    const { offered } = await ask(instructor({ bot: { workingHours: { ...WEEKDAYS, thu: ["10:00", "14:00"] } } }));
    expect(offered).toEqual(["10:00", "14:00"]);
  });

  it("a day off is reported as not a working day", async () => {
    learnerAt(ALICE);
    const { note } = await ask(instructor({ bot: { workingHours: { ...WEEKDAYS, thu: [] } } }));
    expect(note).toMatch(/isn't one of Sam's working days/);
  });

  it("breaks remove times whose lesson would run into them", async () => {
    learnerAt(ALICE);
    const { offered } = await ask(instructor({ bot: { breaks: [{ from: "12:00", to: "13:00" }] } }));
    expect(offered).not.toContain("12:00");
    expect(offered).toContain("11:00"); // 11:00–12:00 ends as the break starts
  });

  it("with 2-hour lessons the same break also rules out 11:00", async () => {
    learnerAt(ALICE);
    const { offered } = await ask(instructor({
      route: { lessonDurationMin: 120 },
      bot: { breaks: [{ from: "12:00", to: "13:00" }] },
    }));
    expect(offered).not.toContain("11:00");
    expect(offered).not.toContain("12:00");
  });

  it("lesson length decides which times clash with a booked lesson", async () => {
    learnerAt(ALICE);
    lessonAt("11:00", ALICE);
    const hour = await ask(instructor({ route: { lessonDurationMin: 60 } }));
    const twoHours = await ask(instructor({ route: { lessonDurationMin: 120 } }));
    expect(hour.offered).toContain("10:00");
    expect(twoHours.offered).not.toContain("10:00");
  });

  it("max lessons per day closes a full day", async () => {
    learnerAt(ALICE);
    lessonAt("09:00", ALICE);
    lessonAt("14:00", ALICE);
    const { info, offered } = await ask(instructor({ bot: { maxLessonsPerDay: 2 } }));
    expect(info.blockedReason).toBe("day_full");
    expect(offered).toEqual([]);
  });

  it("minimum notice blocks days too soon", async () => {
    learnerAt(ALICE);
    const { note } = await ask(instructor({ bot: { minNoticeHours: 72 } }), { date: "2025-06-18", time: "10:00" });
    expect(note).toMatch(/cannot be booked less than 72 hours in advance/);
  });

  it("the booking window blocks days too far ahead", async () => {
    learnerAt(ALICE);
    const { note } = await ask(instructor({ bot: { bookingWindowDays: 14 } }), { date: "2025-07-10", time: "10:00" });
    expect(note).toMatch(/only be made up to 14 days ahead/);
  });

  it("holiday mode blocks the dates and passes on the instructor's message", async () => {
    learnerAt(ALICE);
    const { note } = await ask(instructor({
      bot: { holiday: { enabled: true, from: "2025-06-18", to: "2025-06-20", message: "Back on Monday!" } },
    }), { time: "10:00" });
    expect(note).toMatch(/Sam is away from 2025-06-18 to 2025-06-20/);
    expect(note).toMatch(/Back on Monday!/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Route & travel settings", () => {
  it("'off' offers every free time even to a far learner", async () => {
    learnerAt(CHARLIE);
    const { offered } = await ask(instructor({ route: { preset: "off" } }));
    expect(offered).toEqual(HOURS);
  });

  it("'tight' offers a far learner only the best few times", async () => {
    learnerAt(CHARLIE);
    lessonAt("09:00", ALICE);
    lessonAt("13:00", ALICE);
    const { offered } = await ask(instructor({ route: { preset: "tight" } }));
    expect(offered.length).toBeLessThanOrEqual(3);
    expect(offered.length).toBeLessThan(HOURS.length - 2);
  });

  it("a custom drive limit is respected", async () => {
    learnerAt(BOB);
    lessonAt("09:00", ALICE);
    const generous = await ask(instructor({ route: { preset: "custom", maxAddedDriveMin: 60 } }));
    const strict = await ask(instructor({ route: { preset: "custom", maxAddedDriveMin: 5 } }));
    expect(strict.offered.length).toBeLessThan(generous.offered.length);
  });

  it("allowed lateness decides whether a back-to-back time works", async () => {
    // ~5 km between lessons ≈ 10 min straight-line drive
    learnerAt(BOB);
    lessonAt("09:00", ALICE);
    const strict = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, maxAddedDriveMin: 60 } }), { time: "10:00" });
    const lenient = await ask(instructor({ route: { preset: "custom", travelGraceMin: 15, maxAddedDriveMin: 60 } }), { time: "10:00" });
    expect(strict.info.requestedSlotAvailable).toBe(false);
    expect(strict.info.requestedSlotReason).toMatch(/can't get there in time after your 09:00 lesson/);
    expect(lenient.info.requestedSlotAvailable).toBe(true);
  });

  it("counting the drive from home can push a far-from-home learner over the limit", async () => {
    learnerAt(BOB); // empty day, so every lesson is "from home and back"
    const ignored = await ask(instructor({ route: { preset: "tight", homeLegWeight: "off" } }));
    const counted = await ask(instructor({ route: { preset: "tight", homeLegWeight: "full" } }));
    expect(ignored.offered).toEqual(HOURS);
    expect(counted.offered.length).toBeLessThanOrEqual(3);
  });

  it("without a home address, home legs are ignored", async () => {
    learnerAt(BOB);
    const { offered } = await ask(instructor({ base: null, route: { preset: "tight", homeLegWeight: "full" } }));
    expect(offered).toEqual(HOURS);
  });

  it("a service area in km turns away a new learner further out, telling Donna why", async () => {
    learnerAt(CHARLIE);
    const { info, note } = await ask(instructor({ route: { serviceArea: { radius: 10, unit: "km" } } }), { time: "10:00" });
    expect(info.requestedSlotAvailable).toBe(false);
    expect(info.outsideServiceArea).toMatch(/km away \(area is 10 km\)/);
    expect(note).toMatch(/NO/);
  });

  it("a postcode district on the always-cover list overrides the radius", async () => {
    learnerAt(CHARLIE);
    User.findOne.mockResolvedValue({ phone: PHONE, location: CHARLIE, postalCode: "CW1 2AB", schedulingPrefs: {} });
    const { info } = await ask(instructor({ route: { serviceArea: { radius: 10, unit: "km", postcodeDistricts: ["CW1"] } } }), { time: "10:00" });
    expect(info.outsideServiceArea).toBeNull();
  });

  it("a learner's own past lesson place isn't turned away by the service area, a new far place is", async () => {
    learnerAt(CHARLIE);
    const chain = (v) => ({ select: () => ({ lean: async () => v }) });
    const byDate = Booking.find.getMockImplementation();
    const withHistory = (past) => (q) => (q.userPhone && !q.date ? chain(past) : byDate(q));
    const userFind = User.findOne.getMockImplementation();
    User.findOne.mockImplementation((q) => {
      const u = { phone: PHONE, instructorId: "inst-1", location: CHARLIE, schedulingPrefs: {} };
      return Object.assign(Promise.resolve(u), { select: () => ({ lean: async () => u }) });
    });
    const inst = instructor({ route: { serviceArea: { radius: 1, unit: "miles" } } });

    Booking.find.mockImplementation(withHistory([{ pickupLocation: { address: "x", latitude: CHARLIE.latitude ?? CHARLIE.lat, longitude: CHARLIE.longitude ?? CHARLIE.long } }]));
    expect((await ask(inst, { time: "10:00" })).info.outsideServiceArea).toBeNull();

    Booking.find.mockImplementation(withHistory([]));
    expect((await ask(inst, { time: "10:00" })).info.outsideServiceArea).toMatch(/^pickup about \d+ miles away/);

    Booking.find.mockImplementation(byDate);
    if (userFind) User.findOne.mockImplementation(userFind);
  });

  it("'suggest days that fit your route' adds better days when the asked time doesn't work", async () => {
    learnerAt(BOB);
    lessonAt("09:00", ALICE);
    const on = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, suggestOtherDays: true, lookAheadDays: 5 } }), { time: "10:00" });
    const off = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0, suggestOtherDays: false } }), { time: "10:00" });
    expect(on.info.bestDays.length).toBeGreaterThan(0);
    expect(on.info.bestDays.every((d) => d.date !== DAY)).toBe(true);
    expect(off.info.bestDays).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Per-learner scheduling (Learners → Scheduling)", () => {
  it("times they can't do are never offered", async () => {
    learnerAt(ALICE, { unavailable: [{ days: [4], from: "09:00", to: "12:00" }] }); // Thursdays
    const { offered } = await ask(instructor());
    expect(offered).not.toEqual(expect.arrayContaining(["09:00", "10:00", "11:00"]));
    expect(offered).toContain("12:00");
  });

  it("preferred times are flagged for Donna to mention first", async () => {
    learnerAt(ALICE, { preferredDays: [4], preferredTimes: ["15:00"] });
    const { info } = await ask(instructor());
    expect(info.preferredSlots).toEqual(["15:00"]);
  });

  it("the weekly lesson limit closes the rest of their week", async () => {
    learnerAt(ALICE, { maxLessonsPerWeek: 1 });
    Booking.countDocuments = jest.fn(async (q) => (q.userPhone ? 1 : 0));
    const { info, offered } = await ask(instructor());
    expect(info.blockedReason).toBe("weekly_limit");
    expect(offered).toEqual([]);
  });

  it("priority learners get every reachable time even under 'tight'", async () => {
    lessonAt("09:00", ALICE);
    learnerAt(CHARLIE); // far: normally only the best few
    const normal = await ask(instructor({ route: { preset: "tight" } }));
    learnerAt(CHARLIE, { priority: true });
    const priority = await ask(instructor({ route: { preset: "tight" } }));
    expect(normal.offered.length).toBeLessThanOrEqual(3);
    expect(priority.offered.length).toBeGreaterThan(normal.offered.length);
  });

  it("their own drive limit overrides the instructor's", async () => {
    lessonAt("09:00", ALICE);
    learnerAt(BOB, { maxAddedDriveMin: 120 });
    const { offered } = await ask(instructor({ route: { preset: "tight" } }));
    expect(offered.length).toBeGreaterThan(3);
  });

  it("a saved pickup place is used instead of their home postcode", async () => {
    lessonAt("09:00", ALICE);
    // Home is far away, but their saved "School" is right next to the 09:00 lesson
    learnerAt(CHARLIE, { savedPlaces: [{ label: "School", address: "Near Alice", latitude: 53.031, longitude: -2.221 }] });
    const { info } = await ask(instructor({ route: { preset: "tight" } }), { time: "10:00" });
    expect(info.requestedSlotAvailable).toBe(true);
  });

  it("a pickup given in the chat beats both", async () => {
    lessonAt("09:00", ALICE);
    learnerAt(ALICE);
    aiService.pendingContext[PHONE] = { pickupAddress: "Far away", pickupCoords: { lat: CHARLIE.latitude, long: CHARLIE.longitude } };
    const { info } = await ask(instructor({ route: { preset: "custom", travelGraceMin: 0 } }), { time: "10:00" });
    expect(info.requestedSlotAvailable).toBe(false);
  });
});
