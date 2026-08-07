/**
 * Bookings Route – Unit Tests
 * ─────────────────────────────
 * Covers the helper functions and route handlers in src/routes/bookings.js:
 *
 *  1. buildFilter – query param → Mongoose filter
 *  2. parsePagination – pagination/sort parsing
 *  3. GET /api/bookings – all bookings
 *  4. GET /api/bookings/stats – aggregate stats
 *  5. GET /api/bookings/user/:phone – by user
 *  6. GET /api/bookings/instructor/:id – by instructor
 *  7. GET /api/bookings/:bookingId – single booking
 *  8. Error handling
 *
 * We test via supertest against an Express app that mounts the router.
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/instructorSchema");

const express = require("express");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const Instructor = require("../../src/models/instructorSchema");

// Build a minimal Express app with the bookings router
let app;
let request;

beforeAll(async () => {
  // Dynamic import for supertest-like inline testing
  // We'll simulate requests manually since supertest may not be installed
  const bookingsRouter = require("../../src/routes/bookings");
  app = express();
  app.use(express.json());
  app.use("/api/bookings", bookingsRouter);
});

beforeEach(() => {
  jest.clearAllMocks();
});

// Helper: create a mock req/res and call the route handler
function mockReqRes(query = {}, params = {}) {
  const req = { query, params, body: {} };
  const res = {
    json: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
  };
  return { req, res };
}

// ═══════════════════════════════════════════════════════════════════════════
// Since we don't have supertest, we'll test the route via HTTP listener
// ═══════════════════════════════════════════════════════════════════════════

// We need a lightweight request helper
const http = require("http");

let server;
let baseUrl;

beforeAll((done) => {
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

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${baseUrl}${path}`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    }).on("error", reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. GET /api/bookings – list all bookings
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/bookings", () => {
  it("returns paginated bookings", async () => {
    const mockBookings = [
      { bookingId: "DL-001", date: "2025-07-15", time: "10:00", status: "confirmed" },
      { bookingId: "DL-002", date: "2025-07-16", time: "11:00", status: "confirmed" },
    ];

    // Mock the chained Mongoose query
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(mockBookings),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(2);

    const { status, body } = await httpGet("/api/bookings");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    expect(body.pagination.total).toBe(2);
    expect(body.pagination.page).toBe(1);
  });

  it("applies status filter", async () => {
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(0);

    await httpGet("/api/bookings?status=cancelled");

    expect(Booking.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" })
    );
  });

  it("applies date range filters", async () => {
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(0);

    await httpGet("/api/bookings?from=2025-07-01&to=2025-07-31");

    expect(Booking.find).toHaveBeenCalledWith(
      expect.objectContaining({
        date: { $gte: "2025-07-01", $lte: "2025-07-31" },
      })
    );
  });

  it("applies pagination params", async () => {
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(50);

    await httpGet("/api/bookings?page=3&limit=10");

    expect(mockQuery.skip).toHaveBeenCalledWith(20); // (3-1) * 10
    expect(mockQuery.limit).toHaveBeenCalledWith(10);
  });

  it("returns 500 on database error", async () => {
    Booking.find.mockImplementation(() => {
      throw new Error("DB error");
    });

    const { status, body } = await httpGet("/api/bookings");

    expect(status).toBe(500);
    expect(body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. GET /api/bookings/user/:phone
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/bookings/user/:phone", () => {
  it("returns bookings for a specific user", async () => {
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ bookingId: "DL-001" }]),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(1);

    const { status, body } = await httpGet("/api/bookings/user/447000000001");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(Booking.find).toHaveBeenCalledWith(
      expect.objectContaining({ userPhone: "447000000001" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. GET /api/bookings/instructor/:instructorId
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/bookings/instructor/:instructorId", () => {
  it("returns bookings for a specific instructor", async () => {
    const mockQuery = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    Booking.find.mockReturnValue(mockQuery);
    Booking.countDocuments.mockResolvedValue(0);

    const { status, body } = await httpGet("/api/bookings/instructor/inst-1");

    expect(status).toBe(200);
    expect(Booking.find).toHaveBeenCalledWith(
      expect.objectContaining({ instructorId: "inst-1" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. GET /api/bookings/:bookingId
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/bookings/:bookingId", () => {
  it("returns enriched booking by ID", async () => {
    const mockBooking = {
      bookingId: "DL-ABC",
      userPhone: "447000000001",
      instructorId: "inst-1",
      date: "2025-07-15",
    };

    const mockFindOne = { lean: jest.fn().mockResolvedValue(mockBooking) };
    Booking.findOne.mockReturnValue(mockFindOne);

    const mockUserFind = { lean: jest.fn().mockResolvedValue({ name: "Raj", phone: "447000000001" }) };
    User.findOne.mockReturnValue(mockUserFind);

    const mockInstFind = { lean: jest.fn().mockResolvedValue({ name: "Alice", phoneNumberId: "inst-1" }) };
    Instructor.findOne.mockReturnValue(mockInstFind);

    const { status, body } = await httpGet("/api/bookings/DL-ABC");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.bookingId).toBe("DL-ABC");
    expect(body.data.learner.name).toBe("Raj");
    expect(body.data.instructor.name).toBe("Alice");
  });

  it("returns 404 when booking not found", async () => {
    const mockFindOne = { lean: jest.fn().mockResolvedValue(null) };
    Booking.findOne.mockReturnValue(mockFindOne);

    const { status, body } = await httpGet("/api/bookings/NONEXISTENT");

    expect(status).toBe(404);
    expect(body.success).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. GET /api/bookings/stats
// ═══════════════════════════════════════════════════════════════════════════

describe("GET /api/bookings/stats", () => {
  it("returns aggregate statistics", async () => {
    Booking.aggregate.mockResolvedValueOnce([
      { _id: "confirmed", count: 10 },
      { _id: "cancelled", count: 3 },
    ]);
    Booking.aggregate.mockResolvedValueOnce([
      { _id: "inst-1", totalBookings: 13, confirmed: 10, cancelled: 3, rescheduled: 0 },
    ]);
    Booking.countDocuments.mockResolvedValue(13);
    Booking.distinct.mockResolvedValue(["447000000001", "447000000002"]);

    const mockInstFind = { lean: jest.fn().mockResolvedValue([{ phoneNumberId: "inst-1", name: "Alice" }]) };
    Instructor.find.mockReturnValue(mockInstFind);

    const { status, body } = await httpGet("/api/bookings/stats");

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.totalBookings).toBe(13);
    expect(body.data.uniqueLearners).toBe(2);
    expect(body.data.byStatus.confirmed).toBe(10);
    expect(body.data.byInstructor[0].instructorName).toBe("Alice");
  });

  it("returns 500 on aggregation error", async () => {
    Booking.aggregate.mockRejectedValue(new Error("Aggregation error"));

    const { status, body } = await httpGet("/api/bookings/stats");

    expect(status).toBe(500);
    expect(body.success).toBe(false);
  });
});
