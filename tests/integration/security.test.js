/**
 * Security checks: signed calendar-connect state, WhatsApp webhook signatures,
 * JWT algorithm pinning, MongoDB operator stripping, and Google sign-in tokens
 * that were issued to some other app.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/instructorModel", () => ({ invalidateInstructorCache: jest.fn() }));
const mockGetToken = jest.fn();
jest.mock("../../src/config/google", () => ({
  newClient: jest.fn(() => ({ getToken: mockGetToken, generateAuthUrl: jest.fn(() => "https://accounts.google.com/x") })),
  clientFor: jest.fn(),
  calendar: {},
}));
const mockVerify = jest.fn();
jest.mock("google-auth-library", () => ({ OAuth2Client: jest.fn(() => ({ verifyIdToken: mockVerify })) }));

const crypto = require("crypto");
const express = require("express");
const Instructor = require("../../src/models/instructorSchema");
const { createState, readState } = require("../../src/utils/oauthState");
const verifyMetaSignature = require("../../src/middleware/verifyMetaSignature");
const { clean } = require("../../src/middleware/sanitizeInput");
const { verifyToken } = require("../../src/middleware/jwtAuth");
const { signToken } = require("../../src/utils/jwtSign");

const SECRET = "test-secret-that-is-long-enough";
beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.JWT_SECRET;
});
beforeEach(() => jest.clearAllMocks());

describe("calendar connect state", () => {
  it("round-trips the instructor id", () => {
    expect(readState(createState("abc123"))).toBe("abc123");
  });

  it("rejects forged, tampered, old-style and expired states", () => {
    expect(readState("email:victim@x.com")).toBeNull();
    expect(readState("phone:447700900123")).toBeNull();
    const [body, mac] = createState("abc123").split(".");
    const forgedBody = Buffer.from(JSON.stringify({ i: "victim", n: "x", e: 9999999999 })).toString("base64url");
    expect(readState(`${forgedBody}.${mac}`)).toBeNull();
    expect(readState(`${body}.${mac.slice(0, -2)}xx`)).toBeNull();
    const old = Buffer.from(JSON.stringify({ i: "abc123", n: "x", e: 1 })).toString("base64url");
    const oldMac = crypto.createHmac("sha256", SECRET).update(old).digest("base64url");
    expect(readState(`${old}.${oldMac}`)).toBeNull();
  });

  describe("callback", () => {
    let server, base;
    beforeAll((done) => {
      const app = express();
      app.use("/auth", require("../../src/routes/auth"));
      server = app.listen(0, () => {
        base = `http://127.0.0.1:${server.address().port}`;
        done();
      });
    });
    afterAll((done) => {
      server.close(done);
    });
    const get = (path) => fetch(`${base}${path}`, { redirect: "manual" });

    it("a made-up state never saves a calendar to anyone's account", async () => {
      const res = await get(`/auth/oauth2callback?code=attacker-code&state=${encodeURIComponent("email:victim@x.com")}`);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("calendar=error");
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(Instructor.findOne).not.toHaveBeenCalled();
    });

    it("a signed state saves the calendar to the instructor who started it", async () => {
      const d = { _id: "i1", phoneNumberId: "p1", save: jest.fn() };
      Instructor.findOne.mockResolvedValue(d);
      mockGetToken.mockResolvedValue({ tokens: { refresh_token: "rt" } });
      const res = await get(`/auth/oauth2callback?code=c&state=${encodeURIComponent(createState("i1"))}`);
      expect(res.headers.get("location")).toContain("calendar=connected");
      expect(Instructor.findOne).toHaveBeenCalledWith({ _id: "i1", active: true });
      expect(d.googleRefreshToken).toBe("rt");
    });

    it("the old unauthenticated phone link no longer starts a connection", async () => {
      const res = await get("/auth/google?phone=447700900123");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toMatch(/\/dashboard$/);
    });
  });
});

describe("WhatsApp webhook signature", () => {
  const body = Buffer.from(JSON.stringify({ object: "whatsapp_business_account", entry: [] }));
  const sign = (b, secret = "app-secret") => `sha256=${crypto.createHmac("sha256", secret).update(b).digest("hex")}`;
  const run = (headers, rawBody = body) => {
    const res = { sendStatus: jest.fn() };
    const next = jest.fn();
    verifyMetaSignature({ headers, rawBody }, res, next);
    return { res, next };
  };

  beforeEach(() => {
    process.env.META_APP_SECRET = "app-secret";
  });
  afterEach(() => {
    delete process.env.META_APP_SECRET;
    delete process.env.WHATSAPP_SIGNATURE_CHECK;
  });

  it("lets through a message Meta signed", () => {
    expect(run({ "x-hub-signature-256": sign(body) }).next).toHaveBeenCalled();
  });

  it("refuses unsigned, wrongly signed, or altered messages", () => {
    expect(run({}).res.sendStatus).toHaveBeenCalledWith(403);
    expect(run({ "x-hub-signature-256": sign(body, "other-secret") }).res.sendStatus).toHaveBeenCalledWith(403);
    const altered = Buffer.from(body.toString().replace("[]", "[{}]"));
    expect(run({ "x-hub-signature-256": sign(body) }, altered).res.sendStatus).toHaveBeenCalledWith(403);
  });

  it("refuses everything when the app secret isn't configured", () => {
    delete process.env.META_APP_SECRET;
    expect(run({ "x-hub-signature-256": sign(body) }).res.sendStatus).toHaveBeenCalledWith(403);
  });
});

describe("sign-in tokens", () => {
  const forge = (alg, payload) => {
    const h = Buffer.from(JSON.stringify({ alg, typ: "JWT" })).toString("base64url");
    const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const hash = { HS1: "sha1", HS256: "sha256", HS512: "sha512" }[alg] || "sha256";
    return `${h}.${p}.${crypto.createHmac(hash, SECRET).update(`${h}.${p}`).digest("base64url")}`;
  };

  it("accepts our own tokens", () => {
    expect(verifyToken(signToken({ email: "a@x.com" }, SECRET), SECRET).email).toBe("a@x.com");
  });

  it("refuses other algorithms and tokens that never expire", () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    expect(() => verifyToken(forge("HS1", { email: "a@x.com", exp }), SECRET)).toThrow();
    expect(() => verifyToken(forge("HS512", { email: "a@x.com", exp }), SECRET)).toThrow();
    expect(() => verifyToken(forge("none", { email: "a@x.com", exp }), SECRET)).toThrow();
    expect(() => verifyToken(forge("HS256", { email: "a@x.com" }), SECRET)).toThrow();
  });
});

describe("request sanitising", () => {
  it("strips MongoDB operators and dotted keys, keeps normal data", () => {
    expect(clean({ email: { $ne: null }, name: "Sam", "a.b": 1, list: [{ $gt: 1, ok: 2 }], nested: { deep: { $where: "x" } } })).toEqual({
      email: {},
      name: "Sam",
      list: [{ ok: 2 }],
      nested: { deep: {} },
    });
  });

  it("drops prototype-polluting keys", () => {
    const out = clean(JSON.parse('{"__proto__": {"admin": true}, "constructor": {"x": 1}, "ok": 1}'));
    expect(out).toEqual({ ok: 1 });
    expect({}.admin).toBeUndefined();
  });
});

describe("Google sign-in with a token from another app", () => {
  let server, base;
  const realFetch = global.fetch;
  beforeAll((done) => {
    process.env.GOOGLE_CLIENT_ID = "433-backend.apps.googleusercontent.com";
    const app = express();
    app.use(express.json());
    app.use("/api/auth", require("../../src/routes/authGoogle"));
    server = app.listen(0, () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });
  afterAll((done) => {
    global.fetch = realFetch;
    server.close(done);
  });

  const signUp = (google) => {
    mockVerify.mockRejectedValue(new Error("not an id token"));
    global.fetch = jest.fn(async (url, opts) => {
      if (String(url).startsWith(base)) return realFetch(url, opts);
      if (String(url).includes("tokeninfo")) return { ok: true, json: async () => google };
      return { ok: true, json: async () => ({ sub: google.sub, name: "Victim" }) };
    });
    return global.fetch(`${base}/api/auth/google-signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "ya29.token", signInOnly: true }),
    });
  };

  it("refuses an access token issued to a different Google app", async () => {
    const res = await signUp({ aud: "someone-elses-app.apps.googleusercontent.com", azp: "someone-elses-app.apps.googleusercontent.com", sub: "g1", email: "victim@x.com", email_verified: "true" });
    expect(res.status).toBe(401);
    expect(Instructor.findOne).not.toHaveBeenCalled();
  });

  it("refuses an unverified email", async () => {
    const res = await signUp({ aud: "433-backend.apps.googleusercontent.com", sub: "g1", email: "victim@x.com", email_verified: "false" });
    expect(res.status).toBe(401);
  });

  it("accepts a token issued to our own app", async () => {
    Instructor.findOne.mockResolvedValue(null);
    const res = await signUp({ aud: "433-backend.apps.googleusercontent.com", sub: "g1", email: "victim@x.com", email_verified: "true" });
    // Gets as far as looking the account up (Portal sign-in: no account → 404)
    expect(res.status).toBe(404);
    expect(Instructor.findOne).toHaveBeenCalled();
  });
});
