/**
 * Learners Route – Integration Tests
 * ────────────────────────────────────
 * Covers src/routes/learners.js and src/middleware/instructorAuth.js:
 *
 *  1. instructorAuth – missing/invalid API key → 401
 *  2. POST /api/learners – create success
 *  3. POST /api/learners – duplicate phone → 409
 *  4. GET /api/learners – list/search
 *  5. GET /api/learners/:phone – single lookup
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/services/whatsappService", () => ({
  sendTemplateMessage: jest.fn().mockResolvedValue({}),
}));

const express = require("express");
const http = require("http");
const User = require("../../src/models/userModel");
const Instructor = require("../../src/models/instructorSchema");
const whatsappService = require("../../src/services/whatsappService");

let app;
let server;
let baseUrl;

const VALID_KEY = "test-api-key";
const INSTRUCTOR = {
  _id: "inst-doc-1",
  phoneNumberId: "inst-1",
  name: "Alice",
  apiKey: VALID_KEY,
  active: true,
};

beforeAll((done) => {
  const learnersRouter = require("../../src/routes/learners");
  app = express();
  app.use(express.json());
  app.use("/api/learners", learnersRouter);

  server = app.listen(0, () => {
    const port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => {
    server.unref();
    done();
  });
});

beforeEach(() => {
  jest.clearAllMocks();
});

function httpRequest(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${baseUrl}${path}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers,
        },
      },
      (res) => {
        let chunks = "";
        res.on("data", (chunk) => (chunks += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(chunks) });
          } catch {
            resolve({ status: res.statusCode, body: chunks });
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. instructorAuth
// ═══════════════════════════════════════════════════════════════════════════

describe("instructorAuth", () => {
  it("returns 401 when x-api-key header is missing", async () => {
    const { status, body } = await httpRequest("GET", "/api/learners");

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });

  it("returns 401 when API key does not match an instructor", async () => {
    Instructor.findOne.mockResolvedValue(null);

    const { status, body } = await httpRequest("GET", "/api/learners", {
      headers: { "x-api-key": "bad-key" },
    });

    expect(status).toBe(401);
    expect(body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. POST /api/learners
// ═══════════════════════════════════════════════════════════════════════════

describe("POST /api/learners", () => {
  it("creates a learner, normalizes phone, and sends a welcome template", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({
      phone: "447700900000",
      instructorId: "inst-1",
      name: "Raj",
      currentStep: "age",
    });

    const { status, body } = await httpRequest("POST", "/api/learners", {
      headers: { "x-api-key": VALID_KEY },
      body: { phone: "07700 900000", name: "Raj" },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: "447700900000",
        instructorId: "inst-1",
        name: "Raj",
        currentStep: "age",
        onboardingStarted: false,
      })
    );
    expect(whatsappService.sendTemplateMessage).toHaveBeenCalledWith(
      "447700900000",
      "learner_welcome",
      ["Alice"],
      INSTRUCTOR
    );
  });

  it("defaults currentStep to 'name' when no name provided", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);
    User.findOne.mockResolvedValue(null);
    User.create.mockResolvedValue({ phone: "447700900000", currentStep: "name" });

    await httpRequest("POST", "/api/learners", {
      headers: { "x-api-key": VALID_KEY },
      body: { phone: "07700 900000" },
    });

    expect(User.create).toHaveBeenCalledWith(
      expect.objectContaining({ currentStep: "name" })
    );
  });

  it("returns 409 when the learner already exists", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);
    User.findOne.mockResolvedValue({ phone: "447700900000" });

    const { status, body } = await httpRequest("POST", "/api/learners", {
      headers: { "x-api-key": VALID_KEY },
      body: { phone: "07700 900000", name: "Raj" },
    });

    expect(status).toBe(409);
    expect(body.success).toBe(false);
    expect(User.create).not.toHaveBeenCalled();
  });

  it("returns 400 when phone is missing", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);

    const { status, body } = await httpRequest("POST", "/api/learners", {
      headers: { "x-api-key": VALID_KEY },
      body: { name: "Raj" },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /api/learners
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/learners", () => {
  it("returns paginated learners scoped to the instructor", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);

    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ phone: "447700900000", name: "Raj" }]),
    };
    User.find.mockReturnValue(mockQuery);
    User.countDocuments.mockResolvedValue(1);

    const { status, body } = await httpRequest("GET", "/api/learners", {
      headers: { "x-api-key": VALID_KEY },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(1);
    expect(User.find).toHaveBeenCalledWith(
      expect.objectContaining({ instructorId: "inst-1" })
    );
  });

  it("applies a search filter on name/phone", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);

    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    User.find.mockReturnValue(mockQuery);
    User.countDocuments.mockResolvedValue(0);

    await httpRequest("GET", "/api/learners?search=Raj", {
      headers: { "x-api-key": VALID_KEY },
    });

    expect(User.find).toHaveBeenCalledWith(
      expect.objectContaining({
        instructorId: "inst-1",
        $or: [{ name: expect.any(RegExp) }, { phone: expect.any(RegExp) }],
      })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GET /api/learners/:phone
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/learners/:phone", () => {
  it("returns a learner scoped to the instructor", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);

    const mockFindOne = { lean: jest.fn().mockResolvedValue({ phone: "447700900000", name: "Raj" }) };
    User.findOne.mockReturnValue(mockFindOne);

    const { status, body } = await httpRequest("GET", "/api/learners/07700900000", {
      headers: { "x-api-key": VALID_KEY },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.name).toBe("Raj");
    expect(User.findOne).toHaveBeenCalledWith({
      phone: "447700900000",
      instructorId: "inst-1",
    });
  });

  it("returns 404 when the learner is not found", async () => {
    Instructor.findOne.mockResolvedValue(INSTRUCTOR);

    const mockFindOne = { lean: jest.fn().mockResolvedValue(null) };
    User.findOne.mockReturnValue(mockFindOne);

    const { status, body } = await httpRequest("GET", "/api/learners/447700900000", {
      headers: { "x-api-key": VALID_KEY },
    });

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});
