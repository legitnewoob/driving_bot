/**
 * ChatLogger (File-based) – Unit Tests
 * ──────────────────────────────────────
 * Covers getChatLogger():
 *  1. Creates date-based folder (message-logs/YYYY-MM-DD/)
 *  2. Creates per-phone log file (<phone>.log)
 *  3. Uses correct timestamp format (locale time with APP_TIMEZONE)
 *  4. Caches loggers by date+phone key
 *  5. Returns a winston logger with .info()
 */

const path = require("path");

// Mock fs to track mkdir/existsSync calls
const mockExistsSync = jest.fn();
const mockMkdirSync = jest.fn();

jest.mock("fs", () => ({
  existsSync: (...args) => mockExistsSync(...args),
  mkdirSync: (...args) => mockMkdirSync(...args),
}));

// Mock winston
const mockFileTransport = jest.fn();
const mockCreateLogger = jest.fn().mockReturnValue({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
});

jest.mock("winston", () => ({
  createLogger: (...args) => mockCreateLogger(...args),
  format: {
    combine: jest.fn((...fns) => fns),
    timestamp: jest.fn((opts) => opts),
    printf: jest.fn((fn) => fn),
  },
  transports: {
    File: mockFileTransport,
  },
}));

jest.mock("winston-daily-rotate-file", () => jest.fn());

// Set timezone env before requiring
process.env.APP_TIMEZONE = "Asia/Kolkata";

const getChatLogger = require("../../src/utils/chatLogger");

beforeEach(() => {
  jest.clearAllMocks();
  // Clear the internal cache by re-requiring (or we test caching explicitly)
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Folder Creation
// ═══════════════════════════════════════════════════════════════════════════

describe("Folder creation", () => {
  it("creates date folder when it doesn't exist", () => {
    mockExistsSync.mockReturnValue(false);

    getChatLogger("447000000001");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("message-logs"),
      { recursive: true }
    );
  });

  it("does not create folder when it already exists", () => {
    mockExistsSync.mockReturnValue(true);

    getChatLogger("447000000002");

    expect(mockMkdirSync).not.toHaveBeenCalled();
  });

  it("folder path includes today's date in YYYY-MM-DD format", () => {
    mockExistsSync.mockReturnValue(false);

    getChatLogger("447000000003");

    const folderArg = mockMkdirSync.mock.calls[0][0];
    // Should contain a date-like segment
    expect(folderArg).toMatch(/message-logs[/\\]\d{4}-\d{2}-\d{2}/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Log File Path
// ═══════════════════════════════════════════════════════════════════════════

describe("Log file path", () => {
  it("creates a File transport with phone number as filename", () => {
    mockExistsSync.mockReturnValue(true);

    getChatLogger("447000000099");

    expect(mockCreateLogger).toHaveBeenCalled();
    const config = mockCreateLogger.mock.calls[0][0];
    const fileTransportCall = config.transports[0];

    // The File transport should be constructed with a filename containing the phone number
    expect(mockFileTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: expect.stringContaining("447000000099.log"),
      })
    );
  });

  it("file path is under message-logs/<date>/", () => {
    mockExistsSync.mockReturnValue(true);

    getChatLogger("447000000100");

    const fileConfig = mockFileTransport.mock.calls[
      mockFileTransport.mock.calls.length - 1
    ][0];

    expect(fileConfig.filename).toContain("message-logs");
    expect(fileConfig.filename).toContain("447000000100.log");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Logger Instance
// ═══════════════════════════════════════════════════════════════════════════

describe("Logger instance", () => {
  it("returns an object with .info method", () => {
    mockExistsSync.mockReturnValue(true);

    const logger = getChatLogger("447000000200");

    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
  });

  it("logger level is set to info", () => {
    mockExistsSync.mockReturnValue(true);

    getChatLogger("447000000201");

    const config = mockCreateLogger.mock.calls[
      mockCreateLogger.mock.calls.length - 1
    ][0];
    expect(config.level).toBe("info");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Caching
// ═══════════════════════════════════════════════════════════════════════════

describe("Logger caching", () => {
  it("returns the same logger for the same phone + same day", () => {
    mockExistsSync.mockReturnValue(true);

    const logger1 = getChatLogger("447000000300");
    const callCount1 = mockCreateLogger.mock.calls.length;

    const logger2 = getChatLogger("447000000300");
    const callCount2 = mockCreateLogger.mock.calls.length;

    // Second call should use cache (no new createLogger call)
    expect(callCount2).toBe(callCount1);
    expect(logger1).toBe(logger2);
  });

  it("creates separate loggers for different phone numbers", () => {
    mockExistsSync.mockReturnValue(true);

    const logger1 = getChatLogger("447000000400");
    const logger2 = getChatLogger("447000000401");

    // These are different mock return values but both should trigger createLogger
    expect(mockCreateLogger.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Timestamp Format
// ═══════════════════════════════════════════════════════════════════════════

describe("Timestamp format", () => {
  it("uses APP_TIMEZONE env var for timestamp", () => {
    mockExistsSync.mockReturnValue(true);

    getChatLogger("447000000500");

    const { format } = require("winston");
    // timestamp should be called with a format function that uses APP_TIMEZONE
    expect(format.timestamp).toHaveBeenCalledWith(
      expect.objectContaining({
        format: expect.any(Function),
      })
    );
  });
});
