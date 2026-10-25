/**
 * Packed mode in the route optimiser: Donna generates start times from the
 * day's hours, the lesson length, X (most driving between lessons) and real
 * drive times + a 5-minute variance. See SMART-DAY-PACKING-PLAN.md.
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/services/distanceMatrixService", () => ({
  getDrivingMatrix: jest.fn(async (origins, destinations) => origins.map(() => destinations.map(() => null))),
  clearCache: jest.fn(),
}));
jest.mock("../../src/services/calendarService", () => ({
  getAvailableTimeSlotsForDate: jest.fn(async () => []),
  getBusyBlocks: jest.fn(async () => []),
}));

const Booking = require("../../src/models/bookingModel");
const distanceMatrixService = require("../../src/services/distanceMatrixService");
const calendarService = require("../../src/services/calendarService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const settings = require("../../src/services/instructorSettings");

const DATE = "2030-06-17"; // a Monday
const HOME = { latitude: 53.0, longitude: -2.2 };
const A = { lat: 53.01, long: -2.21 }; // an existing lesson's pickup/drop-off
const B = { lat: 53.05, long: -2.25 }; // the learner asking
const ALL_DAYS = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { start: "08:00", end: "18:00" }]));

const instructor = (over = {}) => ({
  phoneNumberId: "inst-1",
  baseLocation: HOME,
  botSettings: {
    scheduleMode: "packed",
    dayHours: ALL_DAYS,
    lunch: { enabled: true, durationMin: 45, windowFrom: "12:00", windowTo: "14:00" },
    ...(over.botSettings || {}),
  },
  routeSettings: { bufferMin: 20, driveVarianceMin: 5, ...(over.routeSettings || {}) },
});

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

const key = (p) => `${p.lat},${p.long ?? p.lng}`;
function mockDrives(table) {
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) =>
    origins.map((o) => destinations.map((d) => table[`${key(o)}->${key(d)}`] ?? null))
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  Booking.find = jest.fn().mockResolvedValue([]);
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
  calendarService.getBusyBlocks.mockResolvedValue([]);
  distanceMatrixService.getDrivingMatrix.mockImplementation(async (origins, destinations) => origins.map(() => destinations.map(() => null)));
});

describe("packed settings", () => {
  it("picks the preset band from X", () => {
    expect(settings.resolveRouteSettings(instructor({ routeSettings: { bufferMin: 12 } })).preset).toBe("tight");
    expect(settings.resolveRouteSettings(instructor({ routeSettings: { bufferMin: 20 } })).preset).toBe("balanced");
    expect(settings.resolveRouteSettings(instructor({ routeSettings: { bufferMin: 45 } })).preset).toBe("relaxed");
    expect(settings.resolveRouteSettings(instructor()).packed).toBe(true);
  });

  it("fixed mode is the default and keeps the start-time chips", () => {
    expect(settings.isPacked({})).toBe(false);
    expect(settings.timesForDate({}, DATE)).toEqual(["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]);
  });

  it("packed times depend on the lesson length", () => {
    const one = settings.timesForDate(instructor(), DATE, 60);
    const two = settings.timesForDate(instructor(), DATE, 120);
    expect(one.length).toBe(7);
    expect(two.length).toBe(4);
    expect(settings.allWorkingTimes(instructor())).toEqual([]);
  });

  it("without dayHours, the working days come from the start-time chips", () => {
    const inst = { botSettings: { scheduleMode: "packed", workingHours: { mon: ["09:00", "15:00"], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } } };
    expect(settings.dayHoursFor(inst).mon).toEqual({ start: "09:00", end: "16:00" });
    expect(settings.dayHoursFor(inst).tue).toBeNull();
    expect(settings.isWorkingDay(inst, DATE)).toBe(true);
    expect(settings.isWorkingDay(inst, "2030-06-18")).toBe(false);
  });

  it("an old booking without its own length uses the old single length", () => {
    expect(settings.bookingDuration({}, { routeSettings: { lessonDurationMin: 90 } })).toBe(90);
    expect(settings.bookingDuration({ durationMin: 120 }, {})).toBe(120);
  });
});

describe("planDay in packed mode", () => {
  it("without a learner location offers the worst-case packed day", async () => {
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60 });
    for (const t of ["08:00", "09:20", "10:40", "12:00", "14:05", "15:25", "16:45"]) expect(day.offered).toContain(t);
    expect(day.free).toEqual(day.offered);
  });

  it("a nearby learner can start sooner than X after the lesson before", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    mockDrives({ [`${key(A)}->${key(B)}`]: 8, [`${key(B)}->${key(A)}`]: 8 });
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, durationMin: 60 });
    // 8 min drive + 5 variance → 15 min gap: 10:15, not 10:20
    expect(day.free).toContain("10:15");
    expect(day.free).not.toContain("10:05");
    expect(day.offered).toContain("10:15");
  });

  it("a drive just under X is never refused: the variance shrinks to fit", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    mockDrives({ [`${key(A)}->${key(B)}`]: 18, [`${key(B)}->${key(A)}`]: 18 });
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, durationMin: 60 });
    expect(day.free).toContain("10:20");
    expect(day.free).not.toContain("10:15");
  });

  it("a drive over the longest drive (H) isn't offered next to a lesson", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    mockDrives({ [`${key(A)}->${key(B)}`]: 50, [`${key(B)}->${key(A)}`]: 50 });
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, durationMin: 60 });
    expect(day.free).toEqual([]);
  });

  it("a missing drive time uses X", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, durationMin: 60 });
    expect(day.free).toContain("10:20");
    expect(day.free).not.toContain("10:15");
  });

  it("uses each booking's own length", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A, { durationMin: 120 })]);
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60 });
    expect(day.free.some((t) => t >= "08:00" && t < "11:20" && t !== "08:00")).toBe(false);
    expect(day.free).toContain("11:20");
  });

  it("a 2-hour lesson gets fewer, different starts than a 1-hour lesson", async () => {
    Booking.find.mockResolvedValue([booking("10:00", A)]);
    const one = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60 });
    const two = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 120 });
    expect(one.free).toContain("08:40"); // ends 09:40, 20 min before 10:00
    expect(two.free).not.toContain("08:40");
    expect(two.free.length).toBeLessThan(one.free.length);
  });

  it("works around calendar events, but not the lessons' own events", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A, { calendarEventId: "ev-lesson" })]);
    calendarService.getBusyBlocks.mockResolvedValue([{ start: 14 * 60, end: 16 * 60, kind: "block", label: "Dentist" }]);
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60 });
    expect(calendarService.getBusyBlocks.mock.calls[0][2].has("ev-lesson")).toBe(true);
    expect(day.free.some((t) => t > "13:00" && t < "16:20")).toBe(false);
  });

  it("a lesson being moved doesn't block itself", async () => {
    Booking.find.mockResolvedValue([booking("10:00", A, { bookingId: "DL-MOVE" })]);
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60, excludeBookingId: "DL-MOVE" });
    expect(day.free).toContain("09:20");
    expect(day.free).toContain("10:40");
  });

  it("stops at the daily lesson limit", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A)]);
    const day = await routeOptimizer.planDay({
      date: DATE,
      instructor: instructor({ botSettings: { maxLessonsPerDay: 1 } }),
      availableSlots: null,
      durationMin: 60,
    });
    expect(day.blockedReason).toBe("day_full");
  });

  it("a non-working day has nothing", async () => {
    const inst = instructor({ botSettings: { dayHours: { ...ALL_DAYS, mon: null } } });
    const day = await routeOptimizer.planDay({ date: DATE, instructor: inst, availableSlots: null, durationMin: 60 });
    expect(day.free).toEqual([]);
  });

  it("a requested time that fits is included even if it's not an offered start", async () => {
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, durationMin: 60, requestedTime: "10:05" });
    expect(day.free).toContain("10:05");
  });

  it("uses one Routes matrix call for generating and scoring", async () => {
    Booking.find.mockResolvedValue([booking("09:00", A), booking("15:00", A)]);
    await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, durationMin: 60 });
    expect(distanceMatrixService.getDrivingMatrix).toHaveBeenCalledTimes(1);
  });

  it("the drop-off point is used for the drive to the next lesson", async () => {
    const C = { lat: 53.2, long: -2.4 };
    Booking.find.mockResolvedValue([booking("11:00", A)]);
    // Pickup B is next to A, but the drop-off C is further than the longest drive (40)
    mockDrives({ [`${key(B)}->${key(A)}`]: 2, [`${key(C)}->${key(A)}`]: 50 });
    const day = await routeOptimizer.planDay({ date: DATE, instructor: instructor(), availableSlots: null, userLoc: B, dropoffLoc: C, durationMin: 60 });
    expect(day.free.some((t) => t >= "09:00" && t < "11:00")).toBe(false);
  });
});

describe("isPackedStartAvailable", () => {
  it("accepts a time that fits and refuses one that clashes", async () => {
    Booking.find.mockResolvedValue([booking("10:00", A)]);
    const base = { date: DATE, instructor: instructor(), durationMin: 60 };
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "08:00" })).toBe(true);
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "09:30" })).toBe(false);
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "11:05" })).toBe(false);
    expect(await routeOptimizer.isPackedStartAvailable({ ...base, time: "11:20" })).toBe(true);
  });
});
