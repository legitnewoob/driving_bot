/**
 * Helpers – Unit Tests
 * ─────────────────────
 * Covers:
 *  1. cleanupSessions – session eviction based on timeout
 *  2. cleanUpContexts – context clearing based on timeout
 */

// Mock dependencies before requiring
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({ user: jest.fn(), assistant: jest.fn() })));

// We need to mock instructorModel to control userSessions
const mockUserSessions = {};
jest.mock("../../src/models/instructorModel", () => ({
  userSessions: mockUserSessions,
  getUserSession: jest.fn(),
  updateUserSession: jest.fn(),
  getInstructor: jest.fn(),
}));

// Mock timezoneUtils to control "now"
let mockNow = new Date("2025-07-15T12:00:00Z");
jest.mock("../../src/utils/timezoneUtils", () => ({
  getCurrentDate: jest.fn(() => mockNow),
  getCurrentDateString: jest.fn(() => "2025-07-15"),
  timezone: "Europe/London",
}));

// Mock WebhookController
jest.mock("../../src/controllers/webhookController", () => ({
  clearUserConversationHistoryAndContext: jest.fn(),
}));

const WebhookController = require("../../src/controllers/webhookController");
const { cleanupSessions, cleanUpContexts } = require("../../src/utils/helpers");

beforeEach(() => {
  jest.clearAllMocks();
  // Clear all keys from mockUserSessions
  Object.keys(mockUserSessions).forEach((k) => delete mockUserSessions[k]);
  mockNow = new Date("2025-07-15T12:00:00Z");
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. cleanupSessions
// ═══════════════════════════════════════════════════════════════════════════

describe("cleanupSessions", () => {
  it("does nothing when userSessions is empty", () => {
    expect(() => cleanupSessions()).not.toThrow();
  });

  it("removes sessions older than timeout period", () => {
    const oneHourAgo = new Date(mockNow.getTime() - 61 * 60 * 1000);
    mockUserSessions["447000000001"] = { lastActivity: oneHourAgo };
    mockUserSessions["447000000002"] = { lastActivity: mockNow };

    cleanupSessions();

    expect(mockUserSessions["447000000001"]).toBeUndefined();
    expect(mockUserSessions["447000000002"]).toBeDefined();
  });

  it("keeps sessions within timeout period", () => {
    const thirtyMinAgo = new Date(mockNow.getTime() - 30 * 60 * 1000);
    mockUserSessions["447000000001"] = { lastActivity: thirtyMinAgo };

    cleanupSessions();

    expect(mockUserSessions["447000000001"]).toBeDefined();
  });

  it("skips sessions with no lastActivity", () => {
    mockUserSessions["447000000001"] = {};
    mockUserSessions["447000000002"] = { lastActivity: null };

    cleanupSessions();

    expect(mockUserSessions["447000000001"]).toBeDefined();
    expect(mockUserSessions["447000000002"]).toBeDefined();
  });

  it("uses SESSION_TIMEOUT_MINUTES env var", () => {
    const originalEnv = process.env.SESSION_TIMEOUT_MINUTES;
    process.env.SESSION_TIMEOUT_MINUTES = "5"; // 5 minutes

    const sixMinAgo = new Date(mockNow.getTime() - 6 * 60 * 1000);
    const threeMinAgo = new Date(mockNow.getTime() - 3 * 60 * 1000);

    mockUserSessions["expired"] = { lastActivity: sixMinAgo };
    mockUserSessions["active"] = { lastActivity: threeMinAgo };

    cleanupSessions();

    expect(mockUserSessions["expired"]).toBeUndefined();
    expect(mockUserSessions["active"]).toBeDefined();

    process.env.SESSION_TIMEOUT_MINUTES = originalEnv;
  });

  it("handles null session values gracefully", () => {
    mockUserSessions["447000000001"] = null;

    expect(() => cleanupSessions()).not.toThrow();
    expect(mockUserSessions["447000000001"]).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. cleanUpContexts
// ═══════════════════════════════════════════════════════════════════════════

describe("cleanUpContexts", () => {
  it("does nothing when userSessions is empty", () => {
    expect(() => cleanUpContexts()).not.toThrow();
    expect(WebhookController.clearUserConversationHistoryAndContext).not.toHaveBeenCalled();
  });

  it("clears context for sessions older than context timeout", () => {
    const fifteenMinAgo = new Date(mockNow.getTime() - 15 * 60 * 1000);
    mockUserSessions["447000000001"] = { lastActivity: fifteenMinAgo };

    cleanUpContexts();

    expect(WebhookController.clearUserConversationHistoryAndContext).toHaveBeenCalledWith("447000000001");
  });

  it("does NOT clear context for recent sessions", () => {
    const fiveMinAgo = new Date(mockNow.getTime() - 5 * 60 * 1000);
    mockUserSessions["447000000001"] = { lastActivity: fiveMinAgo };

    cleanUpContexts();

    expect(WebhookController.clearUserConversationHistoryAndContext).not.toHaveBeenCalled();
  });

  it("uses CONTEXT_TIMEOUT_MINUTES env var", () => {
    const originalEnv = process.env.CONTEXT_TIMEOUT_MINUTES;
    process.env.CONTEXT_TIMEOUT_MINUTES = "2"; // 2 minutes

    const threeMinAgo = new Date(mockNow.getTime() - 3 * 60 * 1000);
    mockUserSessions["447000000001"] = { lastActivity: threeMinAgo };

    cleanUpContexts();

    expect(WebhookController.clearUserConversationHistoryAndContext).toHaveBeenCalledWith("447000000001");

    process.env.CONTEXT_TIMEOUT_MINUTES = originalEnv;
  });

  it("skips sessions with no lastActivity", () => {
    mockUserSessions["447000000001"] = {};
    mockUserSessions["447000000002"] = { lastActivity: null };

    cleanUpContexts();

    expect(WebhookController.clearUserConversationHistoryAndContext).not.toHaveBeenCalled();
  });

  it("handles null session values gracefully", () => {
    mockUserSessions["447000000001"] = null;

    expect(() => cleanUpContexts()).not.toThrow();
  });

  it("processes multiple sessions independently", () => {
    const fifteenMinAgo = new Date(mockNow.getTime() - 15 * 60 * 1000);
    const fiveMinAgo = new Date(mockNow.getTime() - 5 * 60 * 1000);

    mockUserSessions["expired-1"] = { lastActivity: fifteenMinAgo };
    mockUserSessions["active-1"] = { lastActivity: fiveMinAgo };
    mockUserSessions["expired-2"] = { lastActivity: fifteenMinAgo };

    cleanUpContexts();

    expect(WebhookController.clearUserConversationHistoryAndContext).toHaveBeenCalledTimes(2);
    expect(WebhookController.clearUserConversationHistoryAndContext).toHaveBeenCalledWith("expired-1");
    expect(WebhookController.clearUserConversationHistoryAndContext).toHaveBeenCalledWith("expired-2");
  });
});
