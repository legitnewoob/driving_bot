/**
 * DateTimeUtils – Unit Tests
 * ───────────────────────────
 * Covers the `sanitize` static method which merges extracted date/time
 * info with pending context from previous turns.
 *
 * Cases:
 *  1. Time given, no explicit date → use pending date
 *  2. Date given, no explicit time → use pending time
 *  3. Neither explicit → fall back to full pending context
 *  4. Both explicit → no merge needed
 *  5. No pending context → no merge
 *  6. Edge: empty/null inputs
 */

const DateTimeUtils = require("../../src/utils/dateTimeUtils");

describe("DateTimeUtils.sanitize", () => {
  // ── Case 1: Time given but date NOT explicit → use pending date ──

  it("merges pending date when time is given but date is not explicit", () => {
    const extracted = {
      hasDateTime: true,
      date: null,
      time: "10:00",
      explicitDate: false,
      explicitTime: true,
    };
    const pending = { date: "2025-07-01", time: "09:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-07-01");
    expect(result.time).toBe("10:00");
    expect(result.hasDateTime).toBe(true);
  });

  it("does NOT overwrite explicit date even if pending exists", () => {
    const extracted = {
      hasDateTime: true,
      date: "2025-08-15",
      time: "10:00",
      explicitDate: true,
      explicitTime: true,
    };
    const pending = { date: "2025-07-01", time: "09:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-08-15");
    expect(result.time).toBe("10:00");
  });

  // ── Case 2: Date given but time NOT explicit → use pending time ──

  it("merges pending time when date is given but time is not explicit", () => {
    const extracted = {
      hasDateTime: true,
      date: "2025-07-02",
      time: null,
      explicitDate: true,
      explicitTime: false,
    };
    const pending = { date: "2025-07-01", time: "14:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-07-02");
    expect(result.time).toBe("14:00");
    expect(result.hasDateTime).toBe(true);
  });

  // ── Case 3: Neither date nor time explicit → full pending fallback ──

  it("falls back to full pending context when neither is explicit", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };
    const pending = { date: "2025-07-03", time: "11:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-07-03");
    expect(result.time).toBe("11:00");
    expect(result.hasDateTime).toBe(true);
  });

  it("partial pending (only date) still merges", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };
    const pending = { date: "2025-07-03" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-07-03");
    expect(result.time).toBeNull();
    expect(result.hasDateTime).toBe(true);
  });

  it("partial pending (only time) still merges", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };
    const pending = { time: "15:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBeNull();
    expect(result.time).toBe("15:00");
    expect(result.hasDateTime).toBe(true);
  });

  // ── Case 4: Both explicit → no merge needed ──

  it("returns extracted as-is when both date and time are explicit", () => {
    const extracted = {
      hasDateTime: true,
      date: "2025-07-05",
      time: "16:00",
      explicitDate: true,
      explicitTime: true,
    };
    const pending = { date: "2025-07-01", time: "09:00" };

    const result = DateTimeUtils.sanitize(extracted, pending);

    expect(result.date).toBe("2025-07-05");
    expect(result.time).toBe("16:00");
  });

  // ── Case 5: No pending context ──

  it("returns extracted unchanged when pending context is null", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };

    const result = DateTimeUtils.sanitize(extracted, null);

    expect(result.date).toBeNull();
    expect(result.time).toBeNull();
    expect(result.hasDateTime).toBe(false);
  });

  it("returns extracted unchanged when pending context is undefined", () => {
    const extracted = {
      hasDateTime: true,
      date: "2025-07-01",
      time: null,
      explicitDate: true,
      explicitTime: false,
    };

    const result = DateTimeUtils.sanitize(extracted, undefined);

    expect(result.date).toBe("2025-07-01");
    expect(result.time).toBeNull();
  });

  // ── Case 6: Edge cases ──

  it("does not mutate the original extracted object", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };
    const pending = { date: "2025-07-10", time: "10:00" };

    DateTimeUtils.sanitize(extracted, pending);

    expect(extracted.date).toBeNull();
    expect(extracted.time).toBeNull();
    expect(extracted.hasDateTime).toBe(false);
  });

  it("handles empty pending context object (no date/time keys)", () => {
    const extracted = {
      hasDateTime: false,
      date: null,
      time: null,
      explicitDate: false,
      explicitTime: false,
    };

    const result = DateTimeUtils.sanitize(extracted, {});

    // Case 3 triggers but pending has no date/time
    expect(result.date).toBeNull();
    expect(result.time).toBeNull();
    expect(result.hasDateTime).toBe(true); // hasDateTime set true because pending is truthy
  });
});
