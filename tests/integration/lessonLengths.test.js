/**
 * Lessons have their own length (SMART-DAY-PACKING-PLAN.md): calendar events,
 * booking checks, Portal bookings, the AI prompt and the data migration all
 * use it instead of the instructor's single old length.
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/emailNotifier", () => ({ notifyInvalidGrant: jest.fn(), notifyInstructorReauth: jest.fn() }));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({ lat: 53.02, lng: -2.22 }),
}));
jest.mock("../../src/config/google", () => ({
  clientFor: jest.fn(() => ({})),
  calendar: { events: { list: jest.fn(), insert: jest.fn(), update: jest.fn(), delete: jest.fn() } },
}));
jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2030-07-15"]),
}));
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn() }),
  })),
}));

const express = require("express");
const { calendar } = require("../../src/config/google");
const calendarService = require("../../src/services/calendarService");
const bookingService = require("../../src/services/bookingService");
const Booking = require("../../src/models/bookingModel");
const LessonType = require("../../src/models/lessonTypeModel");
const aiService = require("../../src/services/gemini/aiService");
const { formatDuration } = require("../../src/services/lessonTypes");
const { planMigration } = require("../../scripts/migrateLessonDurations");

const INSTRUCTOR = { phoneNumberId: "inst-1", name: "Sam", availableTimes: ["09:00", "10:00", "11:00", "14:00"] };
const event = (start, end, id = "e1") => ({
  id,
  start: { dateTime: `2030-07-15T${start}:00+01:00` },
  end: { dateTime: `2030-07-15T${end}:00+01:00` },
});

beforeEach(() => {
  jest.clearAllMocks();
  calendar.events.list.mockResolvedValue({ data: { items: [] } });
  calendar.events.insert.mockResolvedValue({ data: { id: "evt-new" } });
  calendar.events.update.mockResolvedValue({ data: {} });
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

describe("formatDuration", () => {
  it.each([[60, "1h"], [90, "1h 30m"], [120, "2h"], [45, "45 min"], [135, "2h 15m"]])("%i → %s", (m, s) => {
    expect(formatDuration(m)).toBe(s);
  });
});

describe("calendar events use the lesson's length", () => {
  it("a 2-hour lesson gets a 2-hour event", async () => {
    await calendarService.createEvent({ date: "2030-07-15", time: "14:00", userPhone: "1", durationMin: 120 }, INSTRUCTOR);
    const r = calendar.events.insert.mock.calls[0][0].resource;
    expect(r.start.dateTime).toContain("2030-07-15T14:00:00");
    expect(r.end.dateTime).toContain("2030-07-15T16:00:00");
  });

  it("moving a 90-minute lesson keeps it 90 minutes", async () => {
    await calendarService.updateEvent("evt-1", { newDate: "2030-07-15", newTime: "10:00", durationMin: 90 }, INSTRUCTOR);
    const r = calendar.events.update.mock.calls[0][0].resource;
    expect((new Date(r.end.dateTime) - new Date(r.start.dateTime)) / 60000).toBe(90);
  });

  it("without a length, uses the instructor's old single length", async () => {
    await calendarService.createEvent({ date: "2030-07-15", time: "14:00", userPhone: "1" }, { ...INSTRUCTOR, routeSettings: { lessonDurationMin: 90 } });
    const r = calendar.events.insert.mock.calls[0][0].resource;
    expect(r.end.dateTime).toContain("2030-07-15T15:30:00");
  });

  it("busy blocks are the day's events in minutes, skipping the lessons' own", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [event("10:00", "11:30", "dentist"), event("14:00", "15:00", "lesson")] } });
    const blocks = await calendarService.getBusyBlocks("2030-07-15", INSTRUCTOR, new Set(["lesson"]));
    expect(blocks).toEqual([{ start: 600, end: 690, kind: "block", label: "Busy" }]);
  });
});

describe("booking checks use the lesson's length", () => {
  it("a 2-hour lesson at 10:00 clashes with an event at 11:30", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [event("11:30", "12:00")] } });
    const short = await bookingService.validateBooking({ date: "2030-07-15", time: "10:00" }, INSTRUCTOR, { durationMin: 60 });
    const long = await bookingService.validateBooking({ date: "2030-07-15", time: "10:00" }, INSTRUCTOR, { durationMin: 120 });
    expect(short).toEqual([]);
    expect(long.join(" ")).toMatch(/already booked/);
  });

  it("a 90-minute lesson at 10:00 clashes with an event at 11:00", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [event("11:00", "12:00")] } });
    const errors = await bookingService.validateBooking({ date: "2030-07-15", time: "10:00" }, INSTRUCTOR, { durationMin: 90 });
    expect(errors.join(" ")).toMatch(/already booked/);
  });

  it("moving a lesson ignores its own calendar event", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [event("10:00", "11:00", "own")] } });
    const errors = await bookingService.validateBooking({ date: "2030-07-15", time: "10:00" }, INSTRUCTOR, { durationMin: 60, ignoreEventId: "own" });
    expect(errors).toEqual([]);
  });
});

describe("Portal bookings", () => {
  let server;
  let base;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.instructor = INSTRUCTOR;
      next();
    });
    app.use("/api/learners", require("../../src/routes/learners"));
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}/api/learners`;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });

  const User = require("../../src/models/userModel");
  const post = (body) =>
    fetch(`${base}/bookings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(() => {
    User.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ name: "Jane", postalCode: "ST5" }) }) });
    LessonType.findOne.mockReturnValue({ lean: () => ({ catch: () => Promise.resolve({ _id: "t120", name: "Beginner", durationMin: 120, price: 80 }) }) });
    Booking.create.mockImplementation(async (doc) => ({ ...doc, _id: "b1" }));
    Booking.updateOne = jest.fn().mockResolvedValue({});
  });

  it("stores the lesson type's length, name and price", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([]) });
    const { status, body } = await post({ userPhone: "4471", date: "2030-07-15", time: "14:00", lessonTypeId: "t120" });
    expect(status).toBe(201);
    expect(Booking.create.mock.calls[0][0]).toMatchObject({ durationMin: 120, lessonTypeName: "Beginner", price: 80 });
    expect(body.data.durationMin).toBe(120);
    const r = calendar.events.insert.mock.calls[0][0].resource;
    expect(r.end.dateTime).toContain("16:00:00");
  });

  it("refuses a lesson that overlaps another one", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([{ time: "15:00", durationMin: 60 }]) });
    const { status, body } = await post({ userPhone: "4471", date: "2030-07-15", time: "14:00", lessonTypeId: "t120" });
    expect(status).toBe(409);
    expect(body.error).toBe("That overlaps the 3:00 pm lesson on 2030-07-15");
    expect(Booking.create).not.toHaveBeenCalled();
  });

  it("an older booking without a length still counts with the old single length", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([{ time: "13:30" }]) });
    const { status } = await post({ userPhone: "4471", date: "2030-07-15", time: "14:00" });
    expect(status).toBe(409);
  });
});

describe("the AI knows each lesson's length", () => {
  const types = [
    { _id: "t120", name: "Beginner", durationMin: 120, price: 80, description: "" },
    { _id: "t60", name: "Novice", durationMin: 60, price: 40, description: "" },
  ];

  it("lists lessons with their length and price", () => {
    const prompt = aiService.getSystemPrompt(INSTRUCTOR, null, types);
    expect(prompt).toContain("- Beginner (2h): £80");
    expect(prompt).toContain("- Novice (1h): £40");
    expect(prompt).toContain("Each lesson is set by the lesson type");
  });

  it("in packed mode doesn't list fixed start times", () => {
    const prompt = aiService.getSystemPrompt({ ...INSTRUCTOR, botSettings: { scheduleMode: "packed" } }, null, types);
    expect(prompt).toContain("worked out for each day from the lesson length");
    expect(prompt).not.toContain("09:00, 10:00, 11:00, 14:00");
  });

  it("uses the length of the lesson picked in this chat, else the usual one, else the only one", async () => {
    jest.spyOn(aiService, "_lessonTypesFor").mockResolvedValue(types);
    delete aiService.pendingContext["4471"];
    expect(await aiService._lessonLengthFor("4471", INSTRUCTOR)).toBeNull();
    expect(await aiService._lessonLengthFor("4471", INSTRUCTOR, { schedulingPrefs: { defaultLessonTypeId: "t60" } })).toBe(60);
    aiService.setPendingLessonType("4471", types[0]);
    expect(await aiService._lessonLengthFor("4471", INSTRUCTOR)).toBe(120);
    delete aiService.pendingContext["4471"];
    aiService._lessonTypesFor.mockResolvedValue([types[1]]);
    expect(await aiService._lessonLengthFor("4471", INSTRUCTOR)).toBe(60);
  });

  it("understands the START_BOOKING action", () => {
    const parsed = aiService.extractActions('Sure!\n[ACTION:START_BOOKING]\n{"lessonType": "Novice"}');
    expect(parsed).toMatchObject({ actionType: "start_booking", bookingData: { lessonType: "Novice" }, responseText: "Sure!" });
  });
});

describe("migrating existing data", () => {
  const inst = { phoneNumberId: "a", routeSettings: { lessonDurationMin: 90 } };

  it("gives the first type the old length, switches off the rest, and adds missing defaults", () => {
    const plan = planMigration({
      instructors: [inst],
      lessonTypes: [
        { _id: "t1", instructorId: "a", name: "Standard", price: 40, sortOrder: 0 },
        { _id: "t2", instructorId: "a", name: "Motorway", price: 55, sortOrder: 1 },
      ],
      bookings: [],
    });
    expect(plan.typeUpdates).toEqual([
      { _id: "t1", set: { durationMin: 90 } },
      { _id: "t2", set: { active: false, name: "Motorway (needs a length)" } },
    ]);
    expect(plan.newTypes.map((t) => [t.name, t.durationMin])).toEqual([["Beginner", 120], ["Novice", 60]]);
  });

  it("gives bookings their lesson type's length, else the old length", () => {
    const plan = planMigration({
      instructors: [inst],
      lessonTypes: [{ _id: "t9", instructorId: "a", name: "Long", price: 90, durationMin: 150, active: true }],
      bookings: [
        { _id: "b1", instructorId: "a", lessonTypeId: "t9" },
        { _id: "b2", instructorId: "a" },
      ],
    });
    expect(plan.bookingUpdates).toEqual([{ _id: "b1", durationMin: 150 }, { _id: "b2", durationMin: 90 }]);
  });

  it("leaves instructors who already have every default alone", () => {
    const plan = planMigration({
      instructors: [inst],
      lessonTypes: [
        { _id: "x", instructorId: "a", name: "Beginner", price: 80, durationMin: 120, active: true },
        { _id: "y", instructorId: "a", name: "Moderate", price: 60, durationMin: 90, active: true },
        { _id: "z", instructorId: "a", name: "Novice", price: 40, durationMin: 60, active: true },
      ],
      bookings: [],
    });
    expect(plan).toEqual({ typeUpdates: [], newTypes: [], bookingUpdates: [] });
  });
});
