/**
 * Deleting an account really deletes it: signing in again with the same Google
 * account starts a new account (and has to pick a plan), it doesn't bring the
 * old one back.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/phoneNumberModel");
// Sign-up is open (no launch waitlist) for these tests
jest.mock("../../src/services/launchService", () => ({ signupAllowed: jest.fn(async () => ({ allowed: true, entry: null })), onSignup: jest.fn() }));
jest.mock("../../src/models/instructorModel", () => ({ invalidateInstructorCache: jest.fn() }));
jest.mock("../../src/services/phoneNumberService", () => ({
  isFullyProvisioned: (i) => !!i.phoneNumberId && !i.phoneNumberId.startsWith("signup_"),
  revokeNumber: jest.fn().mockResolvedValue({}),
}));
const mockStripe = { subscriptions: { cancel: jest.fn() } };
jest.mock("stripe", () => jest.fn(() => mockStripe));
const mockVerify = jest.fn();
jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerify })) }));

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const PhoneNumber = require("../../src/models/phoneNumberModel");
const phoneNumberService = require("../../src/services/phoneNumberService");
const { deleteAccount } = require("../../src/services/accountDeletion");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret";
let server;
let base;
beforeAll((done) => {
  process.env.JWT_SECRET = SECRET;
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../src/routes/authGoogle"));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}/api/auth`; done(); });
});
afterAll((done) => { delete process.env.JWT_SECRET; delete process.env.STRIPE_SECRET_KEY; server.close(done); });
beforeEach(() => jest.clearAllMocks());

const sam = (extra = {}) => ({
  _id: "sam-1", email: "chessforlife.18@gmail.com", name: "Sam", googleId: "g-1", plan: "adi", active: true,
  subscriptionId: "sub_1", subscriptionStatus: "active", phoneNumberId: "real-1", schoolRole: null, save: jest.fn(), ...extra,
});

describe("deleting an account", () => {
  it("cancels billing, releases the number and removes their identity", async () => {
    PhoneNumber.findOne.mockResolvedValue({ _id: "pn-1" });
    await deleteAccount(sam());
    expect(mockStripe.subscriptions.cancel).toHaveBeenCalledWith("sub_1");
    expect(phoneNumberService.revokeNumber).toHaveBeenCalledWith("pn-1");
    const [filter, update] = Instructor.updateOne.mock.calls[0];
    expect(filter).toEqual({ _id: "sam-1" });
    expect(update.$set).toMatchObject({ active: false, email: "deleted+sam-1@deleted.donnadrive.invalid", subscriptionStatus: "canceled" });
    // Kept for admins only: who the account belonged to
    expect(update.$set.deletedIdentity).toEqual({ email: "chessforlife.18@gmail.com", name: "Sam", googleId: "g-1" });
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(update.$unset).toMatchObject({ googleId: 1, apiKey: 1, googleRefreshToken: 1 });
  });

  it("the delete endpoint needs the DELETE confirmation", async () => {
    const res = await fetch(`${base}/delete-account`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken({ email: "chessforlife.18@gmail.com" }, SECRET)}` }, body: "{}",
    });
    expect(res.status).toBe(400);
  });

  it("a school owner with instructors has to remove them first", async () => {
    Instructor.findOne.mockResolvedValue(sam({ schoolRole: "owner", schoolId: "s1" }));
    Instructor.countDocuments.mockResolvedValue(2);
    const res = await fetch(`${base}/delete-account`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${signToken({ email: "chessforlife.18@gmail.com" }, SECRET)}` },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(res.status).toBe(409);
    expect(Instructor.updateOne).not.toHaveBeenCalled();
  });
});

describe("signing in again after deleting", () => {
  beforeEach(() => {
    mockVerify.mockResolvedValue({ getPayload: () => ({ sub: "g-1", email: "chessforlife.18@gmail.com", name: "Sam" }) });
    Instructor.create.mockImplementation(async (doc) => ({ _id: "new-1", ...doc }));
    Instructor.find.mockReturnValue({ lean: async () => [] });
  });

  it("the new account is linked to the deleted one(s), so admins can see they came back", async () => {
    Instructor.findOne.mockResolvedValue(null);
    Instructor.find.mockReturnValue({ lean: async () => [{ _id: "sam-1" }] });
    const res = await signIn();
    expect(Instructor.find).toHaveBeenCalledWith(
      { deletedAt: { $ne: null }, $or: [{ "deletedIdentity.email": "chessforlife.18@gmail.com" }, { "deletedIdentity.googleId": "g-1" }] },
      { _id: 1 }
    );
    expect(Instructor.create).toHaveBeenCalledWith(expect.objectContaining({ previousAccountIds: ["sam-1"], planSelected: false }));
    // For them it's a normal new account
    expect(res).toMatchObject({ isNew: true, needsPlan: true });
  });

  it("first-time sign-ups aren't marked as returning", async () => {
    Instructor.findOne.mockResolvedValue(null);
    await signIn();
    expect(Instructor.create.mock.calls[0][0].previousAccountIds).toBeUndefined();
  });

  const signIn = () => fetch(`${base}/google-signup`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: "id-token", plan: "pdi" }),
  }).then((r) => r.json());

  it("an account deleted the old way (just switched off) is finished off and a new one starts", async () => {
    Instructor.findOne.mockResolvedValue(sam({ active: false }));
    const res = await signIn();
    expect(Instructor.updateOne).toHaveBeenCalledWith({ _id: "sam-1" }, expect.objectContaining({ $set: expect.objectContaining({ active: false }) }));
    expect(Instructor.create).toHaveBeenCalledWith(expect.objectContaining({ email: "chessforlife.18@gmail.com", planSelected: false, active: true }));
    expect(res).toMatchObject({ isNew: true, needsPlan: true });
  });

  it("a fully deleted account isn't found, so it's simply a new sign-up", async () => {
    Instructor.findOne.mockResolvedValue(null);
    const res = await signIn();
    expect(res).toMatchObject({ isNew: true, needsPlan: true });
  });

  it("a suspended account still can't sign in", async () => {
    Instructor.findOne.mockResolvedValue(sam({ active: false, suspended: true }));
    const res = await fetch(`${base}/google-signup`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: "id-token" }),
    });
    expect(res.status).toBe(403);
    expect(Instructor.create).not.toHaveBeenCalled();
  });
});
