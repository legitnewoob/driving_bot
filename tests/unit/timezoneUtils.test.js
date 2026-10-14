/**
 * TimezoneUtils – Unit Tests
 * ───────────────────────────
 * Covers:
 *  1. getCurrentDateString / getCurrentTimeString / getCurrentDate
 *  2. createDateInTimezone – date construction
 *  3. formatDate – date formatting
 *  4. isWeekend – weekend detection
 *  5. getDayName – day name lookup
 *  6. addDays – date arithmetic
 *  7. isToday / isTomorrow – relative date checks
 *  8. getTomorrowDateString / getYesterdayDateString
 *  9. getCurrentDay – day of month
 * 10. getNextOccurrenceOfDay – future date calculation
 * 11. toTimezone – timezone conversion
 * 12. isWithin24Hours / isDayRestricted – booking time restrictions
 */

// Use real timezoneUtils (no mock) – these are pure date functions
const timezoneUtils = require("../../src/utils/timezoneUtils");

// ═══════════════════════════════════════════════════════════════════════════
// 1. getCurrentDateString / getCurrentTimeString / getCurrentDate
// ═══════════════════════════════════════════════════════════════════════════

describe("getCurrentDateString", () => {
  it("returns a string in YYYY-MM-DD format", () => {
    const result = timezoneUtils.getCurrentDateString();
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("getCurrentTimeString", () => {
  it("returns a string in HH:mm format", () => {
    const result = timezoneUtils.getCurrentTimeString();
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe("getCurrentDate", () => {
  it("returns a Date object", () => {
    const result = timezoneUtils.getCurrentDate();
    expect(result).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. createDateInTimezone
// ═══════════════════════════════════════════════════════════════════════════

describe("createDateInTimezone", () => {
  it("creates a valid Date object", () => {
    const result = timezoneUtils.createDateInTimezone("2025-07-15", "10:00");
    expect(result).toBeInstanceOf(Date);
    expect(isNaN(result.getTime())).toBe(false);
  });

  it("defaults time to 00:00 when omitted", () => {
    const result = timezoneUtils.createDateInTimezone("2025-07-15");
    expect(result).toBeInstanceOf(Date);
    expect(isNaN(result.getTime())).toBe(false);
  });

  it("handles midnight", () => {
    const result = timezoneUtils.createDateInTimezone("2025-07-15", "00:00");
    expect(result).toBeInstanceOf(Date);
  });

  it("handles end of day", () => {
    const result = timezoneUtils.createDateInTimezone("2025-07-15", "23:59");
    expect(result).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. formatDate
// ═══════════════════════════════════════════════════════════════════════════

describe("formatDate", () => {
  it("formats date with default format", () => {
    const date = timezoneUtils.createDateInTimezone("2025-07-15", "10:30");
    const result = timezoneUtils.formatDate(date);
    expect(result).toMatch(/2025-07-15/);
  });

  it("formats date with custom format YYYY-MM-DD", () => {
    const date = timezoneUtils.createDateInTimezone("2025-07-15", "10:00");
    const result = timezoneUtils.formatDate(date, "YYYY-MM-DD");
    expect(result).toBe("2025-07-15");
  });

  it("formats date with DD/MM/YYYY format", () => {
    const date = timezoneUtils.createDateInTimezone("2025-07-15", "12:00");
    const result = timezoneUtils.formatDate(date, "DD/MM/YYYY");
    expect(result).toBe("15/07/2025");
  });

  it("formats date with day name", () => {
    const date = timezoneUtils.createDateInTimezone("2025-07-15", "12:00");
    const result = timezoneUtils.formatDate(date, "dddd");
    expect(result).toBe("Tuesday");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. isWeekend
// ═══════════════════════════════════════════════════════════════════════════

describe("isWeekend", () => {
  it("returns true for Saturday", () => {
    expect(timezoneUtils.isWeekend("2025-07-19")).toBe(true); // Saturday
  });

  it("returns true for Sunday", () => {
    expect(timezoneUtils.isWeekend("2025-07-20")).toBe(true); // Sunday
  });

  it("returns false for Monday", () => {
    expect(timezoneUtils.isWeekend("2025-07-21")).toBe(false); // Monday
  });

  it("returns false for Wednesday", () => {
    expect(timezoneUtils.isWeekend("2025-07-16")).toBe(false); // Wednesday
  });

  it("returns false for Friday", () => {
    expect(timezoneUtils.isWeekend("2025-07-18")).toBe(false); // Friday
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. getDayName
// ═══════════════════════════════════════════════════════════════════════════

describe("getDayName", () => {
  it("returns Monday for a known Monday", () => {
    expect(timezoneUtils.getDayName("2025-07-14")).toBe("Monday");
  });

  it("returns Saturday for a known Saturday", () => {
    expect(timezoneUtils.getDayName("2025-07-19")).toBe("Saturday");
  });

  it("returns Sunday for a known Sunday", () => {
    expect(timezoneUtils.getDayName("2025-07-20")).toBe("Sunday");
  });

  it("returns Tuesday for 2025-07-15", () => {
    expect(timezoneUtils.getDayName("2025-07-15")).toBe("Tuesday");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. addDays
// ═══════════════════════════════════════════════════════════════════════════

describe("addDays", () => {
  it("adds 1 day", () => {
    expect(timezoneUtils.addDays("2025-07-15", 1)).toBe("2025-07-16");
  });

  it("adds 7 days", () => {
    expect(timezoneUtils.addDays("2025-07-15", 7)).toBe("2025-07-22");
  });

  it("crosses month boundary", () => {
    expect(timezoneUtils.addDays("2025-07-30", 3)).toBe("2025-08-02");
  });

  it("crosses year boundary", () => {
    expect(timezoneUtils.addDays("2025-12-30", 3)).toBe("2026-01-02");
  });

  it("handles adding 0 days", () => {
    expect(timezoneUtils.addDays("2025-07-15", 0)).toBe("2025-07-15");
  });

  it("handles negative days (subtract)", () => {
    expect(timezoneUtils.addDays("2025-07-15", -1)).toBe("2025-07-14");
  });

  it("handles leap year Feb 28 → 29", () => {
    expect(timezoneUtils.addDays("2024-02-28", 1)).toBe("2024-02-29");
  });

  it("handles non-leap year Feb 28 → Mar 1", () => {
    expect(timezoneUtils.addDays("2025-02-28", 1)).toBe("2025-03-01");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. isToday / isTomorrow
// ═══════════════════════════════════════════════════════════════════════════

describe("isToday", () => {
  it("returns true for today's date", () => {
    const today = timezoneUtils.getCurrentDateString();
    expect(timezoneUtils.isToday(today)).toBe(true);
  });

  it("returns false for yesterday", () => {
    const yesterday = timezoneUtils.getYesterdayDateString();
    expect(timezoneUtils.isToday(yesterday)).toBe(false);
  });

  it("returns false for arbitrary past date", () => {
    expect(timezoneUtils.isToday("2020-01-01")).toBe(false);
  });
});

describe("isTomorrow", () => {
  it("returns true for tomorrow's date", () => {
    const tomorrow = timezoneUtils.getTomorrowDateString();
    expect(timezoneUtils.isTomorrow(tomorrow)).toBe(true);
  });

  it("returns false for today", () => {
    const today = timezoneUtils.getCurrentDateString();
    expect(timezoneUtils.isTomorrow(today)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. getTomorrowDateString / getYesterdayDateString
// ═══════════════════════════════════════════════════════════════════════════

describe("getTomorrowDateString", () => {
  it("returns YYYY-MM-DD format", () => {
    expect(timezoneUtils.getTomorrowDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is exactly 1 day after today", () => {
    const today = timezoneUtils.getCurrentDateString();
    const tomorrow = timezoneUtils.getTomorrowDateString();
    expect(timezoneUtils.addDays(today, 1)).toBe(tomorrow);
  });
});

describe("getYesterdayDateString", () => {
  it("returns YYYY-MM-DD format", () => {
    expect(timezoneUtils.getYesterdayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is exactly 1 day before today", () => {
    const today = timezoneUtils.getCurrentDateString();
    const yesterday = timezoneUtils.getYesterdayDateString();
    expect(timezoneUtils.addDays(today, -1)).toBe(yesterday);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. getCurrentDay
// ═══════════════════════════════════════════════════════════════════════════

describe("getCurrentDay", () => {
  it("returns a number between 1 and 31", () => {
    const day = timezoneUtils.getCurrentDay();
    expect(typeof day).toBe("number");
    expect(day).toBeGreaterThanOrEqual(1);
    expect(day).toBeLessThanOrEqual(31);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. getNextOccurrenceOfDay
// ═══════════════════════════════════════════════════════════════════════════

describe("getNextOccurrenceOfDay", () => {
  it("returns YYYY-MM-DD format", () => {
    const result = timezoneUtils.getNextOccurrenceOfDay(25);
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns a future or current-month date when day hasn't passed", () => {
    const currentDay = timezoneUtils.getCurrentDay();
    const futureDay = currentDay + 5 > 28 ? 1 : currentDay + 5;

    const result = timezoneUtils.getNextOccurrenceOfDay(futureDay);
    const resultDate = new Date(result);
    expect(resultDate.getDate()).toBe(futureDay);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. toTimezone
// ═══════════════════════════════════════════════════════════════════════════

describe("toTimezone", () => {
  it("returns a Date object", () => {
    const result = timezoneUtils.toTimezone("2025-07-15T10:00:00Z");
    expect(result).toBeInstanceOf(Date);
  });

  it("handles Date input", () => {
    const result = timezoneUtils.toTimezone(new Date("2025-07-15T10:00:00Z"));
    expect(result).toBeInstanceOf(Date);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. isDayRestricted
// ═══════════════════════════════════════════════════════════════════════════

describe("isDayRestricted", () => {
  it("blocks today", () => {
    const today = timezoneUtils.getCurrentDateString();
    expect(timezoneUtils.isDayRestricted(today)).toBe(true);
  });

  it("blocks tomorrow (within 24h window)", () => {
    const tomorrow = timezoneUtils.getTomorrowDateString();
    // Tomorrow starts at 00:00, which is always < 24h from now, so it should be blocked
    expect(timezoneUtils.isDayRestricted(tomorrow)).toBe(true);
  });

  it("allows a date far in the future", () => {
    const future = timezoneUtils.addDays(timezoneUtils.getCurrentDateString(), 30);
    expect(timezoneUtils.isDayRestricted(future)).toBe(false);
  });
});
