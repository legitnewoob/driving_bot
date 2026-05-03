/**
 * Response Time – E2E Tests (Real Gemini)
 * ─────────────────────────────────────────
 * Measures actual Gemini API response latency:
 *  1. Single message latency (< 10s)
 *  2. Average latency across multiple messages
 *  3. Consistency — no single response takes excessively long
 *
 * Requires: GOOGLE_AI_API_KEY env var
 * Run:      npm run test:e2e
 */

require("dotenv").config();
const { askGemini } = require("./helpers");

const SINGLE_MSG_LIMIT_MS = 10000; // 10s max for a single Gemini call
const AVG_LIMIT_MS = 8000;         // 8s average
const TIMEOUT = 15000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Response Time (Real Gemini)", () => {
  it(
    `greeting responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await askGemini("Hello!");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Greeting: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `booking request responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await askGemini("I want to book a lesson next Monday at 10am");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Booking request: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `show bookings responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await askGemini("Show me my bookings");
      const elapsed = Date.now() - start;

      console.log(`  ⏱ Show bookings: ${elapsed}ms`);
      expect(elapsed).toBeLessThan(SINGLE_MSG_LIMIT_MS);
    },
    TIMEOUT
  );

  it(
    `average of 5 messages is under ${AVG_LIMIT_MS}ms`,
    async () => {
      const messages = [
        "Hi there",
        "Book a lesson for Friday",
        "10am please",
        "Show my bookings",
        "Cancel booking DL-AB12",
      ];

      const times = [];
      for (const msg of messages) {
        const start = Date.now();
        await askGemini(msg);
        times.push(Date.now() - start);
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`  ⏱ Individual: [${times.map((t) => t + "ms").join(", ")}]`);
      console.log(`  ⏱ Average: ${Math.round(avg)}ms`);

      expect(avg).toBeLessThan(AVG_LIMIT_MS);
    },
    60000
  );
});
