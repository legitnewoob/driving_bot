const { oauth2Client, calendar } = require("../config/google");
const { getInstructor } = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils"); // ✅ import utils

class CalendarService {
  /**
   * Build start and end DateTime objects in configured timezone
   */
  buildDateTimes(date, time) {
    const startDateTime = timezoneUtils.createDateInTimezone(date, time);
    const endDateTime = timezoneUtils.createDateInTimezone(date, time);
    endDateTime.setHours(endDateTime.getHours() + 1);

    return { startDateTime, endDateTime };
  }
  async checkAvailability(date, time, instructorId) {
    try {
      console.log(`🔍 Checking availability for ${date} at ${time}...`);
      // console.log("Using instructor ID:", instructorId);
      oauth2Client.setCredentials({
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
      });

      // console.log("Refresh token:", process.env.GOOGLE_REFRESH_TOKEN);
      const instructor = getInstructor(instructorId);
      // console.log("Using instructor:", instructor);
      if (!instructor) {
        console.error(`❌ Instructor not found: ${instructorId}`);
        return { isAvailable: false, error: "Instructor not found" };
      }

      const { startDateTime, endDateTime } = this.buildDateTimes(date, time);

      if (isNaN(startDateTime.getTime())) {
        console.error(`❌ Invalid date/time format: ${date} ${time}`);
        return { isAvailable: false, error: "Invalid date/time format" };
      }

      const response = await calendar.events.list({
        calendarId: instructor.googleCalendarId,
        timeMin: startDateTime.toISOString(),
        timeMax: endDateTime.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];

      const conflictingEvents = events.filter((event) => {
        if (!event.start || !event.end) return false;

        const eventStart = new Date(event.start.dateTime || event.start.date);
        const eventEnd = new Date(event.end.dateTime || event.end.date);

        return startDateTime < eventEnd && endDateTime > eventStart;
      });

      const isAvailable = conflictingEvents.length === 0;
      console.log(
        `✅ Time slot ${date} at ${time} is ${
          isAvailable ? "AVAILABLE" : "NOT AVAILABLE"
        }`
      );

      return { isAvailable, conflictingEvents };
    } catch (error) {
      console.error("❌ Error checking calendar availability:", error.message);
      return {
        isAvailable: true,
        error: `Could not verify calendar availability: ${error.message}`,
        warning: true,
      };
    }
  }

  async getAvailableTimeSlotsForDate(date, instructorId) {
    try {
      const instructor = getInstructor(instructorId);
      const availableSlots = [];

      for (const time of instructor.availableTimes) {
        const availability = await this.checkAvailability(
          date,
          time,
          instructorId
        );
        if (availability.isAvailable) {
          availableSlots.push(time);
        }
      }

      return availableSlots;
    } catch (error) {
      console.error("❌ Error getting available time slots:", error);
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
      console.error("❌ Error getting calendar context:", error.message);
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
      console.error("❌ Error creating calendar event:", error.message);
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
        description: `Driving lesson booking\nPhone: ${fromUser}}`,
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

      console.log(`✅ Calendar event updated: ${eventId}`);
      return response.data;
    } catch (error) {
      console.error("❌ Error updating calendar event:", error.message);
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

      console.log(`✅ Calendar event deleted: ${eventId}`);
      return { success: true, eventId };
    } catch (error) {
      console.error("❌ Error deleting calendar event:", error.message);
      throw error;
    }
  }
}

module.exports = new CalendarService();
