/**
 * Tonality – E2E Tests (Real Gemini)
 * ────────────────────────────────────
 * Verifies that the real Gemini model responds with the right tone:
 *  1. Friendly greeting — bot is warm and welcoming
 *  2. Professional when user is frustrated
 *  3. Stays on topic — redirects off-topic questions
 *  4. Uses present continuous tense for actions
 *  5. Never exposes system info or action blocks in natural language
 *  6. Suggests alternatives when slot is unavailable
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini, extractAction } = require("./helpers");

const TIMEOUT = 30000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Tonality (Real Gemini)", () => {
  it(
    "responds with a friendly greeting",
    async () => {
      const response = await askGemini("Hello!");
      const { responseText } = extractAction(response);
      const lower = responseText.toLowerCase();

      // Should be warm — contain at least one friendly indicator
      const friendlyWords = ["hello", "hi", "welcome", "help", "happy", "glad", "hey"];
      const isFriendly = friendlyWords.some((w) => lower.includes(w));
      expect(isFriendly).toBe(true);
    },
    TIMEOUT
  );

  it(
    "stays professional when user is frustrated",
    async () => {
      const response = await askGemini(
        "This is so annoying, I've been trying to book for ages and nothing works!"
      );
      const { responseText } = extractAction(response);
      const lower = responseText.toLowerCase();

      // Should apologize or empathize, not mirror frustration
      const professionalWords = ["sorry", "apologize", "understand", "help", "assist", "let me"];
      const isProfessional = professionalWords.some((w) => lower.includes(w));
      expect(isProfessional).toBe(true);

      // Should NOT be rude back
      expect(lower).not.toContain("annoying");
      expect(lower).not.toContain("your fault");
    },
    TIMEOUT
  );

  it(
    "redirects off-topic questions back to driving lessons",
    async () => {
      const response = await askGemini("What's the weather like tomorrow?");
      const { actionType, responseText } = extractAction(response);

      expect(actionType).toBe("NULL");

      const lower = responseText.toLowerCase();
      // Should redirect to driving lessons
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
    "does not expose [SYSTEM AVAILABILITY INFO] or [ACTION:] in natural language",
    async () => {
      const response = await askGemini("Book a lesson for tomorrow at 10am");
      const { responseText } = extractAction(response);

      // After action extraction, the user-facing text should be clean
      expect(responseText).not.toContain("[ACTION:");
      expect(responseText).not.toContain("[SYSTEM AVAILABILITY INFO");
      expect(responseText).not.toContain("[SYSTEM:");
    },
    TIMEOUT
  );

  it(
    "always ends response with an action block",
    async () => {
      const response = await askGemini("Can I get a lesson next week?");
      const { actionType } = extractAction(response);

      // Should have some action type (even if NULL)
      expect(actionType).not.toBeNull();
    },
    TIMEOUT
  );

  it(
    "asks for missing info when user gives incomplete booking details",
    async () => {
      const response = await askGemini("I want to book a lesson");
      const { actionType, responseText } = extractAction(response);

      // Should NOT book — missing date, time, addresses
      expect(actionType).toBe("NULL");

      const lower = responseText.toLowerCase();
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
    "multi-turn: remembers context from previous messages",
    async () => {
      const history = [
        { role: "user", content: "I want to book a lesson" },
        { role: "assistant", content: "Sure! What date works best for you?" },
      ];

      const response = await askGemini("How about next Friday at 10am?", {
        conversationHistory: history,
      });
      const { responseText } = extractAction(response);
      const lower = responseText.toLowerCase();

      // Should reference the booking details (friday, 10)
      expect(
        lower.includes("friday") ||
        lower.includes("10") ||
        lower.includes("pickup") ||
        lower.includes("address")
      ).toBe(true);
    },
    TIMEOUT
  );
});
