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
});
