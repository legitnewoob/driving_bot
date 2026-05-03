/**
 * WhatsApp Token Refresh Service – Unit Tests
 * ─────────────────────────────────────────────
 * Covers:
 *  1. exchangeForLongLivedToken – Meta Graph API call, env validation
 *  2. refreshAndUpdateAll – DB lookup, exchange, bulk update, cache invalidation
 *  3. Error handling – missing env vars, API errors, no instructors, DB errors
 *  4. startTokenRefreshSchedule / stopTokenRefreshSchedule – timer lifecycle
 */

jest.mock("axios");
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../src/models/instructorSchema");
jest.mock("../src/models/instructorModel", () => ({
  invalidateInstructorCache: jest.fn(),
}));

const axios = require("axios");
const logger = require("../src/utils/logger-advanced");
const Instructor = require("../src/models/instructorSchema");
const { invalidateInstructorCache } = require("../src/models/instructorModel");
const {
  exchangeForLongLivedToken,
  refreshAndUpdateAll,
  startTokenRefreshSchedule,
  stopTokenRefreshSchedule,
} = require("../src/utils/refreshWhatsappToken");

// ═══════════════════════════════════════════════════════════════════════════
// Setup / Teardown
// ═══════════════════════════════════════════════════════════════════════════

beforeEach(() => {
  jest.clearAllMocks();
  process.env.META_APP_ID = "test-app-id";
  process.env.META_APP_SECRET = "test-app-secret";
});

afterEach(() => {
  stopTokenRefreshSchedule();
});

afterAll(() => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. exchangeForLongLivedToken
// ═══════════════════════════════════════════════════════════════════════════

describe("exchangeForLongLivedToken", () => {
  it("calls Meta Graph API with correct URL and returns new token", async () => {
    axios.get.mockResolvedValue({
      data: { access_token: "new-long-lived-token", token_type: "bearer", expires_in: 5184000 },
    });

    const result = await exchangeForLongLivedToken("old-token");

    expect(result).toBe("new-long-lived-token");
    expect(axios.get).toHaveBeenCalledTimes(1);

    const calledUrl = axios.get.mock.calls[0][0];
    expect(calledUrl).toContain("graph.facebook.com");
    expect(calledUrl).toContain("grant_type=fb_exchange_token");
    expect(calledUrl).toContain("client_id=test-app-id");
    expect(calledUrl).toContain("client_secret=test-app-secret");
    expect(calledUrl).toContain("fb_exchange_token=old-token");
  });

  it("throws when META_APP_ID is missing", async () => {
    delete process.env.META_APP_ID;

    await expect(exchangeForLongLivedToken("some-token"))
      .rejects.toThrow("Missing META_APP_ID or META_APP_SECRET");
  });

  it("throws when META_APP_SECRET is missing", async () => {
    delete process.env.META_APP_SECRET;

    await expect(exchangeForLongLivedToken("some-token"))
      .rejects.toThrow("Missing META_APP_ID or META_APP_SECRET");
  });

  it("throws when currentToken is null/empty", async () => {
    await expect(exchangeForLongLivedToken(null))
      .rejects.toThrow("No current WhatsApp token available");

    await expect(exchangeForLongLivedToken(""))
      .rejects.toThrow("No current WhatsApp token available");
  });

  it("propagates API errors from Meta", async () => {
    axios.get.mockRejectedValue({
      response: { data: { error: { message: "Invalid OAuth access token" } } },
      message: "Request failed with status code 400",
    });

    await expect(exchangeForLongLivedToken("bad-token")).rejects.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. refreshAndUpdateAll
// ═══════════════════════════════════════════════════════════════════════════

describe("refreshAndUpdateAll", () => {
  const mockInstructors = [
    { phoneNumberId: "inst-1", whatsappToken: "old-shared-token" },
    { phoneNumberId: "inst-2", whatsappToken: "old-shared-token" },
  ];

  function setupSuccessfulRefresh() {
    // findOne returns first instructor with current token
    Instructor.findOne.mockResolvedValue(mockInstructors[0]);

    // Meta API returns new token
    axios.get.mockResolvedValue({
      data: { access_token: "fresh-long-lived-token" },
    });

    // updateMany succeeds
    Instructor.updateMany.mockResolvedValue({ modifiedCount: 2 });

    // find for cache invalidation
    Instructor.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(mockInstructors),
      }),
    });
  }

  it("fetches token from any active instructor, exchanges, and updates all", async () => {
    setupSuccessfulRefresh();

    await refreshAndUpdateAll();

    // 1. Looked up an active instructor
    expect(Instructor.findOne).toHaveBeenCalledWith({ active: true });

    // 2. Called Meta API with the old token
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toContain("fb_exchange_token=old-shared-token");

    // 3. Updated all active instructors with new token
    expect(Instructor.updateMany).toHaveBeenCalledWith(
      { active: true },
      { $set: { whatsappToken: "fresh-long-lived-token" } }
    );

    // 4. Invalidated cache for each instructor
    expect(invalidateInstructorCache).toHaveBeenCalledTimes(2);
    expect(invalidateInstructorCache).toHaveBeenCalledWith("inst-1");
    expect(invalidateInstructorCache).toHaveBeenCalledWith("inst-2");

    // 5. Logged success
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("updated 2 instructor(s)")
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("complete")
    );
  });

  it("skips refresh when no active instructors exist", async () => {
    Instructor.findOne.mockResolvedValue(null);

    await refreshAndUpdateAll();

    expect(axios.get).not.toHaveBeenCalled();
    expect(Instructor.updateMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("no active instructors found")
    );
  });

  it("does not crash when Meta API fails — logs error and continues", async () => {
    Instructor.findOne.mockResolvedValue(mockInstructors[0]);
    axios.get.mockRejectedValue(new Error("Network timeout"));

    // Should not throw
    await refreshAndUpdateAll();

    expect(Instructor.updateMany).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Network timeout")
    );
  });

  it("logs detailed error when Meta returns error response body", async () => {
    Instructor.findOne.mockResolvedValue(mockInstructors[0]);
    axios.get.mockRejectedValue({
      response: { data: { error: { message: "Token expired", code: 190 } } },
      message: "Request failed",
    });

    await refreshAndUpdateAll();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Token expired")
    );
  });

  it("does not crash when DB updateMany fails", async () => {
    Instructor.findOne.mockResolvedValue(mockInstructors[0]);
    axios.get.mockResolvedValue({ data: { access_token: "new-token" } });
    Instructor.updateMany.mockRejectedValue(new Error("DB write failed"));

    await refreshAndUpdateAll();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("DB write failed")
    );
  });

  it("does not crash when missing env vars — logs error", async () => {
    delete process.env.META_APP_ID;
    Instructor.findOne.mockResolvedValue(mockInstructors[0]);

    await refreshAndUpdateAll();

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing META_APP_ID")
    );
    expect(Instructor.updateMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Schedule Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

describe("startTokenRefreshSchedule / stopTokenRefreshSchedule", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    // Prevent actual refreshAndUpdateAll from doing DB calls during schedule tests
    Instructor.findOne.mockResolvedValue(null);
  });

  afterEach(() => {
    stopTokenRefreshSchedule();
    jest.useRealTimers();
  });

  it("calls refreshAndUpdateAll immediately on start", () => {
    startTokenRefreshSchedule();

    // refreshAndUpdateAll is called synchronously (returns a promise, but is invoked)
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("scheduled")
    );
  });

  it("calls refreshAndUpdateAll again after 7 days", () => {
    startTokenRefreshSchedule();
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);

    // Advance 7 days
    jest.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(Instructor.findOne).toHaveBeenCalledTimes(2);

    // Advance another 7 days
    jest.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(Instructor.findOne).toHaveBeenCalledTimes(3);
  });

  it("does NOT call again before 7 days", () => {
    startTokenRefreshSchedule();
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);

    // Advance 6 days — should not trigger
    jest.advanceTimersByTime(6 * 24 * 60 * 60 * 1000);
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);
  });

  it("stopTokenRefreshSchedule stops the interval", () => {
    startTokenRefreshSchedule();
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);

    stopTokenRefreshSchedule();

    // Advance 7 days — should NOT trigger because schedule was stopped
    jest.advanceTimersByTime(7 * 24 * 60 * 60 * 1000);
    expect(Instructor.findOne).toHaveBeenCalledTimes(1);
  });

  it("stopTokenRefreshSchedule is safe to call multiple times", () => {
    startTokenRefreshSchedule();
    stopTokenRefreshSchedule();
    stopTokenRefreshSchedule(); // no-op, should not throw
  });
});
