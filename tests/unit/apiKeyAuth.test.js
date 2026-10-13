/**
 * Portal auth: a valid login token works even when the API key is stale
 * (every new login replaces the API key).
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/instructorSchema");

const crypto = require("crypto");
const Instructor = require("../../src/models/instructorSchema");
const apiKeyAuth = require("../../src/middleware/apiKeyAuth");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret";
const INSTRUCTOR = { _id: "inst-oid", email: "sam@test.com", phoneNumberId: "inst-1", active: true };
const hash = (k) => crypto.createHash("sha256").update(k).digest("hex");

function run(headers) {
  const req = { headers };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  const next = jest.fn();
  return apiKeyAuth(req, res, next).then(() => ({ req, res, next }));
}

beforeAll(() => { process.env.JWT_SECRET = SECRET; });
afterAll(() => { delete process.env.JWT_SECRET; });

beforeEach(() => {
  jest.clearAllMocks();
  Instructor.findOne.mockImplementation((q) => ({
    lean: async () => {
      if (q._id === INSTRUCTOR._id || q.email === INSTRUCTOR.email) return INSTRUCTOR;
      if (q.apiKey === hash("ddp_current")) return INSTRUCTOR;
      return null;
    },
  }));
});

it("accepts a valid login token even with a stale API key", async () => {
  const token = signToken({ email: INSTRUCTOR.email, instructorId: INSTRUCTOR._id }, SECRET);
  const { req, next } = await run({ authorization: `Bearer ${token}`, "x-api-key": "ddp_old_replaced" });
  expect(next).toHaveBeenCalled();
  expect(req.instructor).toBe(INSTRUCTOR);
});

it("still accepts a current API key on its own", async () => {
  const { next } = await run({ "x-api-key": "ddp_current" });
  expect(next).toHaveBeenCalled();
});

it("falls back to the API key when the token is bad", async () => {
  const { next } = await run({ authorization: "Bearer not.a.token", "x-api-key": "ddp_current" });
  expect(next).toHaveBeenCalled();
});

it("rejects an expired token with no usable key", async () => {
  const expired = signToken({ email: INSTRUCTOR.email, instructorId: INSTRUCTOR._id }, SECRET, -10);
  const { res, next } = await run({ authorization: `Bearer ${expired}` });
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(401);
});
