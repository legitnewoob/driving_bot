/**
 * Driving school plan: an owner manages up to 3 instructors (the owner doesn't
 * use a seat). Invites hold a seat; members follow the owner's subscription;
 * the owner can view (not change) each instructor's data.
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/models/schoolModel");
jest.mock("../../src/models/schoolInviteModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/phoneNumberModel");
const mockStripe = {
  subscriptions: { retrieve: jest.fn() },
  subscriptionItems: { create: jest.fn(), update: jest.fn(), del: jest.fn() },
};
jest.mock("stripe", () => jest.fn(() => mockStripe));
jest.mock("../../src/services/phoneNumberService", () => ({
  isFullyProvisioned: (i) => !!i.phoneNumberId && !i.phoneNumberId.startsWith("signup_"),
  revokeNumber: jest.fn().mockResolvedValue({}),
}));

const School = require("../../src/models/schoolModel");
const SchoolInvite = require("../../src/models/schoolInviteModel");
const Instructor = require("../../src/models/instructorSchema");
const PhoneNumber = require("../../src/models/phoneNumberModel");
const phoneNumberService = require("../../src/services/phoneNumberService");
const schoolService = require("../../src/services/schoolService");

const SCHOOL_ID = "school-1";
const owner = (extra = {}) => ({
  _id: "owner-1", name: "Priya Shah", email: "priya@school.test", plan: "driving-school",
  schoolId: SCHOOL_ID, schoolRole: "owner", subscriptionStatus: "active", phoneNumberId: "signup_o", ...extra,
});
const school = (extra = {}) => ({ _id: SCHOOL_ID, name: "Shah Driving School", ownerId: "owner-1", seatLimit: 3, ...extra });

function seats({ members = 0, invites = 0 } = {}) {
  Instructor.countDocuments = jest.fn().mockResolvedValue(members);
  SchoolInvite.countDocuments = jest.fn().mockResolvedValue(invites);
}

beforeEach(() => {
  jest.clearAllMocks();
  School.findById.mockResolvedValue(school());
  seats();
  SchoolInvite.findOne.mockResolvedValue(null);
  Instructor.findOne.mockReturnValue({ lean: async () => null });
  SchoolInvite.create.mockImplementation(async (doc) => ({ _id: "inv-1", ...doc }));
  process.env.FRONTEND_URL = "https://www.donnadrive.co.uk/";
});

// ═══════════════════════════════════════════════════════════════════════════
describe("creating the school", () => {
  it("a driving-school owner without a school gets one, and becomes its owner", async () => {
    School.create.mockResolvedValue(school({ name: "Priya's Driving School" }));
    const s = await schoolService.schoolFor(owner({ schoolId: null, schoolRole: null }));
    expect(School.create).toHaveBeenCalledWith({ name: "Priya's Driving School", ownerId: "owner-1" });
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("owner-1", { schoolId: SCHOOL_ID, schoolRole: "owner" });
    expect(s.name).toBe("Priya's Driving School");
  });

  it("other plans don't get a school", async () => {
    expect(await schoolService.schoolFor({ _id: "x", plan: "adi", schoolId: null })).toBeNull();
    expect(School.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("inviting instructors", () => {
  it("creates an invite with a join link", async () => {
    const { invite, link } = await schoolService.invite(owner(), "  Sam@Example.com ");
    expect(invite.email).toBe("sam@example.com");
    expect(link).toMatch(/^https:\/\/www\.donnadrive\.co\.uk\/join\/[a-f0-9]{48}$/);
  });

  it("stops at 3 seats, counting pending invites", async () => {
    seats({ members: 2, invites: 1 });
    await expect(schoolService.invite(owner(), "sam@example.com")).rejects.toMatchObject({
      status: 409, code: "SEATS_FULL", message: expect.stringContaining("All 3 instructor seats are in use"),
    });
    expect(SchoolInvite.create).not.toHaveBeenCalled();
  });

  it("allows the third seat", async () => {
    seats({ members: 2, invites: 0 });
    await expect(schoolService.invite(owner(), "sam@example.com")).resolves.toBeTruthy();
  });

  it("re-sending to someone already invited returns the same link instead of using another seat", async () => {
    SchoolInvite.findOne.mockResolvedValue({ email: "sam@example.com", token: "abc", status: "pending" });
    const result = await schoolService.invite(owner(), "sam@example.com");
    expect(result.alreadySent).toBe(true);
    expect(SchoolInvite.create).not.toHaveBeenCalled();
  });

  it.each([
    ["not-an-email", "Enter a valid email address"],
    ["priya@school.test", "You manage this school already"],
  ])("rejects %s", async (email, message) => {
    await expect(schoolService.invite(owner(), email)).rejects.toThrow(message);
  });

  it("only the owner can invite", async () => {
    School.findById.mockResolvedValue(school({ ownerId: "someone-else" }));
    await expect(schoolService.invite(owner({ schoolRole: "member" }), "sam@example.com")).rejects.toMatchObject({ status: 403 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("joining a school", () => {
  const invite = (extra = {}) => ({
    schoolId: SCHOOL_ID, email: "sam@example.com", token: "tok", status: "pending",
    expiresAt: new Date(Date.now() + 86400000), save: jest.fn(), ...extra,
  });
  const sam = (extra = {}) => ({ _id: "sam-1", email: "Sam@example.com", plan: "pdi", schoolId: null, phoneNumberId: "signup_s", ...extra });

  beforeEach(() => {
    Instructor.findById.mockReturnValue({ lean: async () => owner() });
  });

  it("joins with the invited Google account and gets the owner's subscription", async () => {
    const inv = invite();
    SchoolInvite.findOne.mockResolvedValue(inv);
    const result = await schoolService.acceptInvite(sam(), "tok");
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("sam-1", {
      schoolId: SCHOOL_ID, schoolRole: "member", plan: "driving-school", subscriptionStatus: "active",
    });
    expect(inv.status).toBe("accepted");
    expect(result.schoolName).toBe("Shah Driving School");
  });

  it("refuses a different Google account, naming the invited one", async () => {
    SchoolInvite.findOne.mockResolvedValue(invite());
    await expect(schoolService.acceptInvite(sam({ email: "other@example.com" }), "tok")).rejects.toMatchObject({
      code: "WRONG_ACCOUNT", message: expect.stringContaining("sam@example.com"),
    });
  });

  it.each([
    ["expired", { expiresAt: new Date(Date.now() - 1000) }],
    ["cancelled", { status: "revoked" }],
  ])("refuses an %s invite", async (_label, change) => {
    SchoolInvite.findOne.mockResolvedValue(invite(change));
    await expect(schoolService.acceptInvite(sam(), "tok")).rejects.toMatchObject({ status: 410 });
  });

  it("refuses someone already in another school", async () => {
    SchoolInvite.findOne.mockResolvedValue(invite());
    await expect(schoolService.acceptInvite(sam({ schoolId: "school-2" }), "tok")).rejects.toThrow("already part of another driving school");
  });

  it("flags when the joiner is still paying for their own plan", async () => {
    SchoolInvite.findOne.mockResolvedValue(invite());
    const result = await schoolService.acceptInvite(sam({ subscriptionId: "sub_1", subscriptionStatus: "active" }), "tok");
    expect(result.hadOwnSubscription).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("removing an instructor", () => {
  it("releases their number and moves them to the free plan", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "sam-1", name: "Sam", phoneNumberId: "real-1" });
    PhoneNumber.findOne.mockResolvedValue({ _id: "pn-1" });
    await schoolService.removeMember(owner(), "sam-1");
    expect(phoneNumberService.revokeNumber).toHaveBeenCalledWith("pn-1");
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("sam-1", { schoolId: null, schoolRole: null, plan: "pdi", subscriptionStatus: null });
  });

  it("can't remove someone from another school", async () => {
    Instructor.findOne.mockResolvedValue(null);
    await expect(schoolService.removeMember(owner(), "stranger")).rejects.toMatchObject({ status: 404 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("owner viewing an instructor", () => {
  it("can view their own instructors", async () => {
    const member = { _id: "sam-1", schoolId: SCHOOL_ID, schoolRole: "member" };
    Instructor.findOne.mockReturnValue({ lean: async () => member });
    expect(await schoolService.viewableInstructor(owner(), "sam-1")).toBe(member);
    expect(Instructor.findOne).toHaveBeenCalledWith({ _id: "sam-1", schoolId: SCHOOL_ID, schoolRole: { $in: ["member", "manager"] }, active: true });
  });

  it("members can't view each other", async () => {
    expect(await schoolService.viewableInstructor(owner({ schoolRole: "member" }), "sam-1")).toBeNull();
  });

  it("no switch means yourself", async () => {
    const o = owner();
    expect(await schoolService.viewableInstructor(o, undefined)).toBe(o);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("subscription follows the owner", () => {
  it("copies the owner's subscription status to every member", async () => {
    await schoolService.syncMembersSubscription(owner({ subscriptionStatus: "past_due" }));
    expect(Instructor.updateMany).toHaveBeenCalledWith(
      { schoolId: SCHOOL_ID, schoolRole: { $in: ["member", "manager"] } },
      { $set: { subscriptionStatus: "past_due" } }
    );
  });

  it("does nothing for instructors who don't own a school", async () => {
    await schoolService.syncMembersSubscription({ schoolRole: null, subscriptionStatus: "active" });
    expect(Instructor.updateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("dashboard API: owner's view is read-only", () => {
  const express = require("express");
  let server;
  let base;
  const member = { _id: "sam-1", name: "Sam", email: "sam@example.com", phoneNumberId: "real-1", baseAddress: "Sam's house", schoolId: SCHOOL_ID, schoolRole: "member" };

  beforeAll((done) => {
    process.env.JWT_SECRET = "test-secret";
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.user = { email: "priya@school.test" }; next(); });
    app.use("/api/dashboard", require("../../src/routes/dashboard"));
    server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/dashboard`; done(); });
  });
  afterAll((done) => {
    delete process.env.JWT_SECRET;
    server.close(done);
  });

  beforeEach(() => {
    Instructor.findOne.mockReturnValue({ lean: async () => owner({ baseAddress: "Priya's office" }) });
    jest.spyOn(schoolService, "viewableInstructor").mockImplementation(async (me, id) => (id === "sam-1" ? member : null));
  });
  afterEach(() => jest.restoreAllMocks());

  it("GET with ?instructor= shows that instructor's data", async () => {
    const res = await fetch(`${base}/settings?instructor=sam-1`).then((r) => r.json());
    expect(res.data.baseAddress).toBe("Sam's house");
  });

  it("an instructor outside the owner's school is refused", async () => {
    const res = await fetch(`${base}/settings?instructor=stranger`);
    expect(res.status).toBe(401);
  });

  it("changes always apply to the signed-in owner, never the viewed instructor", async () => {
    const doc = { ...owner(), botSettings: {}, routeSettings: {}, save: jest.fn(), toObject() { return this; }, markModified: jest.fn(), set: jest.fn() };
    Instructor.findById.mockResolvedValue(doc);
    await fetch(`${base}/settings?instructor=sam-1`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ botSettings: { tone: "brief" } }),
    });
    expect(Instructor.findById).toHaveBeenCalledWith("owner-1");
    expect(schoolService.viewableInstructor).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("paying for extra instructor seats (£10/month each)", () => {
  const EXTRA = "price_extra_seat";
  const sub = (items = []) => ({ id: "sub_1", items: { data: [{ id: "si_base", price: { id: "price_school" }, quantity: 1 }, ...items] } });

  beforeEach(() => {
    process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT = EXTRA;
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub());
    seats({ members: 3, invites: 0 });
  });
  afterAll(() => { delete process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT; });

  const paying = () => owner({ subscriptionId: "sub_1" });

  it("adds an extra-seat line to the subscription and raises the limit", async () => {
    const result = await schoolService.setExtraSeats(paying(), 2);
    expect(mockStripe.subscriptionItems.create).toHaveBeenCalledWith({
      subscription: "sub_1", price: EXTRA, quantity: 2, proration_behavior: "create_prorations",
    });
    expect(School.findByIdAndUpdate).toHaveBeenCalledWith(SCHOOL_ID, { extraSeats: 2, seatLimit: 5 });
    expect(result).toEqual({ extraSeats: 2, seatLimit: 5 });
  });

  it("changes the quantity when there's already an extra-seat line", async () => {
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([{ id: "si_extra", price: { id: EXTRA }, quantity: 2 }]));
    await schoolService.setExtraSeats(paying(), 4);
    expect(mockStripe.subscriptionItems.update).toHaveBeenCalledWith("si_extra", { quantity: 4, proration_behavior: "create_prorations" });
  });

  it("removes the line when going back to the included 3", async () => {
    seats({ members: 3 });
    mockStripe.subscriptions.retrieve.mockResolvedValue(sub([{ id: "si_extra", price: { id: EXTRA }, quantity: 1 }]));
    await schoolService.setExtraSeats(paying(), 0);
    expect(mockStripe.subscriptionItems.del).toHaveBeenCalledWith("si_extra", { proration_behavior: "create_prorations" });
  });

  it("won't drop below the seats in use", async () => {
    seats({ members: 4, invites: 1 });
    await expect(schoolService.setExtraSeats(paying(), 1)).rejects.toMatchObject({
      code: "SEATS_IN_USE", message: expect.stringContaining("at least 2 extra"),
    });
    expect(mockStripe.subscriptionItems.create).not.toHaveBeenCalled();
  });

  it("needs a subscription first", async () => {
    await expect(schoolService.setExtraSeats(owner({ subscriptionId: null }), 1)).rejects.toMatchObject({ code: "NO_SUBSCRIPTION" });
  });

  it.each([[-1], [1.5], ["two"], [51]])("rejects %p", async (value) => {
    await expect(schoolService.setExtraSeats(paying(), value)).rejects.toThrow("whole number from 0 to 50");
  });

  it("the seat limit follows the subscription when it's changed in Stripe", async () => {
    await schoolService.syncSeatsFromSubscription(owner(), sub([{ id: "si_extra", price: { id: EXTRA }, quantity: 3 }]));
    expect(School.findByIdAndUpdate).toHaveBeenCalledWith(SCHOOL_ID, { extraSeats: 3, seatLimit: 6 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("school roles: owner, manager, instructor", () => {
  const manager = (extra = {}) => ({
    _id: "mgr-1", name: "Mo", email: "mo@school.test", plan: "driving-school",
    schoolId: SCHOOL_ID, schoolRole: "manager", subscriptionStatus: "active", ...extra,
  });
  const instructor = () => manager({ _id: "sam-1", email: "sam@school.test", schoolRole: "member" });

  beforeEach(() => {
    Instructor.findById.mockReturnValue({ lean: async () => owner() });
  });

  it("a manager can invite instructors", async () => {
    await expect(schoolService.invite(manager(), "new@example.com")).resolves.toMatchObject({ link: expect.stringContaining("/join/") });
  });

  it("a manager can't invite the owner", async () => {
    await expect(schoolService.invite(manager(), "priya@school.test")).rejects.toThrow("That's the school owner");
  });

  it("an instructor can't invite", async () => {
    await expect(schoolService.invite(instructor(), "new@example.com")).rejects.toMatchObject({ status: 403 });
  });

  it("a manager can remove an instructor", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "sam-1", name: "Sam", email: "sam@school.test", schoolRole: "member", phoneNumberId: "real-1" });
    PhoneNumber.findOne.mockResolvedValue(null);
    await expect(schoolService.removeMember(manager(), "sam-1")).resolves.toMatchObject({ id: "sam-1" });
  });

  it("a manager can't remove another manager", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "mgr-2", name: "Ali", schoolRole: "manager" });
    await expect(schoolService.removeMember(manager(), "mgr-2")).rejects.toThrow("Only the school owner can remove a manager");
  });

  it("nobody can remove themselves", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "mgr-1", name: "Mo", schoolRole: "manager" });
    await expect(schoolService.removeMember(manager(), "mgr-1")).rejects.toThrow("can't remove yourself");
  });

  it("a manager can't change seats or roles", async () => {
    await expect(schoolService.setExtraSeats(manager({ subscriptionId: "sub_1" }), 1)).rejects.toMatchObject({ status: 403 });
    await expect(schoolService.setMemberRole(manager(), "sam-1", "manager")).rejects.toMatchObject({ status: 403 });
  });

  it("the owner can make an instructor a manager and back", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "sam-1", name: "Sam", email: "sam@school.test", schoolRole: "member" });
    await expect(schoolService.setMemberRole(owner(), "sam-1", "manager")).resolves.toMatchObject({ role: "manager", roleLabel: "Manager" });
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("sam-1", { schoolRole: "manager" });
    await schoolService.setMemberRole(owner(), "sam-1", "instructor");
    expect(Instructor.findByIdAndUpdate).toHaveBeenCalledWith("sam-1", { schoolRole: "member" });
  });

  it("rejects unknown roles", async () => {
    await expect(schoolService.setMemberRole(owner(), "sam-1", "owner")).rejects.toThrow("manager or instructor");
  });

  it("a manager can view instructors in the school; an instructor can't", async () => {
    const member = { _id: "sam-1" };
    Instructor.findOne.mockReturnValue({ lean: async () => member });
    expect(await schoolService.viewableInstructor(manager(), "sam-1")).toBe(member);
    expect(await schoolService.viewableInstructor(instructor(), "other")).toBeNull();
  });

  it("a manager counts as a seat", async () => {
    await schoolService.invite(owner(), "x@example.com");
    expect(Instructor.countDocuments).toHaveBeenCalledWith({ schoolId: SCHOOL_ID, schoolRole: { $in: ["member", "manager"] }, active: true });
  });

  it("a school's overview tells each role what they can do", async () => {
    Instructor.find.mockReturnValue({ lean: async () => [] });
    SchoolInvite.find.mockReturnValue({ sort: () => ({ lean: async () => [] }) });
    const asOwner = await schoolService.overview(owner());
    expect(asOwner.permissions).toEqual(expect.arrayContaining(["school.billing", "school.roles", "school.invite"]));
    const asManager = await schoolService.overview(manager());
    expect(asManager.role).toBe("manager");
    expect(asManager.permissions).toEqual(expect.arrayContaining(["school.invite", "school.remove", "school.viewAll"]));
    expect(asManager.permissions).not.toContain("school.billing");
    const asInstructor = await schoolService.overview(instructor());
    expect(asInstructor.permissions).toEqual(["school.view"]);
    expect(asInstructor.members).toEqual([]);
  });
});
