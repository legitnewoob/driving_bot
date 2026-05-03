/**
 * Multi-Instructor Integration Tests
 * ────────────────────────────────────
 * Verifies that the multi-instructor refactor works correctly:
 *
 *  1. Instructor resolution – correct instructor resolved per phone_number_id
 *  2. Instructor isolation – bookings, credentials, and config stay separate
 *  3. Booking flow – createBooking uses the right instructor's calendar & sheets
 *  4. Webhook flow – handleIncomingMessage threads the correct instructor
 *  5. User–instructor linking – new users are linked to the instructor they messaged
 *  6. Reschedule flow – internal instructor lookup from booking's stored instructorId
 *  7. Mock mode – replies captured, not sent to WhatsApp API
 *  8. Unknown instructor – gracefully rejected
 */

// ── Mocks ──────────────────────────────────────────────────────────────

jest.mock("../src/models/bookingModel");
jest.mock("../src/models/userModel");
jest.mock("../src/services/calendarService", () => ({
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  getEventsForDate: jest.fn(),
  checkSlotAgainstEvents: jest.fn(),
  findEarliestAvailableSlot: jest.fn(),
}));
jest.mock("../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-fallback"),
  getLearnerName: jest.fn().mockResolvedValue("Test User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({
    lat: 53.02,
    lng: -2.22,
    formattedAddress: "Mock Address",
    mapUrl: "https://maps.google.com/mock",
    message: "Location found",
  }),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../src/services/whatsappService", () => ({
  sendTextMessage: jest.fn().mockResolvedValue({}),
  sendMessage: jest.fn().mockResolvedValue({}),
}));
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../src/utils/chatLogger", () => jest.fn(() => ({
  info: jest.fn(),
})));
jest.mock("../src/utils/dbChatLogger", () => jest.fn(() => ({
  user: jest.fn(),
  assistant: jest.fn(),
})));

// Mock Gemini so AI calls don't hit the real API
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

// Mock instructorModel – getInstructor returns the correct instructor by phoneNumberId
const INSTRUCTOR_A = {
  phoneNumberId: "phone-A-111",
  name: "Alice Instructor",
  email: "alice@driving.com",
  googleCalendarId: "alice-cal@driving.com",
  googleRefreshToken: "refresh-token-ALICE",
  whatsappToken: "wa-token-ALICE",
  spreadsheetId: "spreadsheet-ALICE",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00"],
  specialties: ["Basic driving", "Parking"],
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  rates: { basic: 45, highway: 55, parking: 40 },
  timezone: "Europe/London",
  active: true,
};

const INSTRUCTOR_B = {
  phoneNumberId: "phone-B-222",
  name: "Bob Instructor",
  email: "bob@driving.com",
  googleCalendarId: "bob-cal@driving.com",
  googleRefreshToken: "refresh-token-BOB",
  whatsappToken: "wa-token-BOB",
  spreadsheetId: "spreadsheet-BOB",
  availableTimes: ["10:00", "12:00", "14:00", "16:00"],
  specialties: ["Highway driving", "City driving"],
  baseLocation: { latitude: 51.5074, longitude: -0.1278 },
  rates: { basic: 50, highway: 65, parking: 50 },
  timezone: "Europe/London",
  active: true,
};

jest.mock("../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async (phoneNumberId) => {
    if (phoneNumberId === "phone-A-111") return INSTRUCTOR_A;
    if (phoneNumberId === "phone-B-222") return INSTRUCTOR_B;
    return null;
  }),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2025-07-01", "2025-07-02", "2025-07-03"]),
}));

// ── Requires (after mocks) ──────────────────────────────────────────────

const Booking = require("../src/models/bookingModel");
const User = require("../src/models/userModel");
const calendarService = require("../src/services/calendarService");
const sheetsService = require("../src/services/sheetsService");
const whatsappService = require("../src/services/whatsappService");
const bookingService = require("../src/services/bookingService");
const webhookController = require("../src/controllers/webhookController");
const aiService = require("../src/services/gemini/aiService");
const { getInstructor } = require("../src/models/instructorModel");
const logger = require("../src/utils/logger-advanced");

// ── Test Data ──────────────────────────────────────────────────────────

const LEARNER_1 = {
  phone: "447000000001",
  name: "Learner One",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  detailsCompleted: true,
  instructorId: "phone-A-111",
};

const LEARNER_2 = {
  phone: "447000000002",
  name: "Learner Two",
  postalCode: "SW1A 1AA",
  location: { latitude: 51.51, longitude: -0.13 },
  detailsCompleted: true,
  instructorId: "phone-B-222",
};

const LEARNER_3 = {
  phone: "447000000003",
  name: "Learner Three",
  postalCode: "ST5 2CD",
  location: { latitude: 53.03, longitude: -2.23 },
  detailsCompleted: true,
  instructorId: "phone-A-111",
};

// ═══════════════════════════════════════════════════════════════════════
// 1. Instructor Resolution
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Instructor Resolution", () => {
  it("resolves Instructor A by phone_number_id", async () => {
    const inst = await getInstructor("phone-A-111");
    expect(inst).toBe(INSTRUCTOR_A);
    expect(inst.name).toBe("Alice Instructor");
    expect(inst.googleRefreshToken).toBe("refresh-token-ALICE");
  });

  it("resolves Instructor B by phone_number_id", async () => {
    const inst = await getInstructor("phone-B-222");
    expect(inst).toBe(INSTRUCTOR_B);
    expect(inst.name).toBe("Bob Instructor");
    expect(inst.googleRefreshToken).toBe("refresh-token-BOB");
  });

  it("returns null for unknown phone_number_id", async () => {
    const inst = await getInstructor("phone-UNKNOWN-999");
    expect(inst).toBeNull();
  });

  it("instructors have different available times", () => {
    expect(INSTRUCTOR_A.availableTimes).not.toEqual(INSTRUCTOR_B.availableTimes);
    expect(INSTRUCTOR_A.availableTimes).toContain("09:00");
    expect(INSTRUCTOR_B.availableTimes).not.toContain("09:00");
    expect(INSTRUCTOR_B.availableTimes).toContain("16:00");
    expect(INSTRUCTOR_A.availableTimes).not.toContain("16:00");
  });

  it("instructors have different base locations", () => {
    expect(INSTRUCTOR_A.baseLocation.latitude).not.toBe(INSTRUCTOR_B.baseLocation.latitude);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Booking Service – Instructor Isolation
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Booking Service Isolation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-evt-mock" });
    Booking.create.mockImplementation((data) =>
      Promise.resolve({ ...data, _id: "mongo-id-" + Math.random().toString(36).slice(2, 6) })
    );
  });

  it("creates a booking under Instructor A with A's credentials", async () => {
    User.findOne.mockResolvedValue(LEARNER_1);

    await bookingService.createBooking(LEARNER_1.phone, {
      date: "2025-07-01",
      time: "09:00",
      userPhone: LEARNER_1.phone,
    }, INSTRUCTOR_A);

    // Calendar event created with Instructor A
    expect(calendarService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2025-07-01", time: "09:00" }),
      INSTRUCTOR_A
    );

    // Booking stored with Instructor A's phoneNumberId
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.instructorId).toBe("phone-A-111");

    // Sheets updated with Instructor A's spreadsheet
    expect(sheetsService.updateLearnerRecord).toHaveBeenCalledWith(
      "spreadsheet-ALICE",
      expect.any(Object),
      expect.any(Object),
      "create",
      INSTRUCTOR_A
    );
  });

  it("creates a booking under Instructor B with B's credentials", async () => {
    User.findOne.mockResolvedValue(LEARNER_2);

    await bookingService.createBooking(LEARNER_2.phone, {
      date: "2025-07-01",
      time: "12:00",
      userPhone: LEARNER_2.phone,
    }, INSTRUCTOR_B);

    // Calendar event created with Instructor B
    expect(calendarService.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({ date: "2025-07-01", time: "12:00" }),
      INSTRUCTOR_B
    );

    // Booking stored with Instructor B's phoneNumberId
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.instructorId).toBe("phone-B-222");

    // Sheets updated with Instructor B's spreadsheet
    expect(sheetsService.updateLearnerRecord).toHaveBeenCalledWith(
      "spreadsheet-BOB",
      expect.any(Object),
      expect.any(Object),
      "create",
      INSTRUCTOR_B
    );
  });

  it("validates time against the CORRECT instructor's available times", async () => {
    // 09:00 is valid for A but NOT for B
    const errorsB = await bookingService.validateBooking({
      date: "2025-07-01",
      time: "09:00",
    }, INSTRUCTOR_B);

    expect(errorsB.length).toBeGreaterThan(0);
    expect(errorsB[0]).toContain("Time slot is not available");

    // 16:00 is valid for B but NOT for A
    const errorsA = await bookingService.validateBooking({
      date: "2025-07-01",
      time: "16:00",
    }, INSTRUCTOR_A);

    expect(errorsA.length).toBeGreaterThan(0);
    expect(errorsA[0]).toContain("Time slot is not available");
  });

  it("allows time 10:00 for BOTH instructors (shared slot)", async () => {
    // 10:00 is in both A and B's availableTimes
    const errorsA = await bookingService.validateBooking({
      date: "2025-07-01",
      time: "10:00",
    }, INSTRUCTOR_A);
    expect(errorsA.length).toBe(0);

    const errorsB = await bookingService.validateBooking({
      date: "2025-07-01",
      time: "10:00",
    }, INSTRUCTOR_B);
    expect(errorsB.length).toBe(0);
  });

  it("two learners book same date/time with DIFFERENT instructors (no conflict)", async () => {
    User.findOne
      .mockResolvedValueOnce(LEARNER_1)
      .mockResolvedValueOnce(LEARNER_2);

    // Learner 1 books 10:00 with Instructor A
    const result1 = await bookingService.createBooking(LEARNER_1.phone, {
      date: "2025-07-01",
      time: "10:00",
      userPhone: LEARNER_1.phone,
    }, INSTRUCTOR_A);

    // Learner 2 books 10:00 with Instructor B (same time, different instructor)
    const result2 = await bookingService.createBooking(LEARNER_2.phone, {
      date: "2025-07-01",
      time: "10:00",
      userPhone: LEARNER_2.phone,
    }, INSTRUCTOR_B);

    // Both bookings created successfully
    expect(Booking.create).toHaveBeenCalledTimes(2);

    // Different instructorIds stored
    expect(Booking.create.mock.calls[0][0].instructorId).toBe("phone-A-111");
    expect(Booking.create.mock.calls[1][0].instructorId).toBe("phone-B-222");

    // Calendar events created with different instructors
    expect(calendarService.createEvent).toHaveBeenCalledTimes(2);
    expect(calendarService.createEvent.mock.calls[0][1]).toBe(INSTRUCTOR_A);
    expect(calendarService.createEvent.mock.calls[1][1]).toBe(INSTRUCTOR_B);
  });

  it("multiple learners under same instructor get same instructorId", async () => {
    User.findOne
      .mockResolvedValueOnce(LEARNER_1)
      .mockResolvedValueOnce(LEARNER_3);

    await bookingService.createBooking(LEARNER_1.phone, {
      date: "2025-07-01",
      time: "09:00",
      userPhone: LEARNER_1.phone,
    }, INSTRUCTOR_A);

    await bookingService.createBooking(LEARNER_3.phone, {
      date: "2025-07-01",
      time: "11:00",
      userPhone: LEARNER_3.phone,
    }, INSTRUCTOR_A);

    expect(Booking.create.mock.calls[0][0].instructorId).toBe("phone-A-111");
    expect(Booking.create.mock.calls[1][0].instructorId).toBe("phone-A-111");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. Webhook Controller – Instructor Routing in Mock Mode
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Webhook Controller (Mock Mode)", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default: user already registered
    User.findOne.mockResolvedValue(LEARNER_1);

    // Default: AI returns a simple text response (no action)
    jest.spyOn(aiService, "getResponse").mockResolvedValue("Hello! How can I help?");
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: false,
      actionType: null,
      bookingData: {},
      responseText: "Hello! How can I help?",
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("resolves Instructor A and sends reply via mock callback", async () => {
    const replies = [];

    await webhookController.handleIncomingMessage(
      LEARNER_1.phone,
      "Hi there",
      "phone-A-111",
      true,
      (reply) => replies.push(reply)
    );

    expect(getInstructor).toHaveBeenCalledWith("phone-A-111");
    expect(replies.length).toBeGreaterThan(0);
    expect(replies[0]).toContain("Hello");

    // In mock mode, WhatsApp API should NOT be called
    expect(whatsappService.sendTextMessage).not.toHaveBeenCalled();
  });

  it("resolves Instructor B for a different learner", async () => {
    User.findOne.mockResolvedValue(LEARNER_2);
    const replies = [];

    await webhookController.handleIncomingMessage(
      LEARNER_2.phone,
      "Hi there",
      "phone-B-222",
      true,
      (reply) => replies.push(reply)
    );

    expect(getInstructor).toHaveBeenCalledWith("phone-B-222");
    expect(replies.length).toBeGreaterThan(0);
  });

  it("silently returns for unknown instructor (no crash)", async () => {
    const replies = [];

    await webhookController.handleIncomingMessage(
      "447999999999",
      "Hello",
      "phone-UNKNOWN-999",
      true,
      (reply) => replies.push(reply)
    );

    expect(getInstructor).toHaveBeenCalledWith("phone-UNKNOWN-999");
    // No reply sent — instructor not found
    expect(replies.length).toBe(0);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("No instructor found")
    );
  });

  it("passes correct instructor to aiService.getResponse", async () => {
    User.findOne.mockResolvedValue(LEARNER_1);
    const replies = [];

    await webhookController.handleIncomingMessage(
      LEARNER_1.phone,
      "Book a lesson",
      "phone-A-111",
      true,
      (reply) => replies.push(reply)
    );

    // aiService.getResponse should receive INSTRUCTOR_A
    expect(aiService.getResponse).toHaveBeenCalledWith(
      "Book a lesson",
      expect.any(Array),
      LEARNER_1.phone,
      INSTRUCTOR_A
    );
  });

  it("passes correct instructor to aiService when Instructor B is used", async () => {
    User.findOne.mockResolvedValue(LEARNER_2);
    const replies = [];

    await webhookController.handleIncomingMessage(
      LEARNER_2.phone,
      "Book a lesson",
      "phone-B-222",
      true,
      (reply) => replies.push(reply)
    );

    expect(aiService.getResponse).toHaveBeenCalledWith(
      "Book a lesson",
      expect.any(Array),
      LEARNER_2.phone,
      INSTRUCTOR_B
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Webhook Controller – Booking Action with Instructor Context
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Booking Action via Webhook", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-evt-webhook" });
    Booking.create.mockImplementation((data) =>
      Promise.resolve({ ...data, _id: "mongo-webhook-id", bookingId: "DL-TEST" })
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("booking through Instructor A creates booking with A's ID", async () => {
    User.findOne.mockResolvedValue(LEARNER_1);

    // AI returns a BOOK action
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Let me book that!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"09:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true,
      actionType: "book",
      bookingData: { date: "2025-07-01", time: "09:00" },
      responseText: "Let me book that!",
    });

    const replies = [];
    await webhookController.handleIncomingMessage(
      LEARNER_1.phone,
      "Book 9am tomorrow",
      "phone-A-111",
      true,
      (reply) => replies.push(reply)
    );

    // Booking created under Instructor A
    expect(Booking.create).toHaveBeenCalled();
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.instructorId).toBe("phone-A-111");

    // Calendar event used Instructor A
    expect(calendarService.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      INSTRUCTOR_A
    );

    // Confirmation reply mentions Alice
    const confirmReply = replies.find((r) => r.includes("Booking Confirmed"));
    expect(confirmReply).toBeDefined();
    expect(confirmReply).toContain("Alice Instructor");
  });

  it("booking through Instructor B creates booking with B's ID", async () => {
    User.findOne.mockResolvedValue(LEARNER_2);

    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Booking now!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"12:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true,
      actionType: "book",
      bookingData: { date: "2025-07-01", time: "12:00" },
      responseText: "Booking now!",
    });

    const replies = [];
    await webhookController.handleIncomingMessage(
      LEARNER_2.phone,
      "Book noon tomorrow",
      "phone-B-222",
      true,
      (reply) => replies.push(reply)
    );

    expect(Booking.create).toHaveBeenCalled();
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.instructorId).toBe("phone-B-222");

    expect(calendarService.createEvent).toHaveBeenCalledWith(
      expect.any(Object),
      INSTRUCTOR_B
    );

    const confirmReply = replies.find((r) => r.includes("Booking Confirmed"));
    expect(confirmReply).toBeDefined();
    expect(confirmReply).toContain("Bob Instructor");
  });

  it("interleaved bookings from different instructors stay isolated", async () => {
    // --- Learner 1 books with Instructor A ---
    User.findOne.mockResolvedValue(LEARNER_1);
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Booked!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"09:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true,
      actionType: "book",
      bookingData: { date: "2025-07-01", time: "09:00" },
      responseText: "Booked!",
    });

    const repliesA = [];
    await webhookController.handleIncomingMessage(
      LEARNER_1.phone, "Book 9am", "phone-A-111",
      true, (r) => repliesA.push(r)
    );

    // --- Learner 2 books with Instructor B ---
    User.findOne.mockResolvedValue(LEARNER_2);
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Booked!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"16:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true,
      actionType: "book",
      bookingData: { date: "2025-07-01", time: "16:00" },
      responseText: "Booked!",
    });

    const repliesB = [];
    await webhookController.handleIncomingMessage(
      LEARNER_2.phone, "Book 4pm", "phone-B-222",
      true, (r) => repliesB.push(r)
    );

    // Verify isolation
    expect(Booking.create).toHaveBeenCalledTimes(2);
    expect(Booking.create.mock.calls[0][0].instructorId).toBe("phone-A-111");
    expect(Booking.create.mock.calls[1][0].instructorId).toBe("phone-B-222");

    // Confirm replies mention the correct instructor
    expect(repliesA.find((r) => r.includes("Alice Instructor"))).toBeDefined();
    expect(repliesB.find((r) => r.includes("Bob Instructor"))).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. User–Instructor Linking (New User Flow)
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – User–Instructor Linking", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("new user messaging Instructor A gets linked to A", async () => {
    // First call: no user found (new user)
    User.findOne.mockResolvedValue(null);

    let savedUser = null;
    User.mockImplementation(function (data) {
      savedUser = { ...data, save: jest.fn().mockResolvedValue(true) };
      return savedUser;
    });

    jest.spyOn(aiService, "getResponse").mockResolvedValue("Welcome!");
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: false, actionType: null, bookingData: {}, responseText: "Welcome!",
    });

    const replies = [];
    await webhookController.handleIncomingMessage(
      "447999000001",
      "Hello",
      "phone-A-111",
      true,
      (reply) => replies.push(reply)
    );

    // ensureUserDetails should have created a User with instructorId = phone-A-111
    expect(User).toHaveBeenCalledWith(
      expect.objectContaining({ instructorId: "phone-A-111" })
    );
  });

  it("new user messaging Instructor B gets linked to B", async () => {
    User.findOne.mockResolvedValue(null);

    let savedUser = null;
    User.mockImplementation(function (data) {
      savedUser = { ...data, save: jest.fn().mockResolvedValue(true) };
      return savedUser;
    });

    jest.spyOn(aiService, "getResponse").mockResolvedValue("Welcome!");
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: false, actionType: null, bookingData: {}, responseText: "Welcome!",
    });

    const replies = [];
    await webhookController.handleIncomingMessage(
      "447999000002",
      "Hello",
      "phone-B-222",
      true,
      (reply) => replies.push(reply)
    );

    expect(User).toHaveBeenCalledWith(
      expect.objectContaining({ instructorId: "phone-B-222" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Reschedule – Internal Instructor Lookup
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Reschedule Uses Stored instructorId", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.updateEvent.mockResolvedValue({});
  });

  it("reschedule looks up instructor from booking and uses correct credentials", async () => {
    const mockBooking = {
      bookingId: "DL-AAAA",
      userPhone: LEARNER_1.phone,
      date: "2025-07-01",
      time: "09:00",
      instructorId: "phone-A-111",
      calendarEventId: "cal-old-a",
      status: "confirmed",
      postalCode: "ST5 1AB",
      location: { latitude: 53.02, longitude: -2.22 },
      pickupLocation: {},
      dropoffLocation: {},
      toObject: function () { return { ...this }; },
      save: jest.fn().mockResolvedValue(true),
    };

    Booking.findOne.mockResolvedValue(mockBooking);
    User.findOne.mockResolvedValue(LEARNER_1);

    await bookingService.rescheduleBooking(LEARNER_1.phone, {
      bookingId: "DL-AAAA",
      newDate: "2025-07-02",
      newTime: "10:00",
    });

    // getInstructor called with the booking's stored instructorId
    expect(getInstructor).toHaveBeenCalledWith("phone-A-111");

    // Calendar update used Instructor A
    expect(calendarService.updateEvent).toHaveBeenCalledWith(
      "cal-old-a",
      expect.objectContaining({ newDate: "2025-07-02", newTime: "10:00" }),
      INSTRUCTOR_A
    );
  });

  it("reschedule for Instructor B's booking uses B's credentials", async () => {
    const mockBooking = {
      bookingId: "DL-BBBB",
      userPhone: LEARNER_2.phone,
      date: "2025-07-01",
      time: "12:00",
      instructorId: "phone-B-222",
      calendarEventId: "cal-old-b",
      status: "confirmed",
      postalCode: "SW1A 1AA",
      location: { latitude: 51.51, longitude: -0.13 },
      pickupLocation: {},
      dropoffLocation: {},
      toObject: function () { return { ...this }; },
      save: jest.fn().mockResolvedValue(true),
    };

    Booking.findOne.mockResolvedValue(mockBooking);
    User.findOne.mockResolvedValue(LEARNER_2);

    await bookingService.rescheduleBooking(LEARNER_2.phone, {
      bookingId: "DL-BBBB",
      newDate: "2025-07-03",
      newTime: "14:00",
    });

    expect(getInstructor).toHaveBeenCalledWith("phone-B-222");
    expect(calendarService.updateEvent).toHaveBeenCalledWith(
      "cal-old-b",
      expect.any(Object),
      INSTRUCTOR_B
    );
  });

  it("reschedule rejects time not in the instructor's available times", async () => {
    const mockBooking = {
      bookingId: "DL-CCCC",
      userPhone: LEARNER_2.phone,
      date: "2025-07-01",
      time: "12:00",
      instructorId: "phone-B-222",
      calendarEventId: "cal-old-c",
      status: "confirmed",
      toObject: function () { return { ...this }; },
      save: jest.fn(),
    };

    Booking.findOne.mockResolvedValue(mockBooking);
    User.findOne.mockResolvedValue(LEARNER_2);

    // 09:00 is NOT in Instructor B's available times
    await expect(
      bookingService.rescheduleBooking(LEARNER_2.phone, {
        bookingId: "DL-CCCC",
        newDate: "2025-07-02",
        newTime: "09:00",
      })
    ).rejects.toThrow("Time slot is not available");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. AI Service – Instructor-Aware System Prompt
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – AI System Prompt", () => {
  it("getSystemPrompt includes Instructor A's name", () => {
    const prompt = aiService.getSystemPrompt(INSTRUCTOR_A);
    expect(prompt).toContain("Alice Instructor");
    expect(prompt).not.toContain("Bob Instructor");
  });

  it("getSystemPrompt includes Instructor B's name", () => {
    const prompt = aiService.getSystemPrompt(INSTRUCTOR_B);
    expect(prompt).toContain("Bob Instructor");
    expect(prompt).not.toContain("Alice Instructor");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Full Day Simulation – Multiple Learners, Multiple Instructors
// ═══════════════════════════════════════════════════════════════════════

describe("Multi-Instructor – Full Day Simulation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-sim" });
    Booking.create.mockImplementation((data) =>
      Promise.resolve({ ...data, _id: "sim-id", bookingId: "DL-SIM" })
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("simulates 3 bookings across 2 instructors in sequence", async () => {
    const bookingLog = [];

    // --- Booking 1: Learner 1 → Instructor A at 09:00 ---
    User.findOne.mockResolvedValue(LEARNER_1);
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Done!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"09:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "book",
      bookingData: { date: "2025-07-01", time: "09:00" },
      responseText: "Done!",
    });

    const r1 = [];
    await webhookController.handleIncomingMessage(
      LEARNER_1.phone, "Book 9am", "phone-A-111", true, (r) => r1.push(r)
    );
    bookingLog.push(Booking.create.mock.calls[Booking.create.mock.calls.length - 1][0]);

    // --- Booking 2: Learner 2 → Instructor B at 16:00 ---
    User.findOne.mockResolvedValue(LEARNER_2);
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Done!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"16:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "book",
      bookingData: { date: "2025-07-01", time: "16:00" },
      responseText: "Done!",
    });

    const r2 = [];
    await webhookController.handleIncomingMessage(
      LEARNER_2.phone, "Book 4pm", "phone-B-222", true, (r) => r2.push(r)
    );
    bookingLog.push(Booking.create.mock.calls[Booking.create.mock.calls.length - 1][0]);

    // --- Booking 3: Learner 3 → Instructor A at 11:00 ---
    User.findOne.mockResolvedValue(LEARNER_3);
    jest.spyOn(aiService, "getResponse").mockResolvedValue(
      'Done!\n[ACTION:BOOK]\n{"date":"2025-07-01","time":"11:00"}'
    );
    jest.spyOn(aiService, "extractActions").mockReturnValue({
      hasAction: true, actionType: "book",
      bookingData: { date: "2025-07-01", time: "11:00" },
      responseText: "Done!",
    });

    const r3 = [];
    await webhookController.handleIncomingMessage(
      LEARNER_3.phone, "Book 11am", "phone-A-111", true, (r) => r3.push(r)
    );
    bookingLog.push(Booking.create.mock.calls[Booking.create.mock.calls.length - 1][0]);

    // --- Assertions ---

    // 3 bookings total
    expect(Booking.create).toHaveBeenCalledTimes(3);

    // Instructor A got 2 bookings, Instructor B got 1
    const instABookings = bookingLog.filter((b) => b.instructorId === "phone-A-111");
    const instBBookings = bookingLog.filter((b) => b.instructorId === "phone-B-222");
    expect(instABookings.length).toBe(2);
    expect(instBBookings.length).toBe(1);

    // Calendar was called with correct instructor each time
    expect(calendarService.createEvent.mock.calls[0][1]).toBe(INSTRUCTOR_A);
    expect(calendarService.createEvent.mock.calls[1][1]).toBe(INSTRUCTOR_B);
    expect(calendarService.createEvent.mock.calls[2][1]).toBe(INSTRUCTOR_A);

    // Each confirmation mentions the correct instructor name
    expect(r1.find((r) => r.includes("Alice Instructor"))).toBeDefined();
    expect(r2.find((r) => r.includes("Bob Instructor"))).toBeDefined();
    expect(r3.find((r) => r.includes("Alice Instructor"))).toBeDefined();
  });
});
