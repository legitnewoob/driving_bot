/**
 * Conversation Stress – E2E Tests (Real Pipeline)
 * ─────────────────────────────────────────────────
 * Pushes the AI with tricky, ambiguous, and edge-case conversations
 * through the REAL application pipeline (handleIncomingMessage):
 *
 *  1. Very long messages
 *  2. Emojis-only messages
 *  3. Misspellings and numbers as words
 *  4. Contradictory instructions (via session)
 *  5. Vague requests
 *  6. Multiple booking requests in one message
 *  7. Topic switching (via session)
 *  8. Long conversation context (via session)
 *  9. Action dispatch validation
 *
 * Env:  Loaded via helpers.js → envs/.env.test
 * Run:  npm run test:e2e
 */

const { E2E_MOCKS } = require("./helpers");
jest.mock("../../src/services/calendarService", E2E_MOCKS.calendarService);
jest.mock("../../src/services/sheetsService", E2E_MOCKS.sheetsService);
jest.mock("../../src/services/whatsappService", E2E_MOCKS.whatsappService);
jest.mock("../../src/utils/chatLogger", E2E_MOCKS.chatLogger);

const {
  sendMessage,
  setupE2ESuite, cleanupE2ETest, teardownE2ESuite,
  getTestSession,
} = require("./helpers");

const TIMEOUT = 30000;
const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Message Format Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Message Format Edge Cases", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "handles a very long message without crashing",
    async () => {
      const longMsg = "I want to book a driving lesson. ".repeat(50) +
        "Next Monday at 10am please, pickup ST5 1AB, dropoff ST4 2DE.";
      const { raw } = await sendMessage(longMsg);

      // Should respond (may book or ask for clarification)
      expect(raw.length).toBeGreaterThan(0);
    },
    TIMEOUT
  );

  it(
    "handles emojis-only message gracefully",
    async () => {
      const { raw } = await sendMessage("🚗💨📅❓");

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");
      // Should still respond helpfully
      expect(raw.length).toBeGreaterThan(10);
    },
    TIMEOUT
  );

  it(
    "handles empty-ish message",
    async () => {
      const { raw } = await sendMessage("...");

      expect(raw).not.toContain("Booking Confirmed");
      expect(raw.length).toBeGreaterThan(0);
    },
    TIMEOUT
  );

  it(
    "handles numbers as words: 'two pm next monday'",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson for two pm next monday, pickup ST5 1AB, dropoff ST4 2DE"
      );

      // Should understand intent — may book or ask for confirmation
      expect(raw.length).toBeGreaterThan(0);
    },
    TIMEOUT
  );

  it(
    "handles misspelled words: 'boook a leson for teusdya'",
    async () => {
      const { raw } = await sendMessage("boook a leson for teusdya at 10am");
      const lower = raw.toLowerCase();

      // Should still understand booking intent
      expect(
        lower.includes("tuesday") ||
        lower.includes("lesson") ||
        lower.includes("book") ||
        lower.includes("date") ||
        lower.includes("day") ||
        lower.includes("time")
      ).toBe(true);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Ambiguous & Contradictory Requests
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Ambiguous & Contradictory Requests", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "handles contradictory date via session: Monday → correction to Wednesday",
    async () => {
      // Turn 1: say Monday
      await sendMessage("Book a lesson for Monday at 10am");

      // Turn 2: correct to Wednesday (session carries the Monday context)
      const { raw } = await sendMessage(
        "Actually no wait, make it Wednesday at 2pm instead. Pickup ST5 1AB, dropoff ST4 2DE"
      );

      // Should handle the correction — may book Wednesday or ask to confirm
      const lower = raw.toLowerCase();
      expect(
        lower.includes("wednesday") ||
        lower.includes("2") ||
        lower.includes("14") ||
        raw.includes("Booking Confirmed") ||
        raw.includes("DL-")
      ).toBe(true);
    },
    60000
  );

  it(
    "handles vague request: 'sometime next week maybe'",
    async () => {
      const { raw } = await sendMessage("I want a lesson sometime next week maybe");
      const lower = raw.toLowerCase();

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");

      // Should ask for specific date/time
      expect(
        lower.includes("date") ||
        lower.includes("day") ||
        lower.includes("when") ||
        lower.includes("prefer") ||
        lower.includes("which")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "handles multiple bookings in one message",
    async () => {
      const { raw } = await sendMessage(
        "I want to book Monday at 10am AND Wednesday at 2pm"
      );

      // AI should handle this gracefully
      expect(raw.length).toBeGreaterThan(10);
    },
    TIMEOUT
  );

  it(
    "handles 'book and cancel' in the same message",
    async () => {
      const { raw } = await sendMessage(
        "Cancel my booking DL-AB12 and also book a new one for Friday at 11am"
      );

      // Should pick one action or ask to do them separately
      expect(raw.length).toBeGreaterThan(10);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Topic Switching (via real sessions)
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Topic Switching", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "handles mid-booking topic switch and return to booking",
    async () => {
      // Turn 1: start booking
      await sendMessage("I want to book a lesson next Monday at 10am");

      // Turn 2: off-topic (session carries context)
      await sendMessage("What's the weather like?");

      // Turn 3: return to booking with addresses
      const { raw } = await sendMessage(
        "Yeah sorry, pickup ST5 1AB and dropoff ST4 2DE"
      );

      // Should recover booking context from session
      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("DL-") ||
        raw.toLowerCase().includes("pickup") ||
        raw.toLowerCase().includes("book")
      ).toBe(true);
    },
    90000 // 3 turns
  );

  it(
    "handles switching from booking to cancellation via session",
    async () => {
      // Turn 1: start booking
      await sendMessage("I want to book a lesson");

      // Turn 2: switch to cancellation (session carries booking context)
      const { raw } = await sendMessage(
        "Actually, forget that. I need to cancel DL-ZZ99 instead"
      );

      // Should handle cancellation
      expect(
        raw.includes("cancelled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-ZZ99") ||
        raw.toLowerCase().includes("cancel")
      ).toBe(true);
    },
    60000
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Long Conversation Context (via real sessions)
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Long Conversation Context", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "maintains context over many turns via session",
    async () => {
      // Turn 1: greeting
      await sendMessage("Hi there");
      // Turn 2: ask about days
      await sendMessage("What days are available?");
      // Turn 3: pick a day
      await sendMessage("How about next Thursday?");
      // Turn 4: pick a time
      await sendMessage("2pm please");

      // Session should have accumulated history
      const session = getTestSession();
      expect(session.conversationHistory.length).toBeGreaterThanOrEqual(4);

      // Turn 5: provide pickup
      await sendMessage("Pickup from ST5 1AB");
      // Turn 6: provide dropoff → should complete booking
      const r6 = await sendMessage("Drop me off at ST4 2DE please");

      expect(
        r6.raw.includes("Booking Confirmed") ||
        r6.raw.includes("DL-") ||
        r6.raw.includes("booked") ||
        r6.raw.toLowerCase().includes("thursday")
      ).toBe(true);
    },
    180000 // 6 turns
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Action Dispatch Validation (through real pipeline)
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Action Dispatch", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "various messages dispatch correct actions through pipeline",
    async () => {
      const messages = [
        { msg: "Hello", expectNo: "Booking Confirmed" },
        { msg: "Show my bookings", expectAny: ["BOOKINGS", "No bookings", "booking"] },
        { msg: "What's the next available slot?", expectAny: ["available", "appointment", "slot"] },
      ];

      for (const { msg, expectNo, expectAny } of messages) {
        const { raw } = await sendMessage(msg);

        if (expectNo) {
          expect(raw).not.toContain(expectNo);
        }
        if (expectAny) {
          const found = expectAny.some((s) => raw.toLowerCase().includes(s.toLowerCase()));
          expect(found).toBe(true);
        }

        cleanupE2ETest(); // isolate each message
      }
    },
    90000
  );

  it(
    "multi-turn booking dispatches processBooking → confirmation message",
    async () => {
      // Turn 1: date + time
      await sendMessage("I want a lesson next Wednesday at 10am");
      // Turn 2: addresses → processBooking runs
      const { raw } = await sendMessage("Pickup ST5 1AB, dropoff ST4 2DE");

      // processBooking sends the confirmation message via mock callback
      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("DL-") ||
        raw.includes("booked")
      ).toBe(true);
    },
    60000
  );

  it(
    "cancel with ID dispatches cancelBooking → confirmation or not found",
    async () => {
      const { raw } = await sendMessage("Cancel my booking DL-AB99");

      expect(
        raw.includes("cancelled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-AB99")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "reschedule dispatches updateBooking → confirmation or not found",
    async () => {
      const { raw } = await sendMessage(
        "Reschedule booking DL-ZZ11 to next Thursday at 3pm"
      );

      expect(
        raw.includes("updated") ||
        raw.includes("rescheduled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-ZZ11")
      ).toBe(true);
    },
    TIMEOUT
  );
});
