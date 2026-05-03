const calendarService = require("./calendarService");
const sheetsService = require("./sheetsService"); // Add this import
const {
  getAvailableDates,
  getInstructor,
} = require("../models/instructorModel");
const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const { customAlphabet } = require("nanoid");
const logger = require("../utils/logger-advanced");
const { getCoordinatesFromPostalCode } = require("./mapsService");

class BookingService {
  async getBookingsByUser(userPhone) {
    return await Booking.find({
      userPhone,
      status: { $in: ["confirmed", "rescheduled"] },
    }).sort({
      date: 1,
      time: 1,
    });
  }

  async cancelBooking(bookingId) {
    try {
      // Find by custom bookingId field instead of _id
      const booking = await Booking.findOne({ bookingId });

      if (!booking) {
        return null; // signal not found
      }

      // Delete calendar event (optional, catch if external API fails)
      try {
        await calendarService.deleteEvent(booking.calendarEventId);
      } catch (err) {
        logger.error(`Calendar deletion failed: ${err.message}`);
        // continue cancellation even if calendar event deletion fails
      }

      // Update Google Sheets
      try {
        const spreadsheetId = sheetsService.getInstructorSpreadsheetId(
          booking.instructorId
        );
        const learnerName = await sheetsService.getLearnerName(
          booking.userPhone,
          booking
        );

        await sheetsService.updateLearnerRecord(
          spreadsheetId,
          {
            phoneNumber: booking.userPhone,
            name: learnerName,
            location: booking.location || "",
          },
          booking,
          "cancel"
        );
      } catch (err) {
        logger.error(`Sheets update failed during cancellation: ${err.message}`);
        // Continue with cancellation even if sheets update fails
      }

      booking.status = "cancelled";
      await booking.save();

      return booking;
    } catch (err) {
      logger.error(`Cancel booking error: ${err.message}`);
      throw new Error("Internal server error while cancelling booking.");
    }
  }

  async validateBooking(bookingData, instructor) {
    const availableDates = getAvailableDates();

    const errors = [];

    // Check required fields
    if (!bookingData.date) errors.push("Date is required");
    if (!bookingData.time) errors.push("Time is required");
    // if (!bookingData.lessonType) errors.push("Lesson type is required");

    if (errors.length > 0) return errors;

    // Validate date
    if (!availableDates.includes(bookingData.date)) {
      errors.push(
        "Date is not available. Please choose from available weekdays."
      );
    }

    // Validate time
    if (!instructor.availableTimes.includes(bookingData.time)) {
      errors.push(
        "Time slot is not available. Available times: " +
          instructor.availableTimes.join(", ")
      );
    }

    // Validate lesson type
    // if (!["basic", "highway", "parking"].includes(bookingData.lessonType)) {
    //   errors.push(
    //     "Invalid lesson type. Choose from: basic, highway, or parking"
    //   );
    // }

    // Check calendar availability (single API call for the whole day)
    if (errors.length === 0) {
      const events = await calendarService.getEventsForDate(
        bookingData.date,
        instructor
      );

      const availability = calendarService.checkSlotAgainstEvents(
        bookingData.date,
        bookingData.time,
        events
      );

      if (!availability.isAvailable) {
        errors.push(
          `The time slot ${bookingData.time} on ${bookingData.date} is already booked.`
        );

        const availableSlots = instructor.availableTimes.filter((time) => {
          const { isAvailable } = calendarService.checkSlotAgainstEvents(
            bookingData.date,
            time,
            events
          );
          return isAvailable;
        });

        if (availableSlots.length > 0) {
          errors.push(
            `Available times for ${bookingData.date}: ${availableSlots.join(
              ", "
            )}`
          );
        } else {
          errors.push(
            `No available time slots for ${bookingData.date}. Please choose a different date.`
          );
        }
      }
    }

    return errors;
  }

  async rescheduleBooking(from, bookingData) {
    const { newDate, newTime, bookingId } = bookingData;
    
    // Step 1: Find booking
    const booking = await Booking.findOne({ bookingId });
    if (!booking) throw new Error("Booking not found");

    // Step 2: Find user (for postal code + lat/long)
    const user = await User.findOne({ phone: from });
    if (!user) throw new Error("User not found");

    // Step 2b: Resolve instructor from the booking's stored instructorId
    const instructor = await getInstructor(booking.instructorId);
    if (!instructor) throw new Error("Instructor not found for this booking");

    // Step 3: Validate slot availability
    const validationErrors = await this.validateBooking({
      ...booking.toObject(),
      date: newDate,
      time: newTime,
    }, instructor);
    if (validationErrors.length > 0)
      throw new Error(validationErrors.join(". "));

    // Step 4: Update event in calendar
    await calendarService.updateEvent(
      booking.calendarEventId,
      bookingData,
      instructor
    );

    // Step 5: Update Google Sheets
    try {
      const spreadsheetId = sheetsService.getInstructorSpreadsheetId(
        booking.instructorId
      );
      const learnerName = await sheetsService.getLearnerName(from, booking);

      await sheetsService.updateLearnerRecord(
        spreadsheetId,
        {
          phoneNumber: from,
          name: learnerName,
          location: booking.location || user.postalCode || "",
        },
        bookingData,
        "reschedule"
      );
    } catch (err) {
      logger.error(`Sheets update failed during rescheduling: ${err.message}`);
      // Continue even if Sheets update fails
    }

    // Step 6: Geocode new pickup/drop-off if provided
    if (bookingData.pickupAddress) {
      try {
        const geo = await getCoordinatesFromPostalCode(bookingData.pickupAddress);
        booking.pickupLocation = { address: bookingData.pickupAddress, latitude: geo.lat, longitude: geo.lng };
      } catch (err) {
        logger.warn(`Pickup geocoding failed for "${bookingData.pickupAddress}": ${err.message}`);
        booking.pickupLocation = { address: bookingData.pickupAddress };
      }
    }

    if (bookingData.dropoffAddress) {
      try {
        const geo = await getCoordinatesFromPostalCode(bookingData.dropoffAddress);
        booking.dropoffLocation = { address: bookingData.dropoffAddress, latitude: geo.lat, longitude: geo.lng };
      } catch (err) {
        logger.warn(`Drop-off geocoding failed for "${bookingData.dropoffAddress}": ${err.message}`);
        booking.dropoffLocation = { address: bookingData.dropoffAddress };
      }
    }

    // Step 7: Update Mongo booking fields
    booking.date = newDate;
    booking.time = newTime;
    booking.status = "rescheduled";

    // Sync updated location from user profile
    booking.postalCode = user.postalCode || booking.postalCode;
    if (user.location?.latitude && user.location?.longitude) {
      booking.location = {
        latitude: user.location.latitude,
        longitude: user.location.longitude,
      };
    }

    await booking.save();

    logger.info(`Booking ${bookingId} rescheduled for ${from}`);
    return booking;
  }

  async createBooking(from, bookingData, instructor) {
    const validationErrors = await this.validateBooking(bookingData, instructor);
    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(". "));
    }

    // ✅ Step 1: Fetch user details
    const user = await User.findOne({ phone: from });

    if (!user) {
      throw new Error("User not found. Please complete your profile first.");
    }

    if (
      !user.postalCode ||
      !user.location?.latitude ||
      !user.location?.longitude
    ) {
      throw new Error(
        "User location details are incomplete. Please update your postal code first."
      );
    }

    // ✅ Step 2: Geocode pickup & drop-off addresses
    let pickupLocation = {};
    let dropoffLocation = {};

    if (bookingData.pickupAddress) {
      try {
        const geo = await getCoordinatesFromPostalCode(bookingData.pickupAddress);
        pickupLocation = { address: bookingData.pickupAddress, latitude: geo.lat, longitude: geo.lng };
      } catch (err) {
        logger.warn(`Pickup geocoding failed for "${bookingData.pickupAddress}": ${err.message}`);
        pickupLocation = { address: bookingData.pickupAddress };
      }
    }

    if (bookingData.dropoffAddress) {
      try {
        const geo = await getCoordinatesFromPostalCode(bookingData.dropoffAddress);
        dropoffLocation = { address: bookingData.dropoffAddress, latitude: geo.lat, longitude: geo.lng };
      } catch (err) {
        logger.warn(`Drop-off geocoding failed for "${bookingData.dropoffAddress}": ${err.message}`);
        dropoffLocation = { address: bookingData.dropoffAddress };
      }
    }

    // ✅ Step 3: Create event in Google Calendar
    const calendarEvent = await calendarService.createEvent(bookingData, instructor);

    // ✅ Step 4: Generate booking ID
    const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4); // no O/0/I/1 confusion
    const bookingId = `DL-${nanoid()}`;

    // ✅ Step 5: Create booking with user location + pickup/drop-off
    const newBooking = await Booking.create({
      bookingId,
      userPhone: bookingData.userPhone,
      date: bookingData.date,
      time: bookingData.time,
      instructorId: instructor.phoneNumberId,
      calendarEventId: calendarEvent.id,
      status: "confirmed",
      postalCode: user.postalCode,
      location: {
        latitude: user.location.latitude,
        longitude: user.location.longitude,
      },
      pickupLocation,
      dropoffLocation,
    });

    // ✅ Step 6: Update Google Sheets
    try {
      const spreadsheetId = instructor.spreadsheetId || sheetsService.getInstructorSpreadsheetId(
        instructor.phoneNumberId
      );
      const learnerName = await sheetsService.getLearnerName(
        bookingData.userPhone,
        bookingData
      );

      await sheetsService.updateLearnerRecord(
        spreadsheetId,
        {
          phoneNumber: bookingData.userPhone,
          name: learnerName,
          location: user.postalCode,
        },
        bookingData,
        "create"
      );
    } catch (err) {
      logger.error(`Sheets update failed during booking creation: ${err.message}`);
      // Continue even if Sheets update fails
    }

    return {
      booking: newBooking,
      calendarEvent,
      bookingData,
    };
  }

  /**
   * Mark a booking as completed (useful for post-lesson updates)
   */
  async completeBooking(bookingId) {
    try {
      const booking = await Booking.findOne({ bookingId });
      if (!booking) return null;

      // Update Google Sheets
      try {
        const spreadsheetId = sheetsService.getInstructorSpreadsheetId(
          booking.instructorId
        );
        const learnerName = await sheetsService.getLearnerName(
          booking.userPhone,
          booking
        );

        await sheetsService.updateLearnerRecord(
          spreadsheetId,
          {
            phoneNumber: booking.userPhone,
            name: learnerName,
            location: booking.location || "",
          },
          booking,
          "complete"
        );
      } catch (err) {
        logger.error(`Sheets update failed during completion: ${err.message}`);
      }

      booking.status = "completed";
      await booking.save();

      return booking;
    } catch (err) {
      logger.error(`Complete booking error: ${err.message}`);
      throw new Error("Internal server error while completing booking.");
    }
  }
}

module.exports = new BookingService();
