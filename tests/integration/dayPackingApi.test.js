/**
 * Dashboard API for packing the day: packed-mode settings, POST /day-preview,
 * and lesson types having their own (distinct) lengths.
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

const leanOf = (v) => ({ lean: () => Promise.resolve(v) });
const sortedLeanOf = (v) => ({ sort: () => leanOf(v) });

describe("packed-mode settings", () => {
  it("switching to packed keeps the working days the start-time chips implied", async () => {
    const { status, body } = await call("PATCH", "/settings", { botSettings: { scheduleMode: "packed" } });
    expect(status).toBe(200);
    expect(savedDoc.botSettings.dayHours.mon).toEqual({ start: "09:00", end: "15:00" });
    expect(savedDoc.botSettings.dayHours.sat).toBeNull();
    expect(body.data.botSettings.scheduleMode).toBe("packed");
    expect(body.data.botSettings.dayHours.mon).toEqual({ start: "09:00", end: "15:00" });
  });

  it("saves X, the variance, day hours and lunch", async () => {
    const dayHours = { mon: { start: "08:00", end: "18:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null };
    const { status } = await call("PATCH", "/settings", {
      routeSettings: { bufferMin: 25, driveVarianceMin: 5 },
      botSettings: { scheduleMode: "packed", dayHours, lunch: { durationMin: 30, windowFrom: "12:30", windowTo: "13:30" } },
    });
    expect(status).toBe(200);
    expect(savedDoc.routeSettings.bufferMin).toBe(25);
    expect(savedDoc.botSettings.dayHours).toEqual(dayHours);
    expect(savedDoc.botSettings.lunch).toMatchObject({ enabled: true, durationMin: 30, windowFrom: "12:30", windowTo: "13:30" });
  });

  it("saving the Route section sends back what it loaded, and that's accepted (older settings, learned gap)", async () => {
    // The popup bug: an older instructor (no longest drive yet) whom Donna has learned a gap for
    instructor.routeSettings = { bufferMin: 20, maxDriveMin: null, autoBufferMin: 15, autoBufferSamples: 12, autoBufferAt: new Date().toISOString() };
    const { body: loaded } = await call("GET", "/settings");
    expect(loaded.data.routeSettings.maxDriveMin).toBe(40);
    expect(Object.keys(loaded.data.routeSettings)).not.toEqual(expect.arrayContaining(["autoBufferMin"]));

    // Change the service area radius and save the whole route draft, as the dashboard does
    const route = { ...loaded.data.routeSettings, serviceArea: { ...loaded.data.routeSettings.serviceArea, radius: 15 } };
    const { status, body } = await call("PATCH", "/settings", { routeSettings: route });
    expect(body.error).toBeUndefined();
    expect(status).toBe(200);
    expect(savedDoc.routeSettings.serviceArea.radius).toBe(15);
    // The learned gap is kept
    expect(savedDoc.routeSettings.autoBufferMin).toBe(15);
  });

  it("an empty longest drive is accepted (Donna works it out from the older setting)", async () => {
    const { status } = await call("PATCH", "/settings", { routeSettings: { maxDriveMin: null } });
    expect(status).toBe(200);
  });

  it("saves the longest drive, and sends back the usual gap Donna works out", async () => {
    const { status, body } = await call("PATCH", "/settings", { routeSettings: { maxDriveMin: 50 } });
    expect(status).toBe(200);
    expect(savedDoc.routeSettings.maxDriveMin).toBe(50);
    expect(body.data.packing).toMatchObject({ maxDriveMin: 50, bufferMin: 25, bufferSource: "default" });
  });

  it.each([
    [{ routeSettings: { maxDriveMin: 61 } }, "maxDriveMin"],
    [{ routeSettings: { maxDriveMin: 11 } }, "maxDriveMin"],
    [{ routeSettings: { autoBufferMin: 5 } }, "autoBufferMin"],
    [{ routeSettings: { bufferMin: 50 } }, "bufferMin"],
    [{ routeSettings: { bufferMin: 10 } }, "bufferMin"],
    [{ routeSettings: { driveVarianceMin: 20 } }, "driveVarianceMin"],
    [{ botSettings: { scheduleMode: "loose" } }, "scheduleMode"],
    [{ botSettings: { dayHours: { mon: { start: "18:00", end: "08:00" } } } }, "dayHours.mon"],
    [{ botSettings: { lunch: { durationMin: 120 } } }, "lunch.durationMin"],
  ])("rejects %j", async (body, field) => {
    const { status, body: res } = await call("PATCH", "/settings", body);
    expect(status).toBe(400);
    expect(res.error).toContain(field);
  });

  it("rejects a lunch window shorter than the lunch", async () => {
    const { status, body } = await call("PATCH", "/settings", {
      botSettings: { lunch: { durationMin: 60, windowFrom: "12:00", windowTo: "12:30" } },
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/shorter than a 60-minute lunch/);
  });
});

describe("POST /day-preview", () => {
  beforeEach(() => {
    LessonType.find.mockReturnValue(sortedLeanOf([
      { _id: "t1", name: "Novice", durationMin: 60, price: 40 },
      { _id: "t2", name: "Moderate", durationMin: 90, price: 60 },
      { _id: "t3", name: "Beginner", durationMin: 120, price: 80 },
    ]));
  });

  it("counts the lessons of each type that fit, with lunch", async () => {
    const { status, body } = await call("POST", "/day-preview", {
      maxDriveMin: 30, // X = half of it: 15
      dayHours: { start: "08:00", end: "18:00" },
      lunch: { enabled: true, durationMin: 45, windowFrom: "12:00", windowTo: "14:00" },
    });
    expect(status).toBe(200);
    const novice = body.data.days.find((d) => d.durationMin === 60);
    expect(novice).toMatchObject({ name: "Novice", count: 7, lunch: { from: "12:45", to: "13:30" } });
    expect(novice.starts[0]).toBe("08:00");
    expect(body.data.days.map((d) => d.durationMin)).toEqual([60, 90, 120]);
  });

  it("a longer longest-drive (so a bigger usual gap) fits fewer lessons", async () => {
    const day = { start: "08:00", end: "18:00" };
    const tight = await call("POST", "/day-preview", { maxDriveMin: 20, dayHours: day });
    const relaxed = await call("POST", "/day-preview", { maxDriveMin: 60, dayHours: day });
    const count = (r) => r.body.data.days.find((d) => d.durationMin === 60).count;
    expect(count(relaxed)).toBeLessThan(count(tight));
  });

  it("checks the draft values", async () => {
    expect((await call("POST", "/day-preview", { maxDriveMin: 99 })).status).toBe(400);
    expect((await call("POST", "/day-preview", { dayHours: { start: "18:00", end: "09:00" } })).status).toBe(400);
  });

  it("uses 1h, 1.5h and 2h when there are no lesson types yet", async () => {
    LessonType.find.mockReturnValue(sortedLeanOf([]));
    const { body } = await call("POST", "/day-preview", { maxDriveMin: 40 });
    expect(body.data.days.map((d) => d.durationMin)).toEqual([60, 90, 120]);
  });
});

describe("lesson types have their own length", () => {
  beforeEach(() => {
    LessonType.findOne.mockImplementation(() => ({
      sort: () => ({ select: () => leanOf(null) }),
      lean: () => Promise.resolve(null),
    }));
    LessonType.create.mockImplementation(async (doc) => ({ _id: "new", ...doc }));
  });

  it("needs a length", async () => {
    const { status, body } = await call("POST", "/lesson-types", { name: "Motorway", price: 55 });
    expect(status).toBe(400);
    expect(body.error).toMatch(/length/);
  });

  it("checks the length is 30 min to 3 hours in 15-minute steps", async () => {
    for (const durationMin of [20, 200, 70]) {
      const { status } = await call("POST", "/lesson-types", { name: "X", price: 1, durationMin });
      expect(status).toBe(400);
    }
  });

  it("creates one with a free length", async () => {
    const { status, body } = await call("POST", "/lesson-types", { name: "Motorway", price: 55, durationMin: 150 });
    expect(status).toBe(201);
    expect(body.data.durationMin).toBe(150);
  });

  it("refuses a second active type with the same length", async () => {
    LessonType.findOne.mockImplementation((q) => ({
      sort: () => ({ select: () => leanOf(null) }),
      lean: () => Promise.resolve(q.durationMin === 60 ? { _id: "t1", name: "Novice", durationMin: 60 } : null),
    }));
    const { status, body } = await call("POST", "/lesson-types", { name: "Standard", price: 40, durationMin: 60 });
    expect(status).toBe(409);
    expect(body.error).toBe('"Novice" is already 1h long. Each lesson type needs a different length.');
  });

  it("refuses changing a type to a length another active type has", async () => {
    LessonType.findOne.mockImplementation((q) => ({
      lean: () => Promise.resolve(
        q._id === "t2" ? { _id: "t2", name: "Moderate", durationMin: 90, active: true }
          : q.durationMin === 60 ? { _id: "t1", name: "Novice", durationMin: 60 } : null
      ),
    }));
    const { status } = await call("PATCH", "/lesson-types/t2", { durationMin: 60 });
    expect(status).toBe(409);
  });

  it("refuses switching a type back on when its length is taken", async () => {
    LessonType.findOne.mockImplementation((q) => ({
      lean: () => Promise.resolve(
        q._id === "t4" ? { _id: "t4", name: "Old", durationMin: 60, active: false }
          : q.durationMin === 60 ? { _id: "t1", name: "Novice", durationMin: 60 } : null
      ),
    }));
    const { status } = await call("PATCH", "/lesson-types/t4", { active: true });
    expect(status).toBe(409);
  });

  it("allows the same length on an inactive type", async () => {
    LessonType.findOne.mockImplementation(() => ({ lean: () => Promise.resolve({ _id: "t4", durationMin: 60, active: true }) }));
    LessonType.findOneAndUpdate.mockResolvedValue({ _id: "t4", active: false });
    const { status } = await call("PATCH", "/lesson-types/t4", { active: false });
    expect(status).toBe(200);
  });
});
