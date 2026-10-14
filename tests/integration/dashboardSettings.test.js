/**
 * Dashboard settings API: GET/PATCH /settings, PATCH /learners/:phone/preferences,
 * POST /route-preview. Uses the real route optimiser with mocked models and
 * mocked Google services (drive times fall back to straight-line estimates).
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/models/paymentModel");
jest.mock("../../src/models/chatLogModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/services/mapsService", () => ({ getCoordinatesFromPostalCode: jest.fn() }));
jest.mock("../../src/services/calendarService", () => ({ getAvailableTimeSlotsForDate: jest.fn() }));
jest.mock("../../src/services/distanceMatrixService", () => ({
  getDrivingMatrix: jest.fn(async (o, d) => o.map(() => d.map(() => null))),
}));

const express = require("express");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const Instructor = require("../../src/models/instructorSchema");
const LessonType = require("../../src/models/lessonTypeModel");
const Notification = require("../../src/models/notificationModel");
const { getCoordinatesFromPostalCode } = require("../../src/services/mapsService");
const calendarService = require("../../src/services/calendarService");

const BASE = { latitude: 53.0168, longitude: -2.2191 };
let instructor;
let savedDoc;
let server;
let baseUrl;

beforeAll((done) => {
  process.env.JWT_SECRET = "test-secret";
  const router = require("../../src/routes/dashboard");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { email: "sam@test.com" };
    next();
  });
  app.use("/api/dashboard", router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/dashboard`;
    done();
  });
});

afterAll((done) => {
  delete process.env.JWT_SECRET;
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  instructor = {
    _id: "inst-oid",
    phoneNumberId: "inst-1",
    name: "Sam",
    email: "sam@test.com",
    availableTimes: ["09:00", "10:00", "11:00", "14:00"],
    baseLocation: BASE,
  };
  Instructor.findOne.mockReturnValue({ lean: () => Promise.resolve(instructor) });
  Instructor.findById.mockImplementation(async () => {
    savedDoc = {
      ...structuredClone(instructor),
      save: jest.fn(async function () {
        return this;
      }),
      toObject() {
        const { save, toObject, ...rest } = this;
        return rest;
      },
    };
    return savedDoc;
  });
  Booking.find.mockResolvedValue([]);
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ═══════════════════════════════════════════════════════════════════════════

describe("GET /settings", () => {
  it("returns defaults that match today's behaviour", async () => {
    const { status, body } = await call("GET", "/settings");
    expect(status).toBe(200);
    const d = body.data;
    expect(d.routeSettings).toMatchObject({ preset: "balanced", lessonDurationMin: 60, maxAddedDriveMin: 20 });
    expect(d.botSettings.workingHours.mon).toEqual(instructor.availableTimes);
    expect(d.botSettings.workingHours.sat).toEqual([]);
    expect(d.botSettings).toMatchObject({ minNoticeHours: 24, bookingWindowDays: 90, tone: "friendly", emojis: true });
    expect(d.hasBaseLocation).toBe(true);
    expect(d.presets.tight.maxAddedDriveMin).toBe(12);
  });
});

describe("PATCH /settings", () => {
  it("saves route and bot settings, merging nested values", async () => {
    instructor.routeSettings = { serviceArea: { radiusMiles: 10, postcodeDistricts: ["ST5"] } };
    instructor.botSettings = { holiday: { enabled: false, message: "Back soon" } };

    const { status, body } = await call("PATCH", "/settings", {
      routeSettings: { preset: "tight", serviceArea: { postcodeDistricts: ["st4", "ST4", "st6"] } },
      botSettings: {
        tone: "professional",
        maxLessonsPerDay: 5,
        holiday: { enabled: true, from: "2030-08-01", to: "2030-08-05" },
        workingHours: { mon: ["10:00", "09:00"], sat: ["09:00"] },
      },
    });

    expect(status).toBe(200);
    expect(savedDoc.save).toHaveBeenCalled();
    expect(savedDoc.routeSettings).toEqual({
      preset: "tight",
      serviceArea: { radiusMiles: 10, postcodeDistricts: ["ST4", "ST6"] },
    });
    expect(savedDoc.botSettings.holiday).toEqual({ enabled: true, message: "Back soon", from: "2030-08-01", to: "2030-08-05" });
    expect(savedDoc.botSettings.workingHours).toEqual({
      mon: ["09:00", "10:00"], tue: [], wed: [], thu: [], fri: [], sat: ["09:00"], sun: [],
    });
    expect(body.data.botSettings.tone).toBe("professional");
  });

  it.each([
    [{ colour: "blue" }, "Unknown setting: colour"],
    [{ routeSettings: { maxAddedDriveMin: 500 } }, "routeSettings.maxAddedDriveMin must be a whole number from 5 to 60"],
    [{ routeSettings: { lessonDurationMin: 50 } }, "in steps of 15"],
    [{ routeSettings: { preset: "turbo" } }, "routeSettings.preset must be one of"],
    [{ routeSettings: { serviceArea: { postcodeDistricts: ["NOPE1"] } } }, `"NOPE1" isn't a postcode district`],
    [{ botSettings: { tone: "sarcastic" } }, "botSettings.tone must be one of"],
    [{ botSettings: { breaks: [{ from: "13:00", to: "12:00" }] } }, "before its \"to\" time"],
    [{ botSettings: { workingHours: { mon: ["9am"] } } }, "botSettings.workingHours.mon must be a list"],
    [{ botSettings: { aboutLessons: "x".repeat(1001) } }, "at most 1000 characters"],
    [{ botSettings: { holiday: { from: "2030-08-05", to: "2030-08-01" } } }, "must end on or after it starts"],
    [{ botSettings: { secretMode: true } }, "Unknown setting: botSettings.secretMode"],
    [{ botSettings: { reminders: "hourly" } }, "botSettings.reminders must be one of: off, 24h, 24h+2h"],
    [{ botSettings: { lateCancellationFee: -5 } }, "botSettings.lateCancellationFee must be an amount"],
    [{ botSettings: { cancellationNoticeHours: 500 } }, "botSettings.cancellationNoticeHours must be a whole number from 0 to 168"],
    [{ botSettings: { notifications: { sms: true } } }, "Unknown setting: botSettings.notifications.sms"],
  ])("rejects %j", async (body, message) => {
    const res = await call("PATCH", "/settings", body);
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" | ")).toContain(message);
    expect(Instructor.findById).not.toHaveBeenCalled();
  });

  it("saves the service area radius in km and returns it as entered", async () => {
    instructor.routeSettings = { serviceArea: { radiusMiles: 10 } };
    const res = await call("PATCH", "/settings", { routeSettings: { serviceArea: { radius: 30, unit: "km" } } });
    expect(res.status).toBe(200);
    expect(savedDoc.routeSettings.serviceArea).toMatchObject({ radius: 30, unit: "km", radiusMiles: null });
    expect(res.body.data.routeSettings.serviceArea).toMatchObject({ radius: 30, unit: "km" });
  });

  it("shows an older miles-only radius as miles", async () => {
    instructor.routeSettings = { serviceArea: { radiusMiles: 12 } };
    const { body } = await call("GET", "/settings");
    expect(body.data.routeSettings.serviceArea).toEqual({ radius: 12, unit: "miles", postcodeDistricts: [] });
  });

  it("allows up to 80 km but only 50 miles", async () => {
    expect((await call("PATCH", "/settings", { routeSettings: { serviceArea: { radius: 80, unit: "km" } } })).status).toBe(200);
    const res = await call("PATCH", "/settings", { routeSettings: { serviceArea: { radius: 80, unit: "miles" } } });
    expect(res.status).toBe(400);
    expect(res.body.errors.join(" ")).toContain("1 to 50 miles");
  });

  it("requires dates when turning holiday mode on", async () => {
    const res = await call("PATCH", "/settings", { botSettings: { holiday: { enabled: true } } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/start and end date/);
  });

  it("geocodes the base address", async () => {
    getCoordinatesFromPostalCode.mockResolvedValue({ lat: 53.1, lng: -2.3, formattedAddress: "Newcastle ST5 1AB, UK" });
    const res = await call("PATCH", "/settings", { baseAddress: "ST5 1AB" });
    expect(res.status).toBe(200);
    expect(savedDoc.baseLocation).toEqual({ latitude: 53.1, longitude: -2.3 });
    expect(savedDoc.baseAddress).toBe("Newcastle ST5 1AB, UK");
  });

  it("reports an address it can't find", async () => {
    getCoordinatesFromPostalCode.mockRejectedValue(new Error("ZERO_RESULTS"));
    const res = await call("PATCH", "/settings", { baseAddress: "nowhere" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Couldn't find that address/);
  });

  it("clears the base location when the address is emptied", async () => {
    await call("PATCH", "/settings", { baseAddress: "" });
    expect(savedDoc.baseLocation).toBeUndefined();
    expect(savedDoc.baseAddress).toBe("");
  });
});

describe("PATCH /learners/:phone/preferences", () => {
  let learner;
  beforeEach(() => {
    learner = {
      phone: "447700000001",
      instructorId: "inst-1",
      schedulingPrefs: { savedPlaces: [{ label: "Home", address: "ST5 1AB", latitude: 53.0, longitude: -2.2 }] },
      save: jest.fn(),
    };
    User.findOne.mockResolvedValue(learner);
  });

  it("saves preferences and geocodes new saved places only", async () => {
    getCoordinatesFromPostalCode.mockResolvedValue({ lat: 53.05, lng: -2.25 });

    const { status, body } = await call("PATCH", "/learners/447700000001/preferences", {
      priority: true,
      maxLessonsPerWeek: 2,
      savedPlaces: [
        { label: "Home", address: "ST5 1AB" },
        { label: "College", address: "ST4 2DE" },
      ],
      unavailable: [{ days: [1, 1, 2], from: "09:00", to: "15:00" }],
    });

    expect(status).toBe(200);
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledTimes(1);
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST4 2DE");
    expect(learner.schedulingPrefs.savedPlaces).toEqual([
      { label: "Home", address: "ST5 1AB", latitude: 53.0, longitude: -2.2 },
      { label: "College", address: "ST4 2DE", latitude: 53.05, longitude: -2.25 },
    ]);
    expect(learner.schedulingPrefs.unavailable).toEqual([{ days: [1, 2], from: "09:00", to: "15:00" }]);
    expect(learner.save).toHaveBeenCalled();
    expect(body.data.priority).toBe(true);
    expect(body.data.savedPlaces[1]).toEqual({ label: "College", address: "ST4 2DE", located: true });
    expect(User.findOne).toHaveBeenCalledWith({ phone: "447700000001", instructorId: "inst-1" });
  });

  it("rejects a saved place it can't find", async () => {
    getCoordinatesFromPostalCode.mockRejectedValue(new Error("ZERO_RESULTS"));
    const res = await call("PATCH", "/learners/447700000001/preferences", {
      savedPlaces: [{ label: "Work", address: "nowhere at all" }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Couldn't find "nowhere at all"/);
    expect(learner.save).not.toHaveBeenCalled();
  });

  it("only accepts the instructor's own lesson types", async () => {
    LessonType.exists.mockResolvedValue(null);
    const res = await call("PATCH", "/learners/447700000001/preferences", {
      defaultLessonTypeId: "64b7f0c2a1b2c3d4e5f60718",
    });
    expect(res.status).toBe(400);
    expect(LessonType.exists).toHaveBeenCalledWith({ _id: "64b7f0c2a1b2c3d4e5f60718", instructorId: "inst-1" });
  });

  it("validates fields", async () => {
    const res = await call("PATCH", "/learners/447700000001/preferences", { maxLessonsPerWeek: 0, nickname: "J" });
    expect(res.status).toBe(400);
    expect(res.body.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("maxLessonsPerWeek"),
      "Unknown setting: nickname",
    ]));
  });

  it("returns 404 for someone else's learner", async () => {
    User.findOne.mockResolvedValue(null);
    const res = await call("PATCH", "/learners/447700000009/preferences", { priority: true });
    expect(res.status).toBe(404);
  });
});

describe("POST /route-preview", () => {
  beforeEach(() => {
    getCoordinatesFromPostalCode.mockResolvedValue({ lat: 53.2, lng: -2.45, formattedAddress: "Far Away, UK" });
    calendarService.getAvailableTimeSlotsForDate.mockResolvedValue(["09:00", "10:00", "11:00", "14:00"]);
  });

  it("shows which slots Donna would offer and why", async () => {
    const { status, body } = await call("POST", "/route-preview", { date: "2030-07-02", address: "ST10 1AA" });

    expect(status).toBe(200);
    const d = body.data;
    expect(d.location).toBe("Far Away, UK");
    expect(d.freeSlots).toEqual(["09:00", "10:00", "11:00", "14:00"]);
    expect(d.usedFallback).toBe(true); // ~25 km away: nothing within 20 min
    expect(d.offered).toHaveLength(3);
    expect(d.slots.map((s) => s.slot)).toEqual(["09:00", "10:00", "11:00", "14:00"]);
    expect(d.slots[0]).toEqual(expect.objectContaining({ feasible: true, reason: expect.stringContaining("from home") }));
    expect(typeof d.slots[0].addedDriveMin).toBe("number");
  });

  it("previews unsaved route settings", async () => {
    const { body } = await call("POST", "/route-preview", {
      date: "2030-07-02", address: "ST10 1AA", routeSettings: { preset: "custom", maxAddedDriveMin: 60 },
    });
    expect(body.data.usedFallback).toBe(false);
    expect(body.data.offered).toHaveLength(4);
  });

  it("explains a non-working day without checking the calendar", async () => {
    const { body } = await call("POST", "/route-preview", { date: "2030-07-06", address: "ST10 1AA" }); // Saturday
    expect(body.data.closedReason).toBe("not_working_day");
    expect(calendarService.getAvailableTimeSlotsForDate).not.toHaveBeenCalled();
  });

  it("reports whether the learner is inside the service area", async () => {
    instructor.routeSettings = { serviceArea: { radiusMiles: 5 } };
    const { body } = await call("POST", "/route-preview", { date: "2030-07-02", address: "ST10 1AA" });
    expect(body.data.serviceArea.inside).toBe(false);
  });

  it("validates the request", async () => {
    expect((await call("POST", "/route-preview", { date: "tomorrow", address: "ST5" })).status).toBe(400);
    expect((await call("POST", "/route-preview", { date: "2030-07-02", address: " " })).status).toBe(400);
    getCoordinatesFromPostalCode.mockRejectedValue(new Error("ZERO_RESULTS"));
    const res = await call("POST", "/route-preview", { date: "2030-07-02", address: "zzz" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Couldn't find/);
  });
});

describe("Notification settings", () => {
  it("defaults: 24h reminders, 48h notice, all alerts by email, handover on", async () => {
    const { body } = await call("GET", "/settings");
    expect(body.data.botSettings).toMatchObject({
      reminders: "24h",
      cancellationNoticeHours: 48,
      lateCancellationFee: null,
      notifications: { booked: true, cancelled: true, rescheduled: true, email: true },
      handover: true,
    });
  });

  it("merges partial notification changes", async () => {
    instructor.botSettings = { notifications: { booked: true, cancelled: true, rescheduled: true, email: true } };
    const res = await call("PATCH", "/settings", { botSettings: { notifications: { email: false }, lateCancellationFee: 35 } });
    expect(res.status).toBe(200);
    expect(savedDoc.botSettings.notifications).toEqual({ booked: true, cancelled: true, rescheduled: true, email: false });
    expect(savedDoc.botSettings.lateCancellationFee).toBe(35);
  });
});

describe("GET /notifications", () => {
  it("returns the instructor's recent notifications with client ids", async () => {
    const chain = { sort: () => chain, limit: () => chain, lean: () => Promise.resolve([
      { clientId: "notif-DL-1", type: "booked", message: "New booking", bookingId: "DL-1", learnerPhone: "4471", createdAt: new Date("2030-01-01") },
    ]) };
    Notification.find.mockReturnValue(chain);

    const { status, body } = await call("GET", "/notifications?since=2029-12-31T00:00:00Z");

    expect(status).toBe(200);
    expect(Notification.find).toHaveBeenCalledWith({ instructorId: "inst-1", createdAt: { $gt: new Date("2029-12-31T00:00:00Z") } });
    expect(body.data[0]).toMatchObject({ id: "notif-DL-1", type: "booked", message: "New booking" });
  });

  it("rejects a bad since", async () => {
    expect((await call("GET", "/notifications?since=yesterday")).status).toBe(400);
  });
});

describe("Geocoding outages", () => {
  it("says the lookup is broken instead of blaming the address", async () => {
    getCoordinatesFromPostalCode.mockRejectedValue(new Error("Geocoding failed: REQUEST_DENIED"));
    const res = await call("POST", "/route-preview", { date: "2030-07-02", address: "ST9 9DX" });
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/Address lookup isn't working/);
  });
});

describe("Learner balance", () => {
  const Payment = require("../../src/models/paymentModel");
  const chain = (rows) => ({ sort: () => ({ lean: () => Promise.resolve(rows) }) });

  function seed(payments) {
    User.findOne.mockReturnValue({ lean: () => Promise.resolve({ phone: "447700900001", instructorId: "inst-1", name: "Ria" }) });
    Booking.find.mockReturnValue(chain([
      { bookingId: "A1", date: "2030-01-01", time: "09:00", status: "completed", price: 35 },
      { bookingId: "A2", date: "2030-01-08", time: "09:00", status: "completed", price: 55 },
      { bookingId: "A3", date: "2030-01-15", time: "09:00", status: "confirmed", price: 35 },
    ]));
    Payment.find.mockReturnValue(chain(payments));
  }

  it("shows money paid ahead as credit, not just £0 outstanding", async () => {
    seed([{ paymentId: "P1", amount: 150, date: "2030-01-01" }]);
    const { status, body } = await call("GET", "/learners/447700900001");
    expect(status).toBe(200);
    expect(body.data).toMatchObject({ totalPaid: 150, totalCharged: 90, outstanding: 0, credit: 60 });
  });

  it("shows what's owed when they're behind", async () => {
    seed([{ paymentId: "P1", amount: 35, date: "2030-01-01" }]);
    const { body } = await call("GET", "/learners/447700900001");
    expect(body.data).toMatchObject({ outstanding: 55, credit: 0 });
  });
});
