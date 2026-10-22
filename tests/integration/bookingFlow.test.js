/**
 * The guided WhatsApp booking flow (SMART-DAY-PACKING-PLAN.md, phase 3b):
 * hi → menu → lesson type → pickup → drop-off → day → time → confirm, plus
 * moving a lesson. Runs the real controller and flow in mock mode, with the
 * route optimiser and booking service stubbed.
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/models/processedMessageModel");
jest.mock("../../src/models/conversationSessionModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/models/waitlistEntryModel");
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn().mockResolvedValue({ id: "evt-1" }),
  updateEvent: jest.fn(),
  deleteEvent: jest.fn(),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true }),
  findEarliestAvailableSlot: jest.fn(),
  getAvailableTimeSlotsForDate: jest.fn().mockResolvedValue(["10:00", "14:00"]),
}));
jest.mock("../../src/services/routeOptimizer", () => ({
  planDay: jest.fn(),
  evaluateSlot: jest.fn().mockResolvedValue(null),
  findEarliestOfferedSlot: jest.fn(),
  resolveUserContext: jest.fn().mockResolvedValue({ userLoc: null, prefs: {}, user: null }),
  suggestBestDays: jest.fn().mockResolvedValue([]),
  timeToMinutes: (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({ lat: 53.02, lng: -2.22, formattedAddress: "1 High St, ST5 1AB" }),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  markReadAndTyping: jest.fn().mockResolvedValue(),
}));
jest.mock("../../src/utils/emailNotifier", () => ({
  sendNotification: jest.fn().mockResolvedValue(true),
  notifyInstructorLearnerMessage: jest.fn().mockResolvedValue(true),
  notifyInvalidGrant: jest.fn(),
  notifyInstructorReauth: jest.fn(),
}));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({ user: jest.fn(), assistant: jest.fn() })));
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn() }),
  })),
}));

let mockInstructor;
jest.mock("../../src/models/instructorModel", () => {
  const actual = jest.requireActual("../../src/models/instructorModel");
  return { ...actual, getInstructor: jest.fn(async () => mockInstructor) };
});

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const LessonType = require("../../src/models/lessonTypeModel");
const routeOptimizer = require("../../src/services/routeOptimizer");
const { getCoordinatesFromPostalCode } = require("../../src/services/mapsService");
const aiService = require("../../src/services/gemini/aiService");
const dateTimeService = require("../../src/services/gemini/dateTimeService");
const bookingService = require("../../src/services/bookingService");
const settings = require("../../src/services/instructorSettings");
const webhookController = require("../../src/controllers/webhookController");
const { userSessions } = require("../../src/models/instructorModel");

const LEARNER = {
  phone: "4471",
  instructorId: "inst-1",
  name: "Jane Doe",
  detailsCompleted: true,
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  schedulingPrefs: { savedPlaces: [{ label: "College", address: "ST4 2DE", latitude: 53.0, longitude: -2.18 }] },
};
const TYPES = [
  { _id: "t120", name: "Beginner", durationMin: 120, price: 80, description: "" },
  { _id: "t90", name: "Moderate", durationMin: 90, price: 60, description: "" },
  { _id: "t60", name: "Novice", durationMin: 60, price: 40, description: "" },
];

// Booking.find(...) chains used here: .lean(), .sort().limit().lean(), .sort()
function chain(list) {
  const p = Promise.resolve(list);
  const c = { lean: () => p, sort: () => c, limit: () => c, then: (a, b) => p.then(a, b) };
  return c;
}
let bookingsList;
const typesAre = (types) => LessonType.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(types) }) });

async function chat(text, extra = {}) {
  const replies = [];
  await webhookController.handleIncomingMessage("4471", text, "inst-1", true, (r, i) => replies.push(i ? { text: i.body, interactive: i } : { text: r }), extra);
  return replies;
}
const tap = (id) => chat("(tap)", { buttonId: id });
const last = (replies) => replies[replies.length - 1];
const ids = (reply) => (reply.interactive.rows || reply.interactive.buttons).map((r) => r.id);
const flow = () => aiService.pendingContext["4471"]?.flow;

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  Object.keys(userSessions).forEach((k) => delete userSessions[k]);
  Object.keys(aiService.pendingContext).forEach((k) => delete aiService.pendingContext[k]);
  aiService._lessonTypeCache.clear();
  mockInstructor = { phoneNumberId: "inst-1", name: "Sam Smith", email: "sam@x.com", availableTimes: ["10:00", "14:00"] };
  User.findOne.mockResolvedValue(LEARNER);
  bookingsList = [];
  Booking.find.mockImplementation(() => chain(bookingsList));
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
  typesAre(TYPES);
  routeOptimizer.planDay.mockResolvedValue({ offered: ["10:00", "14:00"], evaluations: [], preferred: [], booked: [] });
  getCoordinatesFromPostalCode.mockResolvedValue({ lat: 53.02, lng: -2.22, formattedAddress: "1 High St, ST5 1AB" });
  jest.spyOn(aiService, "getResponse").mockResolvedValue("Happy to help!\n[ACTION:NULL]\n{}");
});

// Taps through to the time list for the first offered day
async function toTimes() {
  await tap("bf:menu:book");
  await tap("bf:type:t60");
  await tap("bf:pickup:home");
  const dates = last(await tap("bf:dropoff:same"));
  const firstDate = ids(dates)[0];
  const times = last(await tap(firstDate));
  return { date: firstDate.split(":")[2], times };
}

describe("greeting and menu", () => {
  it("hi shows the menu without calling the AI", async () => {
    const [menu] = await chat("hi");
    expect(menu.text).toBe("Hi Jane! 👋 I'm Donna, Sam Smith's booking assistant. What would you like to do?");
    expect(ids(menu)).toEqual(["bf:menu:book", "bf:menu:talk"]);
    expect(aiService.getResponse).not.toHaveBeenCalled();
  });

  it("with lessons coming up, offers move, cancel and my lessons", async () => {
    bookingsList = [{ bookingId: "DL-1", date: "2030-07-01", time: "10:00" }];
    const [menu] = await chat("Hello!");
    expect(ids(menu)).toEqual(["bf:menu:book", "bf:menu:move", "bf:menu:cancel", "bf:menu:mine", "bf:menu:talk"]);
  });

  it("hides what the instructor turned off", async () => {
    bookingsList = [{ bookingId: "DL-1", date: "2030-07-01", time: "10:00" }];
    mockInstructor.botSettings = { allowCancel: false, allowReschedule: false, handover: false };
    const [menu] = await chat("hey");
    expect(ids(menu)).toEqual(["bf:menu:book", "bf:menu:mine"]);
  });

  it("a real question still goes to the AI", async () => {
    const [reply] = await chat("hi, how much is a lesson?");
    expect(aiService.getResponse).toHaveBeenCalled();
    expect(reply.text).toBe("Happy to help!");
  });
});

describe("booking by tapping", () => {
  it("goes type → pickup → drop-off → day → time → confirm → booked", async () => {
    const types = last(await tap("bf:menu:book"));
    expect(types.text).toBe("Which lesson would you like?");
    expect(types.interactive.rows.map((r) => [r.title, r.description])).toEqual([
      ["Beginner", "2h · £80"],
      ["Moderate", "1h 30m · £60"],
      ["Novice", "1h · £40"],
    ]);

    const pickup = last(await tap("bf:type:t60"));
    expect(pickup.text).toBe("Where should I pick you up?");
    expect(ids(pickup)).toEqual(["bf:pickup:saved:0", "bf:pickup:home", "bf:pickup:pin", "bf:pickup:type"]);

    const dropoff = last(await tap("bf:pickup:home"));
    expect(ids(dropoff)[0]).toBe("bf:dropoff:same");

    const dates = last(await tap("bf:dropoff:same"));
    expect(dates.text).toBe("Which day suits you?");
    expect(dates.interactive.rows[0].description).toBe("2 times free");
    expect(ids(dates)[ids(dates).length - 1]).toBe("bf:date:other");
    // Every day was checked for a 1-hour lesson from the learner's postcode
    expect(routeOptimizer.planDay.mock.calls[0][0]).toMatchObject({ durationMin: 60, userLoc: { lat: 53.02, long: -2.22 } });

    const date = ids(dates)[0].split(":")[2];
    const times = last(await tap(`bf:date:${date}`));
    expect(times.interactive.rows.map((r) => r.title)).toEqual(["10:00 am – 11:00 am", "2:00 pm – 3:00 pm", "Another day"]);

    const confirm = last(await tap("bf:time:14:00"));
    expect(confirm.text).toContain("🎯 Novice · 1h · £40");
    expect(confirm.text).toContain("2:00 pm – 3:00 pm");
    expect(confirm.text).toContain("📍 Pickup: ST5 1AB");
    expect(confirm.text).toContain("🏁 Drop-off: ST5 1AB");
    expect(ids(confirm)).toEqual(["bf:ok", "bf:change", "bf:stop"]);

    const create = jest.spyOn(bookingService, "createBooking").mockResolvedValue({
      booking: { bookingId: "DL-NEW001" },
      lessonType: TYPES[2],
    });
    const done = await tap("bf:ok");
    expect(create).toHaveBeenCalledWith("4471", expect.objectContaining({
      date,
      time: "14:00",
      lessonTypeId: "t60",
      pickupAddress: "ST5 1AB",
      pickupCoords: { lat: 53.02, long: -2.22 },
      dropoffAddress: "ST5 1AB",
    }), mockInstructor);
    expect(done[0].text).toContain("Booking Confirmed");
    expect(done[0].text).toContain("Novice (£40, 1h)");
    expect(flow()).toBeUndefined();
  });

  it("skips the lesson type when there's only one", async () => {
    typesAre([TYPES[2]]);
    const [pickup] = await tap("bf:menu:book");
    expect(pickup.text).toBe("Where should I pick you up?");
    expect(flow()).toMatchObject({ lessonTypeId: "t60", durationMin: 60 });
  });

  it("a shared location becomes the pickup", async () => {
    await tap("bf:menu:book");
    await tap("bf:type:t60");
    const [dropoff] = await chat("📍 Shared location: Asda car park", { location: { lat: 53.1, long: -2.3, label: "Asda car park" } });
    expect(dropoff.text).toBe("And where should the lesson finish?");
    expect(flow().pickup).toEqual({ address: "Asda car park", lat: 53.1, long: -2.3 });
  });

  it("asks again when a typed address can't be found", async () => {
    await tap("bf:menu:book");
    await tap("bf:type:t60");
    await tap("bf:pickup:type");
    getCoordinatesFromPostalCode.mockRejectedValueOnce(new Error("ZERO_RESULTS"));
    const [again] = await chat("somewhere nice");
    expect(again.text).toMatch(/couldn't find that address/);
    const [dropoff] = await chat("ST5 1AB");
    expect(dropoff.text).toBe("And where should the lesson finish?");
    expect(flow().pickup.address).toBe("1 High St, ST5 1AB");
  });

  it("reads a typed day like \"next Friday\"", async () => {
    await tap("bf:menu:book");
    await tap("bf:type:t60");
    await tap("bf:pickup:home");
    await tap("bf:dropoff:same");
    const friday = settings.upcomingBookableDates(mockInstructor, 10).find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 5);
    jest.spyOn(dateTimeService, "extractDateTimeFromMessage").mockResolvedValue({
      hasDateTime: true, date: friday, time: null, explicitDate: true, explicitTime: false,
    });
    const [times] = await chat("next Friday please");
    expect(times.text).toMatch(/^Here's what's free on Fri/);
    expect(flow().date).toBe(friday);
  });

  it("answers a side question and shows the step again", async () => {
    await toTimes();
    aiService.getResponse.mockResolvedValue("A lesson is £40.\n[ACTION:NULL]\n{}");
    const replies = await chat("how much is it?");
    expect(replies[0].text).toBe("A lesson is £40.");
    expect(last(replies).text).toMatch(/^Here's what's free on/);
    expect(aiService.getResponse.mock.calls[0][0]).toContain("part-way through the guided booking (step: time)");
  });

  it("\"Change something\" → Day goes back to the day list, keeping the rest", async () => {
    await toTimes();
    await tap("bf:time:10:00");
    const change = last(await tap("bf:change"));
    expect(ids(change)).toEqual(["bf:chg:type", "bf:chg:pickup", "bf:chg:dropoff", "bf:chg:date", "bf:chg:time"]);
    const dates = last(await tap("bf:chg:date"));
    expect(dates.text).toBe("Which day suits you?");
    expect(flow()).toMatchObject({ lessonTypeId: "t60", date: null, time: null });
    expect(flow().pickup.address).toBe("ST5 1AB");
  });

  it("when the time has just gone, shows fresh times", async () => {
    await toTimes();
    await tap("bf:time:10:00");
    jest.spyOn(bookingService, "createBooking").mockRejectedValue(
      Object.assign(new Error("Sorry, 10:00 am was just booked by someone else."), { userFacing: true })
    );
    routeOptimizer.planDay.mockResolvedValue({ offered: ["14:00"], evaluations: [], booked: [] });
    const replies = await tap("bf:ok");
    expect(replies[0].text).toMatch(/just booked by someone else/);
    expect(last(replies).interactive.rows.map((r) => r.id)).toEqual(["bf:time:14:00", "bf:date:pick"]);
  });

  it("a day with nothing left goes back to the day list", async () => {
    await tap("bf:menu:book");
    await tap("bf:type:t60");
    await tap("bf:pickup:home");
    const dates = last(await tap("bf:dropoff:same"));
    routeOptimizer.planDay.mockResolvedValueOnce({ offered: [], evaluations: [] });
    const replies = await tap(ids(dates)[0]);
    expect(replies[0].text).toMatch(/There's nothing free on .* for a 1h lesson/);
    expect(last(replies).text).toBe("Which day suits you?");
  });

  it("offers the waiting list when nothing is free at all", async () => {
    routeOptimizer.planDay.mockResolvedValue({ offered: [], evaluations: [] });
    await tap("bf:menu:book");
    await tap("bf:type:t120");
    await tap("bf:pickup:home");
    const [none] = await tap("bf:dropoff:same");
    expect(none.text).toMatch(/nothing free for a 2h lesson/);
    expect(ids(none)[0]).toBe("bf:wl");
  });

  it("Cancel stops without booking", async () => {
    await toTimes();
    await tap("bf:time:10:00");
    const [bye] = await tap("bf:stop");
    expect(bye.text).toBe("No problem, nothing's been booked. 👍");
    expect(flow()).toBeUndefined();
  });

  it("the AI can start the flow with details it already has", async () => {
    const date = settings.upcomingBookableDates(mockInstructor, 3)[1];
    aiService.getResponse.mockResolvedValue(
      `Let's get that booked!\n[ACTION:START_BOOKING]\n{"lessonType": "Moderate", "date": "${date}", "pickupAddress": "ST5 1AB", "dropoffAddress": "ST5 1AB"}`
    );
    const replies = await chat("can I book a moderate lesson, pick me up from ST5 1AB?");
    expect(replies[0].text).toBe("Let's get that booked!");
    expect(last(replies).text).toMatch(/^Here's what's free on/);
    expect(flow()).toMatchObject({ lessonTypeId: "t90", durationMin: 90, date });
    expect(last(replies).interactive.rows[0].title).toBe("10:00 am – 11:30 am");
  });

  it("keeps the flow in plain data so the session store can save it", async () => {
    await toTimes();
    expect(JSON.parse(JSON.stringify(flow()))).toEqual(flow());
  });
});

describe("moving a lesson", () => {
  const lesson = {
    bookingId: "DL-MOV001",
    userPhone: "4471",
    instructorId: "inst-1",
    status: "confirmed",
    date: "2030-07-02",
    time: "10:00",
    durationMin: 60,
    lessonTypeId: "t60",
    lessonTypeName: "Novice",
    price: 40,
    calendarEventId: "evt-9",
    pickupLocation: { address: "ST5 1AB", latitude: 53.02, longitude: -2.22 },
    dropoffLocation: { address: "ST5 1AB", latitude: 53.02, longitude: -2.22 },
  };

  beforeEach(() => {
    Booking.findOne.mockResolvedValue(lesson);
  });

  it("asks what to change", async () => {
    const [ask] = await tap("movepick:DL-MOV001");
    expect(ask.text).toContain("Moving your lesson on");
    expect(ids(ask)).toEqual(["bf:mv:when", "bf:mv:place", "bf:mv:type"]);
  });

  it("Date & time: pick a new day and time, then move it", async () => {
    await tap("movepick:DL-MOV001");
    const dates = last(await tap("bf:mv:when"));
    const date = ids(dates)[0].split(":")[2];
    await tap(`bf:date:${date}`);
    const confirm = last(await tap("bf:time:14:00"));
    expect(ids(confirm)[0]).toBe("bf:ok");
    expect(confirm.interactive.buttons[0].title).toBe("Move it");
    const move = jest.spyOn(bookingService, "rescheduleBooking").mockResolvedValue({ bookingId: "DL-MOV001" });
    const [done] = await tap("bf:ok");
    expect(move).toHaveBeenCalledWith("4471", expect.objectContaining({ bookingId: "DL-MOV001", newDate: date, newTime: "14:00" }), "inst-1");
    expect(done.text).toMatch(/Booking DL-MOV001 moved to/);
  });

  it("Lesson type: a longer lesson re-checks the current time", async () => {
    await tap("movepick:DL-MOV001");
    await tap("bf:mv:type");
    const check = jest.spyOn(bookingService, "validateBooking").mockResolvedValue([]);
    const confirm = last(await tap("bf:type:t120"));
    expect(check).toHaveBeenCalledWith(
      { date: "2030-07-02", time: "10:00" },
      mockInstructor,
      expect.objectContaining({ durationMin: 120, excludeBookingId: "DL-MOV001", ignoreEventId: "evt-9" })
    );
    expect(confirm.text).toContain("🎯 Beginner · 2h · £80");
    expect(confirm.text).toContain("10:00 am – 12:00 pm");

    const move = jest.spyOn(bookingService, "rescheduleBooking").mockResolvedValue({ bookingId: "DL-MOV001" });
    await tap("bf:ok");
    expect(move.mock.calls[0][1]).toMatchObject({ newDate: "2030-07-02", newTime: "10:00", lessonTypeId: "t120" });
  });

  it("Lesson type: when the longer lesson no longer fits, offers that day's times", async () => {
    await tap("movepick:DL-MOV001");
    await tap("bf:mv:type");
    jest.spyOn(bookingService, "validateBooking").mockResolvedValue(["clashes"]);
    const replies = await tap("bf:type:t120");
    expect(replies[0].text).toBe("10:00 am on Tue 2 Jul doesn't work for this lesson.");
    expect(last(replies).text).toBe("Here's what's free on Tue 2 Jul:");
  });

  it("Pickup / drop-off: new places, same time if it still works", async () => {
    await tap("movepick:DL-MOV001");
    await tap("bf:mv:place");
    await tap("bf:pickup:saved:0");
    jest.spyOn(bookingService, "validateBooking").mockResolvedValue([]);
    const confirm = last(await tap("bf:dropoff:same"));
    expect(confirm.text).toContain("📍 Pickup: ST4 2DE");
    const move = jest.spyOn(bookingService, "rescheduleBooking").mockResolvedValue({ bookingId: "DL-MOV001" });
    await tap("bf:ok");
    expect(move.mock.calls[0][1]).toMatchObject({
      newDate: "2030-07-02",
      newTime: "10:00",
      pickupAddress: "ST4 2DE",
      pickupCoords: { lat: 53.0, long: -2.18 },
    });
  });

  it("the lesson's own time isn't offered as a new time on the same day", async () => {
    await tap("movepick:DL-MOV001");
    await tap("bf:mv:when");
    const times = last(await tap("bf:date:2030-07-02"));
    expect(ids(times)).toEqual(["bf:time:14:00", "bf:date:pick"]);
  });
});
