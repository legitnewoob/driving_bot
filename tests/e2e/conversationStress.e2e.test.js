/**
 * Conversation Stress – E2E Tests (Real Gemini)
 * ───────────────────────────────────────────────
 * Pushes the AI with tricky, ambiguous, and edge-case conversations:
 *
 *  1. Very long messages
 *  2. Multiple languages
 *  3. Rapid topic switching
 *  4. Contradictory instructions
 *  5. Emojis-only messages
 *  6. Multiple booking requests in one message
 *  7. Extremely vague requests
 *  8. Typos and misspellings
 *  9. Numbers as words ("two pm")
 * 10. Long conversation history (context window)
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini, extractAction } = require("./helpers");

const TIMEOUT = 30000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// ═══════════════════════════════════════════════════════════════════════════
// 1. Message Format Edge Cases
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Message Format Edge Cases", () => {
  it(
    "handles a very long message without crashing",
    async () => {
      const longMsg = "I want to book a driving lesson. ".repeat(50) +
        "Next Monday at 10am please, pickup ST5 1AB, dropoff ST4 2DE.";
      const response = await askGemini(longMsg);
      const { actionType } = extractAction(response);

      // Should still parse and respond (BOOK or NULL)
      expect(actionType).not.toBeNull();
    },
    TIMEOUT
  );

  it(
    "handles emojis-only message gracefully",
    async () => {
      const response = await askGemini("🚗💨📅❓");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");
      // Should still respond helpfully
      expect(responseText.length).toBeGreaterThan(10);
    },
    TIMEOUT
  );

  it(
    "handles empty-ish message",
    async () => {
      const response = await askGemini("...");
      const { actionType } = extractAction(response);
      expect(actionType).toBe("NULL");
    },
    TIMEOUT
  );

  it(
    "handles numbers as words: 'two pm next monday'",
    async () => {
      const response = await askGemini(
        "Book a lesson for two pm next monday, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData) {
        expect(bookingData.time).toBe("14:00");
      }
      // At minimum it should understand the intent
      expect(actionType).not.toBeNull();
    },
    TIMEOUT
  );

  it(
    "handles misspelled words: 'boook a leson for teusdya'",
    async () => {
      const response = await askGemini("boook a leson for teusdya at 10am");
      const { responseText } = extractAction(response);

      // Should still understand booking intent
      const lower = responseText.toLowerCase();
      expect(
        lower.includes("tuesday") ||
        lower.includes("lesson") ||
        lower.includes("book") ||
        lower.includes("date") ||
        lower.includes("day")
      ).toBe(true);
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Ambiguous & Contradictory Requests
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Ambiguous & Contradictory Requests", () => {
  it(
    "handles contradictory date: 'book Monday... no wait, Wednesday'",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson for Monday at 10am" },
        { role: "assistant", content: "Sure! Where would you like to be picked up and dropped off?" },
      ];

      const response = await askGemini(
        "Actually no wait, make it Wednesday at 2pm instead. Pickup ST5 1AB, dropoff ST4 2DE",
        { conversationHistory: history }
      );
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData) {
        // Should use Wednesday (the corrected date), not Monday
        expect(bookingData.time).toBe("14:00");
        // Date should be a Wednesday
        const date = new Date(bookingData.date + "T12:00:00");
        expect(date.getDay()).toBe(3); // Wednesday = 3
      }
    },
    TIMEOUT
  );

  it(
    "handles vague request: 'sometime next week maybe'",
    async () => {
      const response = await askGemini("I want a lesson sometime next week maybe");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");
      // Should ask for specific date/time
      const lower = responseText.toLowerCase();
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
      const response = await askGemini(
        "I want to book Monday at 10am AND Wednesday at 2pm"
      );
      const { actionType, responseText } = extractAction(response);

      // AI should handle this gracefully — either pick one or ask to do them separately
      expect(actionType).not.toBeNull();
      expect(responseText.length).toBeGreaterThan(10);
    },
    TIMEOUT
  );

  it(
    "handles 'book and cancel' in the same message",
    async () => {
      const response = await askGemini(
        "Cancel my booking DL-AB12 and also book a new one for Friday at 11am"
      );
      const { actionType } = extractAction(response);

      // Should pick one action (likely cancel first or ask to separate)
      expect(actionType).not.toBeNull();
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Topic Switching
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Topic Switching", () => {
  it(
    "handles mid-booking topic switch: booking → weather → back to booking",
    async () => {
      const history = [
        { role: "user", content: "I want to book a lesson next Monday at 10am" },
        { role: "assistant", content: "Where would you like to be picked up and dropped off?" },
        { role: "user", content: "What's the weather like?" },
        { role: "assistant", content: "I'm here to help with driving lessons. Would you still like to book for Monday at 10am? I just need your pickup and drop-off addresses." },
      ];

      const response = await askGemini(
        "Yeah sorry, pickup ST5 1AB and dropoff ST4 2DE",
        { conversationHistory: history }
      );
      const { actionType, bookingData } = extractAction(response);

      // Should remember the booking context and complete it
      expect(actionType).toBe("BOOK");
      if (bookingData) {
        expect(bookingData.time).toBe("10:00");
        expect(bookingData.pickupAddress).toBeDefined();
        expect(bookingData.dropoffAddress).toBeDefined();
      }
    },
    TIMEOUT
  );

  it(
    "handles switching from booking to cancellation",
    async () => {
      const history = [
        { role: "user", content: "I want to book a lesson" },
        { role: "assistant", content: "Sure! What date and time work for you?" },
      ];

      const response = await askGemini(
        "Actually, forget that. I need to cancel DL-ZZ99 instead",
        { conversationHistory: history }
      );
      const { actionType, bookingData } = extractAction(response);

      expect(actionType).toBe("CANCEL_BOOKING");
      expect(bookingData.bookingId).toBe("DL-ZZ99");
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Long Conversation Context
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Long Conversation Context", () => {
  it(
    "maintains context over a long conversation history",
    async () => {
      // Build a 10-message history
      const history = [
        { role: "user", content: "Hi there" },
        { role: "assistant", content: "Hello! How can I help you with driving lessons today?" },
        { role: "user", content: "What days are available?" },
        { role: "assistant", content: "We offer lessons Monday to Friday. What day works for you?" },
        { role: "user", content: "How about next Thursday?" },
        { role: "assistant", content: "Thursday works! What time? Available slots are typically 09:00, 10:00, 11:00, 14:00, 15:00, 16:00." },
        { role: "user", content: "2pm please" },
        { role: "assistant", content: "Thursday at 2pm, great! Where would you like to be picked up and dropped off?" },
        { role: "user", content: "Pickup from ST5 1AB" },
        { role: "assistant", content: "Got the pickup as ST5 1AB. What about the drop-off address?" },
      ];

      const response = await askGemini("Drop me off at ST4 2DE please", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      // Should remember all the context and book
      expect(actionType).toBe("BOOK");
      if (bookingData) {
        expect(bookingData.time).toBe("14:00");
        expect(bookingData.pickupAddress).toBeDefined();
        expect(bookingData.dropoffAddress).toBeDefined();
      }
    },
    60000 // longer timeout for large prompt
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Action Tag Format Validation
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Action Tag Format", () => {
  it(
    "every response ends with a valid action tag",
    async () => {
      const messages = [
        "Hello",
        "Book a lesson next Monday at 10am",
        "Show my bookings",
        "Cancel DL-XY12",
        "What's the next available slot?",
      ];

      for (const msg of messages) {
        const response = await askGemini(msg);
        const { actionType } = extractAction(response);

        expect(actionType).not.toBeNull();
        expect(
          ["NULL", "BOOK", "SHOW_BOOKINGS", "CANCEL_BOOKING",
           "UPDATE_BOOKING", "NEXT_AVAILABLE_SLOT"].includes(actionType)
        ).toBe(true);
      }
    },
    120000 // 5 API calls
  );

  it(
    "ACTION:BOOK always includes date, time, pickupAddress, dropoffAddress",
    async () => {
      const history = [
        { role: "user", content: "I want a lesson next Wednesday at 10am" },
        { role: "assistant", content: "What are your pickup and drop-off addresses?" },
      ];

      const response = await askGemini("Pickup ST5 1AB, dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK") {
        expect(bookingData).not.toBeNull();
        expect(bookingData.date).toBeDefined();
        expect(bookingData.time).toBeDefined();
        expect(bookingData.pickupAddress).toBeDefined();
        expect(bookingData.dropoffAddress).toBeDefined();
        // Date format: YYYY-MM-DD
        expect(bookingData.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        // Time format: HH:MM (24h)
        expect(bookingData.time).toMatch(/^\d{2}:\d{2}$/);
      }
    },
    TIMEOUT
  );

  it(
    "ACTION:CANCEL_BOOKING always includes bookingId",
    async () => {
      const response = await askGemini("Cancel my booking DL-AB99");
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "CANCEL_BOOKING") {
        expect(bookingData).not.toBeNull();
        expect(bookingData.bookingId).toBeDefined();
        expect(bookingData.bookingId).toMatch(/^DL-/);
      }
    },
    TIMEOUT
  );

  it(
    "ACTION:UPDATE_BOOKING includes bookingId, newDate, newTime",
    async () => {
      const response = await askGemini(
        "Reschedule booking DL-ZZ11 to next Thursday at 3pm"
      );
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "UPDATE_BOOKING") {
        expect(bookingData).not.toBeNull();
        expect(bookingData.bookingId).toBe("DL-ZZ11");
        expect(bookingData.newDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(bookingData.newTime).toBe("15:00");
      }
    },
    TIMEOUT
  );
});
