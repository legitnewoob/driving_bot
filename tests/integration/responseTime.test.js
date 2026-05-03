/**
 * Response Time – Integration Tests
 * ───────────────────────────────────
 * Measures end-to-end latency of handleIncomingMessage.
 * All external APIs are mocked but the full internal flow runs:
 *   webhook → instructor resolution → user details → AI → action dispatch
 *
 * Acceptable limit: < 3000ms per message
 */

// ── Mocks ──────────────────────────────────────────────────────────────

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn().mockResolvedValue({ id: "evt-perf" }),
  updateEvent: jest.fn().mockResolvedValue({ id: "evt-perf" }),
  deleteEvent: jest.fn().mockResolvedValue({ success: true }),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true, conflictingEvents: [] }),
  findEarliestAvailableSlot: jest.fn().mockResolvedValue({ date: "2025-07-20", time: "09:00" }),
  getAvailableTimeSlotsForDate: jest.fn().mockResolvedValue(["09:00", "10:00", "11:00"]),
  checkAvailability: jest.fn().mockResolvedValue({ isAvailable: true }),
}));
jest.mock("../../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-perf"),
  getLearnerName: jest.fn().mockResolvedValue("Perf User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({
    lat: 53.02, lng: -2.22,
    formattedAddress: "Mock Address",
    mapUrl: "https://maps.google.com/mock",
    message: "Location found",
  }),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({
  user: jest.fn(),
  assistant: jest.fn(),
})));

// Mock Gemini — simulate realistic AI latency (50-150ms)
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
        return {
          response: {
            text: () =>
              "Sure, I can help you with that! What date works for you?\n[ACTION:NULL]\n{}",
          },
        };
      }),
    }),
  })),
}));
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue("You are {{INSTRUCTOR_NAME}}'s booking assistant."),
  };
});

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-perf",
  name: "Perf Instructor",
  googleCalendarId: "cal@perf.com",
  googleRefreshToken: "refresh-perf",
  whatsappToken: "wa-token-perf",
  spreadsheetId: "sheet-perf",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  rates: { basic: 50, highway: 60, parking: 45 },
  timezone: "Europe/London",
  active: true,
};

jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async () => MOCK_INSTRUCTOR),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2025-07-20"]),
}));

const User = require("../../src/models/userModel");
const webhookController = require("../../src/controllers/webhookController");

const REGISTERED_USER = {
  phone: "447900000001",
  name: "Perf User",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  detailsCompleted: true,
  instructorId: "inst-perf",
};

const RESPONSE_LIMIT_MS = 3000;

beforeEach(() => {
  jest.clearAllMocks();
  User.findOne.mockResolvedValue(REGISTERED_USER);
});

// ═══════════════════════════════════════════════════════════════════════════

describe("Response Time – handleIncomingMessage", () => {
  it(`general conversation completes within ${RESPONSE_LIMIT_MS}ms`, async () => {
    const start = Date.now();

    await webhookController.handleIncomingMessage(
      "447900000001",
      "Hi, I want to book a lesson",
      "inst-perf"
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(RESPONSE_LIMIT_MS);
  });

  it(`booking request completes within ${RESPONSE_LIMIT_MS}ms`, async () => {
    const start = Date.now();

    await webhookController.handleIncomingMessage(
      "447900000001",
      "Book me a lesson on Monday at 10am, pickup ST5 1AB dropoff ST4 2DE",
      "inst-perf"
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(RESPONSE_LIMIT_MS);
  });

  it(`show bookings completes within ${RESPONSE_LIMIT_MS}ms`, async () => {
    const start = Date.now();

    await webhookController.handleIncomingMessage(
      "447900000001",
      "Show me my bookings",
      "inst-perf"
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(RESPONSE_LIMIT_MS);
  });

  it(`cancel request completes within ${RESPONSE_LIMIT_MS}ms`, async () => {
    const start = Date.now();

    await webhookController.handleIncomingMessage(
      "447900000001",
      "I want to cancel my booking DL-ABC",
      "inst-perf"
    );

    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(RESPONSE_LIMIT_MS);
  });

  it(
    `5 sequential messages all complete within ${RESPONSE_LIMIT_MS}ms each`,
    async () => {
      const messages = [
        "Hello",
        "I need a lesson",
        "How about next Friday?",
        "10am please",
        "My pickup is ST5 1AB",
      ];

      for (const msg of messages) {
        const start = Date.now();

        await webhookController.handleIncomingMessage("447900000001", msg, "inst-perf");

        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(RESPONSE_LIMIT_MS);
      }
    },
    20000
  );

  it(
    `average response time across 10 messages is under ${RESPONSE_LIMIT_MS}ms`,
    async () => {
      const times = [];
      const messages = [
        "Hi", "Book a lesson", "Tomorrow", "10am",
        "ST5 1AB", "ST4 2DE", "Show bookings", "Cancel DL-X",
        "Thanks", "Bye",
      ];

      for (const msg of messages) {
        const start = Date.now();
        await webhookController.handleIncomingMessage("447900000001", msg, "inst-perf");
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      expect(avg).toBeLessThan(RESPONSE_LIMIT_MS);
    },
    30000
  );
});
