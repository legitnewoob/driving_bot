/**
 * Driving school analytics: the numbers on a small seeded school (two
 * instructors, a mix of lessons, payments and learners), who can see them,
 * and the CSV exports. See PLAN-school-analytics.md.
 */

jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/paymentModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/chatLogModel");
jest.mock("../../src/models/schoolModel");

const Instructor = require("../../src/models/instructorSchema");
const Booking = require("../../src/models/bookingModel");
const Payment = require("../../src/models/paymentModel");
const User = require("../../src/models/userModel");
const ChatLog = require("../../src/models/chatLogModel");
const School = require("../../src/models/schoolModel");
const timezoneUtils = require("../../src/utils/timezoneUtils");
const analyticsService = require("../../src/services/schoolAnalytics");
const schoolService = require("../../src/services/schoolService");

const SCHOOL = { _id: "school-1", name: "Shah Driving School", ownerId: "owner-1", donnaEnabled: true };
const WEEK = ["mon", "tue", "wed", "thu", "fri"];

// A: packs her day 09:00–17:00 Mon–Fri with a 45-minute lunch. B: fixed start times (the defaults).
const ANNA = {
  _id: "inst-a", name: "Anna Lee", phoneNumberId: "pa", schoolId: "school-1", schoolRole: "member", active: true,
  botSettings: {
    scheduleMode: "packed",
    dayHours: Object.fromEntries([...WEEK.map((d) => [d, { start: "09:00", end: "17:00" }]), ["sat", null], ["sun", null]]),
    lunch: { enabled: true, durationMin: 45, windowFrom: "12:00", windowTo: "14:00" },
  },
};
const BEN = { _id: "inst-b", name: "Ben Ito", phoneNumberId: "pb", schoolId: "school-1", schoolRole: "manager", active: true, calendarTokenExpired: true };

const lesson = (instructorId, userPhone, date, time, extra = {}) => ({
  bookingId: `DL-${instructorId}-${date}-${time}`, instructorId, userPhone, date, time, status: "confirmed", ...extra,
});

// The week of Mon 3 – Sun 9 June 2030, and the week before
const FROM = "2030-06-03";
const TO = "2030-06-09";
const BOOKINGS = [
  lesson("pa", "L1", "2030-05-28", "10:00", { status: "completed", price: 40, durationMin: 60 }), // L1's first lesson, last week
  lesson("pa", "L1", "2030-06-03", "10:00", { status: "completed", price: 40, durationMin: 60, source: "whatsapp", driveInMin: 10, rating: 5 }),
  lesson("pa", "L2", "2030-06-04", "10:00", { price: 80, durationMin: 120, source: "portal", driveInMin: 20 }),
  lesson("pa", "L1", "2030-06-05", "09:00", { status: "cancelled", lateCancellation: true, durationMin: 60 }),
  lesson("pb", "L3", "2030-06-06", "14:00", { status: "completed" }), // no price: the default rate (£50); no length: 60 min
];
const PAYMENTS = [{ instructorId: "pb", userPhone: "L3", bookingId: "DL-pb-2030-06-06-14:00", amount: 50, date: "2030-06-06" }];
const lean = (v) => ({ lean: () => Promise.resolve(v) });

beforeEach(() => {
  jest.clearAllMocks();
  analyticsService.clearCache();
  Instructor.find = jest.fn(() => lean([ANNA, BEN]));
  Booking.find = jest.fn(() => lean(BOOKINGS));
  Payment.find = jest.fn(() => lean(PAYMENTS));
  User.find = jest.fn(() => lean([{ phone: "L1", name: "Lily", instructorId: "pa" }, { phone: "L3", name: "Leo", instructorId: "pb" }]));
  ChatLog.aggregate = jest.fn().mockResolvedValue([
    { _id: { instructor: "pa", current: true }, n: 6 },
    { _id: { instructor: "pb", current: true }, n: 2 },
    { _id: { instructor: "pa", current: false }, n: 4 },
  ]);
});

describe("headline numbers", () => {
  let data;
  beforeEach(async () => {
    data = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
  });

  it("lessons and hours, with the change from the week before", () => {
    expect(data.cards.lessons).toEqual({ value: 3, completed: 2, change: 200 });
    expect(data.cards.hours.value).toBe(4); // 1h + 2h + 1h
    expect(data.period).toEqual({ from: FROM, to: TO, prevFrom: "2030-05-27", prevTo: "2030-06-02" });
  });

  it("revenue at each lesson's own price; collected from payments; unpaid = completed with no payment", () => {
    expect(data.cards.revenue).toMatchObject({ booked: 170, collected: 50, unpaid: 40 });
  });

  it("learners: active this week, and new (first ever lesson this week)", () => {
    expect(data.cards.learners).toMatchObject({ active: 3, new: 2 });
  });

  it("cancellations: rate and how many were late", () => {
    expect(data.cards.cancellations).toMatchObject({ rate: 25, count: 1, late: 1 });
  });

  it("diary filled: booked hours over working hours (less lunch), across both instructors", () => {
    const anna = 5 * (8 * 60 - 45); // packed: Mon–Fri 9–5 less lunch
    const ben = 5 * 6 * 60; // fixed: the 6 default start times × 1h, Mon–Fri
    expect(data.cards.diaryFilled.value).toBe(Math.round((240 / (anna + ben)) * 1000) / 10);
  });

  it("Donna: conversations, and her share of the lessons whose booker was recorded", () => {
    expect(data.cards.donna).toMatchObject({ conversations: 8, conversationsChange: 100, bookedShare: 50, untracked: 1 });
  });
});

describe("instructors table", () => {
  it("one row each, with their own numbers and Donna's status", async () => {
    const { instructors } = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    const anna = instructors.find((i) => i.name === "Anna Lee");
    const ben = instructors.find((i) => i.name === "Ben Ito");
    expect(anna).toMatchObject({ lessons: 2, hours: 3, bookedValue: 120, unpaid: 40, cancelRate: 33.3, activeLearners: 2, newLearners: 1, avgDrive: 15, avgRating: 5, conversations: 6, donna: "on" });
    expect(ben).toMatchObject({ lessons: 1, bookedValue: 50, unpaid: 0, donna: "paused" });
  });

  it("can be narrowed to some instructors", async () => {
    const data = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO, instructorIds: ["inst-b"] });
    expect(data.instructors.map((i) => i.name)).toEqual(["Ben Ito"]);
    expect(data.cards.lessons.value).toBe(1);
    expect(Booking.find.mock.calls[0][0]).toEqual({ instructorId: { $in: ["pb"] } });
    // The filter still lists everyone to choose from
    expect(data.allInstructors).toHaveLength(2);
  });

  it("everyone is off when the school has switched Donna off", async () => {
    require("../../src/utils/db").isDbReady.mockReturnValue(true);
    School.findById = jest.fn(() => ({ select: () => lean({ donnaEnabled: false }) }));
    require("../../src/services/donnaStatus").clearSchoolDonnaCache();
    const { instructors } = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    expect(instructors.map((i) => i.donna)).toEqual(["off", "off"]);
    require("../../src/utils/db").isDbReady.mockReturnValue(false);
  });
});

describe("charts", () => {
  it("daily buckets for a week; lessons per instructor, revenue, new vs returning and the busy-hours heatmap", async () => {
    const { charts } = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    expect(charts.buckets).toHaveLength(7);
    expect(charts.lessons.find((s) => s.name === "Anna Lee").values).toEqual([1, 1, 0, 0, 0, 0, 0]);
    expect(charts.revenue[3]).toEqual({ booked: 50, collected: 50 });
    expect(charts.learners[0]).toEqual({ new: 0, returning: 1 }); // L1 on Monday, first seen last week
    expect(charts.learners[1]).toEqual({ new: 1, returning: 0 }); // L2's first lesson
    expect(charts.heatmap.counts[0][charts.heatmap.hours.indexOf(10)]).toBe(1); // Mon 10:00
    expect(charts.heatmap.counts[3][charts.heatmap.hours.indexOf(14)]).toBe(1); // Thu 14:00
  });

  it("weekly buckets for longer periods", async () => {
    const { charts } = await analyticsService.analytics(SCHOOL, { from: "2030-05-06", to: "2030-06-09" });
    expect(charts.buckets).toEqual(["w/c 6 May", "w/c 13 May", "w/c 20 May", "w/c 27 May", "w/c 3 Jun"]);
  });
});

describe("learner lists", () => {
  it("at risk: lessons before, nothing for 3 weeks and nothing booked", async () => {
    const today = timezoneUtils.getCurrentDateString();
    const ago = (n) => timezoneUtils.addDays(today, -n);
    Booking.find = jest.fn(() =>
      lean([
        lesson("pa", "QUIET", ago(30), "10:00", { status: "completed" }),
        lesson("pa", "QUIET", ago(40), "10:00", { status: "completed" }),
        lesson("pa", "RECENT", ago(5), "10:00", { status: "completed" }),
        lesson("pa", "BOOKED", ago(30), "10:00", { status: "completed" }),
        lesson("pa", "BOOKED", timezoneUtils.addDays(today, 10), "10:00"),
      ])
    );
    User.find = jest.fn(() => lean([{ phone: "QUIET", name: "Quinn", instructorId: "pa" }]));
    const { atRisk } = await analyticsService.analytics(SCHOOL, { from: ago(7), to: today });
    expect(atRisk).toEqual([{ phone: "QUIET", name: "Quinn", instructor: { id: "inst-a", name: "Anna Lee" }, lastLesson: ago(30), lessons: 2 }]);
  });

  it("unpaid lessons and the learners with the most hours", async () => {
    const data = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    expect(data.unpaidLessons).toEqual([
      expect.objectContaining({ name: "Lily", date: "2030-06-03", amount: 40, instructor: { id: "inst-a", name: "Anna Lee" } }),
    ]);
    expect(data.topLearners[0]).toMatchObject({ phone: "L2", hours: 2 });
  });
});

describe("periods", () => {
  it.each([
    ["missing dates", {}],
    ["end before start", { from: "2030-06-09", to: "2030-06-03" }],
    ["over a year", { from: "2029-01-01", to: "2030-06-01" }],
  ])("refuses %s", async (_label, q) => {
    await expect(analyticsService.analytics(SCHOOL, q)).rejects.toMatchObject({ userFacing: true, status: 400 });
  });

  it("caches the same question for a minute", async () => {
    await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    expect(Booking.find).toHaveBeenCalledTimes(1);
  });
});

describe("who can see it", () => {
  const person = (schoolRole, extra = {}) => ({ _id: `${schoolRole}-1`, name: schoolRole, schoolId: "school-1", schoolRole, plan: "driving-school", ...extra });
  beforeEach(() => {
    School.findById = jest.fn().mockResolvedValue(SCHOOL);
  });

  it("the owner and managers can", async () => {
    await expect(schoolService.requireSchool(person("owner", { _id: "owner-1" }), "school.viewAll")).resolves.toMatchObject({ school: SCHOOL });
    await expect(schoolService.requireSchool(person("manager"), "school.viewAll")).resolves.toMatchObject({ school: SCHOOL });
  });

  it("an instructor can't", async () => {
    await expect(schoolService.requireSchool(person("member"), "school.viewAll")).rejects.toMatchObject({ status: 403 });
  });
});

describe("CSV exports", () => {
  it("instructors, at-risk learners and unpaid lessons", async () => {
    const data = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    const instructors = analyticsService.csv(data, "instructors").split("\n");
    expect(instructors[0]).toBe("Instructor,Lessons,Hours,Booked £,Unpaid £,Diary filled %,Cancellations %,Active learners,New learners,Avg drive (min),Avg rating,Donna");
    expect(instructors).toHaveLength(3);
    expect(analyticsService.csv(data, "unpaid").split("\n")[1]).toMatch(/^2030-06-03,10:00,Lily,L1,Anna Lee,/);
    expect(analyticsService.csv(data, "at-risk").split("\n")[0]).toBe("Learner,Phone,Instructor,Last lesson,Lessons taken");
    expect(analyticsService.csv(data, "nope")).toBeNull();
  });

  it("a learner's name can't run as a spreadsheet formula", async () => {
    User.find = jest.fn(() => lean([{ phone: "L1", name: "=HYPERLINK(\"x\")", instructorId: "pa" }]));
    const data = await analyticsService.analytics(SCHOOL, { from: FROM, to: TO });
    expect(analyticsService.csv(data, "unpaid")).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });
});
