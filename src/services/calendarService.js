const { oauth2Client, calendar } = require("../config/google");
const { getInstructor } = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");

class CalendarService {

  async findEarliestAvailableSlot(instructorId) {
    try {
      const instructor = getInstructor(instructorId);
      if (!instructor) {
        throw new Error(`Instructor not found: ${instructorId}`);
      }

      // Rule: Start checking from 2 days from now.
      // Get today's date string and add 2 days to it.
      const today = timezoneUtils.getCurrentDateString();
      let dateToCheck = timezoneUtils.addDays(today, 2);

      // Search for up to 90 days in the future
      for (let i = 0; i < 90; i++) {
        // For every loop after the first, advance the date by one day.
        if (i > 0) {
          dateToCheck = timezoneUtils.addDays(dateToCheck, 1);
        }
        // Skip weekends
        if (timezoneUtils.isWeekend(dateToCheck)) {
          continue; // Skip to the next day
        }

        // Single API call for the whole day, then check slots in-memory
        const events = await this.getEventsForDate(dateToCheck, instructorId);

        for (const time of instructor.availableTimes) {
          const { isAvailable } = this.checkSlotAgainstEvents(dateToCheck, time, events);

          if (isAvailable) {
            logger.info(`Earliest available slot: ${dateToCheck} at ${time}`);
            return { date: dateToCheck, time: time };
          }
        }
      }

      logger.warn("No available slots found in the next 90 days");
      return null;
    } catch (error) {
      logger.error(`Error finding earliest slot: ${error.message}`);
      return null;
    }
  }
  /**
   * Build start and end DateTime objects in configured timezone
   */
  buildDateTimes(date, time) {
    const startDateTime = timezoneUtils.createDateInTimezone(date, time);
    const endDateTime = timezoneUtils.createDateInTimezone(date, time);
    endDateTime.setHours(endDateTime.getHours() + 1);

    return { startDateTime, endDateTime };
  }
  /**
   * Fetches all calendar events for a given date in a single API call.
   * @param {string} date - "YYYY-MM-DD"
   * @param {string} instructorId
   * @returns {object[]} array of calendar event objects
   */
  async getEventsForDate(date, instructorId) {
    oauth2Client.setCredentials({
      refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    });

    const instructor = getInstructor(instructorId);
    if (!instructor) throw new Error(`Instructor not found: ${instructorId}`);

    // Build day boundaries: start of day → start of next day
    const dayStart = timezoneUtils.createDateInTimezone(date, "00:00");
    const dayEnd = timezoneUtils.createDateInTimezone(date, "00:00");
    dayEnd.setDate(dayEnd.getDate() + 1);

    const response = await calendar.events.list({
      calendarId: instructor.googleCalendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return response.data.items || [];
  }

  /**
   * Checks whether a specific slot conflicts with a list of events.
   * @param {string} date
   * @param {string} time
   * @param {object[]} events - pre-fetched calendar events for the day
   * @returns {{isAvailable: boolean, conflictingEvents: object[]}}
   */
  checkSlotAgainstEvents(date, time, events) {
    const { startDateTime, endDateTime } = this.buildDateTimes(date, time);

    if (isNaN(startDateTime.getTime())) {
      return { isAvailable: false, error: "Invalid date/time format" };
    }

    const conflictingEvents = events.filter((event) => {
      if (!event.start || !event.end) return false;
      const eventStart = new Date(event.start.dateTime || event.start.date);
      const eventEnd = new Date(event.end.dateTime || event.end.date);
      return startDateTime < eventEnd && endDateTime > eventStart;
    });

    return { isAvailable: conflictingEvents.length === 0, conflictingEvents };
  }

  async checkAvailability(date, time, instructorId) {
    try {

      const instructor = getInstructor(instructorId);
      if (!instructor) {
        return { isAvailable: false, error: "Instructor not found" };
      }

      const events = await this.getEventsForDate(date, instructorId);
      const result = this.checkSlotAgainstEvents(date, time, events);

      return result;
    } catch (error) {
      logger.error(`Calendar availability check error: ${error.message}`);
      return {
        isAvailable: false,
        error: `Could not verify calendar availability: ${error.message}`,
        warning: true,
      };
    }
  }

  async getAvailableTimeSlotsForDate(date, instructorId) {
    try {
      const instructor = getInstructor(instructorId);

      // Single API call for the entire day
      const events = await this.getEventsForDate(date, instructorId);

      // Check each slot against the fetched events in-memory
      const availableSlots = instructor.availableTimes.filter((time) => {
        const { isAvailable } = this.checkSlotAgainstEvents(date, time, events);
        return isAvailable;
      });

      return availableSlots;
    } catch (error) {
      logger.error(`Error getting available time slots: ${error.message}`);
      const instructor = getInstructor(instructorId);
      return instructor.availableTimes;
    }
  }

  async getCalendarContext(instructorId) {
    try {
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });

      const instructor = getInstructor(instructorId);

      const now = timezoneUtils.getCurrentDate();
      const twoWeeksFromNow = new Date(
        now.getTime() + 14 * 24 * 60 * 60 * 1000
      );

      const response = await calendar.events.list({
        calendarId: instructor.googleCalendarId,
        timeMin: now.toISOString(),
        timeMax: twoWeeksFromNow.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];
      return events
        .map((event) => {
          if (event.start && event.start.dateTime) {
            const startTime = new Date(event.start.dateTime);
            return {
              date: startTime.toISOString().split("T")[0],
              time: startTime.toTimeString().slice(0, 5),
              summary: event.summary || "Busy",
            };
          }
          return null;
        })
        .filter(Boolean);
    } catch (error) {
      logger.error(`Error getting calendar context: ${error.message}`);
      return [];
    }
  }

  async createEvent(bookingData) {
    try {
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });

      const instructor = getInstructor(process.env.PHONE_NUMBER_ID);
      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.date,
        bookingData.time
      );

      const event = {
        summary: `Driving Lesson - ${bookingData.userPhone}`,
        description: `Driving lesson booking\nPhone: ${bookingData.userPhone}`,
        start: {
          dateTime: timezoneUtils.formatDate(
            startDateTime,
            "YYYY-MM-DDTHH:mm:ss"
          ),
          timeZone: timezoneUtils.timezone,
        },
        end: {
          dateTime: timezoneUtils.formatDate(
            endDateTime,
            "YYYY-MM-DDTHH:mm:ss"
          ),
          timeZone: timezoneUtils.timezone,
        },
        attendees: [{ email: instructor.googleCalendarId }],
      };

      const response = await calendar.events.insert({
        calendarId: instructor.googleCalendarId,
        auth: oauth2Client,
        resource: event,
      });

      return response.data;
    } catch (error) {
      logger.error(`Error creating calendar event: ${error.message}`);
      throw error;
    }
  }

  async updateEvent(eventId, bookingData, fromUser) {
    try {
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });

      const instructor = getInstructor(process.env.PHONE_NUMBER_ID);
      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.newDate,
        bookingData.newTime
      );

      const event = {
        summary: `Driving Lesson - ${bookingData.newLessonType} - ${fromUser}`,
        description: `Driving lesson booking\nPhone: ${fromUser}`,
        start: {
          dateTime: startDateTime.toISOString(),
          timeZone: timezoneUtils.timezone,
        },
        end: {
          dateTime: endDateTime.toISOString(),
          timeZone: timezoneUtils.timezone,
        },
        attendees: [{ email: instructor.googleCalendarId }],
      };

      const response = await calendar.events.update({
        calendarId: instructor.googleCalendarId,
        eventId,
        resource: event,
      });

      logger.info(`Calendar event updated: ${eventId}`);
      return response.data;
    } catch (error) {
      logger.error(`Error updating calendar event: ${error.message}`);
      throw error;
    }
  }

  async deleteEvent(eventId) {
    try {
      if (!eventId) {
        throw new Error("Event ID is required for deletion");
      }

      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });

      const instructor = getInstructor(process.env.PHONE_NUMBER_ID);

      await calendar.events.delete({
        calendarId: instructor.googleCalendarId,
        eventId,
      });

      logger.info(`Calendar event deleted: ${eventId}`);
      return { success: true, eventId };
    } catch (error) {
      logger.error(`Error deleting calendar event: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new CalendarService();
