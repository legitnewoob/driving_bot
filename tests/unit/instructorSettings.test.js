const s = require("../../src/services/instructorSettings");

const realNow = Date.now;
function setNow(iso) {
  Date.now = () => new Date(iso).getTime();
}
afterEach(() => {
  Date.now = realNow;
});

const LEGACY = { availableTimes: ["09:00", "10:00", "11:00", "14:00"] };

describe("resolveRouteSettings", () => {
  it("defaults to the balanced preset with today's behaviour", () => {
    const r = s.resolveRouteSettings({});
    expect(r).toMatchObject({
      preset: "balanced",
      enabled: true,
      lessonDurationMin: 60,
      travelGraceMin: 10,
      maxAddedDriveMin: 20,
      homeLegWeight: 0.5,
      fragmentationPenaltyMin: 15,
      suggestOtherDays: true,
      lookAheadDays: 10,
    });
  });

  it("a preset overrides the stored drive, grace and penalty values", () => {
    const r = s.resolveRouteSettings({
      routeSettings: { preset: "tight", maxAddedDriveMin: 45, travelGraceMin: 30, fragmentationPenalty: "off" },
    });
    expect(r.maxAddedDriveMin).toBe(12);
    expect(r.travelGraceMin).toBe(5);
    expect(r.fragmentationPenaltyMin).toBe(25);
  });

  it("'custom' uses the stored values", () => {
    const r = s.resolveRouteSettings({
      routeSettings: { preset: "custom", maxAddedDriveMin: 45, travelGraceMin: 0, fragmentationPenalty: "off", homeLegWeight: "full" },
    });
    expect(r).toMatchObject({ maxAddedDriveMin: 45, travelGraceMin: 0, fragmentationPenaltyMin: 0, homeLegWeight: 1 });
  });

  it("'off' disables routing", () => {
    expect(s.resolveRouteSettings({ routeSettings: { preset: "off" } }).enabled).toBe(false);
  });

  it("lesson length is independent of the preset", () => {
    expect(s.resolveRouteSettings({ routeSettings: { preset: "relaxed", lessonDurationMin: 90 } }).lessonDurationMin).toBe(90);
  });

  it("normalises postcode districts to upper case", () => {
    const r = s.resolveRouteSettings({ routeSettings: { serviceArea: { postcodeDistricts: ["st5", "St4"] } } });
    expect(r.serviceArea.postcodeDistricts).toEqual(["ST5", "ST4"]);
  });

  it("accepts mongoose documents", () => {
    const doc = { toObject: () => ({ preset: "relaxed" }) };
    expect(s.resolveRouteSettings({ routeSettings: doc }).maxAddedDriveMin).toBe(30);
  });
});

describe("working days and times", () => {
  it("legacy instructors work their availableTimes Monday–Friday", () => {
    expect(s.timesForDate(LEGACY, "2025-06-16")).toEqual(LEGACY.availableTimes); // Monday
    expect(s.timesForDate(LEGACY, "2025-06-21")).toEqual([]); // Saturday
    expect(s.describeWorkingDays(LEGACY)).toBe("Monday–Friday");
  });

  it("falls back to the default times when none are set", () => {
    expect(s.timesForDate({}, "2025-06-16")).toEqual(["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"]);
  });

  it("per-day working hours replace the weekday rule", () => {
    const inst = {
      ...LEGACY,
      botSettings: {
        workingHours: { mon: ["10:00", "09:00"], tue: [], wed: [], thu: [], fri: [], sat: ["09:00"], sun: [] },
      },
    };
    expect(s.timesForDate(inst, "2025-06-16")).toEqual(["09:00", "10:00"]);
    expect(s.timesForDate(inst, "2025-06-21")).toEqual(["09:00"]);
    expect(s.isWorkingDay(inst, "2025-06-17")).toBe(false);
    expect(s.describeWorkingDays(inst)).toBe("Monday, Saturday");
    expect(s.allWorkingTimes(inst)).toEqual(["09:00", "10:00"]);
  });

  it("describes a run of days that wraps into the weekend", () => {
    const hours = { mon: [], tue: ["09:00"], wed: ["09:00"], thu: ["09:00"], fri: ["09:00"], sat: ["09:00"], sun: [] };
    expect(s.describeWorkingDays({ botSettings: { workingHours: hours } })).toBe("Tuesday–Saturday");
  });

  it("removes slots whose lesson would overlap a break", () => {
    const inst = { ...LEGACY, availableTimes: ["11:00", "11:30", "12:00", "13:00", "14:00"], botSettings: { breaks: [{ from: "12:00", to: "13:00" }] } };
    // 11:00–12:00 ends as the break starts → kept; 11:30 runs into it → removed
    expect(s.timesForDate(inst, "2025-06-16")).toEqual(["11:00", "13:00", "14:00"]);
  });
});

describe("dates", () => {
  it("holiday mode blocks the date range", () => {
    const inst = { botSettings: { holiday: { enabled: true, from: "2025-06-18", to: "2025-06-20" } } };
    expect(s.isOnHoliday(inst, "2025-06-17")).toBe(false);
    expect(s.isOnHoliday(inst, "2025-06-18")).toBe(true);
    expect(s.isOnHoliday(inst, "2025-06-20")).toBe(true);
    expect(s.isOnHoliday({ botSettings: { holiday: { enabled: false, from: "2025-06-18", to: "2025-06-20" } } }, "2025-06-18")).toBe(false);
  });

  it("24h notice blocks today and tomorrow, like the original rule", () => {
    setNow("2025-06-16T09:00:00Z");
    expect(s.isWithinNotice({}, "2025-06-16")).toBe(true);
    expect(s.isWithinNotice({}, "2025-06-17")).toBe(true);
    expect(s.isWithinNotice({}, "2025-06-18")).toBe(false);
  });

  it("longer notice blocks more days", () => {
    setNow("2025-06-16T09:00:00Z");
    expect(s.isWithinNotice({ botSettings: { minNoticeHours: 72 } }, "2025-06-18")).toBe(true);
  });

  it("bookableDates covers working, non-holiday days within the window", () => {
    setNow("2025-06-16T09:00:00Z"); // Monday
    const inst = { ...LEGACY, botSettings: { bookingWindowDays: 7, holiday: { enabled: true, from: "2025-06-19", to: "2025-06-19" } } };
    expect(s.bookableDates(inst)).toEqual(["2025-06-17", "2025-06-18", "2025-06-20", "2025-06-23"]);
  });

  it("upcomingBookableDates also skips days inside the notice period", () => {
    setNow("2025-06-16T09:00:00Z");
    expect(s.upcomingBookableDates(LEGACY, 3)).toEqual(["2025-06-18", "2025-06-19", "2025-06-20"]);
  });

  it("isBeyondWindow checks the booking window", () => {
    setNow("2025-06-16T09:00:00Z");
    const inst = { botSettings: { bookingWindowDays: 14 } };
    expect(s.isBeyondWindow(inst, "2025-06-30")).toBe(false);
    expect(s.isBeyondWindow(inst, "2025-07-01")).toBe(true);
  });
});

describe("resolveBotSettings", () => {
  it("fills defaults and merges partial holiday settings", () => {
    const b = s.resolveBotSettings({ botSettings: { tone: "brief", holiday: { enabled: true } } });
    expect(b).toMatchObject({
      tone: "brief",
      emojis: true,
      minNoticeHours: 24,
      bookingWindowDays: 90,
      acceptingNewLearners: true,
      allowCancel: true,
      allowReschedule: true,
      holiday: { enabled: true, from: null, to: null, message: "" },
    });
  });
});
