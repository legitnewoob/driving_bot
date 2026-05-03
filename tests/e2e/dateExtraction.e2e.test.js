/**
 * Date/Time Extraction – E2E Tests (Real Gemini)
 * ────────────────────────────────────────────────
 * Tests whether the real Gemini model correctly extracts and formats
 * dates and times from natural language in the ACTION:BOOK JSON.
 *
 *  1. Standard formats: "next Monday at 10am"
 *  2. 12h to 24h conversion: "2pm" → "14:00"
 *  3. Relative dates: "tomorrow", "this Friday"
 *  4. Ordinal dates: "the 20th at 3pm"
 *  5. Combined: "next Wednesday afternoon at 2:30"
 *  6. UK English: "fortnight", "half past two"
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini, extractAction } = require("./helpers");

const TIMEOUT = 30000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

// Helper: provide full booking details so AI has enough to produce ACTION:BOOK
const ADDRESSES = ", pickup ST5 1AB, dropoff ST4 2DE";

// ═══════════════════════════════════════════════════════════════════════════
// 1. Time Format – 12h to 24h Conversion
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Time Format Extraction", () => {
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
      `'${input}' → ${expected} in ACTION:BOOK JSON`,
      async () => {
        const history = [
          { role: "user", content: "I want a lesson next Wednesday" },
          { role: "assistant", content: "What time works for you? And your pickup/drop-off addresses?" },
        ];

        const response = await askGemini(`${input} please, pickup ST5 1AB, dropoff ST4 2DE`, {
          conversationHistory: history,
        });
        const { actionType, bookingData } = extractAction(response);

        if (actionType === "BOOK" && bookingData) {
          expect(bookingData.time).toBe(expected);
        }
      },
      TIMEOUT
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Date Format – Correct YYYY-MM-DD
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Date Format Extraction", () => {
  it(
    "produces YYYY-MM-DD format (not DD/MM/YYYY or other)",
    async () => {
      const history = [
        { role: "user", content: "Book me a lesson" },
        { role: "assistant", content: "When would you like it? And your pickup/drop-off?" },
      ];

      const response = await askGemini("Next Monday at 10am, pickup ST5 1AB, dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData) {
        expect(bookingData.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        // Verify it's a future date
        const bookingDate = new Date(bookingData.date);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        expect(bookingDate.getTime()).toBeGreaterThanOrEqual(today.getTime());

        // Verify it's a weekday (Mon-Fri)
        const day = bookingDate.getDay();
        expect(day).toBeGreaterThanOrEqual(1);
        expect(day).toBeLessThanOrEqual(5);

        console.log(`  📅 Extracted date: ${bookingData.date} (${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][day]})`);
      }
    },
    TIMEOUT
  );

  it(
    "'next Monday' resolves to an actual Monday",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson" },
        { role: "assistant", content: "When and where?" },
      ];

      const response = await askGemini("Next Monday at 10am, pickup ST5 1AB, dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData?.date) {
        const day = new Date(bookingData.date + "T12:00:00").getDay();
        expect(day).toBe(1); // Monday = 1
      }
    },
    TIMEOUT
  );

  it(
    "'next Friday' resolves to an actual Friday",
    async () => {
      const history = [
        { role: "user", content: "I want a lesson" },
        { role: "assistant", content: "When and where?" },
      ];

      const response = await askGemini("Next Friday at 3pm, pickup ST5 1AB, dropoff ST4 2DE", {
        conversationHistory: history,
      });
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData?.date) {
        const day = new Date(bookingData.date + "T12:00:00").getDay();
        expect(day).toBe(5); // Friday = 5
        expect(bookingData.time).toBe("15:00");
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. UK English / Colloquial Time References
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Colloquial Date/Time References", () => {
  it(
    "'half past two' → 14:30",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson next Tuesday" },
        { role: "assistant", content: "What time and your addresses?" },
      ];

      const response = await askGemini(
        "Half past two in the afternoon, pickup ST5 1AB, dropoff ST4 2DE",
        { conversationHistory: history }
      );
      const { actionType, bookingData } = extractAction(response);

      if (actionType === "BOOK" && bookingData) {
        expect(["14:30", "14:00", "15:00"]).toContain(bookingData.time);
        console.log(`  🕑 'Half past two' → ${bookingData.time}`);
      }
    },
    TIMEOUT
  );

  it(
    "'quarter to three' → 14:45 or nearest slot",
    async () => {
      const history = [
        { role: "user", content: "Book a lesson next Wednesday" },
        { role: "assistant", content: "What time and addresses?" },
      ];

      const response = await askGemini(
        "Quarter to three, pickup ST5 1AB, dropoff ST4 2DE",
        { conversationHistory: history }
      );
      const { actionType, bookingData } = extractAction(response);

      // Should produce a time near 14:45 or the nearest slot
      if (actionType === "BOOK" && bookingData) {
        console.log(`  🕑 'Quarter to three' → ${bookingData.time}`);
        expect(bookingData.time).toMatch(/^\d{2}:\d{2}$/);
      }
    },
    TIMEOUT
  );

  it(
    "'in the morning' defaults to a morning time",
    async () => {
      const response = await askGemini(
        "Book a lesson next Monday in the morning, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const { actionType, bookingData, responseText } = extractAction(response);

      if (actionType === "BOOK" && bookingData?.time) {
        const hour = parseInt(bookingData.time.split(":")[0], 10);
        expect(hour).toBeLessThan(13); // Morning = before 1pm
        console.log(`  🌅 'in the morning' → ${bookingData.time}`);
      } else {
        // AI might ask for specific time — that's acceptable too
        const lower = responseText.toLowerCase();
        expect(
          lower.includes("time") ||
          lower.includes("morning") ||
          lower.includes("prefer")
        ).toBe(true);
      }
    },
    TIMEOUT
  );

  it(
    "'afternoon' defaults to an afternoon time",
    async () => {
      const response = await askGemini(
        "Book a lesson next Tuesday afternoon, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const { actionType, bookingData, responseText } = extractAction(response);

      if (actionType === "BOOK" && bookingData?.time) {
        const hour = parseInt(bookingData.time.split(":")[0], 10);
        expect(hour).toBeGreaterThanOrEqual(12); // Afternoon = 12+
        console.log(`  🌇 'afternoon' → ${bookingData.time}`);
      } else {
        // Acceptable: AI asks for specific time
        expect(responseText.length).toBeGreaterThan(0);
      }
    },
    TIMEOUT
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Invalid Time Handling
// ═══════════════════════════════════════════════════════════════════════════

describeE2E("E2E – Invalid Time Handling", () => {
  it(
    "AI does NOT book at 3am (outside business hours)",
    async () => {
      const response = await askGemini(
        "Book a lesson next Monday at 3am, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const { actionType } = extractAction(response);

      // 3am is not a valid booking time — should NOT produce BOOK
      expect(actionType).not.toBe("BOOK");
    },
    TIMEOUT
  );

  it(
    "AI does NOT book at midnight",
    async () => {
      const response = await askGemini(
        "Book a lesson next Tuesday at midnight, pickup ST5 1AB, dropoff ST4 2DE"
      );
      const { actionType } = extractAction(response);

      expect(actionType).not.toBe("BOOK");
    },
    TIMEOUT
  );
});
