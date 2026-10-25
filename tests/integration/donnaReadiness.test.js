/**
 * When Donna can be on: setup filled in, a WhatsApp number and a working
 * Google Calendar. When Google access expires she pauses by herself (one email
 * to the instructor), the dashboard says why, and she resumes on reconnect.
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/models/paymentModel");
jest.mock("../../src/models/chatLogModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/utils/emailNotifier", () => ({
  sendNotification: jest.fn().mockResolvedValue(true),
  notifyInvalidGrant: jest.fn().mockResolvedValue(true),
  notifyInstructorReauth: jest.fn().mockResolvedValue(true),
  notifyInstructorLearnerMessage: jest.fn().mockResolvedValue(true),
}));

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const LessonType = require("../../src/models/lessonTypeModel");
const { getSetupStatus } = require("../../src/services/setupStatus");

const HOURS = { mon: ["09:00"], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
// Profile filled in, a real WhatsApp number and a connected calendar
const readyInstructor = (extra = {}) => ({
  _id: "inst-oid",
  email: "sam@test.com",
  name: "Sam",
  phoneNumberId: "1091956790670453",
  googleRefreshToken: "rt",
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  botSettings: { workingHours: HOURS, donnaEnabled: true },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  LessonType.countDocuments = jest.fn().mockResolvedValue(1);
});

describe("setup status: when Donna can be on", () => {
  it("ready with the profile, a WhatsApp number and a working calendar", async () => {
    const s = await getSetupStatus(readyInstructor());
    expect(s).toMatchObject({ complete: true, ready: true, blockers: [], calendarExpired: false });
  });

  it("the profile alone isn't enough: the number and calendar are still to do, in that order", async () => {
    const s = await getSetupStatus(readyInstructor({ phoneNumberId: "signup_abc", googleRefreshToken: undefined }));
    expect(s.complete).toBe(true); // can request a number
    expect(s.ready).toBe(false);
    expect(s.blockers.map((b) => b.key)).toEqual(["number", "calendar"]);
  });

  it("an expired calendar blocks her until it's reconnected", async () => {
    const s = await getSetupStatus(readyInstructor({ calendarTokenExpired: true }));
    expect(s).toMatchObject({ ready: false, calendarExpired: true });
    expect(s.blockers[0]).toMatchObject({ key: "calendarExpired", link: "/dashboard" });
  });

  it("profile gaps come first", async () => {
    LessonType.countDocuments.mockResolvedValue(0);
    const s = await getSetupStatus(readyInstructor({ phoneNumberId: "signup_abc" }));
    expect(s.blockers.map((b) => b.key)).toEqual(["lessonTypes", "number"]);
  });

  it("in packed mode, working hours count when the day hours are set", async () => {
    const s = await getSetupStatus(
      readyInstructor({ botSettings: { scheduleMode: "packed", dayHours: { mon: { start: "08:00", end: "17:00" } } } })
    );
    expect(s.required.find((r) => r.key === "workingHours").done).toBe(true);
  });
});

describe("the Donna switch (dashboard API)", () => {
  let instructor;
  let savedDoc;
  let server;
  let baseUrl;

  beforeAll((done) => {
    process.env.JWT_SECRET = "test-secret";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { email: "sam@test.com" };
      next();
    });
    app.use("/api/dashboard", require("../../src/routes/dashboard"));
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
    instructor = readyInstructor();
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
  });

  const call = async (method, path, body) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  it("turns on when everything is ready", async () => {
    instructor.botSettings.donnaEnabled = false;
    const { status, body } = await call("PATCH", "/settings", { botSettings: { donnaEnabled: true } });
    expect(status).toBe(200);
    expect(body.data.botSettings.donnaEnabled).toBe(true);
  });

  it.each([
    ["no WhatsApp number yet", { phoneNumberId: "signup_abc" }, "get your WhatsApp number"],
    ["no Google Calendar", { googleRefreshToken: undefined }, "connect your Google Calendar"],
    ["Google access expired", { calendarTokenExpired: true }, "reconnect your Google Calendar"],
  ])("won't turn on with %s, and says what to do", async (_label, change, says) => {
    Object.assign(instructor, change);
    instructor.botSettings.donnaEnabled = false;
    const { status, body } = await call("PATCH", "/settings", { botSettings: { donnaEnabled: true } });
    expect(status).toBe(409);
    expect(body.code).toBe("SETUP_INCOMPLETE");
    expect(body.error).toContain(says);
    expect(savedDoc.save).not.toHaveBeenCalled();
  });

  it("shows as off and paused while Google access has expired, without forgetting it was on", async () => {
    instructor.calendarTokenExpired = true;
    const { body } = await call("GET", "/settings");
    expect(body.data.botSettings.donnaEnabled).toBe(false);
    expect(body.data.donnaPausedForCalendar).toBe(true);
    expect(body.data.setup.blockers[0].key).toBe("calendarExpired");
  });

  it("shows as on again once reconnected", async () => {
    const { body } = await call("GET", "/settings");
    expect(body.data.botSettings.donnaEnabled).toBe(true);
    expect(body.data.donnaPausedForCalendar).toBe(false);
  });
});

describe("when Google access expires", () => {
  it("Donna is paused and the instructor is emailed once, not on every failed call", async () => {
    jest.resetModules();
    jest.doMock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
    const mail = { notifyInvalidGrant: jest.fn(), notifyInstructorReauth: jest.fn() };
    jest.doMock("../../src/utils/emailNotifier", () => mail);
    const invalidate = jest.fn();
    jest.doMock("../../src/models/instructorModel", () => ({ invalidateInstructorCache: invalidate }));
    const google = require("../../src/config/google");
    jest.spyOn(google.calendar.events, "list").mockRejectedValue(new Error("invalid_grant"));
    const Inst = require("../../src/models/instructorSchema");
    let flagged = false;
    Inst.findOneAndUpdate = jest.fn(async () => {
      if (flagged) return null;
      flagged = true;
      return {};
    });
    const calendarService = require("../../src/services/calendarService");
    const inst = readyInstructor();

    await expect(calendarService.getEventsForDate("2030-06-17", inst)).rejects.toThrow("invalid_grant");
    await new Promise((r) => setImmediate(r));
    await expect(calendarService.getEventsForDate("2030-06-18", inst)).rejects.toThrow("invalid_grant");
    await new Promise((r) => setImmediate(r));

    expect(Inst.findOneAndUpdate.mock.calls[0][1]).toEqual({ $set: { calendarTokenExpired: true } });
    expect(inst.calendarTokenExpired).toBe(true); // this message already sees it
    expect(invalidate).toHaveBeenCalledWith(inst.phoneNumberId);
    expect(mail.notifyInstructorReauth).toHaveBeenCalledTimes(1);
    expect(mail.notifyInvalidGrant).toHaveBeenCalledTimes(1);
  });
});
