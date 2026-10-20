/**
 * Donna Drive admin panel API: who gets in (staff JWT or the admin key), what
 * each staff role can do, and the customer actions.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/auditLogModel");
jest.mock("../../src/services/auditLog", () => ({ audit: jest.fn() }));
jest.mock("../../src/models/instructorModel", () => ({ invalidateInstructorCache: jest.fn() }));
jest.mock("../../src/services/accountDeletion", () => ({ deleteAccount: jest.fn(), previousAccounts: jest.fn(async () => []) }));
const mockStripe = { subscriptions: { retrieve: jest.fn(), update: jest.fn() } };
jest.mock("stripe", () => jest.fn(() => mockStripe));

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const { audit } = require("../../src/services/auditLog");
const adminAuth = require("../../src/middleware/adminAuth");
const adminService = require("../../src/services/adminService");
const pricing = require("../../src/services/pricingService");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret";
const people = {
  "agrawalraj918@gmail.com": { _id: "raj", name: "Raj", email: "agrawalraj918@gmail.com", staffRole: null },
  "sue@donnadrive.co.uk": { _id: "sue", name: "Sue", email: "sue@donnadrive.co.uk", staffRole: "support" },
  "ann@donnadrive.co.uk": { _id: "ann", name: "Ann", email: "ann@donnadrive.co.uk", staffRole: "admin" },
  "ivy@instructor.test": { _id: "ivy", name: "Ivy", email: "ivy@instructor.test", staffRole: null, plan: "adi" },
};
const as = (email) => ({ Authorization: `Bearer ${signToken({ email }, SECRET)}` });

let server;
let base;
beforeAll((done) => {
  process.env.JWT_SECRET = SECRET;
  process.env.ADMIN_API_KEY = "k".repeat(32);
  const app = express();
  app.use(express.json());
  app.use("/api/admin", adminAuth, require("../../src/routes/admin"));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/admin`; done(); });
});
afterAll((done) => {
  delete process.env.JWT_SECRET;
  delete process.env.ADMIN_API_KEY;
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  Instructor.findOne.mockImplementation((q) => ({ lean: async () => people[q.email] || null }));
});
afterEach(() => jest.restoreAllMocks());

async function call(path, { headers = {}, method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body && { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json() };
}

// ═══════════════════════════════════════════════════════════════════════════
describe("who gets in", () => {
  beforeEach(() => {
    jest.spyOn(adminService, "overview").mockResolvedValue({ ok: true });
  });

  it("the super admin's Google account gets in with full access", async () => {
    const me = await call("/me", { headers: as("agrawalraj918@gmail.com") });
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ role: "admin", email: "agrawalraj918@gmail.com", superAdmin: true });
    expect(me.body.data.permissions).toEqual(expect.arrayContaining(["admin.pricing", "admin.roles", "admin.sales"]));
    expect((await call("/overview", { headers: as("agrawalraj918@gmail.com") })).status).toBe(200);
  });

  it("customers are refused", async () => {
    expect((await call("/overview", { headers: as("ivy@instructor.test") })).status).toBe(403);
  });

  it("no token, a bad token, or an unknown account is refused", async () => {
    expect((await call("/overview")).status).toBe(403);
    expect((await call("/overview", { headers: { Authorization: "Bearer nope" } })).status).toBe(403);
    expect((await call("/overview", { headers: { Authorization: `Bearer ${signToken({ email: "raj@x.com" }, "wrong")}` } })).status).toBe(403);
    expect((await call("/overview", { headers: as("ghost@x.com") })).status).toBe(403);
  });

  it("the server admin key still works (scripts, curl) as a full admin", async () => {
    const res = await call("/overview", { headers: { "x-admin-key": "k".repeat(32) } });
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("support vs admin", () => {
  beforeEach(() => {
    jest.spyOn(adminService, "listCustomers").mockResolvedValue({ data: [], pagination: {} });
    jest.spyOn(adminService, "extendTrial").mockResolvedValue({ id: "ivy" });
    jest.spyOn(adminService, "setComp").mockResolvedValue({ id: "ivy" });
    jest.spyOn(pricing, "updatePlan").mockResolvedValue({ plan: {}, priceChanges: [] });
    jest.spyOn(pricing, "createSale").mockResolvedValue({});
    jest.spyOn(adminService, "setStaffRole").mockResolvedValue({});
  });

  it("support can view customers and extend trials", async () => {
    expect((await call("/customers", { headers: as("sue@donnadrive.co.uk") })).status).toBe(200);
    expect((await call("/customers/ivy/extend-trial", { method: "POST", headers: as("sue@donnadrive.co.uk"), body: { days: 7 } })).status).toBe(200);
    expect(adminService.extendTrial).toHaveBeenCalledWith("ivy", 7, "sue@donnadrive.co.uk");
  });

  it.each([
    ["PATCH", "/plans/adi", { amount: 1200 }],
    ["POST", "/sales", { name: "x" }],
    ["PUT", "/customers/ivy/comp", { plan: "adi" }],
    ["PUT", "/staff", { email: "a@b.c", role: "admin" }],
  ])("support can't %s %s", async (method, path, body) => {
    const res = await call(path, { method, headers: as("sue@donnadrive.co.uk"), body });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("FORBIDDEN_ROLE");
  });

  it("an admin can change pricing, and it's recorded as them", async () => {
    const res = await call("/plans/adi", { method: "PATCH", headers: as("ann@donnadrive.co.uk"), body: { amount: 1200 } });
    expect(res.status).toBe(200);
    expect(pricing.updatePlan).toHaveBeenCalledWith("adi", { amount: 1200 }, "ann@donnadrive.co.uk");
  });

  it("user-facing errors come back as 4xx with the message", async () => {
    pricing.updatePlan.mockRejectedValue(Object.assign(new Error("Price must be at least £1"), { status: 400, userFacing: true }));
    const res = await call("/plans/adi", { method: "PATCH", headers: as("ann@donnadrive.co.uk"), body: { amount: 1 } });
    expect(res).toMatchObject({ status: 400, body: { error: "Price must be at least £1" } });
  });

  it("Stripe errors come back as 502 with Stripe's message", async () => {
    pricing.createSale.mockRejectedValue(Object.assign(new Error("Invalid currency"), { type: "StripeInvalidRequestError" }));
    const res = await call("/sales", { method: "POST", headers: as("ann@donnadrive.co.uk"), body: { name: "x" } });
    expect(res).toMatchObject({ status: 502, body: { error: "Stripe: Invalid currency" } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("customer actions", () => {
  const doc = (extra = {}) => ({
    _id: "ivy", name: "Ivy", email: "ivy@instructor.test", plan: "adi", phoneNumberId: "pn", subscriptionId: "sub_1",
    subscriptionStatus: "trialing", save: jest.fn(), toObject() { return { ...this }; }, ...extra,
  });

  it("extending a trial pushes Stripe's trial end out by N days", async () => {
    const d = doc();
    Instructor.findById.mockReturnValue(Object.assign(Promise.resolve(d), { catch: () => d }));
    const end = Math.floor(Date.now() / 1000) + 3 * 86400;
    mockStripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "trialing", trial_end: end });
    await adminService.extendTrial("ivy", 7, "raj");
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_1", { trial_end: end + 7 * 86400, proration_behavior: "none" });
    expect(d.trialEndsAt).toEqual(new Date((end + 7 * 86400) * 1000));
    expect(audit).toHaveBeenCalledWith("raj", "customer.extend-trial", "ivy@instructor.test", expect.any(Object));
  });

  it("can't extend a trial that isn't a trial", async () => {
    const d = doc({ subscriptionStatus: "active" });
    Instructor.findById.mockReturnValue({ catch: () => d });
    mockStripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_1", status: "active" });
    await expect(adminService.extendTrial("ivy", 7, "raj")).rejects.toThrow("not on a trial");
  });

  it("a comp gives the plan free, counting as active", async () => {
    const d = doc({ plan: "pdi", subscriptionStatus: null, subscriptionId: null });
    Instructor.findById.mockReturnValue({ catch: () => d });
    const until = new Date(Date.now() + 30 * 86400000);
    const r = await adminService.setComp("ivy", { plan: "adi", until: until.toISOString(), note: "Beta tester" }, "raj");
    expect(d.plan).toBe("adi");
    expect(d.comp).toEqual({ plan: "adi", until, note: "Beta tester" });
    expect(r.status).toBe("comped");
  });

  it("school instructors can't be comped (their school pays)", async () => {
    Instructor.findById.mockReturnValue({ catch: () => doc({ schoolRole: "member" }) });
    await expect(adminService.setComp("ivy", { plan: "adi" }, "raj")).rejects.toThrow("driving school covers them");
  });

  it("removing a comp without a subscription puts them back on the free plan", async () => {
    const d = doc({ comp: { plan: "adi" }, subscriptionStatus: null });
    Instructor.findById.mockReturnValue({ catch: () => d });
    await adminService.removeComp("ivy", "raj");
    expect(d.plan).toBe("pdi");
    expect(d.comp.plan).toBeNull();
  });

  it("suspending blocks the account; the super admin can't be suspended", async () => {
    const d = doc();
    Instructor.findById.mockReturnValue({ catch: () => d });
    await adminService.setSuspended("ivy", true, "raj", "agrawalraj918@gmail.com");
    expect(d).toMatchObject({ suspended: true, active: false });

    Instructor.findById.mockReturnValue({ catch: () => doc({ email: "agrawalraj918@gmail.com" }) });
    await expect(adminService.setSuspended("raj", true, "ann", "ann@donnadrive.co.uk")).rejects.toMatchObject({ status: 403 });
  });

  it("deleting an account runs the same deletion as the instructor's own, and lifts a suspension", async () => {
    const { deleteAccount } = require("../../src/services/accountDeletion");
    const d = doc({ suspended: true });
    Instructor.findById.mockReturnValue({ catch: () => d });
    Instructor.updateOne.mockResolvedValue({});
    const res = await adminService.deleteCustomer("ivy", "raj", "agrawalraj918@gmail.com");
    expect(res).toEqual({ id: String(d._id), deleted: true });
    expect(deleteAccount).toHaveBeenCalledWith(d);
    expect(Instructor.updateOne).toHaveBeenCalledWith({ _id: d._id }, { suspended: false });
    expect(audit).toHaveBeenCalledWith("raj", "customer.delete", d.email, expect.anything());
  });

  it("can't delete a super admin, yourself, an already deleted account, or a school owner who still has instructors", async () => {
    const { deleteAccount } = require("../../src/services/accountDeletion");
    Instructor.findById.mockReturnValue({ catch: () => doc({ email: "agrawalraj918@gmail.com" }) });
    await expect(adminService.deleteCustomer("raj", "ann", "ann@donnadrive.co.uk")).rejects.toMatchObject({ status: 403 });
    Instructor.findById.mockReturnValue({ catch: () => doc({ email: "ann@donnadrive.co.uk" }) });
    await expect(adminService.deleteCustomer("ann", "ann", "ann@donnadrive.co.uk")).rejects.toMatchObject({ status: 400 });
    Instructor.findById.mockReturnValue({ catch: () => doc({ deletedAt: new Date() }) });
    await expect(adminService.deleteCustomer("ivy", "raj", "agrawalraj918@gmail.com")).rejects.toMatchObject({ status: 409 });
    Instructor.findById.mockReturnValue({ catch: () => doc({ schoolRole: "owner", schoolId: "s1" }) });
    Instructor.countDocuments.mockResolvedValue(2);
    await expect(adminService.deleteCustomer("ivy", "raj", "agrawalraj918@gmail.com")).rejects.toThrow("2 instructors");
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it("the delete endpoint needs admin.customers and a typed confirmation", async () => {
    expect((await call("/customers/ivy/delete", { method: "POST", headers: as("sue@donnadrive.co.uk"), body: { confirmation: "DELETE" } })).status).toBe(403);
    expect((await call("/customers/ivy/delete", { method: "POST", headers: as("ann@donnadrive.co.uk"), body: {} })).status).toBe(400);
  });

  it("staff roles: can't change a super admin or yourself; the person must have signed in once", async () => {
    await expect(adminService.setStaffRole("agrawalraj918@gmail.com", null, "ann", "ann@donnadrive.co.uk")).rejects.toMatchObject({ status: 403 });
    await expect(adminService.setStaffRole("ann@donnadrive.co.uk", "support", "ann", "ann@donnadrive.co.uk")).rejects.toThrow("your own role");
    Instructor.findOne.mockResolvedValue(null);
    await expect(adminService.setStaffRole("new@x.com", "support", "raj", "agrawalraj918@gmail.com")).rejects.toThrow("sign in to Donna Drive once");
    const d = doc({ staffRole: null });
    Instructor.findOne.mockResolvedValue(d);
    await adminService.setStaffRole("IVY@instructor.test", "support", "raj", "agrawalraj918@gmail.com");
    expect(d.staffRole).toBe("support");
    await expect(adminService.setStaffRole("ivy@instructor.test", "owner", "raj", "agrawalraj918@gmail.com")).rejects.toThrow("admin, support or none");
  });

  it("customer statuses", () => {
    const s = adminService.statusOf;
    expect(s({ plan: "pdi" })).toBe("free");
    expect(s({ plan: "adi", subscriptionStatus: "trialing" })).toBe("trialing");
    expect(s({ plan: "driving-school", schoolRole: "manager", subscriptionStatus: "active" })).toBe("school");
    expect(s({ plan: "adi", comp: { plan: "adi", until: null } })).toBe("comped");
    expect(s({ plan: "adi", comp: { plan: "adi", until: new Date(Date.now() - 1000) }, subscriptionStatus: "canceled" })).toBe("canceled");
    expect(s({ plan: "adi", suspended: true, subscriptionStatus: "active" })).toBe("suspended");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("super admins aren't customers", () => {
  const chain = (rows) => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) });

  it("they're left out of the customer list unless looking at staff", async () => {
    Instructor.find.mockReturnValue(chain([]));
    Instructor.countDocuments.mockResolvedValue(0);
    await adminService.listCustomers({});
    expect(Instructor.find.mock.calls[0][0].$and).toContainEqual({ email: { $nin: ["agrawalraj918@gmail.com"] } });

    Instructor.find.mockClear();
    await adminService.listCustomers({ staff: "true" });
    expect(Instructor.find.mock.calls[0][0].$and).not.toContainEqual({ email: { $nin: ["agrawalraj918@gmail.com"] } });
  });

  it("a support member isn't a super admin", async () => {
    const me = await call("/me", { headers: as("sue@donnadrive.co.uk") });
    expect(me.body.data).toMatchObject({ role: "support", superAdmin: false });
  });
});
