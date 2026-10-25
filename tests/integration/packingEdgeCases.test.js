/**
 * Smart day packing through the route optimiser and booking service: very
 * close and very far learners, the Routes API being down, and two learners
 * claiming overlapping times at the same moment.
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/services/notificationService", () => ({ bookingChanged: jest.fn(() => Promise.resolve()) }));
jest.mock("../../src/services/distanceMatrixService", () => ({
  getDrivingMatrix: jest.fn(async (origins, destinations) => origins.map(() => destinations.map(() => null))),
  clearCache: jest.fn(),
}));
jest.mock("../../src/services/calendarService", () => ({
  getAvailableTimeSlotsForDate: jest.fn(async () => []),
  getBusyBlocks: jest.fn(async () => []),
  createEvent: jest.fn(async () => ({ id: "evt-new" })),
  updateEvent: jest.fn(async () => ({})),
}));
jest.mock("../../src/models/instructorModel", () => ({ getInstructor: jest.fn(), invalidateInstructorCache: jest.fn() }));

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const distanceMatrixService = require("../../src/services/distanceMatrixService");
const calendarService = require("../../src/services/calendarService");
const { getInstructor } = require("../../src/models/instructorModel");
const routeOptimizer = require("../../src/services/routeOptimizer");
const bookingService = require("../../src/services/bookingService");

const DATE = "2030-06-17"; // a Monday
const HOME = { latitude: 53.0168, longitude: -2.2191 }; // Stoke
const A = { lat: 53.0254, long: -2.1768 }; // Hanley: an existing lesson
const NEAR = { lat: 53.0262, long: -2.1771 }; // round the corner from A
const LEEK = { lat: 53.1065, long: -1.9835 }; // ~19 km from A
const ALL_DAYS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { start: "08:00", end: "18:00" }]));

const INSTRUCTOR = {
  phoneNumberId: "inst-1",
  name: "Sam",
  baseLocation: HOME,
  botSettings: { scheduleMode: "packed", dayHours: ALL_DAYS, lunch: { enabled: false } },
  routeSettings: { bufferMin: 20, driveVarianceMin: 5 },
};
// The same instructor with a longest drive of 25 minutes
const SHORT = { ...INSTRUCTOR, routeSettings: { ...INSTRUCTOR.routeSettings, maxDriveMin: 25 } };

const booking = (time, loc, extra = {}) => ({
  bookingId: extra.bookingId || `DL-${time.replace(":", "")}`,
  time,
  date: DATE,
  instructorId: "inst-1",
  status: "confirmed",
  pickupLocation: { latitude: loc.lat, longitude: loc.long },
  dropoffLocation: { latitude: loc.lat, longitude: loc.long },
  ...extra,
});

const key = (pt) => `${pt.lat},${pt.long ?? pt.lng}`;
function mockDrives(table) {
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) =>
    origins.map((o) => destinations.map((d) => table[`${key(o)}->${key(d)}`] ?? null))
  );
}
const plan = (userLoc, extra = {}) =>
  routeOptimizer.planDay({ date: DATE, instructor: INSTRUCTOR, availableSlots: null, userLoc, durationMin: 60, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  Booking.find = jest.fn().mockResolvedValue([]);
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
  calendarService.getBusyBlocks.mockResolvedValue([]);
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) => origins.map(() => destinations.map(() => null)));
});

describe("very close learners", () => {
  it("a learner at the same address as the last drop-off starts 5 minutes after it", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    const day = await plan(A);
    expect(day.free).toContain("10:05");
    expect(day.free).not.toContain("10:00");
  });

  it("a learner round the corner on both sides fits a gap the full X wouldn't", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A), booking("11:10", A)]);
    mockDrives({ [`${key(A)}->${key(NEAR)}`]: 0, [`${key(NEAR)}->${key(A)}`]: 0 });
    const day = await plan(NEAR);
    expect(day.free).toContain("10:05");
  });
});

describe("far learners (between the usual gap and the longest drive)", () => {
  // Leek is 30 min from A and from the instructor's base; X 20, H 40 by default
  const far = () =>
    mockDrives({
      [`${key(A)}->${key(LEEK)}`]: 30,
      [`${key(LEEK)}->${key(A)}`]: 30,
      [`53.0168,-2.2191->${key(LEEK)}`]: 30,
      [`${key(LEEK)}->53.0168,-2.2191`]: 30,
    });

  it("on a quiet day they're fitted in after the full drive, and Donna says why", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    far();
    const day = await plan(LEEK);
    expect(day.free[0]).toBe("10:35");
    expect(day.longDrive).toBe(true);
  });

  it("on a busy day they don't take a local learner's place", async () => {
    Booking.find.mockResolvedValue(["09:00", "10:20", "11:40", "13:00"].map((t) => booking(t, A)));
    far();
    const day = await plan(LEEK);
    expect(day.free).toEqual([]);
  });

  it("the booking check agrees with what was offered", async () => {
    far();
    const base = { date: DATE, instructor: INSTRUCTOR, durationMin: 60, userLoc: LEEK };
    Booking.find.mockResolvedValue(["09:00", "10:20", "11:40", "13:00"].map((t) => booking(t, A)));
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "14:35" })).toBe(false);
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "10:35" })).toBe(true);
  });

  it("a nearby learner isn't flagged as far", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    const day = await plan(A);
    expect(day.longDrive).toBe(false);
  });

  it("still fitted in when the instructor's base is further than the longest drive", async () => {
    // 30 min from the lesson, but 55 min from the base: the guess about who
    // else might book only sizes the gap, it doesn't rule the learner out
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    mockDrives({
      [`${key(A)}->${key(LEEK)}`]: 30,
      [`${key(LEEK)}->${key(A)}`]: 30,
      [`53.0168,-2.2191->${key(LEEK)}`]: 55,
      [`${key(LEEK)}->53.0168,-2.2191`]: 55,
    });
    const day = await plan(LEEK);
    expect(day.free).toContain("17:00");
  });

  it("further than the longest drive: never next to a lesson", async () => {
    Booking.find.mockResolvedValue([booking("12:00", A)]);
    mockDrives({ [`${key(A)}->${key(LEEK)}`]: 50, [`${key(LEEK)}->${key(A)}`]: 50 });
    const day = await plan(LEEK);
    expect(day.free).toEqual([]);
  });

  it("are offered on a day with no lessons", async () => {
    const day = await plan(LEEK);
    expect(day.free.length).toBeGreaterThan(0);
  });

  it("are offered next to a calendar event (no location to drive from)", async () => {
    calendarService.getBusyBlocks.mockResolvedValue([{ start: 8 * 60, end: 12 * 60, kind: "block", label: "Admin" }]);
    const day = await plan(LEEK);
    expect(day.free).toContain("12:20");
  });
});

describe("the instructor's longest drive and usual gap", () => {
  const settings = require("../../src/services/instructorSettings");
  const { usualGap } = require("../../src/services/typicalDrive");

  it("new instructors: longest drive 40, usual gap half of it", () => {
    expect(settings.packingRange({})).toMatchObject({ maxDriveMin: 40, bufferMin: 20, bufferSource: "default" });
  });

  it("instructors who used the old slider keep their gap, with a longest drive of twice it", () => {
    expect(settings.packingRange({ bufferMin: 15 })).toMatchObject({ maxDriveMin: 30, bufferMin: 15, bufferSource: "previous" });
    expect(settings.packingRange({ bufferMin: 45 })).toMatchObject({ maxDriveMin: 60, bufferMin: 45 });
  });

  it("once Donna has seen 10 drives she uses what she learned, kept between 10 and the longest drive", () => {
    expect(settings.packingRange({ maxDriveMin: 40, autoBufferMin: 15, autoBufferSamples: 10 })).toMatchObject({ bufferMin: 15, bufferSource: "learned" });
    expect(settings.packingRange({ maxDriveMin: 40, autoBufferMin: 15, autoBufferSamples: 9 })).toMatchObject({ bufferMin: 20, bufferSource: "default" });
    expect(settings.packingRange({ maxDriveMin: 25, autoBufferMin: 35, autoBufferSamples: 20 })).toMatchObject({ bufferMin: 25 });
    expect(settings.packingRange({ maxDriveMin: 40, autoBufferMin: 5, autoBufferSamples: 20 })).toMatchObject({ bufferMin: 10 });
  });

  it("after a booking Donna re-learns the usual gap from the last 4 weeks of drives", async () => {
    const Instructor = require("../../src/models/instructorSchema");
    const { refresh } = require("../../src/services/typicalDrive");
    const save = jest.spyOn(Instructor, "updateOne").mockResolvedValue({});
    Booking.find = jest.fn(() => ({ lean: () => Promise.resolve([8, 12, 9, 30, 10, 7, 11, 9, 14, 6].map((driveInMin) => ({ driveInMin }))) }));
    const result = await refresh({ ...INSTRUCTOR });
    expect(result).toEqual({ gap: 15, samples: 10 }); // median 9.5 + 5
    expect(Booking.find.mock.calls[0][0]).toMatchObject({ instructorId: "inst-1", driveInMin: { $ne: null } });
    expect(save.mock.calls[0][1].$set).toMatchObject({ "routeSettings.autoBufferMin": 15, "routeSettings.autoBufferSamples": 10 });
    save.mockRestore();
  });

  it("re-learning never breaks a booking, even if the database fails", async () => {
    const { refresh } = require("../../src/services/typicalDrive");
    Booking.find = jest.fn(() => ({ lean: () => Promise.reject(new Error("db down")) }));
    await expect(refresh({ ...INSTRUCTOR })).resolves.toBeNull();
  });

  it("the usual gap is the median drive + 5, rounded up to 5", () => {
    expect(usualGap([4, 6, 9, 30, 8])).toBe(15); // median 8
    expect(usualGap([10, 12])).toBe(20); // median 11
    expect(usualGap([])).toBeNull();
  });
});

describe("when the Routes API is down", () => {
  beforeEach(() => {
    distanceMatrixService.getDrivingMatrix.mockRejectedValue(new Error("Routes API unavailable"));
  });

  it("a close learner gets the full X (never a guessed shorter gap)", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    const day = await plan(NEAR);
    expect(day.free).toContain("10:20");
    expect(day.free).not.toContain("10:05");
  });

  it("a learner further than the longest drive (by straight line) isn't squeezed in", async () => {
    Booking.find.mockResolvedValue([booking("12:00", A)]);
    // Hanley to Leek is ~15 km in a straight line: ~30 min estimated, over 25
    const day = await routeOptimizer.planDay({ date: DATE, instructor: SHORT, availableSlots: null, userLoc: LEEK, durationMin: 60 });
    expect(day.free).toEqual([]);
  });

  it("the booking check agrees with what was offered", async () => {
    Booking.find.mockResolvedValue([booking("12:00", A)]);
    const base = { date: DATE, durationMin: 60, time: "13:20" };
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, instructor: INSTRUCTOR, userLoc: NEAR })).toBe(true);
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, instructor: SHORT, userLoc: LEEK })).toBe(false);
  });
});

describe("two learners claiming overlapping times at once", () => {
  // A tiny in-memory bookings collection. Like the real unique index, it only
  // stops two lessons at the *same* start time.
  let store;
  let seq;

  beforeEach(() => {
    store = [];
    seq = 0;
    getInstructor.mockResolvedValue(INSTRUCTOR);
    User.findOne = jest.fn().mockResolvedValue({ phone: "x", postalCode: "ST1 1AA", location: { latitude: A.lat, longitude: A.long } });
    jest.spyOn(bookingService, "validateBooking").mockResolvedValue([]);
    jest.spyOn(routeOptimizer, "evaluateSlot").mockResolvedValue(null);
    Booking.create = jest.fn(async (doc) => {
      await new Promise((r) => setImmediate(r)); // let the other request get here too
      if (store.some((b) => b.date === doc.date && b.time === doc.time)) {
        throw Object.assign(new Error("dup"), { code: 11000, keyPattern: { instructorId: 1, date: 1, time: 1 } });
      }
      const saved = { ...doc, _id: `id-${++seq}` };
      store.push(saved);
      return saved;
    });
    Booking.find = jest.fn(async (q) =>
      store.filter((b) => b.date === q.date && (!q.bookingId || b.bookingId !== q.bookingId.$ne))
    );
    Booking.deleteOne = jest.fn(async ({ _id }) => {
      store = store.filter((b) => b._id !== _id);
    });
    Booking.updateOne = jest.fn(async () => ({}));
  });

  afterEach(() => jest.restoreAllMocks());

  const book = (phone, time, durationMin) =>
    bookingService.createBooking(phone, { date: DATE, time, lessonType: "", durationMin }, { ...INSTRUCTOR, routeSettings: { ...INSTRUCTOR.routeSettings, lessonDurationMin: durationMin } });

  const overlaps = (list) =>
    list.some((a, i) =>
      list.some((b, j) => {
        if (i >= j) return false;
        const m = (x) => Number(x.time.slice(0, 2)) * 60 + Number(x.time.slice(3));
        return m(a) < m(b) + (b.durationMin || 60) && m(b) < m(a) + (a.durationMin || 60);
      })
    );

  it("never ends with two overlapping lessons, and the loser is told the time was taken", async () => {
    const results = await Promise.allSettled([book("447000000001", "10:00", 60), book("447000000002", "10:30", 60)]);
    expect(overlaps(store)).toBe(false);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect(rejected[0].reason.code).toBe("SLOT_TAKEN");
    // A released claim never gets a calendar event
    expect(calendarService.createEvent).toHaveBeenCalledTimes(store.length);
  });

  it("two lessons that don't overlap are both booked", async () => {
    const results = await Promise.allSettled([book("447000000001", "09:00", 60), book("447000000002", "11:00", 60)]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(store).toHaveLength(2);
  });
});
