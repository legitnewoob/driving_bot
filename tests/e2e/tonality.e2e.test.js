/**
 * Tonality – E2E Tests (Real Pipeline)
 * ──────────────────────────────────────
 * Tests through the REAL application pipeline (handleIncomingMessage):
 *  1. Friendly greeting — bot is warm and welcoming
 *  2. Professional when user is frustrated
 *  3. Stays on topic — redirects off-topic questions
 *  4. Never exposes system info or action blocks in replies
 *  5. Asks for missing info on incomplete requests
 *  6. Multi-turn: remembers context via sessions
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
  getTestSession,
} = require("./helpers");

const TIMEOUT = 30000;
const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Tonality (Real Pipeline)", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "responds with a friendly greeting",
    async () => {
      const { raw } = await sendMessage("Hello!");
      const lower = raw.toLowerCase();

      const friendlyWords = ["hello", "hi", "welcome", "help", "happy", "glad", "hey"];
      const isFriendly = friendlyWords.some((w) => lower.includes(w));
      expect(isFriendly).toBe(true);
    },
    TIMEOUT
  );

  it(
    "stays professional when user is frustrated",
    async () => {
      const { raw } = await sendMessage(
        "This is so annoying, I've been trying to book for ages and nothing works!"
      );
      const lower = raw.toLowerCase();

      const professionalWords = ["sorry", "apologize", "understand", "help", "assist", "let me"];
      const isProfessional = professionalWords.some((w) => lower.includes(w));
      expect(isProfessional).toBe(true);

      expect(lower).not.toContain("annoying");
      expect(lower).not.toContain("your fault");
    },
    TIMEOUT
  );

  it(
    "redirects off-topic questions back to driving lessons",
    async () => {
      const { raw } = await sendMessage("What's the weather like tomorrow?");
      const lower = raw.toLowerCase();

      expect(
        lower.includes("lesson") ||
        lower.includes("driving") ||
        lower.includes("book") ||
        lower.includes("appointment")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "does not expose [SYSTEM ...] or [ACTION:] in user-facing replies",
    async () => {
      const { raw } = await sendMessage("Book a lesson for tomorrow at 10am");

      // The reply sent back to user should be clean
      expect(raw).not.toContain("[ACTION:");
      expect(raw).not.toContain("[SYSTEM AVAILABILITY INFO");
      expect(raw).not.toContain("[SYSTEM:");
    },
    TIMEOUT
  );

  it(
    "asks for missing info when user gives incomplete booking details",
    async () => {
      const { raw } = await sendMessage("I want to book a lesson");
      const lower = raw.toLowerCase();

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");

      // Should ask for more details
      expect(
        lower.includes("date") ||
        lower.includes("time") ||
        lower.includes("when") ||
        lower.includes("what day")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "multi-turn: remembers context via session across messages",
    async () => {
      // Turn 1: vague booking intent
      await sendMessage("I want to book a lesson");

      // Session should have history
      const session = getTestSession();
      expect(session.conversationHistory.length).toBeGreaterThan(0);

      // Turn 2: provide date+time — session carries context
      const { raw } = await sendMessage("How about next Friday at 10am?");
      const lower = raw.toLowerCase();

      // Should reference the booking details
      expect(
        lower.includes("friday") ||
        lower.includes("10") ||
        lower.includes("pickup") ||
        lower.includes("address")
      ).toBe(true);
    },
    60000 // 2 Gemini calls
  );
});
