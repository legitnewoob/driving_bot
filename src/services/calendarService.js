const { calendar, clientFor } = require("../config/google");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { notifyInvalidGrant, notifyInstructorReauth } = require("../utils/emailNotifier");
const Instructor = require("../models/instructorSchema");
const settings = require("./instructorSettings");

// Connecting a calendar from the dashboard only stores a refresh token for the
// instructor's own Google account, so their main calendar is "primary".
function calendarIdFor(instructor) {
  return instructor.googleCalendarId || "primary";
}

function lessonMinutes(instructor) {
  return settings.resolveRouteSettings(instructor).lessonDurationMin;
}

async function handleCalendarTokenExpiry(instructor, service, errorMessage) {
  Promise.resolve(notifyInvalidGrant(instructor, service, errorMessage)).catch(() => {});
  Promise.resolve(notifyInstructorReauth(instructor)).catch(() => {});
  try {
    if (instructor?._id) {
      await Instructor.findByIdAndUpdate(instructor._id, { calendarTokenExpired: true });
    }
  } catch (dbErr) {
    logger.error(`Failed to set calendarTokenExpired flag: ${dbErr.message}`);
  }
}

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
   * A Google client for this instructor only. Each call gets its own, so two
   * instructors' requests running at the same time can never use each other's
   * calendar credentials.
   * @param {Object} instructor - Instructor record from DB
   */
  _auth(instructor) {
    return clientFor(instructor.googleRefreshToken);
  }

  async findEarliestAvailableSlot(instructor) {
    try {
      if (!instructor) {
        throw new Error("Instructor object is required");
      }

      for (const dateToCheck of settings.upcomingBookableDates(instructor, 90)) {
        const events = await this.getEventsForDate(dateToCheck, instructor);

        for (const time of settings.timesForDate(instructor, dateToCheck)) {
          const { isAvailable } = this.checkSlotAgainstEvents(dateToCheck, time, events, lessonMinutes(instructor));

          if (isAvailable) {
            logger.info(`Earliest available slot: ${dateToCheck} at ${time}`);
            return { date: dateToCheck, time: time };
          }
        }
      }

      logger.warn("No available slots found in the booking window");
      return null;
    } catch (error) {
      logger.error(`Error finding earliest slot: ${error.message}`);
      return null;
    }
  }

  /**
   * Build start and end DateTime objects in configured timezone
   */
  buildDateTimes(date, time, durationMin = 60) {
    const startDateTime = timezoneUtils.createDateInTimezone(date, time);
    const endDateTime = new Date(startDateTime.getTime() + durationMin * 60 * 1000);

    return { startDateTime, endDateTime };
  }

  /**
   * Fetches all calendar events for a given date in a single API call.
   * @param {string} date - "YYYY-MM-DD"
   * @param {Object} instructor - Instructor record from DB
   * @returns {object[]} array of calendar event objects
   */
  async getEventsForDate(date, instructor) {
    const auth = this._auth(instructor);

    const dayStart = timezoneUtils.createDateInTimezone(date, "00:00");
    const dayEnd = timezoneUtils.createDateInTimezone(date, "00:00");
    dayEnd.setDate(dayEnd.getDate() + 1);

    try {
      const response = await calendar.events.list({
        auth,
        calendarId: calendarIdFor(instructor),
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      return response.data.items || [];
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in getEventsForDate`);
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
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
  checkSlotAgainstEvents(date, time, events, durationMin = 60) {
    const { startDateTime, endDateTime } = this.buildDateTimes(date, time, durationMin);

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
      const result = this.checkSlotAgainstEvents(date, time, events, lessonMinutes(instructor));

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

      const availableSlots = settings.timesForDate(instructor, date).filter((time) => {
        const { isAvailable } = this.checkSlotAgainstEvents(date, time, events, lessonMinutes(instructor));
        return isAvailable;
      });

      return availableSlots;
    } catch (error) {
      logger.error(`Error getting available time slots: ${error.message}`);
      return settings.timesForDate(instructor, date);
    }
  }

  async getCalendarContext(instructor) {
    try {
      const auth = this._auth(instructor);

      const now = timezoneUtils.getCurrentDate();
      const twoWeeksFromNow = new Date(
        now.getTime() + 14 * 24 * 60 * 60 * 1000
      );

      const response = await calendar.events.list({
        auth,
        calendarId: calendarIdFor(instructor),
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
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
      }
      logger.error(`Error getting calendar context: ${error.message}`);
      return [];
    }
  }

  async createEvent(bookingData, instructor) {
    try {
      const auth = this._auth(instructor);

      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.date,
        bookingData.time,
        lessonMinutes(instructor)
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
      };

      const response = await calendar.events.insert({
        auth,
        calendarId: calendarIdFor(instructor),
        resource: event,
      });

      return response.data;
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in createEvent`);
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
      }
      logger.error(`Error creating calendar event: ${error.message}`);
      throw error;
    }
  }

  async createBlockEvent({ date, startTime, endTime, isFullDay, reason }, instructor) {
    try {
      const auth = this._auth(instructor);

      const summary = reason || "Blocked";
      let event;

      if (isFullDay) {
        // All-day event: use date-only start/end (end is exclusive in Google Calendar)
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        const endDate = nextDay.toISOString().slice(0, 10);

        event = {
          summary: `🚫 ${summary}`,
          description: `Time blocked by instructor via Portal.\nReason: ${summary}`,
          start: { date },
          end: { date: endDate },
        };
      } else {
        const { startDateTime, endDateTime } = (() => {
          const s = timezoneUtils.createDateInTimezone(date, startTime);
          const e = timezoneUtils.createDateInTimezone(date, endTime);
          return { startDateTime: s, endDateTime: e };
        })();

        event = {
          summary: `🚫 ${summary}`,
          description: `Time blocked by instructor via Portal.\nReason: ${summary}`,
          start: {
            dateTime: timezoneUtils.formatDate(startDateTime, "YYYY-MM-DDTHH:mm:ss"),
            timeZone: timezoneUtils.timezone,
          },
          end: {
            dateTime: timezoneUtils.formatDate(endDateTime, "YYYY-MM-DDTHH:mm:ss"),
            timeZone: timezoneUtils.timezone,
          },
        };
      }

      const response = await calendar.events.insert({
        auth,
        calendarId: calendarIdFor(instructor),
        resource: event,
      });

      logger.info(`Block event created on ${date}: ${response.data.id}`);
      return response.data;
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in createBlockEvent`);
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
      }
      logger.error(`Error creating block event: ${error.message}`);
      throw error;
    }
  }

  async updateEvent(eventId, bookingData, instructor) {
    try {
      const auth = this._auth(instructor);

      const { startDateTime, endDateTime } = this.buildDateTimes(
        bookingData.newDate,
        bookingData.newTime,
        lessonMinutes(instructor)
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
      };

      const response = await calendar.events.update({
        auth,
        calendarId: calendarIdFor(instructor),
        eventId,
        resource: event,
      });

      logger.info(`Calendar event updated: ${eventId}`);
      return response.data;
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in updateEvent`);
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
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

      const auth = this._auth(instructor);

      await calendar.events.delete({
        auth,
        calendarId: calendarIdFor(instructor),
        eventId,
      });

      logger.info(`Calendar event deleted: ${eventId}`);
      return { success: true, eventId };
    } catch (error) {
      if (isInvalidGrant(error)) {
        logger.error(`invalid_grant for instructor ${instructor.name} in deleteEvent`);
        handleCalendarTokenExpiry(instructor, "Calendar", error.message);
      }
      logger.error(`Error deleting calendar event: ${error.message}`);
      throw error;
    }
  }
}

module.exports = new CalendarService();
