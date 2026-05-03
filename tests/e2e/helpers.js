/**
 * E2E Test Helpers
 * ─────────────────
 * Shared utilities for end-to-end tests that exercise the REAL application
 * pipeline through webhookController.handleIncomingMessage.
 *
 * What runs real:
 *   - Gemini AI (real API calls)
 *   - MongoDB (test database from envs/.env.test)
 *   - Sessions (in-memory, per-user conversation state)
 *   - Pending context (aiService.pendingContext — date/time accumulation)
 *   - Date/time extraction (dateTimeService)
 *   - User details collection (userDetailsService)
 *   - Geocoding (mapsService — real Maps API)
 *   - DB chat logging (dbChatLogger)
 *
 * What is mocked (set up via jest.mock in each test file using E2E_MOCKS):
 *   - calendarService (can't create real Google Calendar events)
 *   - sheetsService (can't write to real Google Sheets)
 *   - whatsappService (WhatsApp sends captured via mock callback)
 *   - chatLogger (file-based logger — avoid file writes)
 *
 * Requirements:
 *   - envs/.env.test must exist with valid keys
 *
 * Usage:
 *   // At the TOP of each e2e test file (before any other require):
 *   const { E2E_MOCKS } = require("./helpers");
 *   jest.mock("../../src/services/calendarService", E2E_MOCKS.calendarService);
 *   jest.mock("../../src/services/sheetsService", E2E_MOCKS.sheetsService);
 *   jest.mock("../../src/services/whatsappService", E2E_MOCKS.whatsappService);
 *   jest.mock("../../src/utils/chatLogger", E2E_MOCKS.chatLogger);
 *
 *   const { sendMessage, ... } = require("./helpers");
 */

// ── 1. Load environment BEFORE any other require ─────────────────────────
process.env.NODE_ENV = "test";
process.env.LOAD_ENV = "test";
require("../../src/config/env");

// ── 2. Dependencies (loaded AFTER env is configured) ─────────────────────
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const SYSTEM_PROMPT_PATH = path.join(__dirname, "..", "..", "SYSTEM_PROMPT.txt");

// ── 3. Test fixtures ─────────────────────────────────────────────────────

const TEST_PHONE = "447700900001";
const TEST_INSTRUCTOR_PHONE_ID = "e2e-instructor-phone-id";

const TEST_INSTRUCTOR = {
  phoneNumberId: TEST_INSTRUCTOR_PHONE_ID,
  phone: "+440000000000",
  name: process.env.INSTRUCTOR_NAME || "Test Instructor",
  email: process.env.INSTRUCTOR_EMAIL || "test@test.com",
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || "test-calendar@group.calendar.google.com",
  googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "test-refresh-token",
  whatsappToken: "test-whatsapp-token",
  spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || "test-spreadsheet-id",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: {
    latitude: parseFloat(process.env.LATUTIDE_DEFAULT) || 53.0168,
    longitude: parseFloat(process.env.LONGITUDE_DEFAULT) || -2.2191,
  },
  rates: { basic: 50, highway: 60, parking: 45 },
  timezone: process.env.APP_TIMEZONE || "Asia/Kolkata",
  active: true,
};

const TEST_USER = {
  phone: TEST_PHONE,
  instructorId: TEST_INSTRUCTOR_PHONE_ID,
  name: "E2E Test User",
  age: 25,
  dob: "1999-01-01",
  postalCode: "ST5 1AB",
  detailsCompleted: true,
  currentStep: null,
  location: {
    latitude: 53.0168,
    longitude: -2.2191,
  },
};

// ── 4. Jest mock factories ───────────────────────────────────────────────
// These are exported so each test file can call jest.mock() at the top.
// jest.mock() MUST be in the test file itself (Jest hoists it).

const E2E_MOCKS = {
  calendarService: () => ({
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
  }),

  sheetsService: () => ({
    getInstructorSpreadsheetId: jest.fn().mockReturnValue("test-spreadsheet-id"),
    getLearnerName: jest.fn().mockResolvedValue("E2E Test User"),
    updateLearnerRecord: jest.fn().mockResolvedValue({}),
    initializeCredentials: jest.fn(),
  }),

  whatsappService: () => ({
    sendTextMessage: jest.fn().mockResolvedValue({}),
    sendMessage: jest.fn().mockResolvedValue({}),
  }),

  chatLogger: () => jest.fn(() => ({ info: jest.fn() })),
};

// ── 5. Database helpers ──────────────────────────────────────────────────

async function connectTestDB() {
  if (mongoose.connection.readyState === 1) return;

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set — check envs/.env.test");

  const opts = {};
  if (process.env.DB_NAME) opts.dbName = process.env.DB_NAME;

  await mongoose.connect(uri, opts);
  console.log(`  🗄️  Connected to test DB: ${process.env.DB_NAME || "(default)"}`);
}

async function cleanupTestDB() {
  if (mongoose.connection.readyState !== 1) return;

  const collections = await mongoose.connection.db.listCollections().toArray();
  for (const col of collections) {
    await mongoose.connection.db.dropCollection(col.name).catch(() => {});
  }
}

async function disconnectTestDB() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    console.log("  🗄️  Disconnected from test DB");
  }
}

// ── 6. Seed helpers ──────────────────────────────────────────────────────

/**
 * Insert the test instructor into the DB.
 * Also invalidates the instructor cache so it's picked up fresh.
 */
async function seedTestInstructor() {
  const Instructor = require("../../src/models/instructorSchema");
  const { invalidateInstructorCache } = require("../../src/models/instructorModel");

  await Instructor.deleteMany({ phoneNumberId: TEST_INSTRUCTOR_PHONE_ID });
  await Instructor.create(TEST_INSTRUCTOR);
  invalidateInstructorCache(TEST_INSTRUCTOR_PHONE_ID);
}

/**
 * Insert the test user (with completed details) into the DB.
 * This skips the user-details onboarding flow.
 */
async function seedTestUser(overrides = {}) {
  const User = require("../../src/models/userModel");

  await User.deleteMany({ phone: TEST_PHONE });
  return User.create({ ...TEST_USER, ...overrides });
}

// ── 7. Session helpers ───────────────────────────────────────────────────

/**
 * Clear the in-memory session and pending context for the test user.
 * Call between tests to isolate conversation state.
 */
function clearTestSession() {
  const { userSessions } = require("../../src/models/instructorModel");
  const aiService = require("../../src/services/gemini/aiService");

  delete userSessions[TEST_PHONE];
  aiService.clearPendingContext(TEST_PHONE);
}

/**
 * Get the current in-memory session for the test user.
 */
function getTestSession() {
  const { getUserSession } = require("../../src/models/instructorModel");
  return getUserSession(TEST_PHONE);
}

/**
 * Get the current pending context for the test user.
 */
function getTestPendingContext() {
  const aiService = require("../../src/services/gemini/aiService");
  return aiService.pendingContext[TEST_PHONE] || {};
}

// ── 8. sendMessage — the core e2e helper ─────────────────────────────────

/**
 * Send a message through the REAL application pipeline.
 * Uses webhookController.handleIncomingMessage with mock mode to capture replies.
 *
 * This exercises: instructor resolution → user details check → date extraction
 * → pending context → system message → Gemini → action dispatch → session update
 *
 * @param {string} message - User message text
 * @param {Object} [opts]
 * @param {string} [opts.from] - User phone (default: TEST_PHONE)
 * @param {string} [opts.instructorPhoneId] - Instructor phone ID
 * @returns {Promise<{ replies: string[], raw: string }>}
 *   replies = all messages sent back to user (may be multiple)
 *   raw = concatenated replies
 */
async function sendMessage(message, opts = {}) {
  const WebhookController = require("../../src/controllers/webhookController");

  const from = opts.from || TEST_PHONE;
  const instructorPhoneId = opts.instructorPhoneId || TEST_INSTRUCTOR_PHONE_ID;

  const replies = [];
  const mockReplyCallback = (text) => replies.push(text);

  await WebhookController.handleIncomingMessage(
    from,
    message,
    instructorPhoneId,
    true,          // isMock = true
    mockReplyCallback
  );

  return {
    replies,
    raw: replies.join("\n"),
  };
}

// ── 9. Action extractor (same regex as aiService.extractActions) ─────────

function extractAction(aiResponse) {
  const ACTION_REGEX =
    /\[ACTION:(BOOK|UPDATE_BOOKING|CANCEL_BOOKING|SHOW_BOOKINGS|NEXT_AVAILABLE_SLOT|NULL)\]\s*(\{[\s\S]*?\})?\s*$/;

  const match = aiResponse.match(ACTION_REGEX);
  if (!match) return { actionType: null, bookingData: null, responseText: aiResponse };

  let bookingData = null;
  try {
    if (match[2]) bookingData = JSON.parse(match[2]);
  } catch (_) {}

  return {
    actionType: match[1],
    bookingData,
    responseText: aiResponse.replace(ACTION_REGEX, "").trim(),
  };
}

// ── 10. Raw Gemini helpers (for tests that only need direct AI calls) ────

let _model = null;

function getModel() {
  if (_model) return _model;

  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_AI_API_KEY is required for e2e tests. Check envs/.env.test");
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  _model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      temperature: 0.7,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 500,
    },
  });
  return _model;
}

function getSystemPrompt(instructorName) {
  const raw = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
  return raw.replace(/\{\{INSTRUCTOR_NAME\}\}/g, instructorName || TEST_INSTRUCTOR.name);
}

function buildPrompt(userMessage, opts = {}) {
  const { instructorName, conversationHistory = [], systemSuffix = "" } = opts;

  const systemPrompt = getSystemPrompt(instructorName);
  const timezone = TEST_INSTRUCTOR.timezone;
  const today = new Date().toISOString().split("T")[0];

  let conv = `${systemPrompt}\n\nTODAY's date (${timezone}): ${today}\n\nCONVERSATION HISTORY:\n`;
  conversationHistory.forEach((msg) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    conv += `${role}: ${msg.content}\n`;
  });
  conv += `\nUser: ${userMessage}${systemSuffix}\n\nAssistant: `;
  return conv;
}

async function askGemini(userMessage, opts = {}) {
  const model = getModel();
  const prompt = buildPrompt(userMessage, opts);
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ── 11. Shared beforeAll / afterAll / afterEach ──────────────────────────

/**
 * Standard e2e suite setup: connect DB, seed instructor + user, clear session.
 * Call in beforeAll().
 */
async function setupE2ESuite() {
  await connectTestDB();
  await seedTestInstructor();
  await seedTestUser();
}

/**
 * Standard e2e test cleanup: clear session + pending context between tests.
 * Call in afterEach().
 */
function cleanupE2ETest() {
  clearTestSession();
}

/**
 * Standard e2e suite teardown: cleanup DB + disconnect.
 * Call in afterAll().
 */
async function teardownE2ESuite() {
  clearTestSession();
  await cleanupTestDB();
  await disconnectTestDB();
}

// ── 12. describeE2E — centralized guard with clear errors ────────────────
//
// Usage:
//   const { describeE2E, E2E_KEYS } = require("./helpers");
//   describeE2E(E2E_KEYS.AI, "My Suite Name", () => { ... });
//
// Behaviour:
//   - If all required env vars are present → runs normally (plain describe).
//   - If vars are missing AND E2E_SKIP_MISSING=1 → describe.skip (CI-friendly).
//   - If vars are missing AND E2E_SKIP_MISSING is NOT set → throws a clear error
//     telling you exactly which vars are missing so you can fix envs/.env.test.
//
// To run a single file easily:
//   npm run test:e2e -- --testPathPattern=bookingFlow

/** Predefined key groups for the 3 categories of e2e tests */
const E2E_KEYS = {
  /** Tests that call the Gemini AI pipeline */
  AI: ["GOOGLE_AI_API_KEY"],
  /** Tests that call Google Maps (geocoding, distance matrix) */
  MAPS: ["GOOGLE_MAPS_API_KEY"],
  /** Tests that call real Google Calendar API */
  CALENDAR: ["GOOGLE_REFRESH_TOKEN", "GOOGLE_CALENDAR_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  /** Tests that call real Google Sheets API */
  SHEETS: ["GOOGLE_REFRESH_TOKEN", "GOOGLE_SPREADSHEET_ID", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
};

/**
 * @param {string[]} requiredKeys - env var names that must be set
 * @param {string}   suiteName    - describe() suite name
 * @param {Function} suiteFn      - the function passed to describe()
 */
function describeE2E(requiredKeys, suiteName, suiteFn) {
  const missing = requiredKeys.filter((k) => !process.env[k]);

  if (missing.length === 0) {
    // All keys present — run normally
    return describe(suiteName, suiteFn);
  }

  if (process.env.E2E_SKIP_MISSING === "1") {
    // Opt-in silent skip (useful in CI where some creds aren't available)
    return describe.skip(`[SKIPPED — missing env] ${suiteName}`, suiteFn);
  }

  // DEFAULT: Fail loudly so you know exactly what's wrong
  describe(suiteName, () => {
    it("should have required environment variables", () => {
      throw new Error(
        `\n\n❌  E2E suite "${suiteName}" cannot run.\n` +
        `    Missing env vars: ${missing.join(", ")}\n\n` +
        `    Fix: Add them to envs/.env.test\n` +
        `    Or:  set E2E_SKIP_MISSING=1 to skip instead of fail.\n`
      );
    });
  });
}

// ── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  // Mock factories (use at top of test files with jest.mock)
  E2E_MOCKS,

  // Centralized describe guard
  describeE2E,
  E2E_KEYS,

  // Core e2e helper
  sendMessage,

  // Raw Gemini (for tests that don't need the full pipeline)
  getModel,
  getSystemPrompt,
  buildPrompt,
  askGemini,
  extractAction,

  // Fixtures
  TEST_INSTRUCTOR,
  TEST_USER,
  TEST_PHONE,
  TEST_INSTRUCTOR_PHONE_ID,

  // Database
  connectTestDB,
  disconnectTestDB,
  cleanupTestDB,

  // Seeding
  seedTestInstructor,
  seedTestUser,

  // Session
  clearTestSession,
  getTestSession,
  getTestPendingContext,

  // Lifecycle
  setupE2ESuite,
  cleanupE2ETest,
  teardownE2ESuite,
};
