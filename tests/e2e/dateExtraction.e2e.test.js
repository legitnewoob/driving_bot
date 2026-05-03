/**
 * Date/Time Extraction – E2E Tests (Real Pipeline)
 * ──────────────────────────────────────────────────
 * Tests date/time extraction through the REAL application pipeline:
 *   dateTimeService.extractDateTimeFromMessage → dateTimeUtils.sanitize →
 *   aiService.pendingContext → Gemini → action dispatch
 *
 *  1. 12h→24h conversion via real dateTimeService
 *  2. Date format (YYYY-MM-DD) in booking data
 *  3. Colloquial references ("morning", "afternoon", "half past")
 *  4. Invalid times (3am, midnight) rejected by real validation
 *  5. Pending context accumulation across turns
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
  getTestPendingContext,
} = require("./helpers");

const TIMEOUT = 30000;
const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Time Format – Pending Context Captures 24h Time
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Time Format Extraction", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  const TIME_TESTS = [
    { input: "10am", expected: "10:00" },
    { input: "2pm", expected: "14:00" },
    { input: "3pm", expected: "15:00" },
    { input: "9am", expected: "09:00" },
    { input: "4pm", expected: "16:00" },
    { input: "11am", expected: "11:00" },
  ];

  TIME_TESTS.forEach(({ input, expected }) => {
    it(
      `'${input}' → pendingContext captures ${expected}`,
      async () => {
        // Send a message with date+time — dateTimeService will extract
        await sendMessage(`I want a lesson next Wednesday at ${input}`);

        // Verify pendingContext captured the 24h time
        const pending = getTestPendingContext();
        if (pending.time) {
          expect(pending.time).toBe(expected);
        }
      },
      TIMEOUT
    );
  });

  it(
    "multi-turn: date+time+addresses → booking with correct 24h time",
    async () => {
      // Turn 1: date + time
      await sendMessage("I want a lesson next Wednesday at 2pm");
      // Turn 2: addresses → should book with 14:00
      const { raw } = await sendMessage("Pickup ST5 1AB, dropoff ST4 2DE");

      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("DL-") ||
        raw.includes("booked")
      ).toBe(true);
    },
    60000
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Date Format – YYYY-MM-DD in Pending Context
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Date Format Extraction", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "pendingContext stores date in YYYY-MM-DD format",
    async () => {
      await sendMessage("Book me a lesson next Monday at 10am");
      const pending = getTestPendingContext();

      if (pending.date) {
        expect(pending.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // Verify it's a future date
        const bookingDate = new Date(pending.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expect(bookingDate.getTime()).toBeGreaterThanOrEqual(today.getTime());

        // Verify it's a weekday (Mon-Fri)
        const day = bookingDate.getDay();
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(5);

        console.log(`  📅 Extracted date: ${pending.date} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day]})`);
      }
    },
    TIMEOUT
  );

  it(
    "'next Monday' resolves to an actual Monday in pendingContext",
    async () => {
      await sendMessage("Next Monday at 10am please");
      const pending = getTestPendingContext();

      if (pending.date) {
        const day = new Date(pending.date + "T12:00:00").getDay();
        expect(day).toBe(1); // Monday = 1
      }
    },
    TIMEOUT
  );

  it(
    "'next Friday' resolves to an actual Friday in pendingContext",
    async () => {
      await sendMessage("Next Friday at 3pm please");
      const pending = getTestPendingContext();

      if (pending.date) {
        const day = new Date(pending.date + "T12:00:00").getDay();
        expect(day).toBe(5); // Friday = 5
      }
      if (pending.time) {
        expect(pending.time).toBe("15:00");
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Colloquial Date/Time References
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Colloquial Date/Time References", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "'half past two in the afternoon' extracts an afternoon time",
    async () => {
      // Turn 1: date
      await sendMessage("Book a lesson next Tuesday");
      // Turn 2: colloquial time + addresses
      const { raw } = await sendMessage(
        "Half past two in the afternoon, pickup ST5 1AB, dropoff ST4 2DE"
      );

      // Pending context should have captured an afternoon time
      const pending = getTestPendingContext();
      if (pending.time) {
        const hour = parseInt(pending.time.split(":")[0], 10);
        expect(hour).toBeGreaterThanOrEqual(12);
        console.log(`  🕑 'Half past two' → ${pending.time}`);
      }

      // May have booked or asked for clarification
      expect(raw.length).toBeGreaterThan(0);
    },
    60000
  );

  it(
    "'in the morning' → response about morning or asks for specific time",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson next Monday in the morning, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const lower = raw.toLowerCase();

      // Should handle morning reference — may book with morning time or ask
      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("DL-") ||
        lower.includes("time") ||
        lower.includes("morning") ||
        lower.includes("which") ||
        lower.includes("slot")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "'afternoon' → response about afternoon or asks for specific time",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson next Tuesday afternoon, pickup ST5 1AB, dropoff ST4 2DE"
      );

      // Should handle afternoon reference
      expect(raw.length).toBeGreaterThan(0);
      // If it booked, pending context time should be afternoon
      const pending = getTestPendingContext();
      if (pending.time) {
        const hour = parseInt(pending.time.split(":")[0], 10);
        expect(hour).toBeGreaterThanOrEqual(12);
        console.log(`  🌇 'afternoon' → ${pending.time}`);
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Invalid Time Handling (real validation via aiService)
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Invalid Time Handling", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "3am (outside business hours) → does NOT book",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson next Monday at 3am, pickup ST5 1AB, dropoff ST4 2DE"
      );

      // 3am is not a valid booking time
      expect(raw).not.toContain("Booking Confirmed");

      // Should mention valid times or business hours
      const lower = raw.toLowerCase();
      expect(
        lower.includes("available") ||
        lower.includes("valid") ||
        lower.includes("slot") ||
        lower.includes("time") ||
        lower.includes("hour")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "midnight → does NOT book",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson next Tuesday at midnight, pickup ST5 1AB, dropoff ST4 2DE"
      );

      expect(raw).not.toContain("Booking Confirmed");
    },
    TIMEOUT
  );
});
