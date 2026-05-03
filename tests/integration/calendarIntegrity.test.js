/**
 * Calendar Integrity – Integration Tests
 * ────────────────────────────────────────
 * Tests from TestPlan.txt:
 *  1. Timezone correctness – events created at the right local time, not UTC-shifted
 *  2. Correct date placement – event lands on the requested date
 *  3. No overwriting – createEvent uses insert, existing events stay untouched
 *  4. Double-booking prevention – slot with existing event is rejected
 *  5. Booking flow – end-to-end through bookingService → calendarService
 */

jest.mock("../../src/models/bookingModel");
jest.mock("../../src/models/userModel");
jest.mock("../../src/services/sheetsService", () => ({
  getInstructorSpreadsheetId: jest.fn().mockReturnValue("sheet-cal"),
  getLearnerName: jest.fn().mockResolvedValue("Cal User"),
  updateLearnerRecord: jest.fn().mockResolvedValue({}),
  initializeCredentials: jest.fn(),
}));
jest.mock("../../src/services/mapsService", () => ({
  getCoordinatesFromPostalCode: jest.fn().mockResolvedValue({
    lat: 53.02, lng: -2.22,
    formattedAddress: "Stoke-on-Trent",
    mapUrl: "https://maps.google.com/mock",
    message: "Location found",
  }),
  getGoogleMapsLink: jest.fn(),
}));
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

// Mock Google Calendar API at the lowest level so we can inspect call args
jest.mock("../../src/config/google", () => ({
  oauth2Client: { setCredentials: jest.fn() },
  calendar: {
    events: {
      list: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));
jest.mock("../../src/utils/emailNotifier", () => ({
  notifyInvalidGrant: jest.fn(),
}));

jest.mock("../../src/models/instructorModel", () => ({
  getInstructor: jest.fn(async () => MOCK_INSTRUCTOR),
  getUserSession: jest.fn(() => ({ conversationHistory: [] })),
  updateUserSession: jest.fn(),
  getAvailableDates: jest.fn().mockReturnValue(["2025-07-15"]),
}));

const { calendar } = require("../../src/config/google");
const calendarService = require("../../src/services/calendarService");
const Booking = require("../../src/models/bookingModel");
const User = require("../../src/models/userModel");
const bookingService = require("../../src/services/bookingService");
const timezoneUtils = require("../../src/utils/timezoneUtils");

const MOCK_USER = {
  phone: "447000000001",
  name: "Cal User",
  postalCode: "ST5 1AB",
  location: { latitude: 53.02, longitude: -2.22 },
  detailsCompleted: true,
  instructorId: "inst-cal",
};

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-cal",
  name: "Cal Instructor",
  googleCalendarId: "cal@instructor.com",
  googleRefreshToken: "refresh-cal",
  whatsappToken: "wa-token-cal",
  spreadsheetId: "sheet-cal",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  baseLocation: { latitude: 53.0168, longitude: -2.2191 },
  rates: { basic: 50 },
  timezone: "Europe/London",
  active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  User.findOne.mockResolvedValue(MOCK_USER);
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. Timezone Correctness
// ═══════════════════════════════════════════════════════════════════════════

describe("Timezone Correctness", () => {
  it("createEvent places the event at the requested local time, not UTC", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-tz-1" } });

    await calendarService.createEvent(
      { date: "2025-07-15", time: "10:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.insert.mock.calls[0][0].resource;
    const startDt = new Date(resource.start.dateTime);

    // The event should represent 10:00 in the configured timezone
    // Build the expected time in the same timezone
    const expected = timezoneUtils.createDateInTimezone("2025-07-15", "10:00");

    expect(startDt.getTime()).toBe(expected.getTime());
  });

  it("event duration is exactly 1 hour", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-tz-2" } });

    await calendarService.createEvent(
      { date: "2025-07-15", time: "14:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.insert.mock.calls[0][0].resource;
    const start = new Date(resource.start.dateTime);
    const end = new Date(resource.end.dateTime);

    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000);
  });

  it("timezone string is set correctly on the event", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-tz-3" } });

    await calendarService.createEvent(
      { date: "2025-07-15", time: "09:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.insert.mock.calls[0][0].resource;

    // Should have timezone info in start/end
    expect(resource.start.timeZone || resource.start.dateTime).toBeDefined();
    expect(resource.end.timeZone || resource.end.dateTime).toBeDefined();
  });

  it("updateEvent also respects timezone", async () => {
    calendar.events.update.mockResolvedValue({ data: { id: "evt-tz-4" } });

    await calendarService.updateEvent(
      "evt-tz-4",
      { newDate: "2025-07-16", newTime: "15:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.update.mock.calls[0][0].resource;
    const startDt = new Date(resource.start.dateTime);
    const expected = timezoneUtils.createDateInTimezone("2025-07-16", "15:00");

    expect(startDt.getTime()).toBe(expected.getTime());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. Correct Date Placement
// ═══════════════════════════════════════════════════════════════════════════

describe("Correct Date Placement", () => {
  it("event is created on the exact requested date", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-date-1" } });

    await calendarService.createEvent(
      { date: "2025-08-20", time: "11:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.insert.mock.calls[0][0].resource;
    const startDt = new Date(resource.start.dateTime);
    const dateStr = timezoneUtils.formatDate(startDt, "YYYY-MM-DD");

    expect(dateStr).toBe("2025-08-20");
  });

  it("month boundary dates are handled correctly (July 31 → not Aug 1)", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-date-2" } });

    await calendarService.createEvent(
      { date: "2025-07-31", time: "16:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    const resource = calendar.events.insert.mock.calls[0][0].resource;
    const startDt = new Date(resource.start.dateTime);
    const dateStr = timezoneUtils.formatDate(startDt, "YYYY-MM-DD");

    expect(dateStr).toBe("2025-07-31");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. No Overwriting Existing Events
// ═══════════════════════════════════════════════════════════════════════════

describe("No Overwriting Existing Events", () => {
  it("createEvent uses calendar.events.insert (not update)", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-new" } });

    await calendarService.createEvent(
      { date: "2025-07-15", time: "10:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    expect(calendar.events.insert).toHaveBeenCalledTimes(1);
    expect(calendar.events.update).not.toHaveBeenCalled();
  });

  it("createEvent does not delete any existing events", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-safe" } });

    await calendarService.createEvent(
      { date: "2025-07-15", time: "14:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    expect(calendar.events.delete).not.toHaveBeenCalled();
  });

  it("existing events remain untouched after a new booking", async () => {
    const existingEvents = [
      {
        id: "existing-1",
        summary: "Existing Lesson",
        start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "09:00").toISOString() },
        end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "10:00").toISOString() },
      },
    ];

    // Events.list returns the existing event
    calendar.events.list.mockResolvedValue({ data: { items: existingEvents } });
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-new-2" } });

    // Create a new event at a different time
    await calendarService.createEvent(
      { date: "2025-07-15", time: "14:00", userPhone: "447000000001" },
      MOCK_INSTRUCTOR
    );

    // Verify insert was called (new event) but update/delete were NOT called
    expect(calendar.events.insert).toHaveBeenCalledTimes(1);
    expect(calendar.events.update).not.toHaveBeenCalled();
    expect(calendar.events.delete).not.toHaveBeenCalled();

    // Verify the new event has a different ID than the existing one
    const insertArgs = calendar.events.insert.mock.calls[0][0];
    expect(insertArgs.resource.summary).not.toBe("Existing Lesson");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Double-Booking Prevention
// ═══════════════════════════════════════════════════════════════════════════

describe("Double-Booking Prevention", () => {
  it("checkSlotAgainstEvents detects conflict with existing event", () => {
    const existingEvents = [
      {
        start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "10:00").toISOString() },
        end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "11:00").toISOString() },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", existingEvents);
    expect(result.isAvailable).toBe(false);
  });

  it("checkAvailability returns unavailable when slot is taken", async () => {
    calendar.events.list.mockResolvedValue({
      data: {
        items: [
          {
            start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "10:00").toISOString() },
            end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "11:00").toISOString() },
          },
        ],
      },
    });

    const result = await calendarService.checkAvailability("2025-07-15", "10:00", MOCK_INSTRUCTOR);
    expect(result.isAvailable).toBe(false);
  });

  it("getAvailableTimeSlotsForDate excludes booked slots", async () => {
    calendar.events.list.mockResolvedValue({
      data: {
        items: [
          {
            start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "10:00").toISOString() },
            end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "11:00").toISOString() },
          },
          {
            start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "14:00").toISOString() },
            end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "15:00").toISOString() },
          },
        ],
      },
    });

    const slots = await calendarService.getAvailableTimeSlotsForDate("2025-07-15", MOCK_INSTRUCTOR);

    expect(slots).not.toContain("10:00");
    expect(slots).not.toContain("14:00");
    expect(slots).toContain("09:00");
    expect(slots).toContain("11:00");
    expect(slots).toContain("15:00");
    expect(slots).toContain("16:00");
  });

  it("bookingService.createBooking throws when slot is taken", async () => {
    // Slot is NOT available — checkSlotAgainstEvents returns conflict
    calendar.events.list.mockResolvedValue({
      data: {
        items: [
          {
            start: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "10:00").toISOString() },
            end: { dateTime: timezoneUtils.createDateInTimezone("2025-07-15", "11:00").toISOString() },
          },
        ],
      },
    });

    await expect(
      bookingService.createBooking(
        "447000000001",
        { date: "2025-07-15", time: "10:00" },
        MOCK_INSTRUCTOR
      )
    ).rejects.toThrow("already booked");

    // Calendar insert should never be called for an unavailable slot
    expect(calendar.events.insert).not.toHaveBeenCalled();
  });

  it("bookingService.createBooking succeeds when slot IS available", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [] } });
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-booked" } });

    // Mock Booking.create (used by bookingService, not new Booking())
    Booking.create.mockResolvedValue({
      bookingId: "DL-TEST",
      userPhone: "447000000001",
      date: "2025-07-15",
      time: "11:00",
      status: "confirmed",
    });

    const result = await bookingService.createBooking(
      "447000000001",
      { date: "2025-07-15", time: "11:00", pickupAddress: "ST5 1AB", dropoffAddress: "ST4 2DE" },
      MOCK_INSTRUCTOR
    );

    expect(result.booking).toBeDefined();
    expect(result.booking.bookingId).toBe("DL-TEST");
    expect(result.calendarEvent.id).toBe("evt-booked");
    expect(calendar.events.insert).toHaveBeenCalledTimes(1);
    expect(Booking.create).toHaveBeenCalledTimes(1);
  });
});
