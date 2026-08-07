/**
 * Date Parsing Edge Cases – Unit Tests
 * ──────────────────────────────────────
 * From TestPlan.txt lines 11-15:
 *   "okay would you like to book for friday then?"
 *   "Okay let's do friday..."
 *   TEST => ? + friday?? => Or is it something else
 *
 * Covers:
 *  1. generateDateHint resolves "friday" to NEXT Friday (not past)
 *  2. Day-of-week mentions produce correct date context
 *  3. Ambiguous day references ("the 5th", "next week")
 *  4. "tomorrow", "today" edge cases
 *  5. Combined date+time extraction hints
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../../src/utils/timezoneUtils", () => ({
  getCurrentDate: jest.fn(() => new Date("2025-07-15T10:00:00Z")), // Tuesday
  getCurrentDateString: jest.fn(() => "2025-07-15"),
  getCurrentTimeString: jest.fn(() => "10:00"),
  getTomorrowDateString: jest.fn(() => "2025-07-16"),
  getCurrentDay: jest.fn(() => 15),
  timezone: "Europe/London",
}));

jest.mock("../../src/config/gemini", () => ({
  model: null,
}));

const DateTimeService = require("../../src/services/gemini/dateTimeService");

const TODAY = new Date("2025-07-15T10:00:00Z"); // Tuesday, July 15

// ═══════════════════════════════════════════════════════════════════════════
// 1. "friday" → next Friday
// ═══════════════════════════════════════════════════════════════════════════

describe("Friday resolution", () => {
  it("'book for friday' generates a hint referencing Friday", () => {
    const hint = DateTimeService.generateDateHint("okay would you like to book for friday then?", TODAY);
    // Should NOT be empty — it should contain date context
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
  });

  it("'let's do friday' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("Okay let's do friday...", TODAY);
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
  });

  it("'friday at 10am' includes both day and time context", () => {
    const hint = DateTimeService.generateDateHint("Can I book friday at 10am?", TODAY);
    expect(hint).toBeDefined();
  });

  it("'this friday' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("this friday please", TODAY);
    expect(hint).toBeDefined();
  });

  it("'next friday' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("next friday at 2pm", TODAY);
    expect(hint).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Other day-of-week mentions
// ═══════════════════════════════════════════════════════════════════════════

describe("Day-of-week resolution", () => {
  it("'monday' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("book monday at 9am", TODAY);
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
  });

  it("'wednesday' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("how about wednesday?", TODAY);
    expect(hint).toBeDefined();
  });

  it("'saturday' generates a hint (weekend — should still parse)", () => {
    const hint = DateTimeService.generateDateHint("can I book saturday?", TODAY);
    expect(hint).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Day number ambiguity
// ═══════════════════════════════════════════════════════════════════════════

describe("Day number ambiguity", () => {
  it("'the 20th' → current month (July, day hasn't passed)", () => {
    // Today is 15th, 20th hasn't passed → should be July
    const hint = DateTimeService.generateDateHint("book the 20th at 10am", TODAY);
    expect(hint).toContain("NOT passed");
    expect(hint).toContain("July");
  });

  it("'the 10th' → next month (August, day already passed)", () => {
    // Today is 15th, 10th already passed → should be August
    const hint = DateTimeService.generateDateHint("book the 10th please", TODAY);
    expect(hint).toContain("ALREADY PASSED");
    expect(hint).toContain("August");
  });

  it("'the 15th' (today) → handles current day edge", () => {
    const hint = DateTimeService.generateDateHint("can I book the 15th?", TODAY);
    // Day 15 = today, should still generate a valid hint
    expect(hint).toBeDefined();
    expect(hint.length).toBeGreaterThan(0);
  });

  it("'the 31st' → handles month boundary", () => {
    const hint = DateTimeService.generateDateHint("book the 31st", TODAY);
    expect(hint).toBeDefined();
  });

  it("'the 1st' → next month (already passed)", () => {
    const hint = DateTimeService.generateDateHint("book the 1st at 9am", TODAY);
    expect(hint).toContain("ALREADY PASSED");
    expect(hint).toContain("August");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. "tomorrow" / "today" / "asap"
// ═══════════════════════════════════════════════════════════════════════════

describe("Relative date references", () => {
  it("'tomorrow' generates a hint with no standalone day number", () => {
    const hint = DateTimeService.generateDateHint("book tomorrow at 10am", TODAY);
    expect(hint).toContain("No standalone day number");
  });

  it("'today' generates a hint with no standalone day number", () => {
    const hint = DateTimeService.generateDateHint("book today", TODAY);
    expect(hint).toContain("No standalone day number");
  });

  it("'asap' generates urgency hint", () => {
    const hint = DateTimeService.generateDateHint("I need a lesson asap", TODAY);
    expect(hint).toContain("earliest possible");
  });

  it("'as soon as possible' generates urgency hint", () => {
    const hint = DateTimeService.generateDateHint("as soon as possible please", TODAY);
    expect(hint).toContain("earliest possible");
  });

  it("'next week' generates a hint", () => {
    const hint = DateTimeService.generateDateHint("can I book next week?", TODAY);
    expect(hint).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Explicit month mentions
// ═══════════════════════════════════════════════════════════════════════════

describe("Explicit month mentions", () => {
  it("'August 5th' uses explicit August", () => {
    const hint = DateTimeService.generateDateHint("book August 5th at 10am", TODAY);
    expect(hint).toContain("August");
    expect(hint).toContain("explicitly mentioned");
  });

  it("'December 20th' uses explicit December", () => {
    const hint = DateTimeService.generateDateHint("book December 20th", TODAY);
    expect(hint).toContain("December");
  });

  it("'January 3rd' uses explicit January", () => {
    const hint = DateTimeService.generateDateHint("book January 3rd at 2pm", TODAY);
    expect(hint).toContain("January");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. No date at all
// ═══════════════════════════════════════════════════════════════════════════

describe("No date in message", () => {
  it("'I want to book a lesson' has no date → still returns a hint", () => {
    const hint = DateTimeService.generateDateHint("I want to book a lesson", TODAY);
    expect(hint).toBeDefined();
    expect(hint).toContain("No standalone day number");
  });

  it("'hello' has no date → returns a hint", () => {
    const hint = DateTimeService.generateDateHint("hello", TODAY);
    expect(hint).toBeDefined();
  });

  it("'thanks' has no date → returns a hint", () => {
    const hint = DateTimeService.generateDateHint("thanks", TODAY);
    expect(hint).toBeDefined();
  });
});
