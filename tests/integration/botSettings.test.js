/**
 * Instructor bot settings and per-learner preferences in the WhatsApp flow:
 * pause per learner, new-learner intake, cancel/reschedule permissions,
 * emoji removal, custom greeting, route-aware "next available", booking rules.
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn().mockResolvedValue({ id: "evt-1" }),
  deleteEvent: jest.fn(),
  getEventsForDate: jest.fn().mockResolvedValue([]),
  checkSlotAgainstEvents: jest.fn().mockReturnValue({ isAvailable: true }),
  findEarliestAvailableSlot: jest.fn(),
  getAvailableTimeSlotsForDate: jest.fn(),
}));
jest.mock("../../src/services/routeOptimizer", () => ({
  findEarliestOfferedSlot: jest.fn(),
  evaluateSlot: jest.fn().mockResolvedValue({ feasible: true, addedDrive: 6.42, reason: "+6 min drive, after your 09:00 lesson" }),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({ lat: 53.02, lng: -2.22, message: "Location found" }),
}));
jest.mock("../../src/services/whatsappService", () => ({ sendTextMessage: jest.fn().mockResolvedValue({}) }));
jest.mock("../../src/models/lessonTypeModel");
jest.mock("../../src/models/notificationModel");
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => false) }));
jest.mock("../../src/utils/emailNotifier", () => ({
  sendNotification: jest.fn().mockResolvedValue(true),
  notifyInstructorLearnerMessage: jest.fn().mockResolvedValue(true),
  notifyInvalidGrant: jest.fn(),
  notifyInstructorReauth: jest.fn(),
}));
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({ generateContent: jest.fn() }),
  })),
}));

let mockInstructor;
jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async () => mockInstructor),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn(() => ["2025-07-01", "2025-07-02"]),
}));

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const calendarService = require("../../src/services/calendarService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const { notifyInstructorLearnerMessage } = require("../../src/utils/emailNotifier");
const aiService = require("../../src/services/gemini/aiService");
const bookingService = require("../../src/services/bookingService");
const webhookController = require("../../src/controllers/webhookController");

const BASE_INSTRUCTOR = {
  phoneNumberId: "inst-1",
  name: "Sam",
  email: "sam@test.com",
  availableTimes: ["09:00", "10:00", "11:00", "14:00"],
};

const LEARNER = {
  phone: "447700000001",
  name: "Jane",
  instructorId: "inst-1",
  detailsCompleted: true,
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  schedulingPrefs: {},
};

async function send(text, phone = LEARNER.phone) {
  const replies = [];
  await webhookController.handleIncomingMessage(phone, text, "inst-1", true, (r) => replies.push(r));
  return replies;
}

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  mockInstructor = { ...BASE_INSTRUCTOR };
  User.findOne.mockResolvedValue(LEARNER);
});

describe("Donna paused for a learner", () => {
  it("doesn't reply and emails the instructor", async () => {
    User.findOne.mockResolvedValue({ ...LEARNER, schedulingPrefs: { donnaPaused: true } });
    const getResponse = jest.spyOn(aiService, "getResponse");

    const replies = await send("Can I move my lesson?");

    expect(replies).toEqual([]);
    expect(getResponse).not.toHaveBeenCalled();
    expect(notifyInstructorLearnerMessage).toHaveBeenCalledWith(
      mockInstructor,
      expect.objectContaining({ phone: LEARNER.phone }),
      "Can I move my lesson?"
    );
  });
});

describe("Accepting new learners", () => {
  it("turns away numbers Donna hasn't seen before when closed", async () => {
    mockInstructor.botSettings = { acceptingNewLearners: false };
    User.findOne.mockResolvedValue(null);

    const replies = await send("Hi, can I book a lesson?", "447700000099");

    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain("Sam isn't taking on new learners");
  });

  it("still serves existing learners when closed", async () => {
    mockInstructor.botSettings = { acceptingNewLearners: false };
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Sure!\n[ACTION:NULL]\n{}");

    const replies = await send("Hi, can you help me with a lesson?");

    expect(replies).toEqual(["Sure!"]);
  });
});

describe("Custom greeting", () => {
  it("opens the sign-up chat with the instructor's greeting", async () => {
    mockInstructor.botSettings = { customGreeting: "Welcome to Sam's School of Motoring!" };
    User.findOne.mockResolvedValue(null);
    User.mockImplementation(function (doc) {
      Object.assign(this, doc);
      this.save = jest.fn();
    });

    const replies = await send("hello", "447700000077");

    expect(replies[0]).toBe("Welcome to Sam's School of Motoring!\nPlease tell me your *name*:");
  });
});

describe("Cancel / reschedule permissions", () => {
  beforeEach(() => {
    jest.spyOn(aiService, "getResponse").mockResolvedValue("ok");
  });

  it("refuses to cancel when learners can't cancel via Donna", async () => {
    mockInstructor.botSettings = { allowCancel: false };
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "cancel_booking", bookingData: { bookingId: "DL-AAAA" }, responseText: "",
    });
    const cancel = jest.spyOn(bookingService, "cancelBooking");

    const replies = await send("cancel DL-AAAA");

    expect(cancel).not.toHaveBeenCalled();
    expect(replies).toContain("To cancel a lesson, please contact Sam directly.");
  });

  it("refuses to reschedule when learners can't reschedule via Donna", async () => {
    mockInstructor.botSettings = { allowReschedule: false };
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "update_booking", bookingData: { bookingId: "DL-AAAA" }, responseText: "",
    });
    const reschedule = jest.spyOn(bookingService, "rescheduleBooking");

    const replies = await send("move DL-AAAA");

    expect(reschedule).not.toHaveBeenCalled();
    expect(replies).toContain("To move a lesson, please contact Sam directly.");
  });
});

describe("Emoji setting", () => {
  it("strips emoji from every reply when turned off", async () => {
    mockInstructor.botSettings = { emojis: false };
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Great 🎉 see you soon 🚗\n[ACTION:NULL]\n{}");

    const replies = await send("thanks");

    expect(replies).toEqual(["Great see you soon"]);
  });

  it("leaves emoji alone by default", async () => {
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Great 🎉\n[ACTION:NULL]\n{}");
    expect(await send("thanks")).toEqual(["Great 🎉"]);
  });
});

describe("Next available slot", () => {
  beforeEach(() => {
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Checking!");
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "next_available_slot", bookingData: {}, responseText: "Checking!",
    });
  });

  it("uses the route-aware earliest slot", async () => {
    routeOptimizer.findEarliestOfferedSlot.mockResolvedValue({ date: "2025-07-02", time: "14:00" });
    const replies = await send("asap please");
    expect(replies[1]).toContain("Wed 2 Jul at 2:00 pm");
    expect(calendarService.findEarliestAvailableSlot).not.toHaveBeenCalled();
  });

  it("falls back to the calendar if the route check fails", async () => {
    routeOptimizer.findEarliestOfferedSlot.mockRejectedValue(new Error("boom"));
    calendarService.findEarliestAvailableSlot.mockResolvedValue({ date: "2025-07-03", time: "09:00" });
    const replies = await send("asap please");
    expect(replies[1]).toContain("Thu 3 Jul at 9:00 am");
  });
});

describe("Booking rules", () => {
  const bookingData = { date: "2025-07-01", time: "10:00", userPhone: LEARNER.phone, pickupAddress: "ST5 1AB" };

  beforeEach(() => {
    Booking.create.mockImplementation(async (doc) => ({ ...doc }));
    Booking.countDocuments.mockResolvedValue(0);
  });

  it("records the added drive and the learner's default lesson type", async () => {
    require("../../src/utils/db").isDbReady.mockReturnValue(true);
    const LessonType = require("../../src/models/lessonTypeModel");
    LessonType.findOne.mockReturnValue({ lean: () => Promise.resolve({ _id: "lt-1", name: "Motorway", price: 55 }) });
    User.findOne.mockResolvedValue({ ...LEARNER, schedulingPrefs: { defaultLessonTypeId: "lt-1" } });

    const { booking } = await bookingService.createBooking(LEARNER.phone, bookingData, mockInstructor);
    require("../../src/utils/db").isDbReady.mockReturnValue(false);

    expect(booking.addedDriveMin).toBe(6.4);
    expect(booking.routeScoreReason).toMatch(/after your 09:00 lesson/);
    expect(booking.lessonTypeId).toBe("lt-1");
    expect(booking.price).toBe(55);
    expect(booking.lessonTypeName).toBe("Motorway");
    expect(User.findOne).toHaveBeenCalledWith({ phone: LEARNER.phone, instructorId: "inst-1" });
  });

  it("still books if the route check fails", async () => {
    routeOptimizer.evaluateSlot.mockRejectedValueOnce(new Error("maps down"));
    const { booking } = await bookingService.createBooking(LEARNER.phone, bookingData, mockInstructor);
    expect(booking.addedDriveMin).toBeNull();
  });

  it("enforces the learner's weekly limit with a message they can see", async () => {
    User.findOne.mockResolvedValue({ ...LEARNER, schedulingPrefs: { maxLessonsPerWeek: 1 } });
    Booking.countDocuments.mockResolvedValue(1);

    await expect(
      bookingService.createBooking(LEARNER.phone, bookingData, mockInstructor)
    ).rejects.toMatchObject({ userFacing: true, message: expect.stringContaining("limit of 1 lesson that week") });
  });

  it("enforces the instructor's daily lesson limit", async () => {
    mockInstructor.botSettings = { maxLessonsPerDay: 3 };
    Booking.countDocuments.mockResolvedValue(3);

    const errors = await bookingService.validateBooking(bookingData, mockInstructor);

    expect(errors).toContain("2025-07-01 is fully booked. Please choose a different date.");
  });

  it("checks times against that day's working hours", async () => {
    mockInstructor.botSettings = {
      workingHours: { mon: [], tue: ["14:00"], wed: [], thu: [], fri: [], sat: [], sun: [] },
    };
    const errors = await bookingService.validateBooking(bookingData, mockInstructor); // 2025-07-01 is a Tuesday
    expect(errors[0]).toBe("Time slot is not available. Available times: 14:00");
  });
});
