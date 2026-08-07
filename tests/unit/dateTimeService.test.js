/**
 * DateTimeService – Unit Tests
 * ─────────────────────────────
 * Covers the static helper methods on DateTimeService:
 *
 *  1. isValidInput – input validation
 *  2. isValidDateString / isValidTimeString – format validators
 *  3. getDefaultResult – default shape
 *  4. normalizeResult – normalization
 *  5. hasRequiredJsonStructure – JSON structure check
 *  6. parseGeminiResponse – JSON parsing
 *  7. validateExtractedData – full validation with fixes
 *  8. canProvideDefault / getDefaultForProperty – defaults
 *  9. isHighConfidenceResult – confidence check
 * 10. isValidGeminiResponse – Gemini response shape check
 * 11. generateDateHint – date hint generation
 * 12. fallbackExtraction – fallback logic
 * 13. buildGeminiPrompt – prompt building
 */

jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock timezoneUtils for deterministic tests
jest.mock("../../src/utils/timezoneUtils", () => ({
  getCurrentDate: jest.fn(() => new Date("2025-07-15T10:00:00Z")),
  getCurrentDateString: jest.fn(() => "2025-07-15"),
  getCurrentTimeString: jest.fn(() => "10:00"),
  getTomorrowDateString: jest.fn(() => "2025-07-16"),
  getCurrentDay: jest.fn(() => 15),
  timezone: "Europe/London",
}));

// Mock gemini config so require doesn't fail
jest.mock("../../src/config/gemini", () => ({
  model: null,
}));

const DateTimeService = require("../../src/services/gemini/dateTimeService");

// ═══════════════════════════════════════════════════════════════════════════
// 1. isValidInput
// ═══════════════════════════════════════════════════════════════════════════

describe("isValidInput", () => {
  it("returns true for a normal string", () => {
    expect(DateTimeService.isValidInput("book tomorrow at 10am")).toBe(true);
  });

  it("returns false for null", () => {
    expect(DateTimeService.isValidInput(null)).toBeFalsy();
  });

  it("returns false for undefined", () => {
    expect(DateTimeService.isValidInput(undefined)).toBeFalsy();
  });

  it("returns false for empty string", () => {
    expect(DateTimeService.isValidInput("")).toBeFalsy();
  });

  it("returns false for whitespace-only string", () => {
    expect(DateTimeService.isValidInput("   ")).toBe(false);
  });

  it("returns false for a number", () => {
    expect(DateTimeService.isValidInput(123)).toBe(false);
  });

  it("returns false for an object", () => {
    expect(DateTimeService.isValidInput({})).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. isValidDateString / isValidTimeString
// ═══════════════════════════════════════════════════════════════════════════

describe("isValidDateString", () => {
  it("accepts valid YYYY-MM-DD date", () => {
    expect(DateTimeService.isValidDateString("2025-07-15")).toBe(true);
  });

  it("accepts leap day", () => {
    expect(DateTimeService.isValidDateString("2024-02-29")).toBe(true);
  });

  it("rejects DD/MM/YYYY format", () => {
    expect(DateTimeService.isValidDateString("15/07/2025")).toBe(false);
  });

  it("rejects MM-DD-YYYY format", () => {
    expect(DateTimeService.isValidDateString("07-15-2025")).toBe(false);
  });

  it("rejects random string", () => {
    expect(DateTimeService.isValidDateString("not-a-date")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(DateTimeService.isValidDateString("")).toBe(false);
  });

  it("rejects invalid date like 2025-13-01", () => {
    expect(DateTimeService.isValidDateString("2025-13-01")).toBe(false);
  });
});

describe("isValidTimeString", () => {
  it("accepts HH:MM format (09:00)", () => {
    expect(DateTimeService.isValidTimeString("09:00")).toBe(true);
  });

  it("accepts midnight (00:00)", () => {
    expect(DateTimeService.isValidTimeString("00:00")).toBe(true);
  });

  it("accepts 23:59", () => {
    expect(DateTimeService.isValidTimeString("23:59")).toBe(true);
  });

  it("accepts single digit hour (9:05)", () => {
    expect(DateTimeService.isValidTimeString("9:05")).toBe(true);
  });

  it("rejects 25:00", () => {
    expect(DateTimeService.isValidTimeString("25:00")).toBe(false);
  });

  it("rejects 12:60", () => {
    expect(DateTimeService.isValidTimeString("12:60")).toBe(false);
  });

  it("rejects 12pm format", () => {
    expect(DateTimeService.isValidTimeString("12pm")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(DateTimeService.isValidTimeString("")).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. getDefaultResult
// ═══════════════════════════════════════════════════════════════════════════

describe("getDefaultResult", () => {
  it("returns correct default shape", () => {
    const result = DateTimeService.getDefaultResult();

    expect(result).toEqual({
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. normalizeResult
// ═══════════════════════════════════════════════════════════════════════════

describe("normalizeResult", () => {
  it("normalizes a valid result", () => {
    const input = {
      hasDateTime: true,
      date: "2025-07-15",
      time: "10:00",
      confidence: "high",
      explicitDate: true,
      explicitTime: true,
    };

    const result = DateTimeService.normalizeResult(input);

    expect(result.hasDateTime).toBe(true);
    expect(result.date).toBe("2025-07-15");
    expect(result.time).toBe("10:00");
    expect(result.confidence).toBe("high");
    expect(result.explicitDate).toBe(true);
    expect(result.explicitTime).toBe(true);
  });

  it("converts null date/time correctly", () => {
    const input = {
      hasDateTime: false,
      date: null,
      time: null,
      confidence: "low",
      explicitDate: false,
      explicitTime: false,
    };

    const result = DateTimeService.normalizeResult(input);

    expect(result.date).toBeNull();
    expect(result.time).toBeNull();
  });

  it("coerces hasDateTime to boolean", () => {
    const input = {
      hasDateTime: 1,
      date: null,
      time: null,
      confidence: null,
      explicitDate: 0,
      explicitTime: 0,
    };

    const result = DateTimeService.normalizeResult(input);

    expect(result.hasDateTime).toBe(true);
    expect(result.explicitDate).toBe(false);
    expect(result.explicitTime).toBe(false);
  });

  it("defaults confidence to low when missing", () => {
    const result = DateTimeService.normalizeResult({
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    });

    expect(result.confidence).toBe("low");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. hasRequiredJsonStructure
// ═══════════════════════════════════════════════════════════════════════════

describe("hasRequiredJsonStructure", () => {
  it("returns true when hasDateTime is present", () => {
    expect(DateTimeService.hasRequiredJsonStructure({ hasDateTime: true })).toBe(true);
  });

  it("returns false for null", () => {
    expect(DateTimeService.hasRequiredJsonStructure(null)).toBe(false);
  });

  it("returns false for non-object", () => {
    expect(DateTimeService.hasRequiredJsonStructure("string")).toBe(false);
  });

  it("returns false when hasDateTime key is missing", () => {
    expect(DateTimeService.hasRequiredJsonStructure({ date: "2025-07-15" })).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. parseGeminiResponse
// ═══════════════════════════════════════════════════════════════════════════

describe("parseGeminiResponse", () => {
  it("parses valid JSON with hasDateTime", () => {
    const json = JSON.stringify({
      hasDateTime: true,
      date: "2025-07-15",
      time: "10:00",
      confidence: "high",
      reasoning: "test",
      explicitDate: true,
      explicitTime: true,
    });

    const result = DateTimeService.parseGeminiResponse(json);

    expect(result).not.toBeNull();
    expect(result.hasDateTime).toBe(true);
    expect(result.date).toBe("2025-07-15");
  });

  it("returns null for invalid JSON", () => {
    expect(DateTimeService.parseGeminiResponse("{invalid}")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(DateTimeService.parseGeminiResponse(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(DateTimeService.parseGeminiResponse("")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(DateTimeService.parseGeminiResponse(123)).toBeNull();
  });

  it("returns null for valid JSON missing hasDateTime", () => {
    const json = JSON.stringify({ date: "2025-07-15", time: "10:00" });
    expect(DateTimeService.parseGeminiResponse(json)).toBeNull();
  });

  it("trims whitespace before parsing", () => {
    const json = `  ${JSON.stringify({ hasDateTime: false, date: null, time: null })}  `;
    const result = DateTimeService.parseGeminiResponse(json);
    expect(result).not.toBeNull();
    expect(result.hasDateTime).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. validateExtractedData
// ═══════════════════════════════════════════════════════════════════════════

describe("validateExtractedData", () => {
  const validData = () => ({
    hasDateTime: true,
    date: "2025-07-15",
    time: "10:00",
    confidence: "high",
    reasoning: "test",
    explicitDate: true,
    explicitTime: true,
  });

  it("returns true for fully valid data", () => {
    expect(DateTimeService.validateExtractedData(validData())).toBe(true);
  });

  it("returns true with null date (valid)", () => {
    const data = validData();
    data.date = null;
    expect(DateTimeService.validateExtractedData(data)).toBe(true);
  });

  it("returns true with null time (valid)", () => {
    const data = validData();
    data.time = null;
    expect(DateTimeService.validateExtractedData(data)).toBe(true);
  });

  it("returns false for null input", () => {
    expect(DateTimeService.validateExtractedData(null)).toBe(false);
  });

  it("returns false for non-object input", () => {
    expect(DateTimeService.validateExtractedData("string")).toBe(false);
  });

  it("returns false for invalid date format", () => {
    const data = validData();
    data.date = "15/07/2025";
    expect(DateTimeService.validateExtractedData(data)).toBe(false);
  });

  it("returns false for invalid time format", () => {
    const data = validData();
    data.time = "25:00";
    expect(DateTimeService.validateExtractedData(data)).toBe(false);
  });

  it("fixes invalid confidence to low", () => {
    const data = validData();
    data.confidence = "invalid";
    DateTimeService.validateExtractedData(data);
    expect(data.confidence).toBe("low");
  });

  it("fixes non-boolean hasDateTime", () => {
    const data = validData();
    data.hasDateTime = "yes";
    DateTimeService.validateExtractedData(data);
    expect(data.hasDateTime).toBe(true);
  });

  it("provides defaults for missing optional fields", () => {
    const data = {
      hasDateTime: true,
      date: "2025-07-15",
      time: "10:00",
    };
    // confidence, explicitDate, explicitTime are missing but have defaults
    const result = DateTimeService.validateExtractedData(data);
    expect(result).toBe(true);
    expect(data.confidence).toBe("low");
    expect(data.explicitDate).toBe(false);
    expect(data.explicitTime).toBe(false);
  });

  it("returns false when critical hasDateTime is missing", () => {
    const data = {
      date: "2025-07-15",
      time: "10:00",
      confidence: "high",
      explicitDate: true,
      explicitTime: true,
    };
    expect(DateTimeService.validateExtractedData(data)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. canProvideDefault / getDefaultForProperty
// ═══════════════════════════════════════════════════════════════════════════

describe("canProvideDefault", () => {
  it("returns true for confidence", () => {
    expect(DateTimeService.canProvideDefault("confidence", {})).toBe(true);
  });

  it("returns true for explicitDate", () => {
    expect(DateTimeService.canProvideDefault("explicitDate", {})).toBe(true);
  });

  it("returns true for explicitTime", () => {
    expect(DateTimeService.canProvideDefault("explicitTime", {})).toBe(true);
  });

  it("returns false for hasDateTime (critical)", () => {
    expect(DateTimeService.canProvideDefault("hasDateTime", {})).toBe(false);
  });

  it("returns false for date", () => {
    expect(DateTimeService.canProvideDefault("date", {})).toBe(false);
  });

  it("returns false for time", () => {
    expect(DateTimeService.canProvideDefault("time", {})).toBe(false);
  });
});

describe("getDefaultForProperty", () => {
  it("returns low for confidence", () => {
    expect(DateTimeService.getDefaultForProperty("confidence")).toBe("low");
  });

  it("returns false for explicitDate", () => {
    expect(DateTimeService.getDefaultForProperty("explicitDate")).toBe(false);
  });

  it("returns false for explicitTime", () => {
    expect(DateTimeService.getDefaultForProperty("explicitTime")).toBe(false);
  });

  it("returns undefined for unknown property", () => {
    expect(DateTimeService.getDefaultForProperty("unknownProp")).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. isHighConfidenceResult
// ═══════════════════════════════════════════════════════════════════════════

describe("isHighConfidenceResult", () => {
  it("returns true for high confidence with hasDateTime", () => {
    expect(
      DateTimeService.isHighConfidenceResult({
        hasDateTime: true,
        confidence: "high",
      })
    ).toBe(true);
  });

  it("returns false for medium confidence", () => {
    expect(
      DateTimeService.isHighConfidenceResult({
        hasDateTime: true,
        confidence: "medium",
      })
    ).toBe(false);
  });

  it("returns false when hasDateTime is false", () => {
    expect(
      DateTimeService.isHighConfidenceResult({
        hasDateTime: false,
        confidence: "high",
      })
    ).toBe(false);
  });

  it("returns false for null", () => {
    expect(DateTimeService.isHighConfidenceResult(null)).toBeFalsy();
  });

  it("returns false for undefined", () => {
    expect(DateTimeService.isHighConfidenceResult(undefined)).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. isValidGeminiResponse
// ═══════════════════════════════════════════════════════════════════════════

describe("isValidGeminiResponse", () => {
  it("returns true for valid Gemini response object", () => {
    const result = { response: { text: jest.fn() } };
    expect(DateTimeService.isValidGeminiResponse(result)).toBeTruthy();
  });

  it("returns false when response is missing", () => {
    expect(DateTimeService.isValidGeminiResponse({})).toBeFalsy();
  });

  it("returns false when text is missing from response", () => {
    expect(DateTimeService.isValidGeminiResponse({ response: {} })).toBeFalsy();
  });

  it("returns false for null", () => {
    expect(DateTimeService.isValidGeminiResponse(null)).toBeFalsy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. generateDateHint
// ═══════════════════════════════════════════════════════════════════════════

describe("generateDateHint", () => {
  const today = new Date("2025-07-15T10:00:00Z");

  it("returns urgency hint for 'asap'", () => {
    const hint = DateTimeService.generateDateHint("I need a lesson asap", today);
    expect(hint).toContain("earliest possible");
    expect(hint).toContain("hasDateTime");
  });

  it("returns urgency hint for 'as soon as possible'", () => {
    const hint = DateTimeService.generateDateHint("as soon as possible please", today);
    expect(hint).toContain("earliest possible");
  });

  it("returns no-day-number hint when no day found", () => {
    const hint = DateTimeService.generateDateHint("book tomorrow", today);
    expect(hint).toContain("No standalone day number");
  });

  it("uses current month when day has NOT passed", () => {
    // Today is 15th, requesting 20th → current month
    const hint = DateTimeService.generateDateHint("book the 20th at 10am", today);
    expect(hint).toContain("NOT passed");
    expect(hint).toContain("July");
  });

  it("uses next month when day has ALREADY passed", () => {
    // Today is 15th, requesting 5th → next month
    const hint = DateTimeService.generateDateHint("book the 5th please", today);
    expect(hint).toContain("ALREADY PASSED");
    expect(hint).toContain("August");
  });

  it("uses explicit month when mentioned", () => {
    const hint = DateTimeService.generateDateHint("book December 20th", today);
    expect(hint).toContain("December");
    expect(hint).toContain("explicitly mentioned");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. fallbackExtraction
// ═══════════════════════════════════════════════════════════════════════════

describe("fallbackExtraction", () => {
  it("returns default result for any input (current implementation)", () => {
    const result = DateTimeService.fallbackExtraction("book tomorrow at 10am");
    expect(result).toEqual(DateTimeService.getDefaultResult());
  });

  it("returns default result for invalid input", () => {
    const result = DateTimeService.fallbackExtraction("");
    expect(result).toEqual(DateTimeService.getDefaultResult());
  });

  it("returns default result for null", () => {
    const result = DateTimeService.fallbackExtraction(null);
    expect(result).toEqual(DateTimeService.getDefaultResult());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. extractDateTimeFromMessage
// ═══════════════════════════════════════════════════════════════════════════

describe("extractDateTimeFromMessage", () => {
  it("returns default for null input", async () => {
    const result = await DateTimeService.extractDateTimeFromMessage(null);
    expect(result.hasDateTime).toBe(false);
  });

  it("returns default for empty string", async () => {
    const result = await DateTimeService.extractDateTimeFromMessage("");
    expect(result.hasDateTime).toBe(false);
  });

  it("falls back gracefully when Gemini model is null", async () => {
    // Model is mocked as null, so it should use fallback
    const result = await DateTimeService.extractDateTimeFromMessage("book tomorrow at 10am");
    expect(result).toEqual(DateTimeService.getDefaultResult());
  });
});
