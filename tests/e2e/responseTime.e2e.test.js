/**
 * Response Time – E2E Tests (Real Pipeline)
 * ───────────────────────────────────────────
 * Measures full pipeline latency through handleIncomingMessage:
 *   instructor resolution → user details → date extraction → Gemini → action dispatch
 *
 *  1. Single message latency (< 15s — includes date extraction + Gemini)
 *  2. Average latency across multiple messages
 *  3. Consistency — no single response takes excessively long
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
} = require("./helpers");

const SINGLE_MSG_LIMIT_MS = 15000; // 15s max (includes date extraction + Gemini)
const AVG_LIMIT_MS = 12000;        // 12s average
const TIMEOUT = 20000;

const describeE2E = process.env.GOOGLE_AI_API_KEY ? describe : describe.skip;

describeE2E("E2E – Response Time (Real Pipeline)", () => {
  beforeAll(async () => { await setupE2ESuite(); }, 30000);
  afterEach(() => { cleanupE2ETest(); });
  afterAll(async () => { await teardownE2ESuite(); });

  it(
    `greeting responds within ${SINGLE_MSG_LIMIT_MS}ms`,
    async () => {
      const start = Date.now();
      await sendMessage("Hello!");
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
      await sendMessage("I want to book a lesson next Monday at 10am");
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
      await sendMessage("Show me my bookings");
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
        await sendMessage(msg);
        times.push(Date.now() - start);
        cleanupE2ETest(); // isolate each message
      }

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`  ⏱ Individual: [${times.map((t) => t + "ms").join(", ")}]`);
      console.log(`  ⏱ Average: ${Math.round(avg)}ms`);

      expect(avg).toBeLessThan(AVG_LIMIT_MS);
    },
    120000 // 5 API calls
  );
});
