/**
 * Setup before requesting a WhatsApp number, and what happens on assignment:
 *  - setup status: home address, working hours, at least one lesson type
 *  - POST /api/phone-numbers/request refuses until setup is complete
 *  - assignment falls back to any region, uses the freshest token, and moves
 *    everything stored under the temporary signup_… id to the real number
 *  - the Donna on/off switch is accepted by PATCH /settings
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/phoneNumberModel");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/paymentModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/models/waitlistEntryModel");
jest.mock("../../src/models/conversationSessionModel");

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const PhoneNumber = require("../../src/models/phoneNumberModel");
const LessonType = require("../../src/models/lessonTypeModel");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const { getSetupStatus } = require("../../src/services/setupStatus");
const phoneNumberService = require("../../src/services/phoneNumberService");

const HOURS = { mon: ["09:00"], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] };
const ready = (extra = {}) => ({
  _id: "inst-oid",
  email: "sam@test.com",
  name: "Sam",
  phoneNumberId: "signup_abc",
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  botSettings: { workingHours: HOURS },
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  LessonType.countDocuments = jest.fn().mockResolvedValue(1);
  for (const M of [LessonType, Booking, User, require("../../src/models/paymentModel"), require("../../src/models/notificationModel"),
    require("../../src/models/waitlistEntryModel"), require("../../src/models/conversationSessionModel")]) {
    M.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
  }
  delete process.env.WHATSAPP_TOKEN;
});

// ═══════════════════════════════════════════════════════════════════════════
describe("setup status", () => {
  it("is complete with an address, working hours and a lesson type", async () => {
    const s = await getSetupStatus(ready());
    expect(s.complete).toBe(true);
    expect(s.missing).toEqual([]);
    expect(s.hasNumber).toBe(false);
  });

  it.each([
    ["address", { baseLocation: undefined }, "Your home or base address"],
    ["working hours never saved", { botSettings: {} }, "Your working days and lesson times"],
    ["every day off", { botSettings: { workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } } }, "Your working days and lesson times"],
  ])("lists what's missing: %s", async (_label, change, missing) => {
    const s = await getSetupStatus(ready(change));
    expect(s.complete).toBe(false);
    expect(s.missing).toContain(missing);
  });

  it("needs at least one active lesson type", async () => {
    LessonType.countDocuments.mockResolvedValue(0);
    const s = await getSetupStatus(ready());
    expect(s.missing).toEqual(["At least one lesson type with a price"]);
    expect(LessonType.countDocuments).toHaveBeenCalledWith({ instructorId: "signup_abc", active: true });
  });

  it("knows when a number is assigned and the calendar is connected", async () => {
    const s = await getSetupStatus(ready({ phoneNumberId: "1091956790670453", googleRefreshToken: "rt" }));
    expect(s).toMatchObject({ hasNumber: true, calendarConnected: true });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("POST /api/phone-numbers/request", () => {
  let server;
  let url;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { email: "sam@test.com" }; next(); });
    app.use("/api/phone-numbers", require("../../src/routes/phoneNumbers"));
    server = app.listen(0, () => {
      url = `http://127.0.0.1:${server.address().port}/api/phone-numbers/request`;
      done();
    });
  });
  afterAll((done) => {
    server.close(done);
  });
  const request = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(async (r) => ({ status: r.status, body: await r.json() }));

  it("refuses until Donna Settings are filled in, saying what's missing", async () => {
    Instructor.findOne.mockResolvedValue(ready({ baseLocation: undefined }));
    const res = await request();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SETUP_INCOMPLETE");
    expect(res.body.error).toMatch(/your home or base address/);
    expect(res.body.setup.missing).toEqual(["Your home or base address"]);
    expect(PhoneNumber.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("refuses a driving school owner (their instructors each get a number)", async () => {
    Instructor.findOne.mockResolvedValue(ready({ plan: "driving-school", schoolRole: "owner" }));
    const res = await request();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SCHOOL_OWNER");
    expect(PhoneNumber.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("still gives an instructor in a school their own number", async () => {
    Instructor.findOne.mockResolvedValue(ready({ plan: "driving-school", schoolRole: "member" }));
    Instructor.findById.mockReturnValue({ lean: async () => ready() });
    PhoneNumber.findOne.mockReturnValue({ lean: async () => null });
    PhoneNumber.findOneAndUpdate.mockResolvedValue({ phoneNumber: "+15556393643", phoneNumberId: "1091956790670453", whatsappToken: "pool-token" });
    expect((await request()).status).toBe(200);
  });

  it("assigns a number once setup is complete", async () => {
    Instructor.findOne.mockResolvedValue(ready());
    Instructor.findById.mockReturnValue({ lean: async () => ready() });
    PhoneNumber.findOne.mockReturnValue({ lean: async () => null });
    PhoneNumber.findOneAndUpdate.mockResolvedValue({ phoneNumber: "+15556393643", phoneNumberId: "1091956790670453", whatsappToken: "pool-token" });
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.body.phoneNumber).toBe("+15556393643");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("assigning a number", () => {
  beforeEach(() => {
    PhoneNumber.findOne.mockReturnValue({ lean: async () => null });
    Instructor.findById.mockReturnValue({ lean: async () => ready() });
  });

  it("falls back to a number in another region when none match", async () => {
    const usNumber = { phoneNumber: "+15556393643", phoneNumberId: "1091956790670453", whatsappToken: "pool-token", region: "US" };
    PhoneNumber.findOneAndUpdate.mockResolvedValueOnce(null).mockResolvedValueOnce(usNumber);
    const result = await phoneNumberService.assignNumber("inst-oid", { region: "GB" });
    expect(result).toBe(usNumber);
    expect(PhoneNumber.findOneAndUpdate.mock.calls[0][0]).toEqual({ status: "available", region: "GB" });
    expect(PhoneNumber.findOneAndUpdate.mock.calls[1][0]).toEqual({ status: "available" });
  });

  it("gives the instructor the pool's (freshest) token, falling back to the env token", async () => {
    process.env.WHATSAPP_TOKEN = "env-token";
    PhoneNumber.findOneAndUpdate.mockResolvedValue({ phoneNumber: "+1", phoneNumberId: "real-1", whatsappToken: "pool-token" });
    await phoneNumberService.assignNumber("inst-oid");
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("inst-oid", expect.objectContaining({ whatsappToken: "pool-token" }));

    Instructor.findByIdAndUpdate.mockClear();
    PhoneNumber.findOneAndUpdate.mockResolvedValue({ phoneNumber: "+1", phoneNumberId: "real-1", whatsappToken: null });
    await phoneNumberService.assignNumber("inst-oid");
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("inst-oid", expect.objectContaining({ whatsappToken: "env-token" }));
  });

  it("moves lesson types, learners and bookings made before the number to the real number", async () => {
    PhoneNumber.findOneAndUpdate.mockResolvedValue({ phoneNumber: "+1", phoneNumberId: "real-1", whatsappToken: "t" });
    await phoneNumberService.assignNumber("inst-oid");
    for (const M of [LessonType, Booking, User]) {
      expect(M.updateMany).toHaveBeenCalledWith({ instructorId: "signup_abc" }, { $set: { instructorId: "real-1" } });
    }
  });

  it("moves them to the placeholder when a number is revoked", async () => {
    const doc = { status: "assigned", assignedTo: "inst-oid", phoneNumberId: "real-1", save: jest.fn() };
    PhoneNumber.findById.mockResolvedValue(doc);
    await phoneNumberService.revokeNumber("pn-1");
    const [[filter, update]] = LessonType.updateMany.mock.calls;
    expect(filter).toEqual({ instructorId: "real-1" });
    expect(update.$set.instructorId).toMatch(/^signup_/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Donna on/off setting", () => {
  const { validateSettingsUpdate } = require("../../src/services/settingsValidation");
  const settings = require("../../src/services/instructorSettings");

  it("is on by default", () => {
    expect(settings.resolveBotSettings({}).donnaEnabled).toBe(true);
  });

  it("can be switched off through the settings API", () => {
    const { errors, botSettings } = validateSettingsUpdate({ botSettings: { donnaEnabled: false } });
    expect(errors).toEqual([]);
    expect(botSettings).toEqual({ donnaEnabled: false });
  });

  it("rejects anything but true/false", () => {
    const { errors } = validateSettingsUpdate({ botSettings: { donnaEnabled: "off" } });
    expect(errors.join(" ")).toMatch(/donnaEnabled must be true or false/);
  });
});
