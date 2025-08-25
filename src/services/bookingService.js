const calendarService = require("./calendarService");
const {
  getAvailableDates,
  getInstructor,
} = require("../models/instructorModel");
const Booking = require("../models/bookingModel");
const { customAlphabet } = require("nanoid");

class BookingService {
  async getBookingsByUser(userPhone) {
    return await Booking.find({ userPhone , status : "confirmed"}).sort({
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
        console.error("Calendar deletion failed:", err.message);
        // continue cancellation even if calendar event deletion fails
      }

      booking.status = "cancelled";
      await booking.save();

      return booking;
    } catch (err) {
      console.error("Cancel booking error:", err);
      throw new Error("Internal server error while cancelling booking.");
    }
  }
  async validateBooking(bookingData) {
    console.log(
      "🔍 Validating booking data:",
      JSON.stringify(bookingData, null, 2)
    );

    const availableDates = getAvailableDates();
    const instructorId = process.env.PHONE_NUMBER_ID;
    const instructor = getInstructor(instructorId);

    const errors = [];

    // Check required fields
    if (!bookingData.date) errors.push("Date is required");
    if (!bookingData.time) errors.push("Time is required");
    if (!bookingData.lessonType) errors.push("Lesson type is required");

    if (errors.length > 0) return errors;

    // Validate date
    console.log(availableDates);
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
    if (!["basic", "highway", "parking"].includes(bookingData.lessonType)) {
      errors.push(
        "Invalid lesson type. Choose from: basic, highway, or parking"
      );
    }

    // Check calendar availability
    if (errors.length === 0) {
      const availability = await calendarService.checkAvailability(
        bookingData.date,
        bookingData.time,
        instructorId
      );

      if (!availability.isAvailable && !availability.warning) {
        errors.push(
          `The time slot ${bookingData.time} on ${bookingData.date} is already booked.`
        );

        const availableSlots =
          await calendarService.getAvailableTimeSlotsForDate(
            bookingData.date,
            instructorId
          );
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

  async rescheduleBooking(bookingId, newDate, newTime) {
    const booking = await Booking.findById(bookingId);
    if (!booking) throw new Error("Booking not found");

    // Check new slot availability
    const validationErrors = await this.validateBooking({
      ...booking.toObject(),
      date: newDate,
      time: newTime,
    });
    if (validationErrors.length > 0)
      throw new Error(validationErrors.join(". "));

    // Update in calendar
    await calendarService.updateEvent(booking.calendarEventId, {
      date: newDate,
      time: newTime,
    });

    // Update in Mongo
    booking.date = newDate;
    booking.time = newTime;
    booking.status = "rescheduled";
    await booking.save();

    return booking;
  }
  async createBooking(bookingData) {
    const validationErrors = await this.validateBooking(bookingData);

    if (validationErrors.length > 0) {
      throw new Error(validationErrors.join(". "));
    }

    const calendarEvent = await calendarService.createEvent(bookingData);

    const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 4); // no O/0/I/1 confusion
    const bookingId = `DL-${nanoid()}`;
    
    const newBooking = await Booking.create({
      bookingId : bookingId,
      userPhone: bookingData.userPhone,
      date: bookingData.date,
      time: bookingData.time,
      lessonType: bookingData.lessonType,
      specialRequests: bookingData.specialRequests,
      instructorId: process.env.PHONE_NUMBER_ID,
      calendarEventId: calendarEvent.id,
      status: "confirmed",
    });

    const instructor = getInstructor(process.env.PHONE_NUMBER_ID);
    const lessonPrice = instructor.rates[bookingData.lessonType];

    return {
      booking: newBooking,
      calendarEvent,
      instructor,
      lessonPrice,
      bookingData,
    };
  }
}

module.exports = new BookingService();
