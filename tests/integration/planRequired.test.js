/**
 * Someone who signs in but closes the plan picker can't use the dashboard,
 * Portal or a WhatsApp number until they pick a plan.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/authCodeModel");
const mockStripe = { checkout: { sessions: { retrieve: jest.fn() } } };
jest.mock("stripe", () => jest.fn(() => mockStripe));

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const AuthCode = require("../../src/models/authCodeModel");
const requirePlan = require("../../src/middleware/requirePlan");
const { needsPlan } = require("../../src/services/permissions");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret";
const people = {
  "new@x.com": { email: "new@x.com", planSelected: false },
  "old@x.com": { email: "old@x.com" }, // older accounts: unset counts as chosen
  "pdi@x.com": { email: "pdi@x.com", planSelected: true, plan: "pdi" },
  "agrawalraj918@gmail.com": { email: "agrawalraj918@gmail.com", planSelected: false },
};
const as = (email) => ({ Authorization: `Bearer ${signToken({ email }, SECRET)}` });

let server;
let base;
beforeAll((done) => {
  process.env.JWT_SECRET = SECRET;
  const jwtAuth = require("../../src/middleware/jwtAuth");
  const app = express();
  app.use(express.json());
  app.get("/api/dashboard/stats", jwtAuth, requirePlan, (req, res) => res.json({ success: true }));
  app.use("/api/auth", require("../../src/routes/authGoogle"));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { delete process.env.JWT_SECRET; server.close(done); });

beforeEach(() => {
  jest.clearAllMocks();
  Instructor.findOne.mockImplementation((q) => ({ lean: async () => people[q.email] || null }));
});

describe("who needs a plan", () => {
  it.each([
    ["a new sign-up who closed the picker", { planSelected: false }, true],
    ["an older account (never set)", {}, false],
    ["someone who chose", { planSelected: true }, false],
    ["staff", { planSelected: false, staffRole: "support" }, false],
    ["the super admin", { email: "agrawalraj918@gmail.com", planSelected: false }, false],
  ])("%s", (_, person, expected) => {
    expect(needsPlan({ email: "x@x.com", ...person })).toBe(expected);
  });
});

describe("the dashboard API", () => {
  it("refuses someone who hasn't picked a plan", async () => {
    const res = await fetch(`${base}/api/dashboard/stats`, { headers: as("new@x.com") });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("PLAN_REQUIRED");
  });

  it.each(["old@x.com", "pdi@x.com", "agrawalraj918@gmail.com"])("lets %s in", async (email) => {
    const res = await fetch(`${base}/api/dashboard/stats`, { headers: as(email) });
    expect(res.status).toBe(200);
  });

  it("checks the Portal's instructor too (API key / token auth)", async () => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    await requirePlan({ instructor: { email: "new@x.com", planSelected: false } }, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("choosing a plan", () => {
  const doc = (extra = {}) => ({ email: "new@x.com", plan: "pdi", planSelected: false, save: jest.fn(), ...extra });

  it("picking the free plan completes sign-up", async () => {
    const d = doc();
    Instructor.findOne.mockResolvedValue(d);
    const res = await fetch(`${base}/api/auth/choose-plan`, {
      method: "POST", headers: { ...as("new@x.com"), "Content-Type": "application/json" }, body: JSON.stringify({ plan: "pdi" }),
    });
    expect(res.status).toBe(200);
    expect(d).toMatchObject({ plan: "pdi", planSelected: true });
    expect(d.save).toHaveBeenCalled();
  });

  it("PDI can't be picked for free once it has a price", async () => {
    const pricing = require("../../src/services/pricingService");
    const spy = jest.spyOn(pricing, "getPlan").mockResolvedValue({ slug: "pdi", amount: 500, trialDays: 7 });
    const d = doc();
    Instructor.findOne.mockResolvedValue(d);
    const res = await fetch(`${base}/api/auth/choose-plan`, {
      method: "POST", headers: { ...as("new@x.com"), "Content-Type": "application/json" }, body: JSON.stringify({ plan: "pdi" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("PAID_PLAN");
    expect(d.planSelected).toBe(false);
    spy.mockRestore();
  });

  it("paid plans can't be picked without checkout", async () => {
    const res = await fetch(`${base}/api/auth/choose-plan`, {
      method: "POST", headers: { ...as("new@x.com"), "Content-Type": "application/json" }, body: JSON.stringify({ plan: "adi" }),
    });
    expect(res.status).toBe(400);
  });

  it("doesn't downgrade an account that already has a plan", async () => {
    const d = doc({ plan: "adi", planSelected: true });
    Instructor.findOne.mockResolvedValue(d);
    await fetch(`${base}/api/auth/choose-plan`, {
      method: "POST", headers: { ...as("new@x.com"), "Content-Type": "application/json" }, body: JSON.stringify({ plan: "pdi" }),
    });
    expect(d.plan).toBe("adi");
    expect(d.save).not.toHaveBeenCalled();
  });

  describe("coming back from checkout", () => {
    const code = () => ({ code: "c", used: false, expiresAt: new Date(Date.now() + 60000), token: "t", apiKey: "k", instructorId: "i1", save: jest.fn() });
    const back = (body) => fetch(`${base}/api/auth/exchange-code`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });

    it("unlocks when Stripe says checkout finished (before the webhook lands)", async () => {
      AuthCode.findOneAndUpdate.mockResolvedValue(code());
      const d = doc({ _id: "i1", plan: "adi" });
      Instructor.findById.mockResolvedValue(d);
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "complete", client_reference_id: "i1" });
      expect((await back({ code: "c", sessionId: "cs_1" })).status).toBe(200);
      expect(mockStripe.checkout.sessions.retrieve).toHaveBeenCalledWith("cs_1");
      expect(d.planSelected).toBe(true);
    });

    it("stays locked if payment didn't finish", async () => {
      AuthCode.findOneAndUpdate.mockResolvedValue(code());
      const d = doc({ _id: "i1", plan: "adi" });
      Instructor.findById.mockResolvedValue(d);
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "open", client_reference_id: "i1" });
      await back({ code: "c", sessionId: "cs_1" });
      expect(d.planSelected).toBe(false);
    });

    it("stays locked for someone else's checkout, or without a session", async () => {
      AuthCode.findOneAndUpdate.mockResolvedValue(code());
      const d = doc({ _id: "i1", plan: "adi" });
      Instructor.findById.mockResolvedValue(d);
      mockStripe.checkout.sessions.retrieve.mockResolvedValue({ status: "complete", client_reference_id: "someone-else" });
      await back({ code: "c", sessionId: "cs_1" });
      expect(d.planSelected).toBe(false);
      AuthCode.findOneAndUpdate.mockResolvedValue(code());
      await back({ code: "c" });
      expect(d.planSelected).toBe(false);
    });
  });
});
