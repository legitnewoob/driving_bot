/**
 * AIService – Unit Tests
 * ───────────────────────
 * Covers the helper methods on AIService (singleton):
 *
 *  1. getSystemPrompt – instructor name injection
 *  2. updatePendingContext / clearPendingContext – context lifecycle
 *  3. checkDateTimeCompleteness – merging pending + extracted
 *  4. _pruneStaleContexts – TTL eviction
 *  5. isValidBookingTime – time slot validation
 *  6. generateSystemMessage – all 7 check branches
 *  7. buildConversationForGemini – prompt assembly
 *  8. Validation delegates (isWithin24Hours, isDayRestricted, isWeekend, getDayName)
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({ user: jest.fn(), assistant: jest.fn() })));

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn(),
    }),
  })),
}));
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue("You are {{INSTRUCTOR_NAME}}'s booking assistant."),
  };
});
jest.mock("../../src/services/calendarService", () => ({
  getAvailableTimeSlotsForDate: jest.fn(),
  findEarliestAvailableSlot: jest.fn(),
}));
jest.mock("../../src/services/routeOptimizer", () => ({
  filterAvailableSlotsByLocation: jest.fn((slots) => slots),
  resolveUserContext: jest.fn(async () => ({ userLoc: null, prefs: {}, user: null })),
  planDay: jest.fn(async ({ availableSlots }) => ({ offered: availableSlots, evaluations: [], preferred: [] })),
  suggestBestDays: jest.fn(async () => []),
  checkServiceArea: jest.fn(() => ({ inside: true })),
  timeToMinutes: (t) => Number(t.split(":")[0]) * 60 + Number(t.split(":")[1]),
}));

const aiService = require("../../src/services/gemini/aiService");

const INSTRUCTOR_A = {
  name: "Alice",
  availableTimes: ["09:00", "10:00", "11:00", "14:00"],
  timezone: "Europe/London",
};

const INSTRUCTOR_B = {
  name: "Bob",
  availableTimes: ["10:00", "12:00", "14:00", "16:00"],
  timezone: "Europe/London",
};

beforeEach(() => {
  jest.clearAllMocks();
  // Clean pending context between tests
  Object.keys(aiService.pendingContext).forEach((k) => delete aiService.pendingContext[k]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. getSystemPrompt
// ═══════════════════════════════════════════════════════════════════════════

describe("getSystemPrompt", () => {
  it("injects instructor name into template", () => {
    const prompt = aiService.getSystemPrompt(INSTRUCTOR_A);
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("booking assistant");
    expect(prompt).not.toContain("{{INSTRUCTOR_NAME}}");
  });

  it("replaces all occurrences of placeholder", () => {
    const prompt = aiService.getSystemPrompt(INSTRUCTOR_B);
    expect(prompt).toContain("Bob");
    expect(prompt).not.toContain("Alice");
  });

  it("handles missing name gracefully", () => {
    const prompt = aiService.getSystemPrompt({});
    expect(prompt).not.toContain("{{INSTRUCTOR_NAME}}");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. updatePendingContext / clearPendingContext
// ═══════════════════════════════════════════════════════════════════════════

describe("updatePendingContext", () => {
  it("creates context for new user", () => {
    aiService.updatePendingContext("user1", { date: "2025-07-15" });
    expect(aiService.pendingContext["user1"].date).toBe("2025-07-15");
  });

  it("merges date into existing context", () => {
    aiService.updatePendingContext("user2", { time: "10:00" });
    aiService.updatePendingContext("user2", { date: "2025-07-15" });

    expect(aiService.pendingContext["user2"].date).toBe("2025-07-15");
    expect(aiService.pendingContext["user2"].time).toBe("10:00");
  });

  it("merges time into existing context", () => {
    aiService.updatePendingContext("user3", { date: "2025-07-15" });
    aiService.updatePendingContext("user3", { time: "14:00" });

    expect(aiService.pendingContext["user3"].date).toBe("2025-07-15");
    expect(aiService.pendingContext["user3"].time).toBe("14:00");
  });

  it("overwrites existing date/time", () => {
    aiService.updatePendingContext("user4", { date: "2025-07-15", time: "10:00" });
    aiService.updatePendingContext("user4", { date: "2025-07-16", time: "14:00" });

    expect(aiService.pendingContext["user4"].date).toBe("2025-07-16");
    expect(aiService.pendingContext["user4"].time).toBe("14:00");
  });

  it("sets _updatedAt timestamp", () => {
    aiService.updatePendingContext("user5", { date: "2025-07-15" });
    expect(aiService.pendingContext["user5"]._updatedAt).toBeDefined();
    expect(typeof aiService.pendingContext["user5"]._updatedAt).toBe("number");
  });

  it("does not set date/time if not provided", () => {
    aiService.updatePendingContext("user6", {});
    expect(aiService.pendingContext["user6"].date).toBeUndefined();
    expect(aiService.pendingContext["user6"].time).toBeUndefined();
  });
});

describe("clearPendingContext", () => {
  it("removes context for a user", () => {
    aiService.updatePendingContext("user7", { date: "2025-07-15" });
    aiService.clearPendingContext("user7");
    expect(aiService.pendingContext["user7"]).toBeUndefined();
  });

  it("is safe to call for non-existent user", () => {
    expect(() => aiService.clearPendingContext("nonexistent")).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. checkDateTimeCompleteness
// ═══════════════════════════════════════════════════════════════════════════

describe("checkDateTimeCompleteness", () => {
  it("returns extracted values when no pending context", () => {
    const result = aiService.checkDateTimeCompleteness(
      { date: "2025-07-15", time: "10:00" },
      "user-new"
    );

    expect(result.finalDate).toBe("2025-07-15");
    expect(result.finalTime).toBe("10:00");
    expect(result.hasExtractedDate).toBe(true);
    expect(result.hasExtractedTime).toBe(true);
    expect(result.hasPendingDate).toBe(false);
    expect(result.hasPendingTime).toBe(false);
  });

  it("merges pending date when extracted has none", () => {
    aiService.updatePendingContext("userA", { date: "2025-07-15" });

    const result = aiService.checkDateTimeCompleteness(
      { date: null, time: "10:00" },
      "userA"
    );

    expect(result.finalDate).toBe("2025-07-15");
    expect(result.finalTime).toBe("10:00");
    expect(result.hasPendingDate).toBe(true);
  });

  it("merges pending time when extracted has none", () => {
    aiService.updatePendingContext("userB", { time: "14:00" });

    const result = aiService.checkDateTimeCompleteness(
      { date: "2025-07-16", time: null },
      "userB"
    );

    expect(result.finalDate).toBe("2025-07-16");
    expect(result.finalTime).toBe("14:00");
    expect(result.hasPendingTime).toBe(true);
  });

  it("extracted values take priority over pending", () => {
    aiService.updatePendingContext("userC", { date: "2025-07-01", time: "09:00" });

    const result = aiService.checkDateTimeCompleteness(
      { date: "2025-07-20", time: "16:00" },
      "userC"
    );

    expect(result.finalDate).toBe("2025-07-20");
    expect(result.finalTime).toBe("16:00");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. _pruneStaleContexts
// ═══════════════════════════════════════════════════════════════════════════

describe("_pruneStaleContexts", () => {
  it("removes contexts older than 30 minutes", () => {
    aiService.pendingContext["stale-user"] = {
      date: "2025-07-15",
      _updatedAt: Date.now() - 31 * 60 * 1000,
    };
    aiService.pendingContext["fresh-user"] = {
      date: "2025-07-16",
      _updatedAt: Date.now(),
    };

    aiService._pruneStaleContexts();

    expect(aiService.pendingContext["stale-user"]).toBeUndefined();
    expect(aiService.pendingContext["fresh-user"]).toBeDefined();
  });

  it("removes context with missing _updatedAt", () => {
    aiService.pendingContext["no-ts"] = { date: "2025-07-15" };

    aiService._pruneStaleContexts();

    expect(aiService.pendingContext["no-ts"]).toBeUndefined();
  });

  it("does nothing when no contexts exist", () => {
    expect(() => aiService._pruneStaleContexts()).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. generateSystemMessage
// ═══════════════════════════════════════════════════════════════════════════

describe("generateSystemMessage", () => {
  beforeEach(() => {
    aiService._currentInstructorTimes = ["09:00", "10:00", "11:00", "14:00"];
  });

  // CHECK 1: Invalid time slot
  it("rejects invalid time slot", () => {
    const completeness = { finalDate: "2025-07-15", finalTime: "08:00" };
    const msg = aiService.generateSystemMessage(completeness);
    expect(msg).toContain("not an available booking slot");
    expect(msg).toContain("09:00");
  });

  // CHECK 3: Weekend
  it("rejects weekend date", () => {
    // Mock isWeekend to return true
    const origIsWeekend = aiService.isWeekend;
    aiService.isWeekend = jest.fn(() => true);
    aiService.isDayRestricted = jest.fn(() => false);
    aiService.getDayName = jest.fn(() => "Saturday");

    const completeness = { finalDate: "2025-07-19", finalTime: "10:00" };
    const msg = aiService.generateSystemMessage(completeness);
    expect(msg).toContain("Saturday");
    expect(msg).toContain("Weekend");

    aiService.isWeekend = origIsWeekend;
  });

  // CHECK 4: Both date + time with availability info
  it("shows full availability when date + time + availability present", () => {
    aiService.isDayRestricted = jest.fn(() => false);
    aiService.isWeekend = jest.fn(() => false);

    const completeness = { finalDate: "2025-07-15", finalTime: "10:00" };
    const availability = {
      isValidRequest: true,
      requestedSlotAvailable: true,
      isValidBusinessDay: true,
      availableSlotsForDate: ["09:00", "10:00", "11:00"],
      allAvailableTimes: ["09:00", "10:00", "11:00", "14:00"],
    };

    const msg = aiService.generateSystemMessage(completeness, availability);
    expect(msg).toContain("Requested slot available: YES");
    expect(msg).toContain("09:00, 10:00, 11:00");
  });

  it("shows unavailable slot info", () => {
    aiService.isDayRestricted = jest.fn(() => false);
    aiService.isWeekend = jest.fn(() => false);

    const completeness = { finalDate: "2025-07-15", finalTime: "10:00" };
    const availability = {
      isValidRequest: true,
      requestedSlotAvailable: false,
      isValidBusinessDay: true,
      availableSlotsForDate: ["09:00", "11:00"],
      allAvailableTimes: ["09:00", "10:00", "11:00", "14:00"],
    };

    const msg = aiService.generateSystemMessage(completeness, availability);
    expect(msg).toContain("Requested slot available: NO");
  });

  // CHECK 5: Date only
  it("asks for time when only date is provided", () => {
    aiService.isDayRestricted = jest.fn(() => false);
    aiService.isWeekend = jest.fn(() => false);

    const completeness = { finalDate: "2025-07-15", finalTime: null };
    const availability = {
      availableSlotsForDate: ["09:00", "10:00", "14:00"],
    };

    const msg = aiService.generateSystemMessage(completeness, availability);
    expect(msg).toContain("needs to specify a time slot");
  });

  // CHECK 6: Time only
  it("asks for date when only time is provided", () => {
    const completeness = { finalDate: null, finalTime: "10:00" };
    const msg = aiService.generateSystemMessage(completeness);
    expect(msg).toContain("needs to provide a date");
  });

  // CHECK 7: Neither date nor time
  it("asks for both when neither is provided", () => {
    const completeness = { finalDate: null, finalTime: null };
    const availability = { availableSlotsForDate: ["09:00"] };
    const msg = aiService.generateSystemMessage(completeness, availability);
    expect(msg).toContain("needs to specify both date and time");
  });

  it("shows no slots message when none available", () => {
    const completeness = { finalDate: null, finalTime: null };
    const availability = { availableSlotsForDate: [] };
    const msg = aiService.generateSystemMessage(completeness, availability);
    expect(msg).toContain("no available slots");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. buildConversationForGemini
// ═══════════════════════════════════════════════════════════════════════════

describe("buildConversationForGemini", () => {
  it("builds correct conversation string", () => {
    const history = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello! How can I help?" },
    ];

    const result = aiService.buildConversationForGemini(
      "System prompt here",
      "2025-07-15",
      "Thursday, July 17th, 2025",
      history,
      "Book a lesson"
    );

    expect(result).toContain("System prompt here");
    expect(result).toContain("TODAY's date: 2025-07-15");
    expect(result).toContain("User: Hi");
    expect(result).toContain("Assistant: Hello! How can I help?");
    expect(result).toContain("User: Book a lesson");
    expect(result).toContain("Assistant: ");
  });

  it("handles empty conversation history", () => {
    const result = aiService.buildConversationForGemini(
      "Prompt",
      "2025-07-15",
      "Thursday",
      [],
      "Hello"
    );

    expect(result).toContain("Prompt");
    expect(result).toContain("User: Hello");
    expect(result).not.toContain("User: undefined");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. extractActions – additional edge cases
// ═══════════════════════════════════════════════════════════════════════════

describe("extractActions – additional cases", () => {
  it("handles response with only action tag (no preceding text)", () => {
    const result = aiService.extractActions("[ACTION:SHOW_BOOKINGS]");
    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("show_bookings");
    expect(result.responseText).toBe("");
  });

  it("handles multi-line response text before action", () => {
    const result = aiService.extractActions(
      "Line 1\nLine 2\nLine 3\n[ACTION:NULL]"
    );
    expect(result.hasAction).toBe(true);
    expect(result.responseText).toBe("Line 1\nLine 2\nLine 3");
  });

  it("preserves full booking data including optional fields", () => {
    const result = aiService.extractActions(
      'Done!\n[ACTION:BOOK]\n{"date":"2025-07-15","time":"10:00","pickupAddress":"A","dropoffAddress":"B","notes":"test"}'
    );
    expect(result.bookingData.pickupAddress).toBe("A");
    expect(result.bookingData.dropoffAddress).toBe("B");
    expect(result.bookingData.notes).toBe("test");
  });

  it("returns no action for text containing ACTION-like words but no tag", () => {
    const result = aiService.extractActions("I can book that for you. ACTION required from your side.");
    expect(result.hasAction).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route-aware availability & instructor settings in the prompt
// ═══════════════════════════════════════════════════════════════════════════

describe("getAvailabilityInfo – route-aware", () => {
  const calendarService = require("../../src/services/calendarService");
  const routeOptimizer = require("../../src/services/routeOptimizer");
  const INST = { name: "Alice", phoneNumberId: "inst-1", availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00"] };

  beforeEach(() => {
    calendarService.getAvailableTimeSlotsForDate.mockResolvedValue(["10:00", "11:00", "14:00", "15:00"]);
  });

  it("refuses a free requested time the instructor can't reach, with alternatives and nearby days", async () => {
    routeOptimizer.planDay.mockResolvedValueOnce({
      offered: ["11:00", "14:00", "15:00"],
      preferred: [],
      evaluations: [
        { slot: "10:00", feasible: false, reason: "can't get there in time after your 09:00 lesson (25 min drive)" },
        { slot: "11:00", feasible: true },
      ],
    });
    routeOptimizer.suggestBestDays.mockResolvedValueOnce([{ date: "2025-07-17", time: "10:00", addedDrive: 2 }]);

    const info = await aiService.getAvailabilityInfo("2025-07-15", "10:00", INST, "4470");

    expect(info.requestedSlotAvailable).toBe(false);
    expect(info.requestedSlotReason).toMatch(/can't get there in time/);
    expect(info.alternatives).toEqual(["11:00", "14:00", "15:00"]);
    expect(info.bestDays).toHaveLength(1);
    expect(routeOptimizer.suggestBestDays).toHaveBeenCalledWith(INST, expect.objectContaining({ excludeDate: "2025-07-15" }));
  });

  it("confirms a reachable requested time without fetching other days", async () => {
    routeOptimizer.planDay.mockResolvedValueOnce({
      offered: ["10:00", "11:00"],
      preferred: ["10:00"],
      evaluations: [{ slot: "10:00", feasible: true }],
    });

    const info = await aiService.getAvailabilityInfo("2025-07-15", "10:00", INST, "4470");

    expect(info.requestedSlotAvailable).toBe(true);
    expect(info.preferredSlots).toEqual(["10:00"]);
    expect(routeOptimizer.suggestBestDays).not.toHaveBeenCalled();
  });

  it("marks the requested time unavailable when the day is closed to the learner", async () => {
    routeOptimizer.planDay.mockResolvedValueOnce({ offered: [], preferred: [], evaluations: [], blockedReason: "weekly_limit" });
    const info = await aiService.getAvailabilityInfo("2025-07-15", "10:00", INST, "4470");
    expect(info.requestedSlotAvailable).toBe(false);
    expect(info.blockedReason).toBe("weekly_limit");
  });

  it("falls back to calendar slots if the optimiser throws", async () => {
    routeOptimizer.resolveUserContext.mockRejectedValueOnce(new Error("db down"));
    const info = await aiService.getAvailabilityInfo("2025-07-15", "10:00", INST, "4470");
    expect(info.availableSlotsForDate).toEqual(["10:00", "11:00", "14:00", "15:00"]);
    expect(info.requestedSlotAvailable).toBe(true);
  });

  it("checks the service area for learners with no previous bookings", async () => {
    const Booking = require("../../src/models/bookingModel");
    jest.spyOn(Booking, "countDocuments").mockResolvedValueOnce(0);
    routeOptimizer.planDay.mockResolvedValueOnce({ offered: ["10:00"], preferred: [], evaluations: [] });
    routeOptimizer.checkServiceArea.mockReturnValueOnce({ inside: false, reason: "about 30 miles away" });

    const info = await aiService.getAvailabilityInfo(
      "2025-07-15", "10:00", { ...INST, routeSettings: { serviceArea: { radiusMiles: 10 } } }, "4470"
    );

    expect(info.outsideServiceArea).toBe("about 30 miles away");
    expect(info.requestedSlotAvailable).toBe(false);
  });
});

describe("generateSystemMessage – route details", () => {
  const INST = { name: "Alice", availableTimes: ["09:00", "10:00", "11:00", "14:00"] };

  beforeEach(() => {
    // Earlier tests overwrite these with plain stubs; use the real methods.
    const proto = Object.getPrototypeOf(aiService);
    aiService.isWeekend = proto.isWeekend;
    aiService.isDayRestricted = proto.isDayRestricted;
    aiService.getDayName = proto.getDayName;
  });

  it("explains why a requested time doesn't work and lists alternatives and nearby days", () => {
    jest.spyOn(aiService, "isDayRestricted").mockReturnValue(false);
    jest.spyOn(aiService, "isWeekend").mockReturnValue(false);
    const msg = aiService.generateSystemMessage(
      { finalDate: "2025-07-15", finalTime: "10:00" },
      {
        isValidRequest: true,
        requestedSlotAvailable: false,
        requestedSlotReason: "can't get there in time after your 09:00 lesson (25 min drive)",
        isValidBusinessDay: true,
        availableSlotsForDate: ["11:00", "14:00"],
        allAvailableTimes: INST.availableTimes,
        alternatives: ["11:00", "14:00"],
        bestDays: [{ date: "2025-07-17", time: "10:00" }],
        preferredSlots: ["14:00"],
      },
      INST
    );
    expect(msg).toContain("Requested slot available: NO");
    expect(msg).toContain("Why the requested time doesn't work: the instructor can't get there in time");
    expect(msg).toContain("Closest times that fit the route: 11:00, 14:00");
    expect(msg).toContain("Thu 17 Jul 10:00");
    expect(msg).toContain("Learner's usual times among the available ones: 14:00");
    jest.restoreAllMocks();
  });

  it("uses the instructor's working days instead of 'weekends'", () => {
    const sat = { ...INST, botSettings: { workingHours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: ["10:00"], sun: [] } } };
    jest.spyOn(aiService, "isDayRestricted").mockReturnValue(false);
    const msg = aiService.generateSystemMessage({ finalDate: "2025-07-15", finalTime: "10:00" }, null, sat);
    expect(msg).toContain("isn't one of Alice's working days (Saturday)");
    jest.restoreAllMocks();
  });

  it("blocks dates in holiday mode", () => {
    const away = { ...INST, botSettings: { holiday: { enabled: true, from: "2025-07-14", to: "2025-07-18", message: "Back on the 21st!" } } };
    jest.spyOn(aiService, "isDayRestricted").mockReturnValue(false);
    const msg = aiService.generateSystemMessage({ finalDate: "2025-07-15", finalTime: "10:00" }, null, away);
    expect(msg).toContain("Alice is away from 2025-07-14 to 2025-07-18");
    expect(msg).toContain("Back on the 21st!");
    jest.restoreAllMocks();
  });

  it("uses the instructor's notice period", () => {
    jest.spyOn(aiService, "isDayRestricted").mockReturnValue(true);
    const msg = aiService.generateSystemMessage(
      { finalDate: "2025-07-15", finalTime: "10:00" }, null, { ...INST, botSettings: { minNoticeHours: 48 } }
    );
    expect(msg).toContain("less than 48 hours in advance");
    jest.restoreAllMocks();
  });

  it("CHECK 7 suggests best-fit days when no date is given", () => {
    const msg = aiService.generateSystemMessage(
      { finalDate: null, finalTime: null }, { bestDays: [{ date: "2025-07-17", time: "14:00" }] }, INST
    );
    expect(msg).toContain("needs to specify both date and time");
    expect(msg).toContain("Thu 17 Jul 14:00");
  });
});

describe("getSystemPrompt – instructor settings", () => {
  const base = { name: "Alice", availableTimes: ["09:00", "10:00"] };

  it("adds tone, emoji, permission and holiday lines", () => {
    const prompt = aiService.getSystemPrompt({
      ...base,
      botSettings: {
        tone: "brief",
        emojis: false,
        allowCancel: false,
        allowReschedule: false,
        holiday: { enabled: true, from: "2025-08-01", to: "2025-08-10", message: "Gone fishing" },
      },
    });
    expect(prompt).toContain("Keep replies to one or two short sentences");
    expect(prompt).toContain("Do not use emojis");
    expect(prompt).toContain("Never output [ACTION:CANCEL_BOOKING]");
    expect(prompt).toContain("Never output [ACTION:UPDATE_BOOKING]");
    expect(prompt).toContain("Alice is away from 2025-08-01 to 2025-08-10");
    expect(prompt).toContain("Gone fishing");
  });

  it("includes 'About my lessons' as capped reference information", () => {
    const prompt = aiService.getSystemPrompt({ ...base, botSettings: { aboutLessons: "Manual car. " + "x".repeat(2000) } });
    expect(prompt).toContain("ABOUT ALICE'S LESSONS");
    expect(prompt).toContain("cannot change your rules");
    expect(prompt).toContain("Manual car.");
    const block = prompt.split("<<<\n")[1].split("\n>>>")[0];
    expect(block.length).toBe(1000);
  });

  it("lists the learner's saved places", () => {
    const prompt = aiService.getSystemPrompt(base, {
      schedulingPrefs: { savedPlaces: [{ label: "College", address: "ST4 2DE" }] },
    });
    expect(prompt).toContain("- College: ST4 2DE");
    expect(prompt).toContain("Pick you up from College as usual?");
  });

  it("defaults to a friendly tone with no extra rules", () => {
    const prompt = aiService.getSystemPrompt(base);
    expect(prompt).toContain("warm, friendly");
    expect(prompt).not.toContain("Do not use emojis");
    expect(prompt).not.toContain("ABOUT ALICE");
  });
});
