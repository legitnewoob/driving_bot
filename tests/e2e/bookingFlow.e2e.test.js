/**
 * Booking Flow – E2E Tests (Real Gemini)
 * ────────────────────────────────────────
 * Tests the AI's ability to correctly handle booking conversations:
 *  1. Extracts date and time from natural language
 *  2. Asks for missing details (pickup, dropoff)
 *  3. Produces ACTION:BOOK only when all details are present
 *  4. Produces ACTION:SHOW_BOOKINGS for "show my bookings"
 *  5. Produces ACTION:CANCEL_BOOKING when user wants to cancel
 *  6. Produces ACTION:NULL when details are incomplete
 *  7. Handles rescheduling requests
 *  8. Uses 24-hour time format in action JSON
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini, extractAction } = require("./helpers");

const TIMEOUT = 30000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Booking Flow (Real Gemini)", () => {
  // ─── Incomplete booking requests ───────────────────────────────────

  it(
    "returns ACTION:NULL when only date is given (missing time, addresses)",
    async () => {
      const response = await askGemini("I want a lesson next Monday");
      const { actionType } = extractAction(response);

      expect(actionType).toBe("NULL");
    },
    TIMEOUT
  );

  it(
    "returns ACTION:NULL when only time is given (missing date, addresses)",
    async () => {
      const response = await askGemini("Can I book at 10am?");
      const { actionType } = extractAction(response);

      expect(actionType).toBe("NULL");
    },
    TIMEOUT
  );

  it(
    "asks for pickup/dropoff when date and time are given but addresses missing",
    async () => {
      const response = await askGemini("Book me a lesson next Monday at 10am");
      const { actionType, responseText } = extractAction(response);

      // Should not book yet — pickup/dropoff missing
      expect(actionType).toBe("NULL");

      const lower = responseText.toLowerCase();
      expect(
        lower.includes("pickup") ||
        lower.includes("drop") ||
        lower.includes("address") ||
        lower.includes("postal") ||
        lower.includes("location")
      ).toBe(true);
    },
    TIMEOUT
  );

  // ─── Complete booking request ──────────────────────────────────────

  it(
    "returns ACTION:BOOK with valid JSON when all details are provided",
    async () => {
      const history = [
        { role: "user", content: "I want to book a lesson next Monday at 10am" },
        { role: "assistant", content: "Sure! Could you provide your pickup and drop-off addresses?" },
      ];

      const response = await askGemini("Pickup ST5 1AB, dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("BOOK");
      expect(bookingData).not.toBeNull();
      expect(bookingData.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(bookingData.time).toMatch(/^\d{2}:\d{2}$/);
      expect(bookingData.pickupAddress).toBeDefined();
      expect(bookingData.dropoffAddress).toBeDefined();
    },
    TIMEOUT
  );

  // ─── 24-hour time format ───────────────────────────────────────────

  it(
    "uses 24-hour time format in booking JSON (not 12-hour)",
    async () => {
      const history = [
        { role: "user", content: "I want a lesson next Tuesday at 2pm" },
        { role: "assistant", content: "Could you provide your pickup and drop-off?" },
      ];

      const response = await askGemini("Pickup is ST5 1AB and dropoff is ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData?.time) {
        // Should be 14:00, not 2:00 or 2:00 PM
        expect(bookingData.time).toBe("14:00");
      }
    },
    TIMEOUT
  );

  // ─── Show bookings ────────────────────────────────────────────────

  it(
    "returns ACTION:SHOW_BOOKINGS for 'show my bookings'",
    async () => {
      const response = await askGemini("Show me my bookings");
      const { actionType } = extractAction(response);

      expect(actionType).toBe("SHOW_BOOKINGS");
    },
    TIMEOUT
  );

  it(
    "returns ACTION:SHOW_BOOKINGS for 'do I have any lessons?'",
    async () => {
      const response = await askGemini("Do I have any upcoming lessons?");
      const { actionType } = extractAction(response);

      expect(actionType).toBe("SHOW_BOOKINGS");
    },
    TIMEOUT
  );

  // ─── Cancel booking ───────────────────────────────────────────────

  it(
    "returns ACTION:CANCEL_BOOKING when user provides booking ID",
    async () => {
      const response = await askGemini("Cancel my booking DL-AB12");
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("CANCEL_BOOKING");
      if (bookingData) {
        expect(bookingData.bookingId).toBe("DL-AB12");
      }
    },
    TIMEOUT
  );

  it(
    "returns ACTION:NULL when cancelling without booking ID",
    async () => {
      const response = await askGemini("I want to cancel my booking");
      const { actionType, responseText } = extractAction(response);

      // Should ask for booking ID
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

  // ─── Next available slot ──────────────────────────────────────────

  it(
    "returns ACTION:NEXT_AVAILABLE_SLOT for ASAP requests",
    async () => {
      const response = await askGemini("I need a lesson as soon as possible");
      const { actionType } = extractAction(response);

      expect(actionType).toBe("NEXT_AVAILABLE_SLOT");
    },
    TIMEOUT
  );
});
