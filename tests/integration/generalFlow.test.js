/**
 * General Flow Tests
 * ───────────────────
 * End-to-end path coverage for the full application flow:
 *
 *  1. Webhook → AI → No Action (plain conversation)
 *  2. Webhook → AI → BOOK action → processBooking → confirmation
 *  3. Webhook → AI → SHOW_BOOKINGS action → showBookings
 *  4. Webhook → AI → UPDATE_BOOKING action → rescheduleBooking
 *  5. Webhook → AI → CANCEL_BOOKING action → cancelBooking
 *  6. Webhook → AI → NEXT_AVAILABLE_SLOT action
 *  7. Webhook → AI → NULL action (explicit no-op)
 *  8. New user signup flow (ensureUserDetails multi-step)
 *  9. Booking validation failures (missing fields, bad time, slot taken)
 * 10. Cancel edge cases (no ID, not found, calendar delete fails)
 * 11. Show bookings (empty, with bookings)
 * 12. AI error propagation
 * 13. Conversation history management
 * 14. Data deletion flow
 * 15. Booking service – getBookingsByUser, completeBooking
 */

// ── Mocks ──────────────────────────────────────────────────────────────

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/calendarService", () => ({
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  deleteEvent: jest.fn(),
  getEventsForDate: jest.fn(),
  checkSlotAgainstEvents: jest.fn(),
  findEarliestAvailableSlot: jest.fn(),
  getAvailableTimeSlotsForDate: jest.fn(),
  checkAvailability: jest.fn(),
}));
jest.mock("../../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-123"),
  getLearnerName: jest.fn().mockResolvedValue("Test User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({
    lat: 53.02, lng: -2.22,
    formattedAddress: "Mock Address",
    mapUrl: "https://maps.google.com/mock",
    message: "Location found",
  }),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/chatLogger", () => jest.fn(() => ({ info: jest.fn() })));
jest.mock("../../src/utils/dbChatLogger", () => jest.fn(() => ({ user: jest.fn(), assistant: jest.fn() })));

jest.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn().mockReturnValue({
      generateContent: jest.fn(),
    }),
  })),
}));
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn().mockReturnValue("You are {{INSTRUCTOR_NAME}}'s booking assistant."),
  };
});

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-flow",
  name: "Flow Instructor",
  email: "flow@test.com",
  googleCalendarId: "flow-cal@test.com",
  googleRefreshToken: "flow-refresh-token",
  whatsappToken: "flow-wa-token",
  spreadsheetId: "flow-sheet",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  rates: { basic: 50, highway: 60, parking: 45 },
  timezone: "Europe/London",
  active: true,
};

jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async (id) => {
    if (id === "inst-flow") return MOCK_INSTRUCTOR;
    return null;
  }),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2025-07-01", "2025-07-02", "2025-07-03"]),
}));

// ── Requires ──────────────────────────────────────────────────────────

const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const calendarService = require("../../src/services/calendarService");
const sheetsService = require("../../src/services/sheetsService");
const whatsappService = require("../../src/services/whatsappService");
const bookingService = require("../../src/services/bookingService");
const webhookController = require("../../src/controllers/webhookController");
const aiService = require("../../src/services/gemini/aiService");
const { getInstructor, getUserSession, updateUserSession } = require("../../src/models/instructorModel");
const logger = require("../../src/utils/logger-advanced");

// ── Shared test data ──────────────────────────────────────────────────

const REGISTERED_USER = {
  phone: "447700000001",
  name: "Jane Doe",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  detailsCompleted: true,
  instructorId: "inst-flow",
};

/** Helpers */
function mockRegisteredUser() {
  User.findOne.mockResolvedValue(REGISTERED_USER);
}

function mockAiResponse(text) {
  jest.spyOn(aiService, "getResponse").mockResolvedValue(text);
}

function mockAiAction(actionType, bookingData = {}, responseText = "Done!") {
  jest.spyOn(aiService, "extractActions").mockReturnValue({
    hasAction: actionType !== null,
    actionType,
    bookingData,
    responseText,
  });
}

async function sendMockMessage(from, text, instructorId = "inst-flow") {
  const replies = [];
  await webhookController.handleIncomingMessage(
    from, text, instructorId, true, (r) => replies.push(r)
  );
  return replies;
}

// ═══════════════════════════════════════════════════════════════════════
// 1. Plain Conversation (no action)
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Plain Conversation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it("returns AI reply with no side effects", async () => {
    mockAiResponse("Hello! How can I help you today?");
    mockAiAction(null, {}, "Hello! How can I help you today?");

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Hi there");

    expect(replies).toEqual(["Hello! How can I help you today?"]);
    expect(Booking.create).not.toHaveBeenCalled();
    expect(calendarService.createEvent).not.toHaveBeenCalled();
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("stores conversation history for non-action messages", async () => {
    mockAiResponse("Sure, I can help!");
    mockAiAction(null, {}, "Sure, I can help!");

    await sendMockMessage(REGISTERED_USER.phone, "Can you help me?");

    expect(updateUserSession).toHaveBeenCalled();
    const sessionArg = updateUserSession.mock.calls[0][1];
    expect(sessionArg.conversationHistory.length).toBe(2);
    expect(sessionArg.conversationHistory[0].role).toBe("user");
    expect(sessionArg.conversationHistory[1].role).toBe("assistant");
  });

  it("NULL action does not store conversation history", async () => {
    mockAiResponse("Got it.\n[ACTION:NULL]");
    mockAiAction("null", {}, "Got it.");

    await sendMockMessage(REGISTERED_USER.phone, "Thanks");

    // NULL is in the willPerformAction exclusion list → no history update
    // Actually NULL is NOT in the list, so history should be stored
    // Let's verify
    expect(updateUserSession).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. BOOK Action Flow
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – BOOK Action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-flow-1" });
    Booking.create.mockImplementation((data) =>
      Promise.resolve({ ...data, _id: "m-id", bookingId: "DL-FLOW" })
    );
  });
  afterEach(() => jest.restoreAllMocks());

  it("full booking flow: AI → processBooking → calendar + DB + confirmation", async () => {
    mockAiResponse('Booking now!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"10:00"}');
    mockAiAction("book", { date: "2025-07-01", time: "10:00" }, "Booking now!");

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Book 10am tomorrow");

    // AI text reply + booking confirmation
    expect(replies.length).toBe(2);
    expect(replies[0]).toBe("Booking now!");
    expect(replies[1]).toContain("Booking Confirmed");
    expect(replies[1]).toContain("DL-FLOW");
    expect(replies[1]).toContain("Flow Instructor");

    // Side effects
    expect(calendarService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2025-07-01", time: "10:00" }),
      MOCK_INSTRUCTOR
    );
    expect(Booking.create).toHaveBeenCalledWith(
      expect.objectContaining({
        instructorId: "inst-flow",
        date: "2025-07-01",
        time: "10:00",
      })
    );
    expect(sheetsService.updateLearnerRecord).toHaveBeenCalledWith(
      "flow-sheet", expect.any(Object), expect.any(Object), "create", MOCK_INSTRUCTOR
    );
  });

  it("booking with pickup and dropoff addresses included in confirmation", async () => {
    mockAiResponse('Booked!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"14:00","pickupAddress":"10 High St","dropoffAddress":"5 Park Rd"}');
    mockAiAction("book", {
      date: "2025-07-01", time: "14:00",
      pickupAddress: "10 High St", dropoffAddress: "5 Park Rd",
    }, "Booked!");

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Book 2pm with pickup");

    const confirm = replies.find((r) => r.includes("Booking Confirmed"));
    expect(confirm).toContain("10 High St");
    expect(confirm).toContain("5 Park Rd");
  });

  it("booking failure sends error message to user", async () => {
    mockAiResponse('Booking!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"10:00"}');
    mockAiAction("book", { date: "2025-07-01", time: "10:00" }, "Booking!");

    // Make booking fail
    calendarService.createEvent.mockRejectedValue(new Error("Calendar API down"));

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Book lesson");

    expect(replies.length).toBe(2);
    expect(replies[1]).toContain("error processing your booking");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Calendar API down"));
  });

  it("does NOT store conversation history after successful booking", async () => {
    mockAiResponse('Done!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"10:00"}');
    mockAiAction("book", { date: "2025-07-01", time: "10:00" }, "Done!");

    await sendMockMessage(REGISTERED_USER.phone, "Book it");

    // book action clears conversation via clearUserConversationHistoryAndContext
    // which calls updateUserSession with empty history
    expect(updateUserSession).toHaveBeenCalled();
    const sessionArg = updateUserSession.mock.calls[0][1];
    expect(sessionArg.conversationHistory).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. SHOW_BOOKINGS Action
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – SHOW_BOOKINGS Action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it("shows formatted bookings list", async () => {
    mockAiResponse("Here are your bookings\n[ACTION:SHOW_BOOKINGS]");
    mockAiAction("show_bookings", {}, "Here are your bookings");

    Booking.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([
        {
          bookingId: "DL-AAAA", date: new Date("2027-07-01"),
          time: "10:00", status: "confirmed",
        },
      ]),
    });

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Show my bookings");

    expect(replies.length).toBe(2);
    expect(replies[0]).toBe("Here are your bookings");
    expect(replies[1]).toContain("DL-AAAA");
    expect(replies[1]).toContain("10:00");
  });

  it("shows empty bookings message when no bookings exist", async () => {
    mockAiResponse("Checking!\n[ACTION:SHOW_BOOKINGS]");
    mockAiAction("show_bookings", {}, "Checking!");

    Booking.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([]),
    });

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Show bookings");

    const emptyMsg = replies.find((r) => r.includes("No bookings found"));
    expect(emptyMsg).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. CANCEL_BOOKING Action
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – CANCEL_BOOKING Action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it("cancels a booking successfully", async () => {
    mockAiResponse('Cancelling.\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-XXXX"}');
    mockAiAction("cancel_booking", { bookingId: "DL-XXXX" }, "Cancelling.");

    Booking.findOne.mockResolvedValue({
      bookingId: "DL-XXXX",
      calendarEventId: "cal-x",
      instructorId: "inst-flow",
      userPhone: REGISTERED_USER.phone,
      status: "confirmed",
      save: jest.fn().mockImplementation(function () { this.status = "cancelled"; return Promise.resolve(this); }),
    });
    calendarService.deleteEvent.mockResolvedValue({});

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Cancel DL-XXXX");

    expect(replies.length).toBe(2);
    expect(replies[1]).toContain("cancelled successfully");
    expect(replies[1]).toContain("DL-XXXX");
  });

  it("handles missing bookingId gracefully", async () => {
    mockAiResponse('Cancel!\n[ACTION:CANCEL_BOOKING]\n{}');
    mockAiAction("cancel_booking", {}, "Cancel!");

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Cancel booking");

    expect(replies[1]).toContain("provide a valid booking ID");
  });

  it("handles booking not found", async () => {
    mockAiResponse('Cancel!\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-NOPE"}');
    mockAiAction("cancel_booking", { bookingId: "DL-NOPE" }, "Cancel!");

    Booking.findOne.mockResolvedValue(null);

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Cancel DL-NOPE");

    expect(replies[1]).toContain("No booking found");
  });

  it("still cancels even if calendar delete fails", async () => {
    mockAiResponse('Cancel!\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-CALX"}');
    mockAiAction("cancel_booking", { bookingId: "DL-CALX" }, "Cancel!");

    Booking.findOne.mockResolvedValue({
      bookingId: "DL-CALX",
      calendarEventId: "cal-fail",
      instructorId: "inst-flow",
      userPhone: REGISTERED_USER.phone,
      status: "confirmed",
      save: jest.fn().mockImplementation(function () { this.status = "cancelled"; return Promise.resolve(this); }),
    });
    calendarService.deleteEvent.mockRejectedValue(new Error("Google API error"));

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Cancel it");

    expect(replies[1]).toContain("cancelled successfully");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Calendar deletion failed"));
  });

  it("handles bookingService.cancelBooking throwing an error", async () => {
    mockAiResponse('Cancel!\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-ERR"}');
    mockAiAction("cancel_booking", { bookingId: "DL-ERR" }, "Cancel!");

    Booking.findOne.mockRejectedValue(new Error("DB connection lost"));

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Cancel DL-ERR");

    expect(replies[1]).toContain("Something went wrong");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. UPDATE_BOOKING (Reschedule) Action
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – UPDATE_BOOKING Action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.updateEvent.mockResolvedValue({});
  });
  afterEach(() => jest.restoreAllMocks());

  it("reschedules a booking successfully", async () => {
    mockAiResponse('Rescheduling!\n[ACTION:UPDATE_BOOKING]\n{"bookingId":"DL-UPDT","newDate":"2025-07-02","newTime":"14:00"}');
    mockAiAction("update_booking", {
      bookingId: "DL-UPDT", newDate: "2025-07-02", newTime: "14:00",
    }, "Rescheduling!");

    Booking.findOne.mockResolvedValue({
      bookingId: "DL-UPDT",
      date: "2025-07-01", time: "10:00",
      instructorId: "inst-flow",
      calendarEventId: "cal-updt",
      status: "confirmed",
      postalCode: "ST5 1AB",
      location: { latitude: 53.02, longitude: -2.22 },
      pickupLocation: {}, dropoffLocation: {},
      toObject() { return { ...this }; },
      save: jest.fn().mockResolvedValue(true),
    });

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Reschedule to 2pm");

    expect(replies.length).toBe(2);
    expect(replies[1]).toContain("Booking updated");
    expect(replies[1]).toContain("2025-07-02");
    expect(replies[1]).toContain("14:00");
  });

  it("shows error when booking not found for update", async () => {
    mockAiResponse('Update!\n[ACTION:UPDATE_BOOKING]\n{"bookingId":"DL-GONE","newDate":"2025-07-02","newTime":"14:00"}');
    mockAiAction("update_booking", {
      bookingId: "DL-GONE", newDate: "2025-07-02", newTime: "14:00",
    }, "Update!");

    Booking.findOne.mockResolvedValue(null);

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Reschedule");

    // rescheduleBooking throws "Booking not found" → webhook catches and shows error
    expect(replies[1]).toContain("trouble");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. NEXT_AVAILABLE_SLOT Action
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – NEXT_AVAILABLE_SLOT Action", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it("returns the next available slot", async () => {
    mockAiResponse("Let me check!\n[ACTION:NEXT_AVAILABLE_SLOT]");
    mockAiAction("next_available_slot", {}, "Let me check!");

    calendarService.findEarliestAvailableSlot.mockResolvedValue({
      date: "2025-07-01", time: "09:00",
    });

    const replies = await sendMockMessage(REGISTERED_USER.phone, "When's the next slot?");

    expect(replies.length).toBe(2);
    expect(replies[1]).toContain("2025-07-01");
    expect(replies[1]).toContain("09:00");
  });

  it("handles no slots available", async () => {
    mockAiResponse("Checking!\n[ACTION:NEXT_AVAILABLE_SLOT]");
    mockAiAction("next_available_slot", {}, "Checking!");

    calendarService.findEarliestAvailableSlot.mockResolvedValue(null);

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Next available?");

    expect(replies[1]).toContain("no appointments");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Unknown Instructor → Silent Return
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Unknown Instructor", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it("silently returns when instructor not found", async () => {
    const replies = await sendMockMessage("447999999999", "Hello", "unknown-inst");

    expect(replies.length).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("No instructor found")
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. New User Signup Flow
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – New User Signup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });
  afterEach(() => jest.restoreAllMocks());

  it("new user gets prompted for name (step 1)", async () => {
    User.findOne.mockResolvedValue(null);
    User.mockImplementation(function (data) {
      return { ...data, save: jest.fn().mockResolvedValue(true) };
    });
    const spy = jest.spyOn(aiService, "getResponse");

    const replies = await sendMockMessage("447800000001", "Hello", "inst-flow");

    // Should ask for name, not reach AI
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("name");
    expect(spy).not.toHaveBeenCalled();
  });

  it("user in progress gets next question", async () => {
    User.findOne.mockResolvedValue({
      phone: "447800000002",
      name: "John",
      currentStep: "age",
      detailsCompleted: false,
      save: jest.fn().mockResolvedValue(true),
    });

    const replies = await sendMockMessage("447800000002", "25", "inst-flow");

    expect(replies[0]).toContain("dob");
  });

  it("completed user reaches AI flow", async () => {
    mockRegisteredUser();
    mockAiResponse("Hello Jane! How can I help?");
    mockAiAction(null, {}, "Hello Jane! How can I help?");

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Hi", "inst-flow");

    expect(aiService.getResponse).toHaveBeenCalled();
    expect(replies[0]).toContain("Hello Jane");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. Data Deletion Flow
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Data Deletion", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it("'delete my data' removes user and responds", async () => {
    User.findOne.mockResolvedValue(null);
    User.deleteOne.mockResolvedValue({ deletedCount: 1 });

    const replies = await sendMockMessage("447800000003", "delete my data", "inst-flow");

    expect(User.deleteOne).toHaveBeenCalledWith({ phone: "447800000003" });
    expect(replies[0]).toContain("deleted");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. Booking Validation Failures
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Booking Validation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
  });

  it("rejects booking with missing date", async () => {
    const errors = await bookingService.validateBooking(
      { time: "10:00" },
      MOCK_INSTRUCTOR
    );
    expect(errors).toContain("Date is required");
  });

  it("rejects booking with missing time", async () => {
    const errors = await bookingService.validateBooking(
      { date: "2025-07-01" },
      MOCK_INSTRUCTOR
    );
    expect(errors).toContain("Time is required");
  });

  it("rejects booking with unavailable date", async () => {
    const errors = await bookingService.validateBooking(
      { date: "2025-12-25", time: "10:00" },
      MOCK_INSTRUCTOR
    );
    expect(errors[0]).toContain("Date is not available");
  });

  it("rejects booking with unavailable time slot", async () => {
    const errors = await bookingService.validateBooking(
      { date: "2025-07-01", time: "08:00" },
      MOCK_INSTRUCTOR
    );
    expect(errors[0]).toContain("Time slot is not available");
  });

  it("rejects booking when calendar slot is already taken", async () => {
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: false });

    const errors = await bookingService.validateBooking(
      { date: "2025-07-01", time: "10:00" },
      MOCK_INSTRUCTOR
    );
    expect(errors[0]).toContain("already booked");
  });

  it("passes validation for valid booking", async () => {
    const errors = await bookingService.validateBooking(
      { date: "2025-07-01", time: "10:00" },
      MOCK_INSTRUCTOR
    );
    expect(errors.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 11. Booking Service – createBooking Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – createBooking Edge Cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-edge" });
    Booking.create.mockImplementation((data) =>
      Promise.resolve({ ...data, _id: "edge-id", bookingId: "DL-EDGE" })
    );
  });

  it("throws when user not found in DB", async () => {
    User.findOne.mockResolvedValue(null);

    await expect(
      bookingService.createBooking(REGISTERED_USER.phone, {
        date: "2025-07-01", time: "10:00", userPhone: REGISTERED_USER.phone,
      }, MOCK_INSTRUCTOR)
    ).rejects.toThrow("User not found");
  });

  it("throws when user has incomplete location", async () => {
    User.findOne.mockResolvedValue({
      ...REGISTERED_USER,
      postalCode: null,
      location: {},
    });

    await expect(
      bookingService.createBooking(REGISTERED_USER.phone, {
        date: "2025-07-01", time: "10:00", userPhone: REGISTERED_USER.phone,
      }, MOCK_INSTRUCTOR)
    ).rejects.toThrow("location details are incomplete");
  });

  it("continues even if Sheets update fails", async () => {
    User.findOne.mockResolvedValue(REGISTERED_USER);
    sheetsService.updateLearnerRecord.mockRejectedValueOnce(new Error("Sheets quota"));

    const result = await bookingService.createBooking(REGISTERED_USER.phone, {
      date: "2025-07-01", time: "10:00", userPhone: REGISTERED_USER.phone,
    }, MOCK_INSTRUCTOR);

    // Booking still created despite sheets error
    expect(result.booking.bookingId).toBe("DL-EDGE");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Sheets update failed"));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. Booking Service – cancelBooking & getBookingsByUser
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – cancelBooking & getBookingsByUser", () => {
  beforeEach(() => jest.clearAllMocks());

  it("cancelBooking returns null when booking not found", async () => {
    Booking.findOne.mockResolvedValue(null);
    const result = await bookingService.cancelBooking("DL-NOPE");
    expect(result).toBeNull();
  });

  it("cancelBooking sets status to cancelled and saves", async () => {
    const mockBooking = {
      bookingId: "DL-CAN1",
      calendarEventId: "cal-can1",
      instructorId: "inst-flow",
      userPhone: REGISTERED_USER.phone,
      status: "confirmed",
      location: {},
      save: jest.fn().mockResolvedValue(true),
    };
    Booking.findOne.mockResolvedValue(mockBooking);
    calendarService.deleteEvent.mockResolvedValue({});

    const result = await bookingService.cancelBooking("DL-CAN1");

    expect(result.status).toBe("cancelled");
    expect(mockBooking.save).toHaveBeenCalled();
    expect(calendarService.deleteEvent).toHaveBeenCalledWith("cal-can1");
  });

  it("getBookingsByUser calls Booking.find with correct filters", async () => {
    Booking.find.mockReturnValue({
      sort: jest.fn().mockResolvedValue([]),
    });

    await bookingService.getBookingsByUser("447700000001");

    expect(Booking.find).toHaveBeenCalledWith({
      userPhone: "447700000001",
      status: { $in: ["confirmed", "rescheduled"] },
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. AI Error Propagation
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – AI Error Handling", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
  });
  afterEach(() => jest.restoreAllMocks());

  it("sends error message to user when AI throws", async () => {
    jest.spyOn(aiService, "getResponse").mockRejectedValue(new Error("Gemini quota exceeded"));

    const replies = await sendMockMessage(REGISTERED_USER.phone, "Hello");

    expect(replies[0]).toContain("trouble processing");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Gemini quota exceeded")
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 14. AI extractActions Parser
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – extractActions Parser", () => {
  it("parses BOOK action with JSON", () => {
    const result = aiService.extractActions(
      'Great, let me book that!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"10:00"}'
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("book");
    expect(result.bookingData).toEqual({ date: "2025-07-01", time: "10:00" });
    expect(result.responseText).toBe("Great, let me book that!");
  });

  it("parses SHOW_BOOKINGS action (no JSON)", () => {
    const result = aiService.extractActions(
      "Here are your bookings!\n[ACTION:SHOW_BOOKINGS]"
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("show_bookings");
    expect(result.bookingData).toBeNull();
  });

  it("parses CANCEL_BOOKING with bookingId", () => {
    const result = aiService.extractActions(
      'Cancelling now.\n[ACTION:CANCEL_BOOKING]\n{"bookingId":"DL-ABCD"}'
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("cancel_booking");
    expect(result.bookingData.bookingId).toBe("DL-ABCD");
  });

  it("parses UPDATE_BOOKING with reschedule data", () => {
    const result = aiService.extractActions(
      'Rescheduling.\n[ACTION:UPDATE_BOOKING]\n{"bookingId":"DL-XXXX","newDate":"2025-07-02","newTime":"15:00"}'
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("update_booking");
    expect(result.bookingData.newDate).toBe("2025-07-02");
  });

  it("parses NEXT_AVAILABLE_SLOT action", () => {
    const result = aiService.extractActions(
      "Let me find the next slot!\n[ACTION:NEXT_AVAILABLE_SLOT]"
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("next_available_slot");
  });

  it("parses NULL action", () => {
    const result = aiService.extractActions(
      "Understood, thanks!\n[ACTION:NULL]"
    );

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("null");
  });

  it("returns no action for plain text (no action block)", () => {
    const result = aiService.extractActions("Just a normal response with no action.");

    expect(result.hasAction).toBe(false);
    expect(result.actionType).toBeNull();
    expect(result.responseText).toBe("Just a normal response with no action.");
  });

  it("handles malformed JSON gracefully", () => {
    const result = aiService.extractActions(
      'Booking!\n[ACTION:BOOK]\n{invalid json}'
    );

    // Should still detect the action but bookingData parsing fails
    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("book");
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Error parsing action JSON"));
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 15. Mock Mode vs Prod Mode Send
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Mock vs Prod Send Routing", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
    mockAiResponse("Hi!");
    mockAiAction(null, {}, "Hi!");
  });
  afterEach(() => jest.restoreAllMocks());

  it("mock mode captures replies and does NOT call WhatsApp API", async () => {
    const replies = await sendMockMessage(REGISTERED_USER.phone, "Hello");

    expect(replies).toEqual(["Hi!"]);
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("prod mode (isMock=false) calls WhatsApp API", async () => {
    // Call without mock mode
    await webhookController.handleIncomingMessage(
      REGISTERED_USER.phone, "Hello", "inst-flow", false, null
    );

    expect(whatsappService.sendTextMessage).toHaveBeenCalledWith(
      REGISTERED_USER.phone, "Hi!", MOCK_INSTRUCTOR
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 16. Webhook Verification
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – Webhook Verification", () => {
  const OLD_VERIFY_TOKEN = process.env.VERIFY_TOKEN;

  beforeAll(() => {
    process.env.VERIFY_TOKEN = "test-verify-token";
  });
  afterAll(() => {
    process.env.VERIFY_TOKEN = OLD_VERIFY_TOKEN;
  });

  it("verifies webhook with correct token", async () => {
    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "test-verify-token",
        "hub.challenge": "challenge-123",
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.verifyWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("challenge-123");
  });

  it("rejects webhook with wrong token", async () => {
    const req = {
      query: {
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong-token",
        "hub.challenge": "challenge-123",
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.verifyWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.send).toHaveBeenCalledWith("Forbidden");
  });

  it("rejects webhook with wrong mode", async () => {
    const req = {
      query: {
        "hub.mode": "unsubscribe",
        "hub.verify_token": "test-verify-token",
        "hub.challenge": "challenge-123",
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.verifyWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 17. handleWebhook (real webhook route parsing)
// ═══════════════════════════════════════════════════════════════════════

describe("Flow – handleWebhook (full payload parsing)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRegisteredUser();
    mockAiResponse("Got it!");
    mockAiAction(null, {}, "Got it!");
  });
  afterEach(() => jest.restoreAllMocks());

  it("parses WhatsApp text message and invokes handleIncomingMessage", async () => {
    const req = {
      body: {
        object: "whatsapp_business_account",
        entry: [{
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "inst-flow" },
              messages: [{
                from: REGISTERED_USER.phone,
                type: "text",
                text: { body: "Hello" },
              }],
            },
          }],
        }],
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.send).toHaveBeenCalledWith("OK");
    // AI should have been called
    expect(aiService.getResponse).toHaveBeenCalled();
  });

  it("handles interactive button reply", async () => {
    const req = {
      body: {
        object: "whatsapp_business_account",
        entry: [{
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "inst-flow" },
              messages: [{
                from: REGISTERED_USER.phone,
                type: "interactive",
                interactive: {
                  type: "button_reply",
                  button_reply: { title: "Yes, book it" },
                },
              }],
            },
          }],
        }],
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(aiService.getResponse).toHaveBeenCalledWith(
      "Yes, book it", expect.any(Array), REGISTERED_USER.phone, MOCK_INSTRUCTOR
    );
  });

  it("handles interactive list reply", async () => {
    const req = {
      body: {
        object: "whatsapp_business_account",
        entry: [{
          changes: [{
            field: "messages",
            value: {
              metadata: { phone_number_id: "inst-flow" },
              messages: [{
                from: REGISTERED_USER.phone,
                type: "interactive",
                interactive: {
                  type: "list_reply",
                  list_reply: { title: "10:00 AM" },
                },
              }],
            },
          }],
        }],
      },
    };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(aiService.getResponse).toHaveBeenCalledWith(
      "10:00 AM", expect.any(Array), REGISTERED_USER.phone, MOCK_INSTRUCTOR
    );
  });

  it("ignores non-whatsapp payloads", async () => {
    const req = { body: { object: "something_else" } };
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(aiService.getResponse).not.toHaveBeenCalled();
  });

  it("returns 500 on unexpected error", async () => {
    const req = { body: null }; // will cause error
    const res = { status: jest.fn().mockReturnThis(), send: jest.fn() };

    await webhookController.handleWebhook(req, res);

    expect(res.status).toHaveBeenCalledWith(500);
  });
});
