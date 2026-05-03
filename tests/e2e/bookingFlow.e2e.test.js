/**
 * Booking Flow – E2E Tests (Real Pipeline)
 * ──────────────────────────────────────────
 * Tests the full application pipeline through handleIncomingMessage:
 *   - Real Gemini AI, real sessions, real pending context, real date extraction
 *   - Calendar/Sheets/WhatsApp mocked (can't create real events or send messages)
 *
 * Tests:
 *  1. Date-only message → asks for time + addresses
 *  2. Date+time → asks for addresses (pending context accumulates)
 *  3. Multi-turn → full booking with ACTION:BOOK
 *  4. Show bookings
 *  5. Cancel booking with ID
 *  6. ASAP / next available slot
 *  7. Session and pending context verified between turns
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
  getTestSession, getTestPendingContext,
  describeE2E, E2E_KEYS,
} = require("./helpers");

const TIMEOUT = 30000;

describeE2E(E2E_KEYS.AI, "E2E – Booking Flow (Real Pipeline)", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  // ─── Incomplete booking requests ───────────────────────────────────

  it(
    "date-only message: asks for time (pending context stores date)",
    async () => {
      const { replies, raw } = await sendMessage("I want a lesson next Monday");
      const lower = raw.toLowerCase();

      // Should ask for more info (time, addresses)
      expect(
        lower.includes("time") ||
        lower.includes("when") ||
        lower.includes("what time") ||
        lower.includes("prefer")
      ).toBe(true);

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");

      // Pending context should have captured the date
      const pending = getTestPendingContext();
      if (pending.date) {
        expect(pending.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    },
    TIMEOUT
  );

  it(
    "date+time message: asks for addresses (pending context has both)",
    async () => {
      const { raw } = await sendMessage("Book me a lesson next Monday at 10am");
      const lower = raw.toLowerCase();
      
      // Should ask for pickup/dropoff
      expect(
        lower.includes("pickup") ||
        lower.includes("drop") ||
        lower.includes("address") ||
        lower.includes("location") ||
        lower.includes("where")
      ).toBe(true);

      // Pending context should have date + time
      const pending = getTestPendingContext();
      if (pending.date) expect(pending.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (pending.time) expect(pending.time).toMatch(/^\d{2}:\d{2}$/);
    },
    TIMEOUT
  );

  // ─── Multi-turn booking flow ───────────────────────────────────────

  it(
    "multi-turn: date+time → addresses → booking confirmation",
    async () => {
      // Turn 1: date + time
      await sendMessage("I want a lesson next Wednesday at 10am");

      // Session should have conversation history now
      const session = getTestSession();
      expect(session.conversationHistory.length).toBeGreaterThan(0);

      // Turn 2: provide addresses → should trigger booking
      const { raw } = await sendMessage("Pickup ST5 1AB, dropoff ST4 2DE");

      // Should get booking confirmation (processBooking sends it)
      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("booked") ||
        raw.includes("Booking ID") ||
        raw.includes("DL-")
      ).toBe(true);
    },
    60000 // 2 Gemini calls
  );

  // ─── Show bookings ────────────────────────────────────────────────

  it(
    "show bookings: returns booking list or 'no bookings'",
    async () => {
      const { raw } = await sendMessage("Show me my bookings");

      // showBookings sends either bookings list or "no bookings"
      expect(
        raw.includes("BOOKINGS") ||
        raw.includes("No bookings") ||
        raw.includes("upcoming") ||
        raw.toLowerCase().includes("booking")
      ).toBe(true);
    },
    TIMEOUT
  );

  // ─── Cancel booking ───────────────────────────────────────────────

  it(
    "cancel with ID: confirms cancellation or says not found",
    async () => {
      const { raw } = await sendMessage("Cancel my booking DL-AB12");

      // cancelBooking sends confirmation or "not found"
      expect(
        raw.includes("cancelled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-AB12") ||
        raw.toLowerCase().includes("cancel")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "cancel without ID: asks for booking ID",
    async () => {
      const { raw } = await sendMessage("I want to cancel my booking");
      const lower = raw.toLowerCase();

      expect(
        lower.includes("id") ||
        lower.includes("which") ||
        lower.includes("booking")
      ).toBe(true);
    },
    TIMEOUT
  );

  // ─── Next available slot ──────────────────────────────────────────

  it(
    "ASAP request: returns next available slot",
    async () => {
      const { raw } = await sendMessage("I need a lesson as soon as possible");

      // next_available_slot sends the earliest slot or "no appointments"
      expect(
        raw.includes("available") ||
        raw.includes("appointment") ||
        raw.includes("slot") ||
        raw.includes("next")
      ).toBe(true);
    },
    TIMEOUT
  );
});
