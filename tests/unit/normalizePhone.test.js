const { normalizePhone } = require("../../src/utils/normalizePhone");

describe("normalizePhone", () => {
  it("converts UK-local format to E.164 digits", () => {
    expect(normalizePhone("07700 900000")).toBe("447700900000");
  });

  it("converts UK-local format without spaces", () => {
    expect(normalizePhone("07700900000")).toBe("447700900000");
  });

  it("strips a leading + from E.164 numbers", () => {
    expect(normalizePhone("+447700900000")).toBe("447700900000");
  });

  it("leaves already-normalized E.164 numbers unchanged", () => {
    expect(normalizePhone("447700900000")).toBe("447700900000");
  });

  it("strips dashes and other separators", () => {
    expect(normalizePhone("07700-900-000")).toBe("447700900000");
  });

  it("returns falsy input unchanged", () => {
    expect(normalizePhone("")).toBe("");
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeUndefined();
  });
});
