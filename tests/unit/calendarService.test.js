/**
 * CalendarService – Unit Tests
 * ─────────────────────────────
 * Covers:
 *  1. checkSlotAgainstEvents – conflict detection, edge cases
 *  2. buildDateTimes – start/end datetime construction
 *  3. isInvalidGrant – error classification (tested via createEvent/deleteEvent)
 *  4. getEventsForDate – Google Calendar API call, error handling
 *  5. checkAvailability – combined flow
 *  6. getAvailableTimeSlotsForDate – filters available slots
 *  7. findEarliestAvailableSlot – search logic
 *  8. createEvent – event creation, invalid_grant handling
 *  9. updateEvent – event update
 * 10. deleteEvent – event deletion, missing eventId
 */

jest.mock("../../src/config/google", () => ({
  oauth2Client: {
    setCredentials: jest.fn(),
  },
  calendar: {
    events: {
      list: jest.fn(),
      insert: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
  },
}));
jest.mock("../../src/utils/logger-advanced", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock("../../src/utils/emailNotifier", () => ({
  notifyInvalidGrant: jest.fn(),
}));

const { oauth2Client, calendar } = require("../../src/config/google");
const logger = require("../../src/utils/logger-advanced");
const { notifyInvalidGrant } = require("../../src/utils/emailNotifier");
const calendarService = require("../../src/services/calendarService");

const timezoneUtils = require("../../src/utils/timezoneUtils");

const MOCK_INSTRUCTOR = {
  phoneNumberId: "inst-1",
  name: "Test Instructor",
  googleCalendarId: "cal@test.com",
  googleRefreshToken: "refresh-token",
  availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00"],
  timezone: "Europe/London",
};

/** Build an ISO dateTime string in the app's configured timezone */
function tzISO(date, time) {
  return timezoneUtils.createDateInTimezone(date, time).toISOString();
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. checkSlotAgainstEvents
// ═══════════════════════════════════════════════════════════════════════════

describe("checkSlotAgainstEvents", () => {
  it("returns available when no events exist", () => {
    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", []);
    expect(result.isAvailable).toBe(true);
    expect(result.conflictingEvents).toEqual([]);
  });

  it("detects a direct conflict", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "10:00") },
        end: { dateTime: tzISO("2025-07-15", "11:00") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(false);
    expect(result.conflictingEvents.length).toBe(1);
  });

  it("returns available when event is at different time", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "14:00") },
        end: { dateTime: tzISO("2025-07-15", "15:00") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(true);
  });

  it("detects overlap (event starts during slot)", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "10:30") },
        end: { dateTime: tzISO("2025-07-15", "11:30") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(false);
  });

  it("detects overlap (event ends during slot)", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "09:30") },
        end: { dateTime: tzISO("2025-07-15", "10:30") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(false);
  });

  it("returns available when event ends exactly at slot start (no overlap)", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "09:00") },
        end: { dateTime: tzISO("2025-07-15", "10:00") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(true);
  });

  it("returns available when event starts exactly at slot end (no overlap)", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "11:00") },
        end: { dateTime: tzISO("2025-07-15", "12:00") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(true);
  });

  it("skips events with missing start/end", () => {
    const events = [{ summary: "Broken event" }, { start: null, end: null }];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(true);
  });

  it("handles all-day events (date format instead of dateTime)", () => {
    const events = [
      {
        start: { date: "2025-07-15" },
        end: { date: "2025-07-16" },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(false);
  });

  it("returns not available for invalid date/time", () => {
    const result = calendarService.checkSlotAgainstEvents("invalid", "invalid", []);
    expect(result.isAvailable).toBe(false);
    expect(result.error).toContain("Invalid date/time");
  });

  it("detects multiple conflicting events", () => {
    const events = [
      {
        start: { dateTime: tzISO("2025-07-15", "09:30") },
        end: { dateTime: tzISO("2025-07-15", "10:30") },
      },
      {
        start: { dateTime: tzISO("2025-07-15", "10:00") },
        end: { dateTime: tzISO("2025-07-15", "11:00") },
      },
    ];

    const result = calendarService.checkSlotAgainstEvents("2025-07-15", "10:00", events);
    expect(result.isAvailable).toBe(false);
    expect(result.conflictingEvents.length).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. buildDateTimes
// ═══════════════════════════════════════════════════════════════════════════

describe("buildDateTimes", () => {
  it("returns start and end DateTime objects 1 hour apart", () => {
    const { startDateTime, endDateTime } = calendarService.buildDateTimes("2025-07-15", "10:00");

    expect(startDateTime).toBeInstanceOf(Date);
    expect(endDateTime).toBeInstanceOf(Date);
    expect(endDateTime.getTime() - startDateTime.getTime()).toBe(60 * 60 * 1000);
  });

  it("handles midnight crossing", () => {
    const { startDateTime, endDateTime } = calendarService.buildDateTimes("2025-07-15", "23:30");

    // Use timezoneUtils to extract hours/minutes in the configured timezone
    // (avoids system-timezone dependency that breaks on CI vs local)
    const endTime = timezoneUtils.formatDate(endDateTime, "HH:mm");
    expect(endTime).toBe("00:30");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. getEventsForDate
// ═══════════════════════════════════════════════════════════════════════════

describe("getEventsForDate", () => {
  it("sets credentials and returns events", async () => {
    calendar.events.list.mockResolvedValue({
      data: {
        items: [
          { summary: "Lesson 1", start: { dateTime: "2025-07-15T10:00:00" } },
        ],
      },
    });

    const events = await calendarService.getEventsForDate("2025-07-15", MOCK_INSTRUCTOR);

    expect(oauth2Client.setCredentials).toHaveBeenCalledWith({
      refresh_token: "refresh-token",
    });
    expect(events.length).toBe(1);
    expect(events[0].summary).toBe("Lesson 1");
  });

  it("returns empty array when no items", async () => {
    calendar.events.list.mockResolvedValue({ data: {} });

    const events = await calendarService.getEventsForDate("2025-07-15", MOCK_INSTRUCTOR);
    expect(events).toEqual([]);
  });

  it("notifies on invalid_grant error", async () => {
    const error = new Error("invalid_grant: Token has been expired or revoked");
    calendar.events.list.mockRejectedValue(error);

    await expect(
      calendarService.getEventsForDate("2025-07-15", MOCK_INSTRUCTOR)
    ).rejects.toThrow("invalid_grant");

    expect(notifyInvalidGrant).toHaveBeenCalledWith(
      MOCK_INSTRUCTOR,
      "Calendar",
      expect.stringContaining("invalid_grant")
    );
  });

  it("throws non-invalid_grant errors without notifying", async () => {
    calendar.events.list.mockRejectedValue(new Error("Network error"));

    await expect(
      calendarService.getEventsForDate("2025-07-15", MOCK_INSTRUCTOR)
    ).rejects.toThrow("Network error");

    expect(notifyInvalidGrant).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. checkAvailability
// ═══════════════════════════════════════════════════════════════════════════

describe("checkAvailability", () => {
  it("returns available for free slot", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [] } });

    const result = await calendarService.checkAvailability("2025-07-15", "10:00", MOCK_INSTRUCTOR);
    expect(result.isAvailable).toBe(true);
  });

  it("returns unavailable when instructor is null", async () => {
    const result = await calendarService.checkAvailability("2025-07-15", "10:00", null);
    expect(result.isAvailable).toBe(false);
    expect(result.error).toContain("Instructor not found");
  });

  it("returns unavailable with warning on API error", async () => {
    calendar.events.list.mockRejectedValue(new Error("API quota exceeded"));

    const result = await calendarService.checkAvailability("2025-07-15", "10:00", MOCK_INSTRUCTOR);
    expect(result.isAvailable).toBe(false);
    expect(result.warning).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. getAvailableTimeSlotsForDate
// ═══════════════════════════════════════════════════════════════════════════

describe("getAvailableTimeSlotsForDate", () => {
  it("returns only available slots", async () => {
    calendar.events.list.mockResolvedValue({
      data: {
        items: [
          {
            start: { dateTime: tzISO("2025-07-15", "10:00") },
            end: { dateTime: tzISO("2025-07-15", "11:00") },
          },
        ],
      },
    });

    const slots = await calendarService.getAvailableTimeSlotsForDate("2025-07-15", MOCK_INSTRUCTOR);

    // 10:00 is taken, rest should be available
    expect(slots).not.toContain("10:00");
    expect(slots).toContain("09:00");
    expect(slots).toContain("14:00");
  });

  it("returns all slots when no events", async () => {
    calendar.events.list.mockResolvedValue({ data: { items: [] } });

    const slots = await calendarService.getAvailableTimeSlotsForDate("2025-07-15", MOCK_INSTRUCTOR);
    expect(slots).toEqual(MOCK_INSTRUCTOR.availableTimes);
  });

  it("returns all instructor times as fallback on error", async () => {
    calendar.events.list.mockRejectedValue(new Error("API error"));

    const slots = await calendarService.getAvailableTimeSlotsForDate("2025-07-15", MOCK_INSTRUCTOR);
    expect(slots).toEqual(MOCK_INSTRUCTOR.availableTimes);
    expect(logger.error).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. findEarliestAvailableSlot
// ═══════════════════════════════════════════════════════════════════════════

describe("findEarliestAvailableSlot", () => {
  it("returns null when instructor is null", async () => {
    const result = await calendarService.findEarliestAvailableSlot(null);
    expect(result).toBeNull();
  });

  it("returns first available slot", async () => {
    // All events empty → first available time on first checked date
    calendar.events.list.mockResolvedValue({ data: { items: [] } });

    const result = await calendarService.findEarliestAvailableSlot(MOCK_INSTRUCTOR);

    expect(result).not.toBeNull();
    expect(result.time).toBe("09:00");
    expect(result.date).toBeDefined();
  });

  it("returns null when no slots available in 90 days", async () => {
    // Stub getEventsForDate to return empty, but make checkSlotAgainstEvents
    // always report unavailable — simulates every slot being booked.
    calendar.events.list.mockResolvedValue({ data: { items: [] } });
    jest.spyOn(calendarService, "checkSlotAgainstEvents").mockReturnValue({
      isAvailable: false,
      conflictingEvents: [{ summary: "Booked" }],
    });

    const result = await calendarService.findEarliestAvailableSlot(MOCK_INSTRUCTOR);
    expect(result).toBeNull();

    calendarService.checkSlotAgainstEvents.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. createEvent
// ═══════════════════════════════════════════════════════════════════════════

describe("createEvent", () => {
  it("creates event with correct data", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-123" } });

    const bookingData = {
      date: "2025-07-15",
      time: "10:00",
      userPhone: "447000000001",
    };

    const result = await calendarService.createEvent(bookingData, MOCK_INSTRUCTOR);

    expect(result.id).toBe("evt-123");
    expect(calendar.events.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        calendarId: "cal@test.com",
      })
    );
  });

  it("includes pickup/dropoff in description", async () => {
    calendar.events.insert.mockResolvedValue({ data: { id: "evt-456" } });

    const bookingData = {
      date: "2025-07-15",
      time: "10:00",
      userPhone: "447000000001",
      pickupAddress: "ST5 1AB",
      dropoffAddress: "ST4 2DE",
    };

    await calendarService.createEvent(bookingData, MOCK_INSTRUCTOR);

    const resource = calendar.events.insert.mock.calls[0][0].resource;
    expect(resource.description).toContain("Pickup: ST5 1AB");
    expect(resource.description).toContain("Drop-off: ST4 2DE");
  });

  it("notifies on invalid_grant", async () => {
    calendar.events.insert.mockRejectedValue(new Error("invalid_grant: expired"));

    await expect(
      calendarService.createEvent({ date: "2025-07-15", time: "10:00", userPhone: "447" }, MOCK_INSTRUCTOR)
    ).rejects.toThrow("invalid_grant");

    expect(notifyInvalidGrant).toHaveBeenCalledWith(MOCK_INSTRUCTOR, "Calendar", expect.any(String));
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. updateEvent
// ═══════════════════════════════════════════════════════════════════════════

describe("updateEvent", () => {
  it("updates event with new date/time", async () => {
    calendar.events.update.mockResolvedValue({ data: { id: "evt-123" } });

    const bookingData = {
      newDate: "2025-07-16",
      newTime: "14:00",
      userPhone: "447000000001",
    };

    const result = await calendarService.updateEvent("evt-123", bookingData, MOCK_INSTRUCTOR);

    expect(result.id).toBe("evt-123");
    expect(calendar.events.update).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-123" })
    );
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("evt-123"));
  });

  it("notifies on invalid_grant during update", async () => {
    calendar.events.update.mockRejectedValue(new Error("invalid_grant"));

    await expect(
      calendarService.updateEvent("evt-x", { newDate: "2025-07-16", newTime: "14:00" }, MOCK_INSTRUCTOR)
    ).rejects.toThrow("invalid_grant");

    expect(notifyInvalidGrant).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. deleteEvent
// ═══════════════════════════════════════════════════════════════════════════

describe("deleteEvent", () => {
  it("deletes event and returns success", async () => {
    calendar.events.delete.mockResolvedValue({});

    const result = await calendarService.deleteEvent("evt-del", MOCK_INSTRUCTOR);

    expect(result.success).toBe(true);
    expect(result.eventId).toBe("evt-del");
    expect(calendar.events.delete).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt-del" })
    );
  });

  it("throws when eventId is missing", async () => {
    await expect(calendarService.deleteEvent(null, MOCK_INSTRUCTOR)).rejects.toThrow(
      "Event ID is required"
    );
  });

  it("throws when eventId is empty string", async () => {
    await expect(calendarService.deleteEvent("", MOCK_INSTRUCTOR)).rejects.toThrow(
      "Event ID is required"
    );
  });

  it("notifies on invalid_grant during delete", async () => {
    calendar.events.delete.mockRejectedValue(new Error("invalid_grant"));

    await expect(
      calendarService.deleteEvent("evt-fail", MOCK_INSTRUCTOR)
    ).rejects.toThrow("invalid_grant");

    expect(notifyInvalidGrant).toHaveBeenCalled();
  });
});
