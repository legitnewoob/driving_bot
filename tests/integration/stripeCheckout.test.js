/**
 * POST /api/stripe/create-checkout-session must not start a second subscription
 * when Stripe already has one, even if our DB hasn't heard via webhook yet.
 */

const mockStripe = {
  customers: { create: jest.fn() },
  subscriptions: { list: jest.fn() },
  checkout: { sessions: { create: jest.fn() } },
};
jest.mock("stripe", () => jest.fn(() => mockStripe));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/authCodeModel");

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const AuthCode = require("../../src/models/authCodeModel");

let server;
let baseUrl;
let instructor;

beforeAll((done) => {
  process.env.JWT_SECRET = "test-secret";
  process.env.STRIPE_PRICE_ADI = "price_adi";
  const router = require("../../src/routes/stripe");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { email: "sam@test.com" };
    next();
  });
  app.use("/api/stripe", router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}/api/stripe`;
    done();
  });
});

afterAll((done) => {
  delete process.env.JWT_SECRET;
  delete process.env.STRIPE_PRICE_ADI;
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  instructor = {
    _id: { toString: () => "inst-oid" },
    email: "sam@test.com",
    name: "Sam",
    stripeCustomerId: "cus_123",
    subscriptionId: null,
    subscriptionStatus: null,
    save: jest.fn(async () => instructor),
  };
  Instructor.findOne.mockResolvedValue(instructor);
  AuthCode.create.mockResolvedValue({});
  mockStripe.checkout.sessions.create.mockResolvedValue({ url: "https://checkout.test/s" });
});

const checkout = () =>
  fetch(`${baseUrl}/create-checkout-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: "adi" }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

describe("create-checkout-session", () => {
  it("refuses when Stripe already has a subscription the DB doesn't know about yet", async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_1", status: "trialing" }] });

    const res = await checkout();

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already have a subscription/);
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
    // and the DB catches up
    expect(instructor).toMatchObject({ subscriptionId: "sub_1", subscriptionStatus: "trialing" });
  });

  it("allows a new checkout when the only subscriptions are cancelled", async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [{ id: "sub_old", status: "canceled" }] });

    const res = await checkout();

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://checkout.test/s");
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ customer: "cus_123", subscription_data: { trial_period_days: 30 } })
    );
  });

  it("creates the customer on first checkout without listing subscriptions", async () => {
    instructor.stripeCustomerId = null;
    mockStripe.customers.create.mockResolvedValue({ id: "cus_new" });

    const res = await checkout();

    expect(res.status).toBe(200);
    expect(mockStripe.subscriptions.list).not.toHaveBeenCalled();
    expect(instructor.stripeCustomerId).toBe("cus_new");
  });

  it("embedded checkout (shown in the dashboard's modal) returns a client secret and comes back to the dashboard", async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
    mockStripe.checkout.sessions.create.mockResolvedValue({ client_secret: "cs_secret_1", url: null });
    const res = await fetch(`${baseUrl}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan: "adi", embedded: true }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

    expect(res.body).toMatchObject({ success: true, clientSecret: "cs_secret_1" });
    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.ui_mode).toBe("embedded_page");
    expect(params.return_url).toMatch(/\/dashboard\?auth_code=[a-f0-9]+&session_id=\{CHECKOUT_SESSION_ID\}$/);
    expect(params.success_url).toBeUndefined();
    expect(params.cancel_url).toBeUndefined();
  });

  it("hosted checkout sends people back to the (locked) dashboard if they back out", async () => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
    await checkout();
    const params = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(params.cancel_url).toMatch(/\/dashboard$/);
    expect(params.success_url).toContain("session_id={CHECKOUT_SESSION_ID}");
  });
});

describe("which plans go through checkout", () => {
  const pricing = require("../../src/services/pricingService");
  const buy = (plan) =>
    fetch(`${baseUrl}/create-checkout-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan }),
    }).then(async (r) => ({ status: r.status, body: await r.json() }));

  beforeEach(() => {
    mockStripe.subscriptions.list.mockResolvedValue({ data: [] });
  });
  afterEach(() => jest.restoreAllMocks());

  it("a free plan (priced £0) has nothing to pay", async () => {
    jest.spyOn(pricing, "getPlan").mockResolvedValue({ slug: "pdi", amount: 0, trialDays: 0 });
    const res = await buy("pdi");
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FREE_PLAN");
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("PDI with a price goes through checkout with its trial, and is remembered as the plan they're paying for", async () => {
    jest.spyOn(pricing, "getPlan").mockResolvedValue({ slug: "pdi", amount: 500, trialDays: 7, stripePriceId: "price_pdi_5" });
    const res = await buy("pdi");
    expect(res.status).toBe(200);
    const session = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(session.line_items).toEqual([{ price: "price_pdi_5", quantity: 1 }]);
    expect(session.subscription_data).toEqual({ trial_period_days: 7 });
    expect(instructor).toMatchObject({ plan: "pdi", pendingPlan: "pdi" });
  });

  it("a priced plan without a trial charges at checkout", async () => {
    jest.spyOn(pricing, "getPlan").mockResolvedValue({ slug: "pdi", amount: 500, trialDays: 0, stripePriceId: "price_pdi_5" });
    await buy("pdi");
    expect(mockStripe.checkout.sessions.create.mock.calls[0][0].subscription_data).toEqual({});
  });

  it("an unknown plan is refused", async () => {
    jest.spyOn(pricing, "getPlan").mockResolvedValue(null);
    expect((await buy("gold")).status).toBe(400);
  });
});
