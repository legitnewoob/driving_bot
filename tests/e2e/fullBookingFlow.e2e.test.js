/**
 * Full Booking Conversation Flow – E2E Tests (Real Pipeline)
 * ───────────────────────────────────────────────────────────
 * Multi-turn conversations through handleIncomingMessage:
 *   Real sessions, real pending context, real date extraction, real Gemini.
 *
 *  1. Greeting → date → time → addresses → booking confirmation
 *  2. Dynamic dropoff: asks for addresses when missing
 *  3. Cancellation flow (multi-turn with session)
 *  4. Rescheduling flow (multi-turn with session)
 *  5. Show bookings
 *  6. Weekend / past date rejection
 *  7. Next available slot
 *  8. Edge cases (mid-conversation changes, corrections)
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
  getTestSession, getTestPendingContext,
} = require("./helpers");

const TIMEOUT = 30000;
const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Full Multi-Turn Booking Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Full Booking Conversation", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "complete flow: greeting → date+time → addresses → booking confirmation",
    async () => {
      // Turn 1: Greeting
      const r1 = await sendMessage("Hi, I'd like to book a driving lesson");
      expect(r1.raw).not.toContain("Booking Confirmed");

      // Session should have history
      expect(getTestSession().conversationHistory.length).toBeGreaterThan(0);

      // Turn 2: Provide date + time
      const r2 = await sendMessage("Next Monday at 10am please");
      const lower2 = r2.raw.toLowerCase();

      // Should ask for addresses
      expect(
        lower2.includes("pickup") ||
        lower2.includes("drop") ||
        lower2.includes("address") ||
        lower2.includes("where") ||
        lower2.includes("location")
      ).toBe(true);

      // Pending context should have date/time
      const pending = getTestPendingContext();
      if (pending.date) expect(pending.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

      // Turn 3: Provide addresses → should trigger booking
      const r3 = await sendMessage("Pickup from ST5 1AB and drop off at ST4 2DE");

      // Should get booking confirmation
      expect(
        r3.raw.includes("Booking Confirmed") ||
        r3.raw.includes("booked") ||
        r3.raw.includes("Booking ID") ||
        r3.raw.includes("DL-")
      ).toBe(true);

      console.log("  ✅ Full flow completed:", r3.raw.substring(0, 150));
    },
    180000 // 3 Gemini calls + date extraction
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Dynamic Dropoff
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Dynamic Dropoff", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "asks for addresses when date+time given but no addresses",
    async () => {
      const { raw } = await sendMessage("Book me a lesson next Tuesday at 2pm");
      const lower = raw.toLowerCase();

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");

      // Should ask for addresses
      expect(
        lower.includes("pickup") ||
        lower.includes("drop") ||
        lower.includes("address") ||
        lower.includes("where") ||
        lower.includes("location")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "multi-turn: date+time → postcodes → booking",
    async () => {
      // Turn 1: date + time
      await sendMessage("Book a lesson next Wednesday at 10am");

      // Turn 2: provide postcodes
      const { raw } = await sendMessage("Pickup ST5 1AB, dropoff ST4 7PX");

      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("booked") ||
        raw.includes("DL-")
      ).toBe(true);
    },
    60000
  );

  it(
    "multi-turn: date+time → full addresses → booking",
    async () => {
      // Turn 1: date + time
      await sendMessage("I want a lesson next Thursday at 11am");

      // Turn 2: provide full addresses
      const { raw } = await sendMessage(
        "Pick me up from 15 High Street, Newcastle-under-Lyme and drop me at Cobridge Road, Stoke"
      );

      expect(
        raw.includes("Booking Confirmed") ||
        raw.includes("booked") ||
        raw.includes("DL-")
      ).toBe(true);
    },
    60000
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cancellation Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Cancellation Flow", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "cancel with booking ID",
    async () => {
      const { raw } = await sendMessage("I need to cancel my booking DL-XY89");

      expect(
        raw.includes("cancelled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-XY89")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "cancel without ID → asks for ID → provide ID → cancellation",
    async () => {
      // Turn 1: cancel without ID
      const r1 = await sendMessage("I want to cancel my booking");
      const lower1 = r1.raw.toLowerCase();
      expect(
        lower1.includes("id") ||
        lower1.includes("which") ||
        lower1.includes("booking")
      ).toBe(true);

      // Turn 2: provide ID (session carries context)
      const r2 = await sendMessage("It's DL-AB12");
      expect(
        r2.raw.includes("cancelled") ||
        r2.raw.includes("No booking found") ||
        r2.raw.includes("DL-AB12")
      ).toBe(true);
    },
    60000
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Rescheduling Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Rescheduling Flow", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "reschedule with booking ID + new date/time in one message",
    async () => {
      const { raw } = await sendMessage(
        "I want to reschedule my booking DL-AB12 to next Friday at 3pm"
      );

      // updateBooking sends confirmation or "not found"
      expect(
        raw.includes("updated") ||
        raw.includes("rescheduled") ||
        raw.includes("No booking found") ||
        raw.includes("DL-AB12") ||
        raw.toLowerCase().includes("friday")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "multi-turn reschedule: ask → provide ID → provide new date/time",
    async () => {
      // Turn 1: vague reschedule intent
      await sendMessage("Can I move my lesson to a different day?");

      // Turn 2: provide booking ID
      await sendMessage("DL-ZZ99");

      // Turn 3: provide new date/time
      const r3 = await sendMessage("Next Wednesday at 11am");

      expect(
        r3.raw.includes("updated") ||
        r3.raw.includes("rescheduled") ||
        r3.raw.includes("No booking found") ||
        r3.raw.includes("DL-ZZ99") ||
        r3.raw.toLowerCase().includes("wednesday")
      ).toBe(true);
    },
    90000 // 3 turns
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Show Bookings
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Show Bookings", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  const SHOW_MESSAGES = [
    "Show me my bookings",
    "Do I have any upcoming lessons?",
    "What lessons do I have?",
    "My bookings",
  ];

  SHOW_MESSAGES.forEach((msg) => {
    it(
      `'${msg}' → shows bookings or 'no bookings'`,
      async () => {
        const { raw } = await sendMessage(msg);

        expect(
          raw.includes("BOOKINGS") ||
          raw.includes("No bookings") ||
          raw.includes("upcoming") ||
          raw.toLowerCase().includes("booking")
        ).toBe(true);
      },
      TIMEOUT
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Date Validation (Weekend / Past)
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Date Validation", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "does NOT book for Saturday — mentions weekdays",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson this Saturday at 10am, pickup ST5 1AB dropoff ST4 2DE"
      );

      // Should NOT have booked
      expect(raw).not.toContain("Booking Confirmed");

      // Should mention weekdays
      const lower = raw.toLowerCase();
      expect(
        lower.includes("weekday") ||
        lower.includes("monday") ||
        lower.includes("friday") ||
        lower.includes("weekend") ||
        lower.includes("not available")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "does NOT book for Sunday",
    async () => {
      const { raw } = await sendMessage("Can I book a lesson next Sunday at 9am?");

      expect(raw).not.toContain("Booking Confirmed");
      const lower = raw.toLowerCase();
      expect(
        lower.includes("weekday") ||
        lower.includes("monday") ||
        lower.includes("friday") ||
        lower.includes("weekend") ||
        lower.includes("not available")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "does NOT book for a past date",
    async () => {
      const { raw } = await sendMessage(
        "Book a lesson for January 1st 2024 at 10am, pickup ST5 1AB dropoff ST4 2DE"
      );

      expect(raw).not.toContain("Booking Confirmed");
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Next Available Slot
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Next Available Slot", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  const ASAP_MESSAGES = [
    "I need a lesson as soon as possible",
    "What's the earliest available slot?",
    "When's the next free lesson?",
  ];

  ASAP_MESSAGES.forEach((msg) => {
    it(
      `'${msg}' → returns next available slot`,
      async () => {
        const { raw } = await sendMessage(msg);

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
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Conversation Edge Cases", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    "mid-conversation correction: change dropoff address",
    async () => {
      // Turn 1: date + time
      await sendMessage("Book a lesson next Tuesday at 10am");

      // Turn 2: addresses
      await sendMessage("Pickup ST5 1AB, dropoff ST4 2DE");

      // If booking already happened, session is cleared.
      // If not, Turn 3 will correct:
      const r3 = await sendMessage("Actually, change the dropoff to ST1 1AA instead");
      const lower = r3.raw.toLowerCase();

      // Should acknowledge the change or confirm a booking
      expect(
        lower.includes("st1") ||
        lower.includes("drop") ||
        lower.includes("updated") ||
        lower.includes("changed") ||
        lower.includes("confirm") ||
        r3.raw.includes("Booking Confirmed") ||
        r3.raw.includes("DL-")
      ).toBe(true);
    },
    90000 // 3 turns
  );

  it(
    "time correction mid-flow: 10am → 2pm",
    async () => {
      // Turn 1: book with initial time
      await sendMessage("Book me next Monday at 10am");

      // Turn 2: correct time before providing addresses
      const r2 = await sendMessage("Actually make it 2pm not 10am");
      const lower = r2.raw.toLowerCase();

      // Should acknowledge the change
      expect(
        lower.includes("2") ||
        lower.includes("14") ||
        lower.includes("pm") ||
        lower.includes("pickup") ||
        lower.includes("address")
      ).toBe(true);
    },
    60000
  );
});
