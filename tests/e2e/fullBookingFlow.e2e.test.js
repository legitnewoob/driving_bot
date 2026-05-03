/**
 * Full Booking Conversation Flow – E2E Tests (Real Gemini)
 * ─────────────────────────────────────────────────────────
 * Simulates complete multi-turn booking conversations with real Gemini:
 *
 *  1. Greeting → date → time → addresses → ACTION:BOOK
 *  2. Dynamic dropoff: AI asks for pickup/dropoff when missing
 *  3. Cancellation: user provides booking ID → ACTION:CANCEL_BOOKING
 *  4. Rescheduling: user asks to move booking → ACTION:UPDATE_BOOKING
 *  5. Show bookings: user asks to see bookings → ACTION:SHOW_BOOKINGS
 *  6. Weekend date rejection: AI refuses Saturday/Sunday
 *  7. Past date rejection: AI refuses dates in the past
 *  8. Next available slot: ASAP request → ACTION:NEXT_AVAILABLE_SLOT
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini, extractAction } = require("./helpers");

const TIMEOUT = 30000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Full Multi-Turn Booking Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Full Booking Conversation", () => {
  it(
    "complete flow: greeting → date → time → addresses → ACTION:BOOK",
    async () => {
      // Turn 1: Greeting
      const r1 = await askGemini("Hi, I'd like to book a driving lesson");
      const a1 = extractAction(r1);
      expect(a1.actionType).toBe("NULL");

      // Turn 2: Provide date
      const r2 = await askGemini("Next Monday please", {
        conversationHistory: [
          { role: "user", content: "Hi, I'd like to book a driving lesson" },
          { role: "assistant", content: r1 },
        ],
      });
      const a2 = extractAction(r2);
      expect(a2.actionType).toBe("NULL");

      // Turn 3: Provide time
      const r3 = await askGemini("10am works", {
        conversationHistory: [
          { role: "user", content: "Hi, I'd like to book a driving lesson" },
          { role: "assistant", content: r1 },
          { role: "user", content: "Next Monday please" },
          { role: "assistant", content: r2 },
        ],
      });
      const a3 = extractAction(r3);
      // Should still be NULL or ask for addresses
      const lower3 = a3.responseText.toLowerCase();
      const asksForAddress =
        lower3.includes("pickup") ||
        lower3.includes("address") ||
        lower3.includes("drop") ||
        lower3.includes("location") ||
        lower3.includes("postal");

      if (a3.actionType === "NULL") {
        expect(asksForAddress).toBe(true);
      }

      // Turn 4: Provide addresses → should get ACTION:BOOK
      const r4 = await askGemini("Pickup from ST5 1AB and drop off at ST4 2DE", {
        conversationHistory: [
          { role: "user", content: "Hi, I'd like to book a driving lesson" },
          { role: "assistant", content: r1 },
          { role: "user", content: "Next Monday please" },
          { role: "assistant", content: r2 },
          { role: "user", content: "10am works" },
          { role: "assistant", content: r3 },
        ],
      });
      const a4 = extractAction(r4);

      expect(a4.actionType).toBe("BOOK");
      expect(a4.bookingData).not.toBeNull();
      expect(a4.bookingData.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(a4.bookingData.time).toBe("10:00");
      expect(a4.bookingData.pickupAddress).toBeDefined();
      expect(a4.bookingData.dropoffAddress).toBeDefined();

      console.log("  ✅ Full flow booking data:", JSON.stringify(a4.bookingData));
    },
    120000 // 2 min for 4 Gemini calls
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Dynamic Dropoff – AI Asks for Addresses
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Dynamic Dropoff", () => {
  it(
    "AI asks for pickup/dropoff when user provides date+time but no addresses",
    async () => {
      const response = await askGemini("Book me a lesson next Tuesday at 2pm");
      const { actionType, responseText } = extractAction(response);

      // Should NOT book yet
      expect(actionType).toBe("NULL");

      // Should ask for addresses
      const lower = responseText.toLowerCase();
      expect(
        lower.includes("pickup") ||
        lower.includes("drop") ||
        lower.includes("address") ||
        lower.includes("location") ||
        lower.includes("where")
      ).toBe(true);

      console.log("  📍 AI asked:", responseText.substring(0, 100) + "...");
    },
    TIMEOUT
  );

  it(
    "AI accepts postcode-style addresses and produces ACTION:BOOK",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson next Wednesday at 10am" },
        { role: "assistant", content: "Sure! Could you please provide your pickup and drop-off addresses or postcodes?" },
      ];

      const response = await askGemini("Pickup ST5 1AB, dropoff at the test centre ST4 7PX", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("BOOK");
      expect(bookingData).not.toBeNull();
      expect(bookingData.pickupAddress).toBeDefined();
      expect(bookingData.dropoffAddress).toBeDefined();

      console.log("  📍 Pickup:", bookingData.pickupAddress);
      console.log("  📍 Dropoff:", bookingData.dropoffAddress);
    },
    TIMEOUT
  );

  it(
    "AI accepts 'pick me up from home' and resolves it contextually",
    async () => {
      const history = [
        { role: "user", content: "I want a lesson next Thursday at 11am" },
        { role: "assistant", content: "Where would you like to be picked up and dropped off?" },
      ];

      const response = await askGemini(
        "Pick me up from 15 High Street, Newcastle-under-Lyme and drop me at Cobridge Road, Stoke", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("BOOK");
      if (bookingData) {
        expect(bookingData.pickupAddress).toBeDefined();
        expect(bookingData.dropoffAddress).toBeDefined();
        console.log("  📍 Pickup:", bookingData.pickupAddress);
        console.log("  📍 Dropoff:", bookingData.dropoffAddress);
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Cancellation Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Cancellation Flow", () => {
  it(
    "AI returns ACTION:CANCEL_BOOKING with booking ID",
    async () => {
      const response = await askGemini("I need to cancel my booking DL-XY89");
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("CANCEL_BOOKING");
      expect(bookingData).not.toBeNull();
      expect(bookingData.bookingId).toBe("DL-XY89");
    },
    TIMEOUT
  );

  it(
    "AI asks for booking ID when user says 'cancel' without ID",
    async () => {
      const response = await askGemini("I want to cancel my lesson");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");
      const lower = responseText.toLowerCase();
      expect(
        lower.includes("id") ||
        lower.includes("which") ||
        lower.includes("booking")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "AI handles cancellation with ID after being asked",
    async () => {
      const history = [
        { role: "user", content: "I want to cancel my booking" },
        { role: "assistant", content: "Sure, I can help with that. Could you please provide your booking ID? It starts with DL-" },
      ];

      const response = await askGemini("It's DL-AB12", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("CANCEL_BOOKING");
      expect(bookingData.bookingId).toBe("DL-AB12");
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Rescheduling Flow
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Rescheduling Flow", () => {
  it(
    "AI returns ACTION:UPDATE_BOOKING with new date/time and booking ID",
    async () => {
      const response = await askGemini(
        "I want to reschedule my booking DL-AB12 to next Friday at 3pm"
      );
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("UPDATE_BOOKING");
      expect(bookingData).not.toBeNull();
      expect(bookingData.bookingId).toBe("DL-AB12");
      expect(bookingData.newDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(bookingData.newTime).toBe("15:00");

      console.log("  📅 Rescheduled to:", bookingData.newDate, bookingData.newTime);
    },
    TIMEOUT
  );

  it(
    "AI asks for booking ID when user says 'reschedule' without it",
    async () => {
      const response = await askGemini("Can I move my lesson to a different day?");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");
      const lower = responseText.toLowerCase();
      expect(
        lower.includes("id") ||
        lower.includes("which") ||
        lower.includes("booking")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "AI handles multi-turn rescheduling",
    async () => {
      const history = [
        { role: "user", content: "I want to reschedule my booking" },
        { role: "assistant", content: "Of course! What's your booking ID?" },
        { role: "user", content: "DL-ZZ99" },
        { role: "assistant", content: "Got it! What new date and time would you like?" },
      ];

      const response = await askGemini("Next Wednesday at 11am", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("UPDATE_BOOKING");
      expect(bookingData.bookingId).toBe("DL-ZZ99");
      expect(bookingData.newTime).toBe("11:00");
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Show Bookings
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Show Bookings", () => {
  const SHOW_MESSAGES = [
    "Show me my bookings",
    "Do I have any upcoming lessons?",
    "What lessons do I have?",
    "My bookings",
  ];

  SHOW_MESSAGES.forEach((msg) => {
    it(
      `'${msg}' → ACTION:SHOW_BOOKINGS`,
      async () => {
        const response = await askGemini(msg);
        const { actionType } = extractAction(response);
        expect(actionType).toBe("SHOW_BOOKINGS");
      },
      TIMEOUT
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Weekend / Past Date Rejection
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Date Validation", () => {
  it(
    "AI does NOT book for Saturday",
    async () => {
      const history = [
        { role: "user", content: "I want a lesson this Saturday at 10am" },
        { role: "assistant", content: "I'm afraid we only offer lessons on weekdays (Monday to Friday). Would you like to choose a different day?" },
      ];

      // User insists on Saturday
      const response = await askGemini("No I want Saturday, pickup ST5 1AB dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType } = extractAction(response);

      // Should NOT produce BOOK for a weekend
      expect(actionType).not.toBe("BOOK");
    },
    TIMEOUT
  );

  it(
    "AI mentions weekdays only when user asks for Sunday",
    async () => {
      const response = await askGemini("Can I book a lesson next Sunday at 9am?");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");
      const lower = responseText.toLowerCase();
      expect(
        lower.includes("weekday") ||
        lower.includes("monday") ||
        lower.includes("friday") ||
        lower.includes("not available")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "AI does NOT book for a past date",
    async () => {
      const response = await askGemini(
        "Book a lesson for January 1st 2024 at 10am, pickup ST5 1AB dropoff ST4 2DE"
      );
      const { actionType } = extractAction(response);

      // Should not book a date in the past
      expect(actionType).not.toBe("BOOK");
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Next Available Slot
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Next Available Slot", () => {
  const ASAP_MESSAGES = [
    "I need a lesson as soon as possible",
    "What's the earliest available slot?",
    "When's the next free lesson?",
  ];

  ASAP_MESSAGES.forEach((msg) => {
    it(
      `'${msg}' → ACTION:NEXT_AVAILABLE_SLOT`,
      async () => {
        const response = await askGemini(msg);
        const { actionType } = extractAction(response);
        expect(actionType).toBe("NEXT_AVAILABLE_SLOT");
      },
      TIMEOUT
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Conversation Edge Cases", () => {
  it(
    "AI handles 'change my dropoff' mid-conversation",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson next Tuesday at 10am" },
        { role: "assistant", content: "Where would you like to be picked up and dropped off?" },
        { role: "user", content: "Pickup ST5 1AB, dropoff ST4 2DE" },
        { role: "assistant", content: "Just to confirm: next Tuesday at 10am, pickup ST5 1AB, drop-off ST4 2DE. Shall I go ahead and book?" },
      ];

      const response = await askGemini(
        "Actually, change the dropoff to ST1 1AA instead",
        { conversationHistory: history }
      );
      const { responseText } = extractAction(response);
      const lower = responseText.toLowerCase();

      // Should acknowledge the change
      expect(
        lower.includes("st1") ||
        lower.includes("drop") ||
        lower.includes("updated") ||
        lower.includes("changed") ||
        lower.includes("confirm")
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "AI handles multiple bookings in one conversation",
    async () => {
      // After a booking is confirmed, user asks for another
      const history = [
        { role: "user", content: "Book a lesson next Monday at 10am, pickup ST5 1AB, dropoff ST4 2DE" },
        { role: "assistant", content: "Your lesson is booked for next Monday at 10am! Booking ID: DL-XX12" },
      ];

      const response = await askGemini("Great! Can I also book one for Wednesday at 2pm?", {
        conversationHistory: history,
      });
      const { actionType, responseText } = extractAction(response);

      // Should either ask for addresses again or try to book
      const lower = responseText.toLowerCase();
      expect(
        actionType === "NULL" || // asks for addresses
        actionType === "BOOK"    // books with same addresses
      ).toBe(true);
    },
    TIMEOUT
  );

  it(
    "AI maintains context when user corrects a detail",
    async () => {
      const history = [
        { role: "user", content: "Book me next Monday at 10am" },
        { role: "assistant", content: "What are your pickup and drop-off addresses?" },
        { role: "user", content: "Pickup ST5 1AB, dropoff ST4 2DE" },
        { role: "assistant", content: "To confirm: Monday at 10am, pickup ST5 1AB, dropoff ST4 2DE?" },
      ];

      const response = await askGemini("Actually make it 2pm not 10am", {
        conversationHistory: history,
      });
      const { actionType, bookingData, responseText } = extractAction(response);

      if (actionType === "BOOK") {
        // If it books directly, time should be 14:00
        expect(bookingData.time).toBe("14:00");
      } else {
        // Otherwise it should mention 2pm in confirmation
        const lower = responseText.toLowerCase();
        expect(lower.includes("2") || lower.includes("14")).toBe(true);
      }
    },
    TIMEOUT
  );
});
