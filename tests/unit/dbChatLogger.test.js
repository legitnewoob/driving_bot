/**
 * DbChatLogger (MongoDB-based) – Unit Tests
 * ────────────────────────────────────────────
 * Covers getDbChatLogger():
 *  1. Returns wrapped logger with .user(), .assistant(), .system() methods
 *  2. Each method injects correct metadata (instructor, phoneNumber, role, date)
 *  3. Caches loggers by date+instructor+phone key
 *  4. Uses MongoTransport for persistence
 *  5. Message content is passed through correctly
 */

// Mock winston
const mockLoggerInfo = jest.fn();
const mockCreateLogger = jest.fn().mockReturnValue({
  info: mockLoggerInfo,
});

jest.mock("winston", () => ({
  createLogger: (...args) => mockCreateLogger(...args),
  format: {
    combine: jest.fn((...fns) => fns),
    json: jest.fn(() => "json-format"),
  },
}));

// Mock MongoTransport
jest.mock("../../src/utils/mongoTransport", () => {
  return jest.fn().mockImplementation(() => ({
    name: "mongo",
    log: jest.fn(),
  }));
});

process.env.APP_TIMEZONE = "Asia/Kolkata";

const MongoTransport = require("../../src/utils/mongoTransport");
const getDbChatLogger = require("../../src/utils/dbChatLogger");

beforeEach(() => {
  jest.clearAllMocks();
  mockLoggerInfo.mockClear();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Wrapped Logger Shape
// ═══════════════════════════════════════════════════════════════════════════

describe("Wrapped logger shape", () => {
  it("returns an object with .user() method", () => {
    const logger = getDbChatLogger("inst-1", "447000000001");
    expect(typeof logger.user).toBe("function");
  });

  it("returns an object with .assistant() method", () => {
    const logger = getDbChatLogger("inst-1", "447000000002");
    expect(typeof logger.assistant).toBe("function");
  });

  it("returns an object with .system() method", () => {
    const logger = getDbChatLogger("inst-1", "447000000003");
    expect(typeof logger.system).toBe("function");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Metadata Injection
// ═══════════════════════════════════════════════════════════════════════════

describe("Metadata injection", () => {
  it(".user() logs with role=user and correct instructor/phone", () => {
    const logger = getDbChatLogger("inst-A", "447000000010");
    logger.user("Hello from user");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        instructor: "inst-A",
        phoneNumber: "447000000010",
        role: "user",
        message: "Hello from user",
        date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      })
    );
  });

  it(".assistant() logs with role=assistant", () => {
    const logger = getDbChatLogger("inst-B", "447000000011");
    logger.assistant("Here's my response");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "assistant",
        message: "Here's my response",
        instructor: "inst-B",
        phoneNumber: "447000000011",
      })
    );
  });

  it(".system() logs with role=system", () => {
    const logger = getDbChatLogger("inst-C", "447000000012");
    logger.system("System event");

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        role: "system",
        message: "System event",
        instructor: "inst-C",
      })
    );
  });

  it("date field is in YYYY-MM-DD format", () => {
    const logger = getDbChatLogger("inst-D", "447000000013");
    logger.user("Test");

    const loggedData = mockLoggerInfo.mock.calls[0][0];
    expect(loggedData.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("different instructors get different metadata", () => {
    const logger1 = getDbChatLogger("inst-X", "447000000020");
    const logger2 = getDbChatLogger("inst-Y", "447000000020");

    logger1.user("Msg 1");
    logger2.user("Msg 2");

    expect(mockLoggerInfo.mock.calls[0][0].instructor).toBe("inst-X");
    expect(mockLoggerInfo.mock.calls[1][0].instructor).toBe("inst-Y");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Caching
// ═══════════════════════════════════════════════════════════════════════════

describe("Logger caching", () => {
  it("returns same instance for same instructor+phone+day", () => {
    const logger1 = getDbChatLogger("inst-cache", "447000000030");
    const callCount1 = mockCreateLogger.mock.calls.length;

    const logger2 = getDbChatLogger("inst-cache", "447000000030");
    const callCount2 = mockCreateLogger.mock.calls.length;

    expect(logger1).toBe(logger2);
    expect(callCount2).toBe(callCount1); // no new createLogger call
  });

  it("creates different instances for different phones", () => {
    const logger1 = getDbChatLogger("inst-cache2", "447000000040");
    const logger2 = getDbChatLogger("inst-cache2", "447000000041");

    expect(logger1).not.toBe(logger2);
  });

  it("creates different instances for different instructors", () => {
    const logger1 = getDbChatLogger("inst-A2", "447000000050");
    const logger2 = getDbChatLogger("inst-B2", "447000000050");

    expect(logger1).not.toBe(logger2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. MongoTransport Usage
// ═══════════════════════════════════════════════════════════════════════════

describe("MongoTransport usage", () => {
  it("createLogger is called with MongoTransport instance", () => {
    getDbChatLogger("inst-mongo", "447000000060");

    const config = mockCreateLogger.mock.calls[
      mockCreateLogger.mock.calls.length - 1
    ][0];

    // transports should contain a MongoTransport instance
    expect(config.transports).toBeDefined();
    expect(config.transports.length).toBe(1);
    expect(MongoTransport).toHaveBeenCalled();
  });

  it("logger level is info", () => {
    getDbChatLogger("inst-level", "447000000070");

    const config = mockCreateLogger.mock.calls[
      mockCreateLogger.mock.calls.length - 1
    ][0];
    expect(config.level).toBe("info");
  });

  it("uses JSON format", () => {
    const { format } = require("winston");
    getDbChatLogger("inst-fmt", "447000000080");

    expect(format.json).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Message Content
// ═══════════════════════════════════════════════════════════════════════════

describe("Message content passthrough", () => {
  it("passes message string exactly as provided", () => {
    const logger = getDbChatLogger("inst-msg", "447000000090");
    logger.user("Book a lesson for Friday at 10am please");

    expect(mockLoggerInfo.mock.calls[0][0].message).toBe(
      "Book a lesson for Friday at 10am please"
    );
  });

  it("handles empty message", () => {
    const logger = getDbChatLogger("inst-empty", "447000000091");
    logger.user("");

    expect(mockLoggerInfo.mock.calls[0][0].message).toBe("");
  });

  it("handles long message", () => {
    const longMsg = "a".repeat(5000);
    const logger = getDbChatLogger("inst-long", "447000000092");
    logger.user(longMsg);

    expect(mockLoggerInfo.mock.calls[0][0].message).toBe(longMsg);
  });

  it("handles special characters in message", () => {
    const specialMsg = '{"action": "BOOK"} <script>alert(1)</script> 🎉';
    const logger = getDbChatLogger("inst-special", "447000000093");
    logger.assistant(specialMsg);

    expect(mockLoggerInfo.mock.calls[0][0].message).toBe(specialMsg);
  });
});
