/**
 * Adding a learner from the Portal: saved in WhatsApp's number format and
 * welcomed on WhatsApp with the learner_added template.
 */
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/whatsappService", () => ({ sendTemplate: jest.fn(async () => ({})) }));
jest.mock("../../src/services/mapsService", () => ({ getCoordinatesFromPostalCode: jest.fn(async () => ({ lat: 1, lng: 2 })) }));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const express = require("express");
const User = require("../../src/models/userModel");
const whatsappService = require("../../src/services/whatsappService");
const router = require("../../src/routes/learners");

let server;
let url;
let instructor;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => ((req.instructor = instructor), next()));
  app.use("/api/learners", router);
  await new Promise((r) => (server = app.listen(0, r)));
  url = `http://127.0.0.1:${server.address().port}/api/learners`;
});
afterAll(() => server.close());

beforeEach(() => {
  jest.clearAllMocks();
  instructor = { phoneNumberId: "pn-1", name: "Sam Patel" };
  User.findOne.mockResolvedValue(null);
  User.create.mockImplementation(async (doc) => ({ ...doc, toObject: () => doc }));
});

const post = (body) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

describe("adding a learner from the Portal", () => {
  it("saves the number as WhatsApp has it and sends the welcome template", async () => {
    const res = await post({ name: "Jordan Smith", phone: "07700 900123" });

    expect(res.status).toBe(201);
    expect(res.body.welcomeSent).toBe(true);
    expect(User.create.mock.calls[0][0].phone).toBe("447700900123");
    expect(whatsappService.sendTemplate).toHaveBeenCalledWith("447700900123", "learner_added", "en", ["Jordan", "Sam Patel"], [], instructor);
  });

  it("finds a learner saved the old way instead of adding them twice", async () => {
    await post({ name: "Jordan", phone: "07700 900123" });
    expect(User.findOne.mock.calls[0][0].phone.$in).toEqual(["447700900123", "07700900123"]);
  });

  it("doesn't message when asked not to, or before the instructor has a number", async () => {
    expect((await post({ phone: "07700900123", notify: false })).body.welcomeSent).toBe(false);
    instructor = { phoneNumberId: "signup_abc", name: "Sam" };
    expect((await post({ phone: "07700900123" })).body.welcomeSent).toBe(false);
    expect(whatsappService.sendTemplate).not.toHaveBeenCalled();
  });

  it("still adds the learner when WhatsApp refuses the message", async () => {
    whatsappService.sendTemplate.mockRejectedValueOnce(new Error("template not approved"));
    const res = await post({ phone: "+44 7700 900123" });
    expect(res.status).toBe(201);
    expect(res.body.welcomeSent).toBe(false);
    expect(whatsappService.sendTemplate.mock.calls[0][3][0]).toBe("there");
  });

  it("turns typed numbers into WhatsApp's format", () => {
    expect(router.toWhatsAppNumber("07700 900123")).toBe("447700900123");
    expect(router.toWhatsAppNumber("+44 7700 900123")).toBe("447700900123");
    expect(router.toWhatsAppNumber("0044 7700 900123")).toBe("447700900123");
  });
});
