/**
 * Phase 2 of PLAN-bot-improvements.md:
 *  2.1 reminders · 2.2 lesson types · 2.3 instructor notifications · 2.4 waiting list
 *  2.5 late cancellation · 2.6 shared locations / other message types · 2.7 tappable options
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
  getAvailableTimeSlotsForDate: jest.fn(),
}));
jest.mock("../../src/services/routeOptimizer", () => ({
  placeAllowed: async () => ({ inside: true }),
  evaluateSlot: jest.fn().mockResolvedValue(null),
  findEarliestOfferedSlot: jest.fn(),
  resolveUserContext: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({ lat: 53.02, lng: -2.22 }),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendButtons: jest.fn().mockResolvedValue({}),
  sendList: jest.fn().mockResolvedValue({}),
  sendTemplate: jest.fn().mockResolvedValue({}),
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
  return {
    ...actual,
    getInstructor: jest.fn(async () => mockInstructor),
    getAvailableDates: jest.fn(() => ["2030-07-01", "2030-07-02"]),
  };
});

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const LessonType = require("../../src/models/lessonTypeModel");
const Notification = require("../../src/models/notificationModel");
const WaitlistEntry = require("../../src/models/waitlistEntryModel");
const ConversationSession = require("../../src/models/conversationSessionModel");
const db = require("../../src/utils/db");
const whatsappService = require("../../src/services/whatsappService");
const calendarService = require("../../src/services/calendarService");
const routeOptimizer = require("../../src/services/routeOptimizer");
const { sendNotification } = require("../../src/utils/emailNotifier");
const aiService = require("../../src/services/gemini/aiService");
const bookingService = require("../../src/services/bookingService");
const notificationService = require("../../src/services/notificationService");
const waitlistService = require("../../src/services/waitlistService");
const reminders = require("../../src/jobs/reminders");
const webhookController = require("../../src/controllers/webhookController");
const { parseIncoming } = require("../../src/controllers/webhookController");
const { userSessions } = require("../../src/models/instructorModel");

const LEARNER = {
  phone: "4471",
  instructorId: "inst-1",
  name: "Jane",
  detailsCompleted: true,
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  schedulingPrefs: {},
};

const inHours = (h) => {
  const d = new Date(Date.now() + h * 3600 * 1000);
  const tz = require("../../src/utils/timezoneUtils");
  return { date: tz.formatDate(d, "YYYY-MM-DD"), time: tz.formatDate(d, "HH:mm") };
};

async function chat(text, extra = {}) {
  const replies = [];
  await webhookController.handleIncomingMessage("4471", text, "inst-1", true, (r, i) => replies.push(i ? { text: r, interactive: i } : r), extra);
  return replies;
}

const aiSays = (text) => jest.spyOn(aiService, "getResponse").mockResolvedValue(text);

beforeEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
  db.isDbReady.mockReturnValue(false);
  Object.keys(userSessions).forEach((k) => delete userSessions[k]);
  Object.keys(aiService.pendingContext).forEach((k) => delete aiService.pendingContext[k]);
  aiService._lessonTypeCache.clear();
  mockInstructor = { phoneNumberId: "inst-1", name: "Sam", email: "sam@x.com", availableTimes: ["09:00", "10:00", "14:00"] };
  User.findOne.mockResolvedValue(LEARNER);
  Booking.countDocuments = jest.fn().mockResolvedValue(0);
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.1 reminders", () => {
  const booking = (overrides = {}) => ({
    _id: "b1",
    bookingId: "DL-REM001",
    userPhone: "4471",
    instructorId: "inst-1",
    status: "confirmed",
    reminderSentAt: null,
    shortReminderSentAt: null,
    pickupLocation: { address: "ST5 1AB" },
    ...inHours(24),
    ...overrides,
  });

  beforeEach(() => {
    db.isDbReady.mockReturnValue(true);
    Booking.findOneAndUpdate.mockResolvedValue({ _id: "b1" });
  });

  it("sends buttons when the learner messaged in the last 24h", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking()]) });
    ConversationSession.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ lastActivity: new Date() }) }) });

    const result = await reminders.runOnce();

    expect(result.sent).toBe(1);
    expect(Booking.findOneAndUpdate).toHaveBeenCalledWith({ _id: "b1", reminderSentAt: null }, { reminderSentAt: expect.any(Date) });
    const [to, text, buttons] = whatsappService.sendButtons.mock.calls[0];
    expect(to).toBe("4471");
    expect(text).toContain("Reminder: your driving lesson with Sam");
    expect(buttons.map((b) => b.id)).toEqual(["rem:confirm:DL-REM001", "rem:move:DL-REM001", "rem:cancel:DL-REM001"]);
  });

  it("uses the approved template outside the 24h window", async () => {
    process.env.WHATSAPP_REMINDER_TEMPLATE = "lesson_reminder";
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking()]) });
    ConversationSession.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    await reminders.runOnce();
    delete process.env.WHATSAPP_REMINDER_TEMPLATE;

    const [to, name, lang, params, payloads] = whatsappService.sendTemplate.mock.calls[0];
    expect([to, name, lang]).toEqual(["4471", "lesson_reminder", "en_GB"]);
    expect(params[0]).toBe("Sam");
    expect(params[3]).toBe("ST5 1AB");
    expect(payloads).toEqual(["rem:confirm:DL-REM001", "rem:move:DL-REM001", "rem:cancel:DL-REM001"]);
  });

  it("skips (and releases the claim) when there's no template and no recent message", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking()]) });
    ConversationSession.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });

    const result = await reminders.runOnce();

    expect(result.skippedNoTemplate).toBe(1);
    expect(Booking.updateOne).toHaveBeenCalledWith({ _id: "b1" }, { reminderSentAt: null });
  });

  it("doesn't send when another server already claimed it", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking()]) });
    Booking.findOneAndUpdate.mockResolvedValue(null);
    await reminders.runOnce();
    expect(whatsappService.sendButtons).not.toHaveBeenCalled();
  });

  it("respects 'off' and only sends the 2h reminder when chosen", async () => {
    ConversationSession.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ lastActivity: new Date() }) }) });
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking({ ...inHours(2), reminderSentAt: new Date() })]) });

    mockInstructor.botSettings = { reminders: "off" };
    expect((await reminders.runOnce()).sent).toBe(0);

    mockInstructor.botSettings = { reminders: "24h" };
    expect((await reminders.runOnce()).sent).toBe(0);

    mockInstructor.botSettings = { reminders: "24h+2h" };
    expect((await reminders.runOnce()).sent).toBe(1);
    expect(whatsappService.sendTextMessage.mock.calls[0][1]).toContain("starts at");
  });

  it("ignores lessons outside the reminder window", async () => {
    Booking.find.mockReturnValue({ lean: () => Promise.resolve([booking(inHours(40)), booking(inHours(10))]) });
    expect((await reminders.runOnce()).sent).toBe(0);
  });

  describe("button replies", () => {
    const active = () => ({ ...booking(), save: jest.fn() });

    it("confirm records the learner's confirmation", async () => {
      const b = active();
      Booking.findOne.mockResolvedValue(b);
      const replies = await chat("I'll be there", { buttonId: "rem:confirm:DL-REM001" });
      expect(b.learnerConfirmedAt).toBeInstanceOf(Date);
      expect(replies[0]).toContain("see you on");
    });

    it("reschedule asks for a new time and remembers which booking", async () => {
      Booking.findOne.mockResolvedValue(active());
      const replies = await chat("Reschedule", { buttonId: "rem:move:DL-REM001" });
      expect(replies[0]).toContain("I'll move booking DL-REM001");
      expect(userSessions["4471::inst-1"].conversationHistory[0].content).toContain("DL-REM001");
    });

    it("cancel goes through the normal cancel flow", async () => {
      Booking.findOne.mockResolvedValue({ ...active(), ...inHours(72) });
      jest.spyOn(bookingService, "cancelBooking").mockResolvedValue({ status: "cancelled" });
      const replies = await chat("Cancel", { buttonId: "rem:cancel:DL-REM001" });
      expect(bookingService.cancelBooking).toHaveBeenCalledWith("DL-REM001", expect.objectContaining({ userPhone: "4471" }));
      expect(replies[0]).toContain("cancelled successfully");
    });

    it("only acts on the learner's own booking", async () => {
      Booking.findOne.mockResolvedValue(null);
      const replies = await chat("I'll be there", { buttonId: "rem:confirm:DL-OTHER1" });
      expect(Booking.findOne).toHaveBeenCalledWith({ bookingId: "DL-OTHER1", userPhone: "4471", instructorId: "inst-1" });
      expect(replies[0]).toContain("isn't booked any more");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.2 lesson types", () => {
  const TYPES = [
    { _id: "lt-std", name: "Standard", price: 40, description: "" },
    { _id: "lt-mwy", name: "Motorway", price: 55, description: "Dual carriageways too" },
  ];

  it("lists the instructor's lesson types and prices for Donna", async () => {
    db.isDbReady.mockReturnValue(true);
    LessonType.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve(TYPES) }) });
    const types = await aiService._lessonTypesFor(mockInstructor);
    const prompt = aiService.getSystemPrompt(mockInstructor, null, types);
    expect(prompt).toContain("- Motorway: £55 — Dual carriageways too");
    expect(prompt).toContain('"lessonType"');
  });

  it("books the lesson type the learner chose and snapshots its price", async () => {
    db.isDbReady.mockReturnValue(true);
    LessonType.find.mockReturnValue({ lean: () => Promise.resolve(TYPES) });
    Booking.create.mockImplementation(async (doc) => ({ ...doc, _id: "b1" }));

    const { booking, lessonType } = await bookingService.createBooking(
      "4471", { date: "2030-07-01", time: "10:00", userPhone: "4471", lessonType: "motorway" }, mockInstructor
    );

    expect(lessonType.name).toBe("Motorway");
    expect(booking).toMatchObject({ lessonTypeId: "lt-mwy", lessonTypeName: "Motorway", price: 55 });
  });

  it("shows the lesson type and price in the confirmation", async () => {
    jest.spyOn(bookingService, "createBooking").mockResolvedValue({
      booking: { bookingId: "DL-LT0001" },
      lessonType: { name: "Motorway", price: 55 },
    });
    aiSays('Booking!\n[ACTION:BOOK]\n{"date":"2030-07-01","time":"10:00","lessonType":"Motorway"}');
    const replies = await chat("book motorway");
    expect(replies[1]).toContain("🎯 Lesson: Motorway (£55)");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.3 instructor notifications", () => {
  const booking = { bookingId: "DL-N00001", userPhone: "4471", date: "2030-07-01", time: "10:00", lessonTypeName: "Standard" };

  beforeEach(() => {
    db.isDbReady.mockReturnValue(true);
    User.findOne.mockReturnValue({ lean: () => Promise.resolve({ name: "Jane" }) });
  });

  it("records a portal notification and emails the instructor", async () => {
    await notificationService.bookingChanged(mockInstructor, "booked", booking);
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({
      instructorId: "inst-1",
      type: "booked",
      clientId: "notif-DL-N00001",
      message: expect.stringContaining("New booking: Jane — Mon 1 Jul at 10:00 am (Standard)"),
    }));
    expect(sendNotification).toHaveBeenCalledWith(expect.stringContaining("New booking"), expect.any(String), null, "sam@x.com");
  });

  it("describes reschedules and late cancellations", async () => {
    await notificationService.bookingChanged(mockInstructor, "rescheduled", booking, { date: "2030-06-30", time: "09:00" });
    await notificationService.bookingChanged(mockInstructor, "cancelled", { ...booking, lateCancellation: true });
    const messages = Notification.create.mock.calls.map(([n]) => n.message);
    expect(messages[0]).toContain("moved their lesson from Sun 30 Jun at 9:00 am to Mon 1 Jul at 10:00 am");
    expect(messages[1]).toContain("late cancellation");
  });

  it("respects the instructor's choices", async () => {
    mockInstructor.botSettings = { notifications: { cancelled: false, email: false } };
    await notificationService.bookingChanged(mockInstructor, "cancelled", booking);
    await notificationService.bookingChanged(mockInstructor, "booked", booking);
    expect(Notification.create).toHaveBeenCalledTimes(1);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("a notification failure never breaks a booking", async () => {
    Notification.create.mockRejectedValue(new Error("db down"));
    await expect(notificationService.bookingChanged(mockInstructor, "booked", booking)).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.4 waiting list", () => {
  beforeEach(() => db.isDbReady.mockReturnValue(true));

  it("Donna adds the learner when asked", async () => {
    aiSays('Sure!\n[ACTION:WAITLIST]\n{"fromDate":"2030-07-01","preferredTimes":["10:00","9am"]}');
    const replies = await chat("let me know if anything earlier comes up");
    expect(WaitlistEntry.findOneAndUpdate).toHaveBeenCalledWith(
      { instructorId: "inst-1", phone: "4471", status: { $in: ["waiting", "offered"] } },
      expect.objectContaining({ fromDate: "2030-07-01", toDate: null, preferredTimes: ["10:00"], status: "waiting" }),
      { upsert: true }
    );
    expect(replies[1]).toContain("You're on the list");
  });

  it("offers a freed slot to the 3 best-fitting learners who can make it", async () => {
    const entries = ["a", "b", "c", "d", "e"].map((p, i) => ({ _id: `w${i}`, phone: p, preferredTimes: [] }));
    entries.push({ _id: "w-time", phone: "f", preferredTimes: ["14:00"] }); // wrong time
    entries.push({ _id: "w-date", phone: "g", toDate: "2030-06-01", preferredTimes: [] }); // too early
    WaitlistEntry.find.mockReturnValue({ lean: () => Promise.resolve(entries) });
    routeOptimizer.resolveUserContext.mockImplementation(async (_i, phone) => ({ userLoc: { phone } }));
    const drive = { a: 20, b: 3, c: 9, d: 1, e: 40 };
    routeOptimizer.evaluateSlot.mockImplementation(async (_d, _t, _i, loc) =>
      loc.phone === "d" ? { feasible: false } : { feasible: true, addedDrive: drive[loc.phone] }
    );
    ConversationSession.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ lastActivity: new Date() }) }) });

    const offered = await waitlistService.offerSlot(mockInstructor, "2030-07-03", "10:00", "4471");

    expect(offered).toEqual(["b", "c", "a"]);
    expect(whatsappService.sendButtons.mock.calls[0][2].map((x) => x.id)).toEqual(["wl:take:2030-07-03:10:00", "wl:skip"]);
    expect(WaitlistEntry.updateOne).toHaveBeenCalledWith(
      { _id: "w1" }, { status: "offered", offer: { date: "2030-07-03", time: "10:00", at: expect.any(Date) } }
    );
  });

  it("cancelling a lesson offers the slot to the waiting list", async () => {
    const spy = jest.spyOn(waitlistService, "offerSlot").mockResolvedValue([]);
    Booking.findOne.mockResolvedValue({
      bookingId: "DL-W00001", userPhone: "4471", instructorId: "inst-1", status: "confirmed",
      ...inHours(100), save: jest.fn(),
    });
    await bookingService.cancelBooking("DL-W00001", { userPhone: "4471", instructorId: "inst-1", instructor: mockInstructor });
    await new Promise((r) => setImmediate(r));
    expect(spy).toHaveBeenCalledWith(mockInstructor, expect.any(String), expect.any(String), "4471");
  });

  it("'Book it' books the slot for the first learner to tap", async () => {
    WaitlistEntry.findOne.mockResolvedValue({ _id: "w1" });
    jest.spyOn(bookingService, "createBooking").mockResolvedValue({ booking: { bookingId: "DL-WL0001" } });
    Booking.findOne.mockResolvedValue({ bookingId: "DL-WL0001" });

    const replies = await chat("Book it", { buttonId: "wl:take:2030-07-03:10:00" });

    expect(bookingService.createBooking).toHaveBeenCalledWith(
      "4471", expect.objectContaining({ date: "2030-07-03", time: "10:00", pickupAddress: "ST5 1AB" }), mockInstructor
    );
    expect(replies[0]).toContain("Booking Confirmed");
    expect(WaitlistEntry.updateOne).toHaveBeenCalledWith({ _id: "w1" }, { status: "booked" });
  });

  it("a later tap gets 'already taken' and stays on the list", async () => {
    WaitlistEntry.findOne.mockResolvedValue({ _id: "w2" });
    jest.spyOn(bookingService, "createBooking").mockRejectedValue(
      Object.assign(new Error("Sorry, 10:00 on 2030-07-03 was just booked by someone else. Please pick another time."), { userFacing: true })
    );
    Booking.findOne.mockResolvedValue(null);

    const replies = await chat("Book it", { buttonId: "wl:take:2030-07-03:10:00" });

    expect(replies[0]).toContain("was just booked by someone else");
    expect(WaitlistEntry.updateOne).toHaveBeenCalledWith({ _id: "w2" }, { status: "waiting" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.5 late cancellation", () => {
  const soon = () => ({ bookingId: "DL-LATE01", userPhone: "4471", instructorId: "inst-1", status: "confirmed", ...inHours(10), save: jest.fn() });

  it("warns before cancelling inside the notice period", async () => {
    mockInstructor.botSettings = { cancellationNoticeHours: 48, lateCancellationFee: 35 };
    Booking.findOne.mockResolvedValue(soon());
    const cancel = jest.spyOn(bookingService, "cancelBooking");
    aiSays('Okay.\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-LATE01"}');

    const replies = await chat("cancel DL-LATE01");

    expect(cancel).not.toHaveBeenCalled();
    expect(replies[1].text).toContain("less than 48 hours away");
    expect(replies[1].text).toContain("may be charged £35");
    expect(replies[1].interactive.buttons.map((b) => b.id)).toEqual(["latecancel:yes:DL-LATE01", "latecancel:no"]);
  });

  it("cancels and flags it once the learner confirms", async () => {
    const b = soon();
    Booking.findOne.mockResolvedValue(b);
    const replies = await chat("Yes, cancel it", { buttonId: "latecancel:yes:DL-LATE01" });
    expect(b.status).toBe("cancelled");
    expect(b.lateCancellation).toBe(true);
    expect(replies[0]).toContain("cancelled successfully");
  });

  it("keeps the lesson if they change their mind", async () => {
    const b = soon();
    Booking.findOne.mockResolvedValue(b);
    const replies = await chat("Keep my lesson", { buttonId: "latecancel:no" });
    expect(b.status).toBe("confirmed");
    expect(replies[0]).toContain("still booked");
  });

  it("cancels straight away with plenty of notice", async () => {
    const b = { ...soon(), ...inHours(100) };
    Booking.findOne.mockResolvedValue(b);
    aiSays('Okay.\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-LATE01"}');
    await chat("cancel DL-LATE01");
    expect(b.status).toBe("cancelled");
    expect(b.lateCancellation).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.6 shared locations and other message types", () => {
  it("parses a shared pin into pickup text and coordinates", () => {
    expect(parseIncoming({ type: "location", location: { latitude: 53.03, longitude: -2.18, name: "Hanley Bus Station" } })).toEqual({
      text: "📍 Shared location: Hanley Bus Station",
      location: { lat: 53.03, long: -2.18, label: "Hanley Bus Station" },
    });
  });

  it("flags voice notes and images, and ignores reactions", () => {
    expect(parseIncoming({ type: "audio" })).toEqual({ unsupportedType: "audio" });
    expect(parseIncoming({ type: "image" })).toEqual({ unsupportedType: "image" });
    expect(parseIncoming({ type: "reaction" })).toEqual({});
  });

  it("reads tapped list rows and template buttons by id", () => {
    expect(parseIncoming({ type: "interactive", interactive: { type: "list_reply", list_reply: { id: "slot:2030-07-01:10:00", title: "Mon 1 Jul, 10:00" } } }))
      .toEqual({ text: "Mon 1 Jul, 10:00", buttonId: "slot:2030-07-01:10:00" });
    expect(parseIncoming({ type: "button", button: { text: "I'll be there", payload: "rem:confirm:DL-X" } }))
      .toEqual({ text: "I'll be there", buttonId: "rem:confirm:DL-X" });
  });

  it("uses a shared pin as the pickup, with exact coordinates", async () => {
    aiSays("Got it!\n[ACTION:NULL]\n{}");
    await chat("📍 Shared location: Hanley Bus Station", { location: { lat: 53.03, long: -2.18, label: "Hanley Bus Station" } });
    expect(aiService.pendingContext["4471"]).toMatchObject({
      pickupAddress: "Hanley Bus Station",
      pickupCoords: { lat: 53.03, long: -2.18 },
    });
  });

  it("books with the pin's coordinates instead of geocoding", async () => {
    aiService.pendingContext["4471"] = { pickupAddress: "Hanley Bus Station", pickupCoords: { lat: 53.03, long: -2.18 } };
    Booking.create.mockImplementation(async (doc) => ({ ...doc, _id: "b1" }));
    aiSays('Booking.\n[ACTION:BOOK]\n{"date":"2030-07-01","time":"10:00","pickupAddress":"Hanley Bus Station"}');

    await chat("yes");

    expect(Booking.create).toHaveBeenCalledWith(expect.objectContaining({
      pickupLocation: { address: "Hanley Bus Station", latitude: 53.03, longitude: -2.18 },
    }));
    expect(require("../../src/services/mapsService").getCoordinatesFromPostalCode).not.toHaveBeenCalledWith("Hanley Bus Station");
  });

  it("replies politely to voice notes without calling the AI", async () => {
    const spy = jest.spyOn(aiService, "getResponse");
    const replies = await chat("", { unsupportedType: "audio" });
    expect(spy).not.toHaveBeenCalled();
    expect(replies[0]).toContain("I can only read text messages and shared locations");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.7 tappable options", () => {
  it("sends offered times as a list", async () => {
    aiSays('Here are the times for Monday:\n[ACTION:NULL]\n{"offerDate":"2030-07-01","offerSlots":["09:00","10:00","bad"]}');
    const [reply] = await chat("what's free monday?");
    expect(reply.interactive.type).toBe("list");
    expect(reply.interactive.body).toBe("Here are the times for Monday:");
    expect(reply.interactive.rows).toEqual([
      { id: "slot:2030-07-01:09:00", title: "Mon 1 Jul, 9:00 am" },
      { id: "slot:2030-07-01:10:00", title: "Mon 1 Jul, 10:00 am" },
    ]);
  });

  it("a tapped time reaches the AI as an exact request", async () => {
    const spy = aiSays("Great\n[ACTION:NULL]\n{}");
    await chat("Mon 1 Jul, 10:00", { buttonId: "slot:2030-07-01:10:00" });
    expect(spy.mock.calls[0][0]).toBe("I'd like 10:00 on 2030-07-01");
  });

  it("sends yes/no buttons when Donna asks to confirm", async () => {
    aiSays('Shall I book Monday 10:00 from ST5 1AB?\n[ACTION:NULL]\n{"askConfirm":true}');
    const [reply] = await chat("monday 10");
    expect(reply.interactive.buttons.map((b) => b.title)).toEqual(["Yes, book it", "No, change it"]);
  });

  it("uses WhatsApp list and button messages for real chats", async () => {
    aiSays('Pick one:\n[ACTION:NULL]\n{"offerDate":"2030-07-01","offerSlots":["09:00","10:00"]}');
    await webhookController.handleIncomingMessage("4471", "times?", "inst-1");
    expect(whatsappService.sendList).toHaveBeenCalledWith(
      "4471", "Pick one:", "Choose a time", expect.arrayContaining([expect.objectContaining({ id: "slot:2030-07-01:09:00" })]), mockInstructor
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("2.8 menus for lesson types, moving and cancelling", () => {
  const lesson = (id, days, time = "10:00", extra = {}) => ({
    bookingId: id, userPhone: "4471", instructorId: "inst-1", status: "confirmed",
    date: inHours(days * 24).date, time, lessonTypeName: "Standard", pickupLocation: { address: "ST5 1AB" },
    save: jest.fn(), ...extra,
  });
  const bookingsAre = (list) => Booking.find.mockReturnValue({ sort: () => Promise.resolve(list) });

  it("shows lesson types as a tappable list with prices", async () => {
    db.isDbReady.mockReturnValue(true);
    LessonType.find.mockReturnValue({ sort: () => ({ lean: () => Promise.resolve([
      { _id: "lt-std", name: "Standard", price: 40, description: "" },
      { _id: "lt-mwy", name: "Motorway", price: 55, description: "Dual carriageways too" },
    ]) }) });
    aiSays('Which lesson would you like?\n[ACTION:NULL]\n{"offerLessonTypes":true}');

    const [reply] = await chat("book a lesson");

    expect(reply.interactive.type).toBe("list");
    expect(reply.interactive.rows).toEqual([
      { id: "lt:lt-std", title: "Standard", description: "£40" },
      { id: "lt:lt-mwy", title: "Motorway", description: "£55 · Dual carriageways too" },
    ]);
  });

  it("a tapped lesson type reaches Donna as the learner's choice", async () => {
    LessonType.findOne.mockReturnValue({ lean: () => ({ catch: () => Promise.resolve({ _id: "lt-mwy", name: "Motorway" }) }) });
    const spy = aiSays("Great\n[ACTION:NULL]\n{}");
    await chat("Motorway", { buttonId: "lt:lt-mwy" });
    expect(spy.mock.calls[0][0]).toBe("I'd like the Motorway lesson");
  });

  it("cancel without saying which lesson lists their lessons to tap", async () => {
    bookingsAre([lesson("DL-AAA001", 5), lesson("DL-BBB002", 8, "14:00")]);
    aiSays("Sure\n[ACTION:CANCEL_BOOKING]\n{}");

    const replies = await chat("cancel my lesson");

    const list = replies[1];
    expect(list.text).toMatch(/^Which lesson would you like to cancel\?/);
    expect(list.interactive.rows.map((r) => r.id)).toEqual(["cancelpick:DL-AAA001", "cancelpick:DL-BBB002"]);
    expect(list.interactive.rows[0].description).toBe("Standard · ST5 1AB");
  });

  it("tapping a lesson asks to confirm, and only Yes cancels it", async () => {
    const b = lesson("DL-AAA001", 5);
    Booking.findOne.mockResolvedValue(b);

    const [ask] = await chat("Thu, 10:00", { buttonId: "cancelpick:DL-AAA001" });
    expect(ask.interactive.buttons.map((x) => x.id)).toEqual(["cancelyes:DL-AAA001", "cancelno"]);
    expect(b.status).toBe("confirmed");

    const [done] = await chat("Yes, cancel it", { buttonId: "cancelyes:DL-AAA001" });
    expect(b.status).toBe("cancelled");
    expect(done).toContain("cancelled successfully");
  });

  it("a late lesson goes straight to the fee warning instead of a second question", async () => {
    mockInstructor.botSettings = { cancellationNoticeHours: 48, lateCancellationFee: 35 };
    Booking.findOne.mockResolvedValue(lesson("DL-LATE02", 0.4));
    const [reply] = await chat("pick", { buttonId: "cancelpick:DL-LATE02" });
    expect(reply.text).toContain("may be charged £35");
    expect(reply.interactive.buttons[0].id).toBe("latecancel:yes:DL-LATE02");
  });

  it("with one lesson, skips the list and asks to confirm", async () => {
    bookingsAre([lesson("DL-ONE001", 5)]);
    aiSays("Sure\n[ACTION:CANCEL_BOOKING]\n{}");
    const replies = await chat("cancel my lesson");
    expect(replies[1].interactive.buttons.map((x) => x.id)).toEqual(["cancelyes:DL-ONE001", "cancelno"]);
  });

  it("move without saying which lesson lists them, then asks what to change", async () => {
    bookingsAre([lesson("DL-AAA001", 5), lesson("DL-BBB002", 8, "14:00")]);
    aiSays("Sure\n[ACTION:UPDATE_BOOKING]\n{}");
    const replies = await chat("move my lesson");
    expect(replies[1].interactive.rows.map((r) => r.id)).toEqual(["movepick:DL-AAA001", "movepick:DL-BBB002"]);

    Booking.findOne.mockResolvedValue(lesson("DL-BBB002", 8, "14:00"));
    const [ask] = await chat("pick", { buttonId: "movepick:DL-BBB002" });
    expect(ask.text).toMatch(/Let's sort out your lesson/);
    expect(ask.interactive.rows.map((r) => r.id)).toEqual(expect.arrayContaining(["bf:mv:when", "bf:mv:place"]));
    // Donna knows which lesson is moving
    expect(aiService.pendingContext["4471"].flow.bookingId).toBe("DL-BBB002");
  });

  it("my bookings ends with Move / Cancel / Book buttons, hiding ones the instructor turned off", async () => {
    mockInstructor.botSettings = { allowCancel: false };
    bookingsAre([lesson("DL-AAA001", 5)]);
    aiSays("Here you go\n[ACTION:SHOW_BOOKINGS]");
    const replies = await chat("my bookings");
    const last = replies[replies.length - 1];
    expect(last.interactive.buttons.map((x) => x.id)).toEqual(["menu:move", "menu:book"]);
  });

  it("remembers a date Donna worked out, so the next turn checks real availability", async () => {
    aiSays('That would be Wednesday 21st.\n[ACTION:NULL]\n{"date":"2030-10-21"}');
    await chat("how about next wed");
    expect(aiService.pendingContext["4471"]).toMatchObject({ date: "2030-10-21" });
  });

  it("ignores past dates in Donna's JSON", async () => {
    aiSays('Okay.\n[ACTION:NULL]\n{"date":"2001-01-01"}');
    await chat("hmm");
    expect(aiService.pendingContext["4471"]?.date).toBeUndefined();
  });

  it("respects the instructor's settings on taps too", async () => {
    mockInstructor.botSettings = { allowCancel: false };
    const [reply] = await chat("pick", { buttonId: "cancelpick:DL-AAA001" });
    expect(reply).toContain("please contact Sam directly");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Handover to the instructor", () => {
  it("pauses Donna for the learner and tells the instructor", async () => {
    db.isDbReady.mockReturnValue(true);
    aiSays("Of course.\n[ACTION:HANDOVER]\n{}");
    const replies = await chat("can I talk to Sam please");
    expect(User.updateOne).toHaveBeenCalledWith(
      { phone: "4471", instructorId: "inst-1" }, { $set: { "schedulingPrefs.donnaPaused": true } }
    );
    expect(Notification.create).toHaveBeenCalledWith(expect.objectContaining({ type: "handover", learnerPhone: "4471" }));
    expect(replies[1]).toContain("I've let Sam know");
  });

  it("just points them to the instructor when handover is off", async () => {
    mockInstructor.botSettings = { handover: false };
    aiSays("Sure.\n[ACTION:HANDOVER]\n{}");
    const replies = await chat("talk to a human");
    expect(User.updateOne).not.toHaveBeenCalled();
    expect(replies[1]).toContain("reach Sam directly");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Messages to a number with no instructor", () => {
  it("tells the learner the number isn't linked, instead of going silent", async () => {
    const getInstructor = require("../../src/models/instructorModel").getInstructor;
    getInstructor.mockResolvedValueOnce(null);
    const replies = [];
    await webhookController.handleIncomingMessage("4479", "hi", "unassigned-number", true, (r) => replies.push(r));
    expect(replies).toEqual([expect.stringContaining("isn't linked to a Donna Drive instructor")]);
  });

  it("says it at most once an hour to the same learner", async () => {
    const getInstructor = require("../../src/models/instructorModel").getInstructor;
    getInstructor.mockResolvedValue(null);
    const replies = [];
    await webhookController.handleIncomingMessage("4478", "hi", "unassigned-2", true, (r) => replies.push(r));
    await webhookController.handleIncomingMessage("4478", "hello?", "unassigned-2", true, (r) => replies.push(r));
    expect(replies).toHaveLength(1);
    getInstructor.mockImplementation(async () => mockInstructor);
  });

  it("uses the number's own token from the pool for real WhatsApp replies", async () => {
    const getInstructor = require("../../src/models/instructorModel").getInstructor;
    getInstructor.mockResolvedValueOnce(null);
    db.isDbReady.mockReturnValue(true);
    const PhoneNumber = require("../../src/models/phoneNumberModel");
    jest.spyOn(PhoneNumber, "findOne").mockReturnValue({ lean: async () => ({ phoneNumberId: "pool-1", whatsappToken: "pool-token" }) });

    await webhookController.handleIncomingMessage("4477", "hi", "pool-1");

    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      "4477",
      expect.stringContaining("isn't linked to a Donna Drive instructor"),
      { phoneNumberId: "pool-1", whatsappToken: "pool-token" }
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Google Calendar access expired", () => {
  beforeEach(() => {
    mockInstructor.calendarTokenExpired = true;
  });
  afterEach(() => {
    delete mockInstructor.calendarTokenExpired;
    webhookController._donnaOffReplies.clear(); // the "once an hour" reply memory
  });

  it("Donna pauses: tells the learner to contact the instructor and doesn't run the AI or book", async () => {
    const ai = jest.spyOn(aiService, "getResponse");
    const replies = await chat("can I book friday at 10?");
    expect(replies).toEqual(["Sorry, Sam isn't taking bookings through Donna right now. Please contact them directly."]);
    expect(ai).not.toHaveBeenCalled();
  });

  it("starts again by herself once the calendar is reconnected", async () => {
    delete mockInstructor.calendarTokenExpired;
    const ai = jest.spyOn(aiService, "getResponse").mockResolvedValue("Hi! How can I help?\n[ACTION:NULL]\n{}");
    await chat("hi, can you help me with a lesson?");
    expect(ai).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("Donna switched off by the instructor", () => {
  beforeEach(() => {
    mockInstructor.botSettings = { donnaEnabled: false };
  });

  it("tells the learner to contact the instructor and doesn't run the AI", async () => {
    const ai = jest.spyOn(aiService, "getResponse");
    const replies = await chat("can I book friday?");
    expect(replies).toEqual(["Sorry, Sam isn't taking bookings through Donna right now. Please contact them directly."]);
    expect(ai).not.toHaveBeenCalled();
  });

  it("says it at most once an hour, but keeps passing messages on", async () => {
    await chat("hello?");
    const second = await chat("anyone there?");
    expect(second).toEqual([]);
  });

  it("forwards real messages to the instructor (portal bell + email)", async () => {
    const { notifyInstructorLearnerMessage } = require("../../src/utils/emailNotifier");
    const notify = jest.spyOn(notificationService, "notify").mockResolvedValue();
    await webhookController.handleIncomingMessage("4471", "I'm running late", "inst-1", false, null, { messageId: "wamid.off1" });
    expect(notifyInstructorLearnerMessage).toHaveBeenCalledWith(mockInstructor, expect.anything(), "I'm running late", { reason: "off" });
    expect(notify).toHaveBeenCalledWith(mockInstructor, expect.objectContaining({ type: "paused_message", message: expect.stringContaining("Donna is switched off") }));
  });

  it("holds reminders while she's off", async () => {
    db.isDbReady.mockReturnValue(true);
    const soon = inHours(22);
    Booking.find.mockReturnValue({ lean: async () => [{ _id: "b1", bookingId: "DL-OFF001", userPhone: "4471", instructorId: "inst-1", status: "confirmed", ...soon, reminderSentAt: null, shortReminderSentAt: null }] });
    Booking.findOneAndUpdate = jest.fn();
    await reminders.runOnce();
    expect(Booking.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("doesn't offer freed slots to the waiting list while she's off", async () => {
    db.isDbReady.mockReturnValue(true);
    WaitlistEntry.find.mockReturnValue({ lean: async () => [{ phone: "4472", status: "waiting" }] });
    const offered = await waitlistService.offerSlot(mockInstructor, inHours(100).date, "10:00");
    expect(offered).toEqual([]);
    expect(WaitlistEntry.find).not.toHaveBeenCalled();
  });
});
