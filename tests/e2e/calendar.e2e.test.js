/**
 * Calendar Service – E2E Tests (Real Google Calendar API)
 * ────────────────────────────────────────────────────────
 * Tests the REAL Google Calendar API through calendarService:
 *   - Create events on a real test calendar
 *   - Check availability against real events
 *   - Update events (reschedule)
 *   - Delete events (cleanup)
 *   - Find earliest available slot
 *
 * All events created during tests are cleaned up in afterAll.
 *
 * Requires in envs/.env.test:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL,
 *   GOOGLE_REFRESH_TOKEN (test account), GOOGLE_CALENDAR_ID (test calendar)
 *
 * Run: npm run test:e2e
 */

// Load env before anything else
const { TEST_INSTRUCTOR, connectTestDB, disconnectTestDB, cleanupTestDB, describeE2E, E2E_KEYS } = require("./helpers");

const TIMEOUT = 15000;

// Real calendarService — no mocks
const calendarService = require("../../src/services/calendarService");

// Helper: get a future weekday date string (YYYY-MM-DD)
function getFutureWeekday(daysAhead = 30) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  // Ensure it's a weekday
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split("T")[0];
}

// Track created event IDs for cleanup
const createdEventIds = [];

describeE2E(E2E_KEYS.CALENDAR, "E2E – Calendar Service (Real Google Calendar API)", () => {
  beforeAll(async () => { await connectTestDB(); }, 30000);
  afterAll(async () => {
    // Cleanup: delete all events created during tests
    for (const eventId of createdEventIds) {
      try {
        await calendarService.deleteEvent(eventId, TEST_INSTRUCTOR);
      } catch (err) {
        console.warn(`  ⚠️  Failed to cleanup event ${eventId}: ${err.message}`);
      }
    }
    await cleanupTestDB();
    await disconnectTestDB();
  });

  // Use a date far enough in the future to avoid conflicts with real bookings
  const TEST_DATE = getFutureWeekday(60);
  const TEST_TIME = "09:00";

  // ─── Create Event ──────────────────────────────────────────────────

  it(
    "creates a calendar event and returns event data with ID",
    async () => {
      const bookingData = {
        date: TEST_DATE,
        time: TEST_TIME,
        userPhone: "447700900099",
        pickupAddress: "ST5 1AB",
        dropoffAddress: "ST4 2DE",
      };

      const event = await calendarService.createEvent(bookingData, TEST_INSTRUCTOR);

      expect(event).toBeDefined();
      expect(event.id).toBeDefined();
      expect(event.summary).toContain("447700900099");

      // Track for cleanup
      createdEventIds.push(event.id);

      console.log(`  📅 Created event: ${event.id} on ${TEST_DATE} at ${TEST_TIME}`);
    },
    TIMEOUT
  );

  // ─── Get Events for Date ───────────────────────────────────────────

  it(
    "getEventsForDate returns the event we just created",
    async () => {
      const events = await calendarService.getEventsForDate(TEST_DATE, TEST_INSTRUCTOR);

      expect(Array.isArray(events)).toBe(true);
      expect(events.length).toBeGreaterThan(0);

      // Should contain our test event
      const testEvent = events.find((e) =>
        e.summary && e.summary.includes("447700900099")
      );
      expect(testEvent).toBeDefined();

      console.log(`  📅 Found ${events.length} event(s) on ${TEST_DATE}`);
    },
    TIMEOUT
  );

  // ─── Check Availability ────────────────────────────────────────────

  it(
    "checkAvailability returns NOT available for the booked slot",
    async () => {
      const result = await calendarService.checkAvailability(
        TEST_DATE, TEST_TIME, TEST_INSTRUCTOR
      );

      expect(result.isAvailable).toBe(false);

      console.log(`  📅 Slot ${TEST_DATE} ${TEST_TIME}: available=${result.isAvailable}`);
    },
    TIMEOUT
  );

  it(
    "checkAvailability returns available for a different time on the same day",
    async () => {
      const result = await calendarService.checkAvailability(
        TEST_DATE, "16:00", TEST_INSTRUCTOR
      );

      expect(result.isAvailable).toBe(true);

      console.log(`  📅 Slot ${TEST_DATE} 16:00: available=${result.isAvailable}`);
    },
    TIMEOUT
  );

  // ─── Check Slot Against Events ─────────────────────────────────────

  it(
    "checkSlotAgainstEvents detects conflicts correctly",
    async () => {
      const events = await calendarService.getEventsForDate(TEST_DATE, TEST_INSTRUCTOR);

      const booked = calendarService.checkSlotAgainstEvents(TEST_DATE, TEST_TIME, events);
      expect(booked.isAvailable).toBe(false);
      expect(booked.conflictingEvents.length).toBeGreaterThan(0);

      const free = calendarService.checkSlotAgainstEvents(TEST_DATE, "16:00", events);
      expect(free.isAvailable).toBe(true);
      expect(free.conflictingEvents.length).toBe(0);
    },
    TIMEOUT
  );

  // ─── Get Available Time Slots ──────────────────────────────────────

  it(
    "getAvailableTimeSlotsForDate excludes the booked slot",
    async () => {
      const slots = await calendarService.getAvailableTimeSlotsForDate(
        TEST_DATE, TEST_INSTRUCTOR
      );

      expect(Array.isArray(slots)).toBe(true);
      // 09:00 should NOT be available (we booked it)
      expect(slots).not.toContain(TEST_TIME);
      // Other slots should still be available
      expect(slots.length).toBeGreaterThan(0);

      console.log(`  📅 Available slots on ${TEST_DATE}: ${slots.join(", ")}`);
    },
    TIMEOUT
  );

  // ─── Update Event (Reschedule) ─────────────────────────────────────

  it(
    "updateEvent reschedules to a new date/time",
    async () => {
      const eventId = createdEventIds[0];
      expect(eventId).toBeDefined();

      const newDate = getFutureWeekday(61);
      const rescheduleData = {
        newDate,
        newTime: "14:00",
        userPhone: "447700900099",
      };

      const updated = await calendarService.updateEvent(eventId, rescheduleData, TEST_INSTRUCTOR);

      expect(updated).toBeDefined();
      expect(updated.id).toBe(eventId);

      // Old slot should now be free
      const oldSlot = await calendarService.checkAvailability(
        TEST_DATE, TEST_TIME, TEST_INSTRUCTOR
      );
      expect(oldSlot.isAvailable).toBe(true);

      // New slot should be booked
      const newSlot = await calendarService.checkAvailability(
        newDate, "14:00", TEST_INSTRUCTOR
      );
      expect(newSlot.isAvailable).toBe(false);

      console.log(`  📅 Rescheduled ${eventId}: ${TEST_DATE} ${TEST_TIME} → ${newDate} 14:00`);
    },
    TIMEOUT
  );

  // ─── Delete Event ──────────────────────────────────────────────────

  it(
    "deleteEvent removes the event from calendar",
    async () => {
      // Create a temporary event to delete
      const tempBooking = {
        date: getFutureWeekday(62),
        time: "11:00",
        userPhone: "447700900098",
      };

      const tempEvent = await calendarService.createEvent(tempBooking, TEST_INSTRUCTOR);
      expect(tempEvent.id).toBeDefined();

      // Delete it
      const result = await calendarService.deleteEvent(tempEvent.id, TEST_INSTRUCTOR);
      expect(result.success).toBe(true);

      // Verify it's gone — slot should be available
      const check = await calendarService.checkAvailability(
        tempBooking.date, tempBooking.time, TEST_INSTRUCTOR
      );
      expect(check.isAvailable).toBe(true);

      console.log(`  📅 Deleted event: ${tempEvent.id}`);
      // Don't add to createdEventIds since we already deleted it
    },
    TIMEOUT
  );

  // ─── Find Earliest Available Slot ──────────────────────────────────

  it(
    "findEarliestAvailableSlot returns a valid future weekday + time",
    async () => {
      const slot = await calendarService.findEarliestAvailableSlot(TEST_INSTRUCTOR);

      expect(slot).not.toBeNull();
      expect(slot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(slot.time).toMatch(/^\d{2}:\d{2}$/);
      expect(TEST_INSTRUCTOR.availableTimes).toContain(slot.time);

      // Should be a weekday
      const day = new Date(slot.date + "T12:00:00").getDay();
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(5);

      console.log(`  📅 Earliest slot: ${slot.date} at ${slot.time}`);
    },
    30000 // may scan many days
  );

  // ─── Calendar Context ──────────────────────────────────────────────

  it(
    "getCalendarContext returns events for the next 2 weeks",
    async () => {
      const context = await calendarService.getCalendarContext(TEST_INSTRUCTOR);

      expect(Array.isArray(context)).toBe(true);
      // Each event should have date, time, summary
      for (const event of context) {
        expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(event.time).toMatch(/^\d{2}:\d{2}$/);
        expect(event.summary).toBeDefined();
      }

      console.log(`  📅 Calendar context: ${context.length} events in next 2 weeks`);
    },
    TIMEOUT
  );
});
