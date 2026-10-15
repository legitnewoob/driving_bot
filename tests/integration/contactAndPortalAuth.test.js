/**
 * The website's Contact us form, and the Portal's sign-in rules: Portal sign-in
 * never creates an account, and the Portal can hand its sign-in to the dashboard.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/authCodeModel");
jest.mock("../../src/models/contactRequestModel");
jest.mock("../../src/utils/emailNotifier", () => ({ sendContactRequest: jest.fn() }));
jest.mock("google-auth-library", () => ({
  OAuth2Client: jest.fn(() => ({ verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ sub: "g1", email: "stranger@x.com", name: "S" }) })) })),
}));

const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const AuthCode = require("../../src/models/authCodeModel");
const ContactRequest = require("../../src/models/contactRequestModel");
const { sendContactRequest } = require("../../src/utils/emailNotifier");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret";
let server;
let base;
beforeAll((done) => {
  process.env.JWT_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use("/api/auth", require("../../src/routes/authGoogle"));
  app.use("/api/contact", require("../../src/routes/contact"));
  server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
});
afterAll((done) => { delete process.env.JWT_SECRET; server.close(done); });
beforeEach(() => jest.clearAllMocks());

const post = (path, body, headers = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("Contact us", () => {
  beforeEach(() => {
    ContactRequest.create.mockResolvedValue({ _id: "c1" });
    ContactRequest.updateOne.mockResolvedValue({});
  });

  it("saves the message and emails the team", async () => {
    sendContactRequest.mockResolvedValue(true);
    const res = await post("/api/contact", { name: " Sam ", email: "Sam@X.com", message: "Do you cover Leeds?" });
    expect(res.status).toBe(201);
    expect(ContactRequest.create).toHaveBeenCalledWith({ name: "Sam", email: "sam@x.com", message: "Do you cover Leeds?" });
    expect(sendContactRequest).toHaveBeenCalledWith({ name: "Sam", email: "sam@x.com", message: "Do you cover Leeds?" });
    expect(ContactRequest.updateOne).toHaveBeenCalledWith({ _id: "c1" }, { emailed: true });
  });

  it("still succeeds (and keeps the message) when email fails", async () => {
    sendContactRequest.mockResolvedValue(false);
    const res = await post("/api/contact", { name: "Sam", email: "sam@x.com" });
    expect(res.status).toBe(201);
    expect(ContactRequest.create).toHaveBeenCalled();
    expect(ContactRequest.updateOne).not.toHaveBeenCalled();
  });

  it("needs a name and a valid email", async () => {
    expect((await post("/api/contact", { email: "sam@x.com" })).status).toBe(400);
    expect((await post("/api/contact", { name: "Sam", email: "nope" })).status).toBe(400);
    expect(ContactRequest.create).not.toHaveBeenCalled();
  });

  it("quietly drops bots that fill the hidden field", async () => {
    const res = await post("/api/contact", { name: "Bot", email: "b@x.com", website: "http://spam" });
    expect(res.status).toBe(200);
    expect(ContactRequest.create).not.toHaveBeenCalled();
  });
});

describe("Portal sign-in", () => {
  it("doesn't create an account for someone who isn't an instructor", async () => {
    Instructor.findOne.mockResolvedValue(null);
    const res = await post("/api/auth/google-signup", { credential: "id-token", signInOnly: true });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("NOT_REGISTERED");
    expect(Instructor.create).not.toHaveBeenCalled();
  });

  it("treats a deleted account as not registered (and leaves it alone)", async () => {
    Instructor.findOne.mockResolvedValue({ email: "stranger@x.com", active: false });
    const res = await post("/api/auth/google-signup", { credential: "id-token", signInOnly: true });
    expect(res.status).toBe(404);
    expect(Instructor.create).not.toHaveBeenCalled();
  });
});

describe("Portal → dashboard handoff", () => {
  const token = signToken({ email: "alex@x.com", instructorId: "i1" }, SECRET);

  it("issues a short-lived one-time code carrying the same sign-in", async () => {
    Instructor.findOne.mockResolvedValue({ _id: "i1", email: "alex@x.com", active: true });
    AuthCode.create.mockResolvedValue({});
    const res = await post("/api/auth/handoff", {}, { Authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const { code } = await res.json();
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    const saved = AuthCode.create.mock.calls[0][0];
    expect(saved).toMatchObject({ code, instructorId: "i1", token });
    expect(saved.apiKey).toBeUndefined();
    expect(saved.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(2 * 60 * 1000);
  });

  it("needs a signed-in instructor", async () => {
    expect((await post("/api/auth/handoff", {})).status).toBe(401);
  });
});
