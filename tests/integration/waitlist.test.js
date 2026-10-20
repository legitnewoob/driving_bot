/**
 * The launch waitlist: joining, referrals, the sign-up gate, invites, the
 * admin's launch settings, the launch perk at checkout and referral rewards.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/launchSignupModel");
jest.mock("../../src/models/counterModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/schoolInviteModel");
jest.mock("../../src/models/promoCodeModel");
jest.mock("../../src/models/authCodeModel");
jest.mock("../../src/services/auditLog", () => ({ audit: jest.fn() }));
jest.mock("../../src/services/accountDeletion", () => ({ previousAccounts: jest.fn(async () => []), deleteAccount: jest.fn() }));
jest.mock("../../src/services/pricingService", () => ({ getPlan: jest.fn(async (slug) => ({ slug, amount: slug === "driving-school" ? 9900 : 2900 })) }));
jest.mock("../../src/utils/waitlistEmails", () => ({
  sendWaitlistConfirmation: jest.fn(async () => true),
  sendWaitlistMovedUp: jest.fn(async () => true),
  sendWaitlistInvite: jest.fn(async () => true),
  sendWaitlistReminder: jest.fn(async () => true),
  sendLaunchAnnouncement: jest.fn(async () => true),
  sendReferralReward: jest.fn(async () => true),
  sendWaitlistDigest: jest.fn(async () => true),
  shareUrl: (code) => `http://site/?ref=${code}`,
}));
const mockSettings = {};
jest.mock("../../src/services/settings", () => ({
  LAUNCH_MODES: ["waitlist", "invite", "open"],
  getAll: jest.fn(async () => ({ ...mockSettings })),
  get: jest.fn(async (k) => mockSettings[k]),
  setMany: jest.fn(async (v) => Object.assign(mockSettings, v)),
}));
const mockVerify = jest.fn();
jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerify })) }));

const express = require("express");
const LaunchSignup = require("../../src/models/launchSignupModel");
const Counter = require("../../src/models/counterModel");
const Instructor = require("../../src/models/instructorSchema");
const SchoolInvite = require("../../src/models/schoolInviteModel");
const PromoCode = require("../../src/models/promoCodeModel");
const { audit } = require("../../src/services/auditLog");
const emails = require("../../src/utils/waitlistEmails");
const launch = require("../../src/services/launchService");
const { signToken } = require("../../src/utils/jwtSign");

/** A mongoose query stand-in: chainable, and awaitable to `value`. */
const q = (value) => {
  const p = Promise.resolve(value);
  const chain = { sort: () => chain, limit: () => chain, lean: () => p, select: () => chain, then: (a, b) => p.then(a, b), catch: (f) => p.catch(f) };
  return chain;
};
const doc = (fields) => ({ save: jest.fn(async function () { return this; }), ...fields });
const day = 24 * 60 * 60 * 1000;

let server;
let base;
beforeAll((done) => {
  process.env.JWT_SECRET = "test-secret";
  process.env.ADMIN_API_KEY = "admin-key-123";
  process.env.GOOGLE_CLIENT_ID = "gid";
  const app = express();
  app.use(express.json());
  app.use("/api", require("../../src/routes/waitlist"));
  app.use("/api/auth", require("../../src/routes/authGoogle"));
  app.use("/api/admin", require("../../src/middleware/adminAuth"), require("../../src/routes/admin"));
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});
afterAll((done) => {
  server.close(done);
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(mockSettings, {
    "launch.mode": "waitlist",
    "launch.date": null,
    "launch.message": "",
    "launch.invitePromoCode": null,
    "referral.maxFreeMonths": 12,
  });
  LaunchSignup.findOne.mockReturnValue(q(null));
  LaunchSignup.find.mockReturnValue(q([]));
  LaunchSignup.exists.mockResolvedValue(null);
  LaunchSignup.countDocuments.mockResolvedValue(0);
  LaunchSignup.updateOne.mockResolvedValue({});
  LaunchSignup.aggregate.mockResolvedValue([]);
  Instructor.findOne.mockReturnValue(q(null));
  Instructor.exists.mockResolvedValue(null);
  Instructor.updateOne.mockResolvedValue({});
  SchoolInvite.findOne.mockReturnValue(q(null));
  Counter.findOneAndUpdate.mockResolvedValue({ seq: 142 });
});

const req = (method, path, body, headers = {}) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", ...headers }, ...(body && { body: JSON.stringify(body) }) });
const post = (path, body, headers) => req("POST", path, body, headers);

describe("joining", () => {
  beforeEach(() => {
    LaunchSignup.create.mockImplementation(async (d) => doc({ _id: "e1", status: "waiting", referrals: 0, createdAt: new Date(), ...d }));
  });

  it("puts them on the list with the next position, a link code, and emails their place", async () => {
    LaunchSignup.countDocuments.mockResolvedValue(141); // 141 people waiting ahead
    const res = await post("/api/waitlist", { name: " Raj Agrawal ", email: "Raj@X.com", source: { utm_source: "ig" } });
    expect(res.status).toBe(201);
    const { data } = await res.json();
    expect(data.created).toBe(true);
    expect(data.entry).toMatchObject({ name: "Raj Agrawal", email: "raj@x.com", place: 142, referrals: 0, referralsToPriority: 3 });
    expect(data.entry.token).toMatch(/^[a-f0-9]{48}$/);
    expect(data.entry.referralCode).toMatch(/^raj[a-z0-9]+$/);
    const saved = LaunchSignup.create.mock.calls[0][0];
    expect(saved).toMatchObject({ email: "raj@x.com", position: 142, referredBy: null, source: expect.objectContaining({ utm_source: "ig" }) });
    expect(emails.sendWaitlistConfirmation).toHaveBeenCalledWith(expect.objectContaining({ email: "raj@x.com" }), expect.objectContaining({ place: 142 }));
  });

  it("needs a name and a valid email", async () => {
    expect((await post("/api/waitlist", { email: "a@x.com" })).status).toBe(400);
    expect((await post("/api/waitlist", { name: "A", email: "nope" })).status).toBe(400);
    expect(LaunchSignup.create).not.toHaveBeenCalled();
  });

  it("quietly drops bots that fill the hidden field", async () => {
    const res = await post("/api/waitlist", { name: "Bot", email: "b@x.com", website: "spam" });
    expect(res.status).toBe(201);
    expect(LaunchSignup.create).not.toHaveBeenCalled();
  });

  it("joining twice keeps their place and doesn't hand out their private link", async () => {
    LaunchSignup.countDocuments.mockResolvedValue(39);
    LaunchSignup.findOne.mockReturnValue(q(doc({ _id: "e1", name: "Raj", email: "raj@x.com", position: 50, referrals: 1, status: "waiting", accessToken: "secret", emails: {} })));
    const res = await post("/api/waitlist", { name: "Raj", email: "raj@x.com" });
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data).toEqual({ created: false, entry: { name: "Raj", place: 40, status: "waiting" } });
    expect(JSON.stringify(data)).not.toContain("secret");
    expect(LaunchSignup.create).not.toHaveBeenCalled();
    // Their link is emailed again instead (at most hourly)
    expect(emails.sendWaitlistConfirmation).toHaveBeenCalled();
  });

  it("doesn't re-send the link more than once an hour", async () => {
    LaunchSignup.findOne.mockReturnValue(q(doc({ name: "Raj", email: "raj@x.com", position: 50, status: "waiting", emails: { confirmationSentAt: new Date() } })));
    await post("/api/waitlist", { name: "Raj", email: "raj@x.com" });
    expect(emails.sendWaitlistConfirmation).not.toHaveBeenCalled();
  });

  it("someone with an account is told to sign in", async () => {
    Instructor.findOne.mockReturnValue(q({ _id: "i1", email: "raj@x.com" }));
    const res = await post("/api/waitlist", { name: "Raj", email: "raj@x.com" });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("HAS_ACCOUNT");
  });

  it("two joins with the same email at once: the second gets the first's place", async () => {
    LaunchSignup.countDocuments.mockResolvedValue(141);
    LaunchSignup.findOne.mockReturnValueOnce(q(null)).mockReturnValue(q({ name: "Raj", position: 142, referrals: 0, status: "waiting" }));
    LaunchSignup.create.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));
    const res = await post("/api/waitlist", { name: "Raj", email: "raj@x.com" });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ created: false, entry: { name: "Raj", place: 142, status: "waiting" } });
  });
});

describe("referrals on the waitlist", () => {
  const referrer = (fields = {}) => doc({ _id: "r1", name: "Ella", email: "ella@x.com", referralCode: "ella1ab", position: 100, referrals: 0, status: "waiting", emails: {}, ...fields });

  beforeEach(() => {
    LaunchSignup.create.mockImplementation(async (d) => doc({ _id: "e2", status: "waiting", referrals: 0, ...d }));
  });

  it("a friend joining with their link moves them up 10 places and tells them", async () => {
    LaunchSignup.findOne.mockImplementation((f) => q(f.referralCode === "ella1ab" ? referrer() : null));
    LaunchSignup.findOneAndUpdate.mockResolvedValue(referrer({ referrals: 1 }));
    // 99 waiting ahead of Ella before, 89 after
    LaunchSignup.countDocuments.mockResolvedValueOnce(99).mockResolvedValueOnce(89);
    await post("/api/waitlist", { name: "Sam", email: "sam@x.com", ref: "ELLA1AB" });
    expect(LaunchSignup.create.mock.calls[0][0].referredBy).toBe("ella1ab");
    expect(LaunchSignup.findOneAndUpdate).toHaveBeenCalledWith({ _id: "r1" }, { $inc: { referrals: 1 } }, { new: true });
    expect(emails.sendWaitlistMovedUp).toHaveBeenCalledWith(expect.anything(), { from: 100, to: 90, friendName: "Sam", referrals: 1 });
  });

  it("the third friend makes them priority", async () => {
    LaunchSignup.findOne.mockImplementation((f) => q(f.referralCode === "ella1ab" ? referrer({ referrals: 2 }) : null));
    LaunchSignup.findOneAndUpdate.mockResolvedValue(referrer({ referrals: 3 }));
    await post("/api/waitlist", { name: "Sam", email: "sam@x.com", ref: "ella1ab" });
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ _id: "r1" }, { priority: true });
  });

  it("emails about moving up at most once a day", async () => {
    LaunchSignup.findOne.mockImplementation((f) => q(f.referralCode === "ella1ab" ? referrer() : null));
    LaunchSignup.findOneAndUpdate.mockResolvedValue(referrer({ referrals: 2, emails: { movedUpAt: new Date(Date.now() - 60 * 1000) } }));
    await post("/api/waitlist", { name: "Sam", email: "sam@x.com", ref: "ella1ab" });
    expect(LaunchSignup.findOneAndUpdate).toHaveBeenCalled();
    expect(emails.sendWaitlistMovedUp).not.toHaveBeenCalled();
  });

  it("an unknown code is ignored", async () => {
    await post("/api/waitlist", { name: "Sam", email: "sam@x.com", ref: "nobody" });
    expect(LaunchSignup.create.mock.calls[0][0].referredBy).toBeNull();
    expect(LaunchSignup.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("the first person on an empty list is #1, however many joined and left before", async () => {
    Counter.findOneAndUpdate.mockResolvedValue({ seq: 2 });
    LaunchSignup.create.mockImplementation(async (d) => doc({ _id: "e3", status: "waiting", referrals: 0, ...d }));
    LaunchSignup.countDocuments.mockResolvedValue(0);
    const { data } = await (await post("/api/waitlist", { name: "Ann", email: "ann@x.com" })).json();
    expect(data.entry).toMatchObject({ position: 2, place: 1 });
  });

  it("place counts only people still waiting ahead of them", async () => {
    LaunchSignup.countDocuments.mockResolvedValue(4);
    expect(await launch.rankOf({ _id: "e1", status: "waiting", position: 20, referrals: 1 })).toBe(5);
    const query = LaunchSignup.countDocuments.mock.calls[0][0];
    expect(query).toMatchObject({ status: "waiting", _id: { $ne: "e1" } });
    // Not priority: every priority person is ahead, plus anyone further along
    expect(query.$or[0]).toEqual({ priority: true });
    // Invited, signed-up or removed people have no place
    expect(await launch.rankOf({ status: "invited" })).toBeNull();
  });
});

describe("their status page and answers", () => {
  it("shows their place, friends and the launch details", async () => {
    LaunchSignup.findOne.mockReturnValue(q(doc({ name: "Raj", email: "raj@x.com", position: 142, referrals: 1, referralCode: "raj1", status: "waiting", accessToken: "t1" })));
    LaunchSignup.find.mockReturnValue(q([{ name: "Sam Smith", createdAt: new Date() }]));
    mockSettings["launch.date"] = new Date(Date.now() + 5 * day).toISOString().slice(0, 10);
    LaunchSignup.countDocuments.mockResolvedValue(131);
    const res = await req("GET", "/api/waitlist/me?t=t1");
    const { data } = await res.json();
    expect(data).toMatchObject({ place: 132, referrals: 1, referralsToPriority: 2, friends: [{ name: "Sam" }] });
    expect(data.launch.date).toBe(mockSettings["launch.date"]);
  });

  it("an unknown link is a 404", async () => {
    expect((await req("GET", "/api/waitlist/me?t=nope")).status).toBe(404);
  });

  it("saves only known answers", async () => {
    const entry = doc({ name: "Raj", email: "raj@x.com", position: 1, status: "waiting", accessToken: "t1" });
    LaunchSignup.findOne.mockReturnValue(q(entry));
    const res = await req("PATCH", "/api/waitlist/me?t=t1", { type: "school", schoolSize: "6-15", area: "Leeds", currentTool: ["whatsapp", "fax"], marketingConsent: true, position: 1 });
    expect(res.status).toBe(200);
    expect(entry).toMatchObject({ type: "school", schoolSize: "6-15", area: "Leeds", currentTool: ["whatsapp"], marketingConsent: true, position: 1 });
    expect(entry.save).toHaveBeenCalled();
  });

  it("school size only applies to schools", async () => {
    const entry = doc({ name: "Raj", position: 1, status: "waiting", schoolSize: "2-5", type: "school" });
    LaunchSignup.findOne.mockReturnValue(q(entry));
    await req("PATCH", "/api/waitlist/me?t=t1", { type: "adi" });
    expect(entry.schoolSize).toBeNull();
  });

  it("unsubscribing stops product emails", async () => {
    LaunchSignup.findOne.mockReturnValue(q(doc({ _id: "e1", status: "waiting" })));
    const res = await req("GET", "/api/waitlist/unsubscribe/t1");
    expect(res.status).toBe(200);
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ _id: "e1" }, expect.objectContaining({ marketingConsent: false, unsubscribedAt: expect.any(Date) }));
  });
});

describe("GET /api/launch", () => {
  it("shows the date only while sign-up is closed and the day hasn't passed", async () => {
    mockSettings["launch.date"] = new Date(Date.now() + 3 * day).toISOString().slice(0, 10);
    LaunchSignup.countDocuments.mockResolvedValue(340);
    let { data } = await (await req("GET", "/api/launch")).json();
    expect(data).toMatchObject({ mode: "waitlist", date: mockSettings["launch.date"], count: 340 });

    mockSettings["launch.date"] = "2020-01-01";
    ({ data } = await (await req("GET", "/api/launch")).json());
    expect(data.date).toBeNull();

    mockSettings["launch.date"] = new Date(Date.now() + 3 * day).toISOString().slice(0, 10);
    mockSettings["launch.mode"] = "open";
    ({ data } = await (await req("GET", "/api/launch")).json());
    expect(data.date).toBeNull();
  });
});

describe("the sign-up gate", () => {
  const signUp = (body = {}) => post("/api/auth/google-signup", { credential: "id-token", ...body });

  beforeEach(() => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ sub: "g1", email: "new@x.com", name: "New Person" }) });
    Instructor.findOne.mockResolvedValue(null);
    Instructor.create.mockImplementation(async (d) => ({ _id: "i1", ...d, save: jest.fn() }));
  });

  it("blocks a new account while the waitlist is on, and creates nothing", async () => {
    const res = await signUp();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WAITLIST", onList: false, name: "New Person", email: "new@x.com" });
    expect(Instructor.create).not.toHaveBeenCalled();
  });

  it("tells someone already on the list their place", async () => {
    LaunchSignup.findOne.mockReturnValue(q({ email: "new@x.com", position: 50, referrals: 0, status: "waiting" }));
    LaunchSignup.countDocuments.mockResolvedValue(49);
    const res = await signUp();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WAITLIST", onList: true, place: 50 });
  });

  it("lets them in with a valid invite link, and marks their place used", async () => {
    const entry = { _id: "e1", email: "work@x.com", status: "invited", referralCode: "new1", referredBy: "ella1", invite: { expiresAt: new Date(Date.now() + day), usedAt: null } };
    LaunchSignup.findOne.mockImplementation((f) => q(f["invite.tokenHash"] === launch.hash("tok") ? entry : null));
    const res = await signUp({ invite: "tok" });
    expect(res.status).toBe(200);
    expect(Instructor.create).toHaveBeenCalled();
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ _id: "e1" }, expect.objectContaining({ status: "joined", instructorId: "i1", "invite.usedAt": expect.any(Date) }));
    // Their link code and referrer move to the account
    expect(Instructor.updateOne).toHaveBeenCalledWith({ _id: "i1" }, { referralCode: "new1", referredBy: "ella1" });
  });

  it("an expired or used invite link doesn't work", async () => {
    LaunchSignup.findOne.mockImplementation((f) =>
      q(f["invite.tokenHash"] ? { status: "invited", invite: { expiresAt: new Date(Date.now() - 1000) } } : null)
    );
    expect((await signUp({ invite: "tok" })).status).toBe(403);
    LaunchSignup.findOne.mockImplementation((f) =>
      q(f["invite.tokenHash"] ? { status: "joined", invite: { expiresAt: new Date(Date.now() + day), usedAt: new Date() } } : null)
    );
    expect((await signUp({ invite: "tok" })).status).toBe(403);
  });

  it("an invited email gets in without the link", async () => {
    LaunchSignup.findOne.mockImplementation((f) => q(f.email ? { _id: "e1", email: "new@x.com", status: "invited", invite: { expiresAt: new Date(Date.now() + day) } } : null));
    expect((await signUp()).status).toBe(200);
  });

  it("a deleted account doesn't get past the waitlist: they're back in the queue", async () => {
    LaunchSignup.findOne.mockImplementation((f) => q(f.email ? { email: "new@x.com", status: "waiting", position: 40, referrals: 0 } : null));
    LaunchSignup.countDocuments.mockResolvedValue(39);
    const res = await signUp();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "WAITLIST", onList: true, place: 40 });
  });

  it("deleting an account puts their waitlist place back to waiting", async () => {
    await launch.onAccountDeleted({ _id: "i1" });
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ instructorId: "i1" }, expect.objectContaining({ status: "waiting", instructorId: null }));
  });

  it("instructors invited by a driving school always get in", async () => {
    SchoolInvite.findOne.mockReturnValue(q({ email: "new@x.com", status: "pending" }));
    expect((await signUp()).status).toBe(200);
  });

  it("super admins always get in", async () => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ sub: "g2", email: "agrawalraj918@gmail.com", name: "Raj" }) });
    expect((await signUp()).status).toBe(200);
  });

  it("existing accounts sign in as normal", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "i9", email: "new@x.com", active: true, save: jest.fn() });
    const res = await signUp();
    expect(res.status).toBe(200);
    expect(LaunchSignup.findOne).not.toHaveBeenCalled();
  });

  it("open mode lets everyone in, and a ?ref= link is remembered", async () => {
    mockSettings["launch.mode"] = "open";
    Instructor.findOne.mockImplementation((f) => (f?.referralCode ? q({ _id: "i5", referralCode: "ella1", email: "ella@x.com" }) : Promise.resolve(null)));
    const res = await signUp({ ref: "ella1" });
    expect(res.status).toBe(200);
    expect(Instructor.updateOne).toHaveBeenCalledWith({ _id: "i1" }, { referredBy: "ella1" });
  });
});

describe("admin", () => {
  const admin = { "x-admin-key": "admin-key-123" };
  const supportJwt = () => ({ Authorization: `Bearer ${signToken({ email: "s@dd.com" }, "test-secret")}` });

  it("invites the next N in line: priority first, then by place, with the launch perk", async () => {
    mockSettings["launch.invitePromoCode"] = "EARLY20";
    PromoCode.findOne.mockReturnValue(q({ code: "EARLY20", percentOff: 20, duration: "repeating", durationMonths: 3, stripePromotionCodeId: "promo_1", active: true }));
    const a = doc({ email: "a@x.com", position: 10, referrals: 0, status: "waiting" });
    const b = doc({ email: "b@x.com", position: 90, referrals: 3, priority: true, status: "waiting" });
    const c = doc({ email: "c@x.com", position: 5, referrals: 0, status: "waiting" });
    LaunchSignup.find.mockReturnValue(q([a, b, c]));
    const res = await post("/api/admin/waitlist/invite", { next: 2 }, admin);
    const { data } = await res.json();
    expect(data).toEqual({ invited: 2, emailed: 2, failed: [] });
    expect(emails.sendWaitlistInvite.mock.calls.map((c) => c[0].email)).toEqual(["b@x.com", "c@x.com"]);
    expect(b.status).toBe("invited");
    expect(b.invite).toMatchObject({ promoCode: "EARLY20", tokenHash: expect.any(String), expiresAt: expect.any(Date) });
    const { joinUrl, promo } = emails.sendWaitlistInvite.mock.calls[0][1];
    expect(joinUrl).toMatch(/\/join\?invite=[a-f0-9]{48}$/);
    // Only the hash is stored
    expect(b.invite.tokenHash).toBe(launch.hash(joinUrl.split("=")[1]));
    expect(promo.label).toBe("20% off for 3 months");
    expect(audit).toHaveBeenCalledWith("admin-key", "waitlist.invite", "2 people", expect.anything());
  });

  it("the list shows live places: gaps close, and only waiting people have one", async () => {
    const rows = [
      { _id: "a", name: "A", email: "a@x.com", position: 5, referrals: 0, status: "waiting", createdAt: new Date() },
      { _id: "b", name: "B", email: "b@x.com", position: 9, referrals: 0, status: "waiting", createdAt: new Date() },
      { _id: "c", name: "C", email: "c@x.com", position: 2, referrals: 0, status: "invited", createdAt: new Date() },
    ];
    LaunchSignup.find.mockImplementation((f) => q(f.status === "waiting" ? rows.filter((r) => r.status === "waiting") : rows));
    const { data } = await (await req("GET", "/api/admin/waitlist?status=all", null, admin)).json();
    expect(Object.fromEntries(data.map((r) => [r.email, r.place]))).toEqual({ "a@x.com": 1, "b@x.com": 2, "c@x.com": null });
  });

  it("support can see the list and invite, but not change launch settings", async () => {
    Instructor.findOne.mockReturnValue(q({ _id: "s1", email: "s@dd.com", staffRole: "support", active: true }));
    expect((await req("GET", "/api/admin/waitlist", null, supportJwt())).status).toBe(200);
    expect((await req("PUT", "/api/admin/launch", { mode: "open" }, supportJwt())).status).toBe(403);
  });

  it("launch settings: validated and audited", async () => {
    PromoCode.find.mockReturnValue(q([]));
    expect((await req("PUT", "/api/admin/launch", { mode: "sideways" }, admin)).status).toBe(400);
    expect((await req("PUT", "/api/admin/launch", { date: "next week" }, admin)).status).toBe(400);
    PromoCode.findOne.mockReturnValue(q(null));
    expect((await req("PUT", "/api/admin/launch", { invitePromoCode: "NOPE" }, admin)).status).toBe(400);

    const res = await req("PUT", "/api/admin/launch", { mode: "invite", date: "2026-11-03", message: "20% off for waitlisters" }, admin);
    expect(res.status).toBe(200);
    expect(mockSettings).toMatchObject({ "launch.mode": "invite", "launch.date": "2026-11-03", "launch.message": "20% off for waitlisters" });
    expect(audit).toHaveBeenCalledWith("admin-key", "launch.settings", "launch", expect.objectContaining({ changes: expect.objectContaining({ "launch.mode": { from: "waitlist", to: "invite" } }) }));

    await req("PUT", "/api/admin/launch", { date: "" }, admin);
    expect(mockSettings["launch.date"]).toBeNull();
  });

  it("removing spam takes back the places it earned its referrer", async () => {
    const entry = doc({ _id: "e9", email: "spam@x.com", status: "waiting", referredBy: "ella1" });
    LaunchSignup.findById.mockResolvedValue(entry);
    LaunchSignup.findOneAndUpdate.mockResolvedValue({ _id: "r1", referrals: 2, priority: true });
    await post("/api/admin/waitlist/e9/remove", {}, admin);
    expect(entry.status).toBe("removed");
    expect(LaunchSignup.findOneAndUpdate).toHaveBeenCalledWith({ referralCode: "ella1", referrals: { $gt: 0 } }, { $inc: { referrals: -1 } }, { new: true });
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ _id: "r1" }, { priority: false });
  });

  it("CSV export neutralises spreadsheet formulas", async () => {
    LaunchSignup.find.mockReturnValue(q([{ position: 1, referrals: 0, name: "=HYPERLINK(1)", email: "a@x.com", status: "waiting", createdAt: new Date() }]));
    const res = await req("GET", "/api/admin/waitlist.csv", null, admin);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    const text = await res.text();
    expect(text).toContain("'=HYPERLINK(1)");
  });

  it("the launch announcement only goes out once sign-up is open, to people who opted in", async () => {
    expect((await post("/api/admin/launch/announce", {}, admin)).status).toBe(400);
    mockSettings["launch.mode"] = "open";
    LaunchSignup.find.mockReturnValue(q([doc({ _id: "e1", email: "a@x.com" })]));
    const { data } = await (await post("/api/admin/launch/announce", {}, admin)).json();
    expect(data).toEqual({ sent: 1, of: 1 });
    expect(LaunchSignup.find).toHaveBeenCalledWith(expect.objectContaining({ marketingConsent: true, unsubscribedAt: null }));
  });
});

describe("invite reminders", () => {
  it("sends one reminder with a fresh link", async () => {
    const entry = { _id: "e1", email: "a@x.com", invite: { promoCode: null, expiresAt: new Date(Date.now() + 9 * day) } };
    LaunchSignup.find.mockReturnValue(q([entry]));
    expect(await launch.sendDueReminders()).toBe(1);
    expect(LaunchSignup.updateOne).toHaveBeenCalledWith({ _id: "e1" }, { "invite.tokenHash": expect.any(String), "invite.remindedAt": expect.any(Date) });
    expect(emails.sendWaitlistReminder).toHaveBeenCalled();
    expect(LaunchSignup.find).toHaveBeenCalledWith(expect.objectContaining({ "invite.remindedAt": null, "invite.usedAt": null, unsubscribedAt: null }));
  });
});

describe("launch perk at checkout", () => {
  it("applies the invite's promo code", async () => {
    LaunchSignup.findOne.mockReturnValue(q({ invite: { promoCode: "EARLY20" } }));
    PromoCode.findOne.mockReturnValue(q({ code: "EARLY20", stripePromotionCodeId: "promo_1", plans: [] }));
    expect(await launch.checkoutPerk({ _id: "i1" }, "adi")).toEqual({ discounts: [{ promotion_code: "promo_1" }] });
  });

  it("not for a plan the code doesn't cover, or an expired code", async () => {
    LaunchSignup.findOne.mockReturnValue(q({ invite: { promoCode: "EARLY20" } }));
    PromoCode.findOne.mockReturnValue(q({ code: "EARLY20", stripePromotionCodeId: "promo_1", plans: ["driving-school"] }));
    expect(await launch.checkoutPerk({ _id: "i1" }, "adi")).toBeNull();
    PromoCode.findOne.mockReturnValue(q({ code: "EARLY20", stripePromotionCodeId: "promo_1", expiresAt: new Date(Date.now() - 1000) }));
    expect(await launch.checkoutPerk({ _id: "i1" }, "adi")).toBeNull();
  });

  it("nothing for someone who didn't come in by invite", async () => {
    expect(await launch.checkoutPerk({ _id: "i1" }, "adi")).toBeNull();
  });
});

describe("give a month, get a month", () => {
  const stripe = { customers: { createBalanceTransaction: jest.fn(async () => ({})) } };
  const friend = { _id: "f1", email: "sam@x.com", name: "Sam", plan: "adi", referredBy: "ella1", referralRewardedAt: null, stripeCustomerId: "cus_f" };
  const paid = { amount_paid: 2900, billing_reason: "subscription_cycle", metadata: {} };

  beforeEach(() => {
    Instructor.findOne.mockResolvedValue({ _id: "r1", email: "ella@x.com", name: "Ella", plan: "driving-school", referralCode: "ella1", stripeCustomerId: "cus_r", referralFreeMonths: 0 });
    Instructor.findOneAndUpdate.mockResolvedValue({ ...friend, referralRewardedAt: new Date() });
  });

  it("a referred customer's first payment gives both a month of their own plan as credit", async () => {
    const result = await launch.rewardReferral(stripe, friend, paid);
    expect(result).toEqual({ friend: true, referrer: true });
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith("cus_f", expect.objectContaining({ amount: -2900, currency: "gbp" }));
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith("cus_r", expect.objectContaining({ amount: -9900, currency: "gbp" }));
    expect(emails.sendReferralReward).toHaveBeenCalledTimes(2);
  });

  it("pays once: a retried webhook finds it already claimed", async () => {
    Instructor.findOneAndUpdate.mockResolvedValue(null);
    expect(await launch.rewardReferral(stripe, friend, paid)).toBeNull();
    expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("not for £0 invoices, trial seat charges or one-off invoices", async () => {
    expect(await launch.rewardReferral(stripe, friend, { ...paid, amount_paid: 0 })).toBeNull();
    expect(await launch.rewardReferral(stripe, friend, { ...paid, metadata: { kind: "trial-seats" } })).toBeNull();
    expect(await launch.rewardReferral(stripe, friend, { ...paid, billing_reason: "manual" })).toBeNull();
    expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });

  it("the referrer stops earning at the cap; the friend still gets theirs", async () => {
    mockSettings["referral.maxFreeMonths"] = 2;
    Instructor.findOne.mockResolvedValue({ _id: "r1", referralCode: "ella1", stripeCustomerId: "cus_r", referralFreeMonths: 2, plan: "adi" });
    expect(await launch.rewardReferral(stripe, friend, paid)).toEqual({ friend: true, referrer: false });
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledTimes(1);
  });
});
