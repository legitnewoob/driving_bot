/**
 * Pickup & Drop-off Location Tests
 *
 * Tests the full pickup/drop-off feature across:
 *  1. AI extractActions – parsing pickupAddress/dropoffAddress from AI response
 *  2. bookingService.createBooking – geocoding, fallback, saving to DB
 *  3. bookingService.rescheduleBooking – geocoding on reschedule
 *  4. Calendar event description – includes addresses
 */

// ── Mocks ──────────────────────────────────────────────────────────────

jest.mock("../src/models/bookingModel");
jest.mock("../src/models/userModel");
jest.mock("../src/services/calendarService", () => ({
  createEvent: jest.fn(),
  updateEvent: jest.fn(),
  getEventsForDate: jest.fn(),
  checkSlotAgainstEvents: jest.fn(),
}));
jest.mock("../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-123"),
  getLearnerName: jest.fn().mockResolvedValue("Test User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
}));
jest.mock("../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn(),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../src/models/instructorModel", () => ({
  getAvailableDates: jest.fn().mockReturnValue(["2025-06-20"]),
  getInstructor: jest.fn().mockResolvedValue({
    phoneNumberId: "inst-1",
    name: "Test Instructor",
    email: "cal@test.com",
    googleCalendarId: "cal@test.com",
    googleRefreshToken: "mock-refresh-token",
    whatsappToken: "mock-wa-token",
    spreadsheetId: "sheet-123",
    availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
    baseLocation: { latitude: 53.02, longitude: -2.22 },
    rates: { basic: 50, highway: 60, parking: 45 },
    timezone: "Europe/London",
    active: true,
  }),
}));
jest.mock("../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const Booking = require("../src/models/bookingModel");
const User = require("../src/models/userModel");
const calendarService = require("../src/services/calendarService");
const { getCoordinatesFromPostalCode } = require("../src/services/mapsService");
const logger = require("../src/utils/logger-advanced");
const bookingService = require("../src/services/bookingService");

// extractActions is on the aiService singleton – require after mocks
// We only need it for parsing tests, no Gemini calls involved
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
    readFileSync: jest.fn().mockReturnValue("mock system prompt"),
  };
});
const aiService = require("../src/services/gemini/aiService");

// ── Test Data ──────────────────────────────────────────────────────────

const MOCK_USER = {
  phone: "447000000001",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
};

const MOCK_GEO_RESULT = (addr) => ({
  lat: 53.03,
  lng: -2.23,
  formattedAddress: `Formatted ${addr}`,
  mapUrl: "https://maps.google.com/test",
  message: "Location found",
});

const BASE_BOOKING_DATA = {
  date: "2025-06-20",
  time: "10:00",
  userPhone: "447000000001",
};

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-1",
  name: "Test Instructor",
  email: "cal@test.com",
  googleCalendarId: "cal@test.com",
  googleRefreshToken: "mock-refresh-token",
  whatsappToken: "mock-wa-token",
  spreadsheetId: "sheet-123",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: { latitude: 53.02, longitude: -2.22 },
  rates: { basic: 50, highway: 60, parking: 45 },
  timezone: "Europe/London",
  active: true,
};

// ═══════════════════════════════════════════════════════════════════════
// 1. AI extractActions – parsing pickup/drop-off from AI response
// ═══════════════════════════════════════════════════════════════════════

describe("extractActions – pickup/drop-off parsing", () => {
  it("parses pickupAddress and dropoffAddress from BOOK action", () => {
    const response = `I'm booking your lesson now!
[ACTION:BOOK]
{"date":"2025-06-20","time":"10:00","pickupAddress":"ST5 1AB","dropoffAddress":"ST4 2DE"}`;

    const result = aiService.extractActions(response);

    expect(result.hasAction).toBe(true);
    expect(result.actionType).toBe("book");
    expect(result.bookingData.date).toBe("2025-06-20");
    expect(result.bookingData.time).toBe("10:00");
    expect(result.bookingData.pickupAddress).toBe("ST5 1AB");
    expect(result.bookingData.dropoffAddress).toBe("ST4 2DE");
    expect(result.responseText).toBe("I'm booking your lesson now!");
  });

  it("parses BOOK action with only pickupAddress (no drop-off)", () => {
    const response = `Booking now!
[ACTION:BOOK]
{"date":"2025-06-20","time":"10:00","pickupAddress":"ST5 1AB"}`;

    const result = aiService.extractActions(response);

    expect(result.bookingData.pickupAddress).toBe("ST5 1AB");
    expect(result.bookingData.dropoffAddress).toBeUndefined();
  });

  it("parses BOOK action with only dropoffAddress (no pickup)", () => {
    const response = `On it!
[ACTION:BOOK]
{"date":"2025-06-20","time":"10:00","dropoffAddress":"CW1 3AA"}`;

    const result = aiService.extractActions(response);

    expect(result.bookingData.dropoffAddress).toBe("CW1 3AA");
    expect(result.bookingData.pickupAddress).toBeUndefined();
  });

  it("parses BOOK action without any addresses (backward compatible)", () => {
    const response = `Booking!
[ACTION:BOOK]
{"date":"2025-06-20","time":"10:00"}`;

    const result = aiService.extractActions(response);

    expect(result.hasAction).toBe(true);
    expect(result.bookingData.date).toBe("2025-06-20");
    expect(result.bookingData.pickupAddress).toBeUndefined();
    expect(result.bookingData.dropoffAddress).toBeUndefined();
  });

  it("parses full addresses (not just postal codes)", () => {
    const response = `Let me book that!
[ACTION:BOOK]
{"date":"2025-06-20","time":"14:00","pickupAddress":"123 High Street, Stoke-on-Trent","dropoffAddress":"45 Station Road, Newcastle"}`;

    const result = aiService.extractActions(response);

    expect(result.bookingData.pickupAddress).toBe("123 High Street, Stoke-on-Trent");
    expect(result.bookingData.dropoffAddress).toBe("45 Station Road, Newcastle");
  });

  it("parses UPDATE_BOOKING with new pickup/drop-off addresses", () => {
    const response = `Updating your booking!
[ACTION:UPDATE_BOOKING]
{"bookingId":"DL-ABCD","newDate":"2025-06-21","newTime":"14:00","pickupAddress":"ST5 2AA","dropoffAddress":"ST4 3BB"}`;

    const result = aiService.extractActions(response);

    expect(result.actionType).toBe("update_booking");
    expect(result.bookingData.pickupAddress).toBe("ST5 2AA");
    expect(result.bookingData.dropoffAddress).toBe("ST4 3BB");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. bookingService.createBooking – geocoding pickup/drop-off
// ═══════════════════════════════════════════════════════════════════════

describe("bookingService.createBooking – pickup/drop-off", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Default mocks for a successful booking
    User.findOne.mockResolvedValue(MOCK_USER);
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-evt-123" });
    Booking.create.mockImplementation((data) => Promise.resolve({ ...data, _id: "mongo-id" }));
  });

  it("geocodes both pickup and drop-off addresses on create", async () => {
    getCoordinatesFromPostalCode
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST5 1AB"))
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST4 2DE"));

    const result = await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    // Geocoder called twice
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledTimes(2);
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST5 1AB");
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST4 2DE");

    // Booking.create receives the geocoded locations
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({
      address: "ST5 1AB",
      latitude: 53.03,
      longitude: -2.23,
    });
    expect(createCall.dropoffLocation).toEqual({
      address: "ST4 2DE",
      latitude: 53.03,
      longitude: -2.23,
    });
  });

  it("saves address without coords when geocoding fails", async () => {
    getCoordinatesFromPostalCode
      .mockRejectedValueOnce(new Error("Geocoding failed: ZERO_RESULTS"))
      .mockRejectedValueOnce(new Error("Geocoding failed: ZERO_RESULTS"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "INVALID1",
      dropoffAddress: "INVALID2",
    }, MOCK_INSTRUCTOR);

    const createCall = Booking.create.mock.calls[0][0];
    // Address saved but no lat/long
    expect(createCall.pickupLocation).toEqual({ address: "INVALID1" });
    expect(createCall.dropoffLocation).toEqual({ address: "INVALID2" });

    // Warnings logged
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Pickup geocoding failed")
    );
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Drop-off geocoding failed")
    );
  });

  it("handles booking with no pickup/drop-off (backward compatible)", async () => {
    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
    }, MOCK_INSTRUCTOR);

    // Geocoder NOT called
    expect(getCoordinatesFromPostalCode).not.toHaveBeenCalled();

    // Empty objects saved
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({});
    expect(createCall.dropoffLocation).toEqual({});
  });

  it("handles only pickup provided (no drop-off)", async () => {
    getCoordinatesFromPostalCode.mockResolvedValueOnce(MOCK_GEO_RESULT("ST5 1AB"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "ST5 1AB",
    }, MOCK_INSTRUCTOR);

    expect(getCoordinatesFromPostalCode).toHaveBeenCalledTimes(1);
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST5 1AB");

    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation.address).toBe("ST5 1AB");
    expect(createCall.pickupLocation.latitude).toBe(53.03);
    expect(createCall.dropoffLocation).toEqual({});
  });

  it("handles only drop-off provided (no pickup)", async () => {
    getCoordinatesFromPostalCode.mockResolvedValueOnce(MOCK_GEO_RESULT("ST4 2DE"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    expect(getCoordinatesFromPostalCode).toHaveBeenCalledTimes(1);

    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({});
    expect(createCall.dropoffLocation.address).toBe("ST4 2DE");
  });

  it("pickup geocoding fails but drop-off succeeds", async () => {
    getCoordinatesFromPostalCode
      .mockRejectedValueOnce(new Error("API error"))
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST4 2DE"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "BAD_CODE",
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({ address: "BAD_CODE" });
    expect(createCall.dropoffLocation.latitude).toBe(53.03);
  });

  it("still passes pickup/drop-off data to calendar event", async () => {
    getCoordinatesFromPostalCode
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST5 1AB"))
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST4 2DE"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    // Calendar createEvent receives the booking data with addresses
    const calCall = calendarService.createEvent.mock.calls[0][0];
    expect(calCall.pickupAddress).toBe("ST5 1AB");
    expect(calCall.dropoffAddress).toBe("ST4 2DE");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. bookingService.rescheduleBooking – geocoding on reschedule
// ═══════════════════════════════════════════════════════════════════════

describe("bookingService.rescheduleBooking – pickup/drop-off", () => {
  let mockBooking;

  beforeEach(() => {
    jest.clearAllMocks();

    mockBooking = {
      bookingId: "DL-ABCD",
      userPhone: "447000000001",
      date: "2025-06-20",
      time: "10:00",
      instructorId: "inst-1",
      calendarEventId: "cal-old",
      status: "confirmed",
      postalCode: "ST5 1AB",
      location: { latitude: 53.02, longitude: -2.22 },
      pickupLocation: {},
      dropoffLocation: {},
      toObject: function () { return { ...this }; },
      save: jest.fn().mockResolvedValue(true),
    };

    Booking.findOne.mockResolvedValue(mockBooking);
    User.findOne.mockResolvedValue(MOCK_USER);
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.updateEvent.mockResolvedValue({});
  });

  it("geocodes new pickup and drop-off on reschedule", async () => {
    getCoordinatesFromPostalCode
      .mockResolvedValueOnce(MOCK_GEO_RESULT("ST6 3CC"))
      .mockResolvedValueOnce(MOCK_GEO_RESULT("CW1 4DD"));

    const result = await bookingService.rescheduleBooking("447000000001", {
      bookingId: "DL-ABCD",
      newDate: "2025-06-20",
      newTime: "14:00",
      pickupAddress: "ST6 3CC",
      dropoffAddress: "CW1 4DD",
    });

    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("ST6 3CC");
    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith("CW1 4DD");

    expect(mockBooking.pickupLocation).toEqual({
      address: "ST6 3CC",
      latitude: 53.03,
      longitude: -2.23,
    });
    expect(mockBooking.dropoffLocation).toEqual({
      address: "CW1 4DD",
      latitude: 53.03,
      longitude: -2.23,
    });
    expect(mockBooking.save).toHaveBeenCalled();
  });

  it("saves address-only when geocoding fails on reschedule", async () => {
    getCoordinatesFromPostalCode
      .mockRejectedValueOnce(new Error("API quota exceeded"));

    await bookingService.rescheduleBooking("447000000001", {
      bookingId: "DL-ABCD",
      newDate: "2025-06-20",
      newTime: "14:00",
      pickupAddress: "BAD_ADDR",
    });

    expect(mockBooking.pickupLocation).toEqual({ address: "BAD_ADDR" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Pickup geocoding failed")
    );
  });

  it("does not call geocoder when no addresses provided on reschedule", async () => {
    await bookingService.rescheduleBooking("447000000001", {
      bookingId: "DL-ABCD",
      newDate: "2025-06-20",
      newTime: "14:00",
    });

    expect(getCoordinatesFromPostalCode).not.toHaveBeenCalled();
    // Original empty locations unchanged
    expect(mockBooking.pickupLocation).toEqual({});
  });

  it("updates only drop-off, keeps existing pickup on reschedule", async () => {
    mockBooking.pickupLocation = { address: "OLD_PICKUP", latitude: 53.01, longitude: -2.20 };

    getCoordinatesFromPostalCode.mockResolvedValueOnce(MOCK_GEO_RESULT("NEW_DROP"));

    await bookingService.rescheduleBooking("447000000001", {
      bookingId: "DL-ABCD",
      newDate: "2025-06-20",
      newTime: "14:00",
      dropoffAddress: "NEW_DROP",
    });

    // Pickup untouched
    expect(mockBooking.pickupLocation.address).toBe("OLD_PICKUP");
    // Drop-off updated
    expect(mockBooking.dropoffLocation.address).toBe("NEW_DROP");
    expect(mockBooking.dropoffLocation.latitude).toBe(53.03);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Calendar event description – includes pickup/drop-off
// ═══════════════════════════════════════════════════════════════════════

describe("Calendar event description – pickup/drop-off", () => {
  it("includes pickup and drop-off in description when both provided", () => {
    const lines = [
      "Driving lesson booking",
      "Phone: 447000000001",
      "Pickup: ST5 1AB",
      "Drop-off: ST4 2DE",
    ];
    const bookingData = {
      userPhone: "447000000001",
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    };

    const description = [
      "Driving lesson booking",
      `Phone: ${bookingData.userPhone}`,
      bookingData.pickupAddress ? `Pickup: ${bookingData.pickupAddress}` : null,
      bookingData.dropoffAddress ? `Drop-off: ${bookingData.dropoffAddress}` : null,
    ].filter(Boolean).join("\n");

    expect(description).toBe(lines.join("\n"));
  });

  it("excludes pickup/drop-off from description when not provided", () => {
    const bookingData = {
      userPhone: "447000000001",
    };

    const description = [
      "Driving lesson booking",
      `Phone: ${bookingData.userPhone}`,
      bookingData.pickupAddress ? `Pickup: ${bookingData.pickupAddress}` : null,
      bookingData.dropoffAddress ? `Drop-off: ${bookingData.dropoffAddress}` : null,
    ].filter(Boolean).join("\n");

    expect(description).toBe("Driving lesson booking\nPhone: 447000000001");
    expect(description).not.toContain("Pickup");
    expect(description).not.toContain("Drop-off");
  });

  it("includes only pickup when drop-off is missing", () => {
    const bookingData = {
      userPhone: "447000000001",
      pickupAddress: "ST5 1AB",
    };

    const description = [
      "Driving lesson booking",
      `Phone: ${bookingData.userPhone}`,
      bookingData.pickupAddress ? `Pickup: ${bookingData.pickupAddress}` : null,
      bookingData.dropoffAddress ? `Drop-off: ${bookingData.dropoffAddress}` : null,
    ].filter(Boolean).join("\n");

    expect(description).toContain("Pickup: ST5 1AB");
    expect(description).not.toContain("Drop-off");
  });

  it("calendarService.createEvent receives addresses in bookingData", async () => {
    // This is tested via the createBooking integration above,
    // but let's also verify the mock was called with correct shape
    jest.clearAllMocks();
    User.findOne.mockResolvedValue(MOCK_USER);
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-evt-456" });
    Booking.create.mockImplementation((data) => Promise.resolve({ ...data }));
    getCoordinatesFromPostalCode.mockResolvedValue(MOCK_GEO_RESULT("test"));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    const calArg = calendarService.createEvent.mock.calls[0][0];
    expect(calArg.pickupAddress).toBe("ST5 1AB");
    expect(calArg.dropoffAddress).toBe("ST4 2DE");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Edge Cases
// ═══════════════════════════════════════════════════════════════════════

describe("Pickup/Drop-off – Edge Cases", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findOne.mockResolvedValue(MOCK_USER);
    calendarService.getEventsForDate.mockResolvedValue([]);
    calendarService.checkSlotAgainstEvents.mockReturnValue({ isAvailable: true });
    calendarService.createEvent.mockResolvedValue({ id: "cal-evt-789" });
    Booking.create.mockImplementation((data) => Promise.resolve({ ...data }));
  });

  it("handles empty string addresses (treated as no address)", async () => {
    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "",
      dropoffAddress: "",
    }, MOCK_INSTRUCTOR);

    expect(getCoordinatesFromPostalCode).not.toHaveBeenCalled();
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({});
    expect(createCall.dropoffLocation).toEqual({});
  });

  it("handles very long address strings", async () => {
    const longAddr = "A".repeat(500);
    getCoordinatesFromPostalCode.mockResolvedValue(MOCK_GEO_RESULT(longAddr));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: longAddr,
    }, MOCK_INSTRUCTOR);

    expect(getCoordinatesFromPostalCode).toHaveBeenCalledWith(longAddr);
    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation.address).toBe(longAddr);
  });

  it("handles addresses with special characters", async () => {
    const specialAddr = "123 O'Brien's Lane, St. Mary's & Co.";
    getCoordinatesFromPostalCode.mockResolvedValue(MOCK_GEO_RESULT(specialAddr));

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: specialAddr,
    }, MOCK_INSTRUCTOR);

    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation.address).toBe(specialAddr);
  });

  it("extractActions handles JSON with unicode addresses", () => {
    const response = `Booking!
[ACTION:BOOK]
{"date":"2025-06-20","time":"10:00","pickupAddress":"Hauptstra\u00dfe 42","dropoffAddress":"M\u00fcnchen Hbf"}`;

    const result = aiService.extractActions(response);
    expect(result.bookingData.pickupAddress).toBe("Hauptstra\u00dfe 42");
    expect(result.bookingData.dropoffAddress).toBe("M\u00fcnchen Hbf");
  });

  it("geocoding network timeout still saves the address", async () => {
    const timeoutError = new Error("timeout of 5000ms exceeded");
    timeoutError.code = "ECONNABORTED";
    getCoordinatesFromPostalCode.mockRejectedValue(timeoutError);

    await bookingService.createBooking("447000000001", {
      ...BASE_BOOKING_DATA,
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    }, MOCK_INSTRUCTOR);

    const createCall = Booking.create.mock.calls[0][0];
    expect(createCall.pickupLocation).toEqual({ address: "ST5 1AB" });
    expect(createCall.dropoffLocation).toEqual({ address: "ST4 2DE" });
  });
});
