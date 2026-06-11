const { oauth2Client, calendar } = require("../config/google");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { notifyInvalidGrant } = require("../utils/emailNotifier");

/**
 * Check if an error is an invalid_grant (expired/revoked refresh token).
 */
function isInvalidGrant(error) {
  const msg = error?.message || "";
  const code = error?.response?.data?.error || "";
  return msg.includes("invalid_grant") || code === "invalid_grant";
}

class CalendarService {

  /**
   * Set OAuth2 credentials from the instructor's refresh token.
   * @param {Object} instructor - Instructor record from DB
   */
  _setCredentials(instructor) {
    oauth2Client.setCredentials({
      refresh_token: instructor.googleRefreshToken,
    });
  }

  async findEarliestAvailableSlot(instructor) {
    try {
      if (!instructor) {
        throw new Error("Instructor object is required");
      }

      const today = timezoneUtils.getCurrentDateString();
      let dateToCheck = timezoneUtils.addDays(today, 2);

      for (let i = 0; i < 90; i++) {
        if (i > 0) {
          dateToCheck = timezoneUtils.addDays(dateToCheck, 1);
        }
        if (timezoneUtils.isWeekend(dateToCheck)) {
          continue;
        }

        const events = await this.getEventsForDate(dateToCheck, instructor);

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
   * @param {Object} instructor - Instructor record from DB
   * @returns {object[]} array of calendar event objects
   */
  async getEventsForDate(date, instructor) {
    this._setCredentials(instructor);

    const dayStart = timezoneUtils.createDateInTimezone(date, "00:00");
    const dayEnd = timezoneUtils.createDateInTimezone(date, "00:00");
    dayEnd.setDate(dayEnd.getDate() + 1);

    try {
      const response = await calendar.events.list({
        calendarId: instructor.googleCalendarId,
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      return response.data.items || [];
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in getEventsForDate`);
        notifyInvalidGrant(instructor, "Calendar", error.message);
      }
      throw error;
    }
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

  async checkAvailability(date, time, instructor) {
    try {
      if (!instructor) {
        return { isAvailable: false, error: "Instructor not found" };
      }

      const events = await this.getEventsForDate(date, instructor);
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

  async getAvailableTimeSlotsForDate(date, instructor) {
    try {
      const events = await this.getEventsForDate(date, instructor);

      const availableSlots = instructor.availableTimes.filter((time) => {
        const { isAvailable } = this.checkSlotAgainstEvents(date, time, events);
        return isAvailable;
      });

      return availableSlots;
    } catch (error) {
      logger.error(`Error getting available time slots: ${error.message}`);
      return instructor.availableTimes;
    }
  }

  async getCalendarContext(instructor) {
    try {
      this._setCredentials(instructor);

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
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in getCalendarContext`);
        notifyInvalidGrant(instructor, "Calendar", error.message);
      }
      logger.error(`Error getting calendar context: ${error.message}`);
      return [];
    }
  }

  async createEvent(bookingData, instructor) {
    try {
      this._setCredentials(instructor);

      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.date,
        bookingData.time
      );

      const event = {
        summary: `Driving Lesson - ${bookingData.userPhone}`,
        description: [
          `Driving lesson booking`,
          `Phone: ${bookingData.userPhone}`,
          bookingData.pickupAddress ? `Pickup: ${bookingData.pickupAddress}` : null,
          bookingData.dropoffAddress ? `Drop-off: ${bookingData.dropoffAddress}` : null,
        ].filter(Boolean).join("\n"),
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
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in createEvent`);
        notifyInvalidGrant(instructor, "Calendar", error.message);
      }
      logger.error(`Error creating calendar event: ${error.message}`);
      throw error;
    }
  }

  async updateEvent(eventId, bookingData, instructor) {
    try {
      this._setCredentials(instructor);

      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.newDate,
        bookingData.newTime
      );

      const event = {
        summary: `Driving Lesson - ${bookingData.userPhone || ""}`,
        description: [
          `Driving lesson booking`,
          bookingData.pickupAddress ? `Pickup: ${bookingData.pickupAddress}` : null,
          bookingData.dropoffAddress ? `Drop-off: ${bookingData.dropoffAddress}` : null,
        ].filter(Boolean).join("\n"),
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
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in updateEvent`);
        notifyInvalidGrant(instructor, "Calendar", error.message);
      }
      logger.error(`Error updating calendar event: ${error.message}`);
      throw error;
    }
  }

  async deleteEvent(eventId, instructor) {
    try {
      if (!eventId) {
        throw new Error("Event ID is required for deletion");
      }

      this._setCredentials(instructor);

      await calendar.events.delete({
        calendarId: instructor.googleCalendarId,
        eventId,
      });

      logger.info(`Calendar event deleted: ${eventId}`);
      return { success: true, eventId };
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in deleteEvent`);
        notifyInvalidGrant(instructor, "Calendar", error.message);
      }
      logger.error(`Error deleting calendar event: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new CalendarService();
