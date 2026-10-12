const calendarService = require("./calendarService");
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
  async getBookingsByUser(userPhone, instructorId) {
    const query = {
      userPhone,
      status: { $in: ["confirmed", "rescheduled"] },
    };
    if (instructorId) query.instructorId = instructorId;
    return await Booking.find(query).sort({ date: 1, time: 1 });
  }

  async cancelBooking(bookingId) {
    try {
      const booking = await Booking.findOne({ bookingId });

      if (!booking) {
        return null; // signal not found
      }

      // Delete calendar event (optional, catch if external API fails)
      try {
        const instructor = await getInstructor(booking.instructorId);
        await calendarService.deleteEvent(booking.calendarEventId, instructor);
      } catch (err) {
        logger.error(`Calendar deletion failed: ${err.message}`);
        // continue cancellation even if calendar event deletion fails
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

    if (!bookingData.date) errors.push("Date is required");
    if (!bookingData.time) errors.push("Time is required");

    if (errors.length > 0) return errors;

    if (!availableDates.includes(bookingData.date)) {
      errors.push(
        "Date is not available. Please choose from available weekdays."
      );
    }

    if (!instructor.availableTimes.includes(bookingData.time)) {
      errors.push(
        "Time slot is not available. Available times: " +
          instructor.availableTimes.join(", ")
      );
    }

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

    const booking = await Booking.findOne({ bookingId });
    if (!booking) throw new Error("Booking not found");

    const user = await User.findOne({ phone: from });
    if (!user) throw new Error("User not found");

    const instructor = await getInstructor(booking.instructorId);
    if (!instructor) throw new Error("Instructor not found for this booking");

    const validationErrors = await this.validateBooking({
      ...booking.toObject(),
      date: newDate,
      time: newTime,
    }, instructor);
    if (validationErrors.length > 0)
      throw new Error(validationErrors.join(". "));

    await calendarService.updateEvent(
      booking.calendarEventId,
      bookingData,
      instructor
    );

    if (bookingData.pickupAddress) {
      try {
        logger.info(`Geocoding pickup address for reschedule ${bookingId}: "${bookingData.pickupAddress}"`);
        const geo = await getCoordinatesFromPostalCode(bookingData.pickupAddress);
        booking.pickupLocation = { address: bookingData.pickupAddress, latitude: geo.lat, longitude: geo.lng };
        logger.info(`Pickup geocoded for reschedule ${bookingId}: (${geo.lat}, ${geo.lng}) — ${geo.formattedAddress || bookingData.pickupAddress}`);
      } catch (err) {
        logger.warn(`Pickup geocoding failed for "${bookingData.pickupAddress}": ${err.message}`);
        booking.pickupLocation = { address: bookingData.pickupAddress };
      }
    }

    if (bookingData.dropoffAddress) {
      try {
        logger.info(`Geocoding drop-off address for reschedule ${bookingId}: "${bookingData.dropoffAddress}"`);
        const geo = await getCoordinatesFromPostalCode(bookingData.dropoffAddress);
        booking.dropoffLocation = { address: bookingData.dropoffAddress, latitude: geo.lat, longitude: geo.lng };
        logger.info(`Drop-off geocoded for reschedule ${bookingId}: (${geo.lat}, ${geo.lng}) — ${geo.formattedAddress || bookingData.dropoffAddress}`);
      } catch (err) {
        logger.warn(`Drop-off geocoding failed for "${bookingData.dropoffAddress}": ${err.message}`);
        booking.dropoffLocation = { address: bookingData.dropoffAddress };
      }
    }

    booking.date = newDate;
    booking.time = newTime;
    booking.status = "rescheduled";

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

    let pickupLocation = {};
    let dropoffLocation = {};

    if (bookingData.pickupAddress) {
      try {
        logger.info(`Geocoding pickup address for ${from}: "${bookingData.pickupAddress}"`);
        const geo = await getCoordinatesFromPostalCode(bookingData.pickupAddress);
        pickupLocation = { address: bookingData.pickupAddress, latitude: geo.lat, longitude: geo.lng };
        logger.info(`Pickup geocoded for ${from}: (${geo.lat}, ${geo.lng}) — ${geo.formattedAddress || bookingData.pickupAddress}`);
      } catch (err) {
        logger.warn(`Pickup geocoding failed for "${bookingData.pickupAddress}": ${err.message}`);
        pickupLocation = { address: bookingData.pickupAddress };
      }
    }

    if (bookingData.dropoffAddress) {
      try {
        logger.info(`Geocoding drop-off address for ${from}: "${bookingData.dropoffAddress}"`);
        const geo = await getCoordinatesFromPostalCode(bookingData.dropoffAddress);
        dropoffLocation = { address: bookingData.dropoffAddress, latitude: geo.lat, longitude: geo.lng };
        logger.info(`Drop-off geocoded for ${from}: (${geo.lat}, ${geo.lng}) — ${geo.formattedAddress || bookingData.dropoffAddress}`);
      } catch (err) {
        logger.warn(`Drop-off geocoding failed for "${bookingData.dropoffAddress}": ${err.message}`);
        dropoffLocation = { address: bookingData.dropoffAddress };
      }
    }

    const calendarEvent = await calendarService.createEvent(bookingData, instructor);

    const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4);
    const bookingId = `DL-${nanoid()}`;

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

    return {
      booking: newBooking,
      calendarEvent,
      bookingData,
    };
  }

  async completeBooking(bookingId) {
    try {
      const booking = await Booking.findOne({ bookingId });
      if (!booking) return null;

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
