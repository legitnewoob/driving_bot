/**
 * Response Time – E2E Tests (Real Pipeline)
 * ───────────────────────────────────────────
 * Measures full pipeline latency through handleIncomingMessage:
 *   instructor resolution → user details → date extraction → Gemini → action dispatch
 *
 *  1. Single message latency (< 15s — includes date extraction + Gemini)
 *  2. Average latency across multiple messages
 *  3. Consistency — no single response takes excessively long
 *
 * Env:  Loaded via helpers.js → envs/.env.test
 * Run:  npm run test:e2e
 */

jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn().mockResolvedValue({ id: "cal-event-e2e-123" }),
  updateEvent: jest.fn().mockResolvedValue({ id: "cal-event-e2e-123" }),
  deleteEvent: jest.fn().mockResolvedValue({}),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true, conflictingEvents: [] }),
  findEarliestAvailableSlot: jest.fn().mockResolvedValue({ date: "2026-05-06", time: "10:00" }),
  getAvailableTimeSlotsForDate: jest.fn().mockResolvedValue(
    ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]
  ),
  checkAvailability: jest.fn().mockResolvedValue(true),
}));
jest.mock("../../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("test-spreadsheet-id"),
  getLearnerName: jest.fn().mockResolvedValue("E2E Test User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));

const {
  sendMessage,
  setupE2ESuite, cleanupE2ETest, teardownE2ESuite,
} = require("./helpers");

const SINGLE_MSG_LIMIT_MS = 15000; // 15s max (includes date extraction + Gemini)
const AVG_LIMIT_MS = 12000;        // 12s average
const TIMEOUT = 20000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Response Time (Real Pipeline)", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    `greeting responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await sendMessage("Hello!");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Greeting: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `booking request responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await sendMessage("I want to book a lesson next Monday at 10am");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Booking request: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `show bookings responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await sendMessage("Show me my bookings");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Show bookings: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `average of 5 messages is under ${AVG_LIMIT_MS}ms`,
    async () => {
      const messages = [
        "Hi there",
        "Book a lesson for Friday",
        "10am please",
        "Show my bookings",
        "Cancel booking DL-AB12",
      ];

      const times = [];
      for (const msg of messages) {
        const start = Date.now();
        await sendMessage(msg);
        times.push(Date.now() - start);
        cleanupE2ETest(); // isolate each message
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`  ⏱ Individual: [${times.map((t) => t + "ms").join(", ")}]`);
      console.log(`  ⏱ Average: ${Math.round(avg)}ms`);

      expect(avg).toBeLessThan(AVG_LIMIT_MS);
    },
    120000 // 5 API calls
  );
});
