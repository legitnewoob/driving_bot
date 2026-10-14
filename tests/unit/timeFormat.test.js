const { to12h } = require("../../src/utils/timeFormat");

describe("to12h", () => {
  it.each([
    ["00:00", "12:00 am"],
    ["00:30", "12:30 am"],
    ["09:00", "9:00 am"],
    ["11:59", "11:59 am"],
    ["12:00", "12:00 pm"],
    ["13:05", "1:05 pm"],
    ["23:45", "11:45 pm"],
  ])("%s → %s", (input, expected) => {
    expect(to12h(input)).toBe(expected);
  });

  it("leaves anything that isn't HH:MM alone", () => {
    expect(to12h("soon")).toBe("soon");
    expect(to12h(undefined)).toBe(undefined);
    expect(to12h("25:00")).toBe("25:00");
  });
});
