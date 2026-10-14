const calendarService = require("./calendarService");
const { to12h } = require("../utils/timeFormat");
const {
  getAvailableDates,
  getInstructor,
} = require("../models/instructorModel");
const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const { customAlphabet } = require("nanoid");
const logger = require("../utils/logger-advanced");
const timezoneUtils = require("../utils/timezoneUtils");
const { getCoordinatesFromPostalCode } = require("./mapsService");
const routeOptimizer = require("./routeOptimizer");
const settings = require("./instructorSettings");
const LessonType = require("../models/lessonTypeModel");
const notifications = require("./notificationService");
const { isDbReady } = require("../utils/db");

const ACTIVE_STATUSES = ["confirmed", "rescheduled"];
const newBookingId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const MAX_ID_ATTEMPTS = 5;

function userFacingError(message, extra = {}) {
  return Object.assign(new Error(message), { userFacing: true }, extra);
}

function isDuplicateKey(err, field) {
  return err?.code === 11000 && (!field || Object.keys(err.keyPattern || err.keyValue || {}).includes(field));
}

function slotTakenError(date, time) {
  return userFacingError(
    `Sorry, ${to12h(time)} on ${date} was just booked by someone else. Please pick another time.`,
    { code: "SLOT_TAKEN" }
  );
}

function hoursUntil(date, time) {
  return (timezoneUtils.createDateInTimezone(date, time).getTime() - Date.now()) / 3600000;
}

async function geocodeAddress(address, from, label) {
  try {
    const geo = await getCoordinatesFromPostalCode(address);
    logger.info(`${label} geocoded for ${from}: (${geo.lat}, ${geo.lng}) — ${geo.formattedAddress || address}`);
    return { address, latitude: geo.lat, longitude: geo.lng };
  } catch (err) {
    logger.warn(`${label} geocoding failed for "${address}": ${err.message}`);
    return { address };
  }
}

async function resolveLessonType(instructorId, requestedName, defaultId) {
  if (!requestedName && !defaultId) return null;
  if (!isDbReady()) return null;
  try {
    if (requestedName) {
      const types = await LessonType.find({ instructorId, active: true }).lean();
      const wanted = String(requestedName).trim().toLowerCase();
      const match =
        types.find((t) => t.name.toLowerCase() === wanted) ||
        types.find((t) => t.name.toLowerCase().includes(wanted) || wanted.includes(t.name.toLowerCase()));
      if (match) return match;
    }
    if (defaultId) return await LessonType.findOne({ _id: defaultId, instructorId }).lean();
  } catch (err) {
    logger.warn(`Lesson type lookup failed: ${err.message}`);
  }
  return null;
}

class BookingService {
  async getBookingsByUser(userPhone, instructorId) {
    const query = {
      userPhone,
      status: { $in: ["confirmed", "rescheduled"] },
    };
    if (instructorId) query.instructorId = instructorId;
    return await Booking.find(query).sort({ date: 1, time: 1 });
  }

  /**
   * Cancels a booking. Pass scope { userPhone, instructorId } so a learner can
   * only cancel their own lessons; an unknown or someone else's id returns null.
   * Returns { booking, late } where late means inside the instructor's notice period.
   */
  async cancelBooking(bookingId, scope = {}) {
    let booking;
    try {
      booking = await Booking.findOne({
        bookingId,
        ...(scope.userPhone && { userPhone: scope.userPhone }),
        ...(scope.instructorId && { instructorId: scope.instructorId }),
      });
    } catch (err) {
      logger.error(`Cancel booking lookup error: ${err.message}`);
      throw new Error("Internal server error while cancelling booking.");
    }
    if (!booking) return null;
    if (booking.status === "cancelled") return booking;

    const instructor = scope.instructor || (await getInstructor(booking.instructorId));
    const { cancellationNoticeHours } = settings.resolveBotSettings(instructor);
    const late = cancellationNoticeHours > 0 && hoursUntil(booking.date, booking.time) < cancellationNoticeHours;

    try {
      await calendarService.deleteEvent(booking.calendarEventId, instructor);
    } catch (err) {
      logger.error(`Calendar deletion failed: ${err.message}`);
    }

    try {
      booking.status = "cancelled";
      if (late) booking.lateCancellation = true;
      await booking.save();
    } catch (err) {
      logger.error(`Cancel booking error: ${err.message}`);
      throw new Error("Internal server error while cancelling booking.");
    }

    notifications.bookingChanged(instructor, "cancelled", booking).catch(() => {});
    require("./waitlistService")
      .offerSlot(instructor, booking.date, booking.time, booking.userPhone)
      .catch((err) => logger.warn(`Waitlist offer failed: ${err.message}`));
    return booking;
  }

  isLateCancellation(booking, instructor) {
    const { cancellationNoticeHours } = settings.resolveBotSettings(instructor);
    return cancellationNoticeHours > 0 && hoursUntil(booking.date, booking.time) < cancellationNoticeHours;
  }

  async validateBooking(bookingData, instructor) {
    const availableDates = getAvailableDates(instructor);

    const errors = [];

    if (!bookingData.date) errors.push("Date is required");
    if (!bookingData.time) errors.push("Time is required");

    if (errors.length > 0) return errors;

    if (!availableDates.includes(bookingData.date)) {
      errors.push(
        `Date is not available. ${instructor.name || "The instructor"} works ${settings.describeWorkingDays(instructor)}.`
      );
    }

    const dayTimes = settings.timesForDate(instructor, bookingData.date);
    if (!dayTimes.includes(bookingData.time)) {
      errors.push(
        "Time slot is not available. Available times: " +
          (dayTimes.length ? dayTimes : settings.allWorkingTimes(instructor)).join(", ")
      );
    }

    const { maxLessonsPerDay } = settings.resolveBotSettings(instructor);
    if (errors.length === 0 && maxLessonsPerDay) {
      const booked = await Booking.countDocuments({
        date: bookingData.date,
        instructorId: instructor.phoneNumberId,
        status: { $in: ["confirmed", "rescheduled"] },
      });
      if (booked >= maxLessonsPerDay) {
        errors.push(`${bookingData.date} is fully booked. Please choose a different date.`);
      }
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
          `The time slot ${to12h(bookingData.time)} on ${bookingData.date} is already booked.`
        );

        const availableSlots = dayTimes.filter((time) => {
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

  /**
   * Moves a learner's own booking. Returns null if the id isn't theirs.
   * The new slot is claimed in Mongo first (unique per instructor/date/time),
   * then the calendar is updated; if the calendar fails the move is undone.
   */
  async rescheduleBooking(from, bookingData, instructorId = null) {
    const { newDate, newTime, bookingId } = bookingData;

    const booking = await Booking.findOne({
      bookingId,
      userPhone: from,
      ...(instructorId && { instructorId }),
      status: { $in: ACTIVE_STATUSES },
    });
    if (!booking) return null;

    const user = await User.findOne({ phone: from, instructorId: booking.instructorId });
    if (!user) throw new Error("User not found");

    const instructor = await getInstructor(booking.instructorId);
    if (!instructor) throw new Error("Instructor not found for this booking");

    const validationErrors = await this.validateBooking({
      ...booking.toObject(),
      date: newDate,
      time: newTime,
    }, instructor);
    if (validationErrors.length > 0) throw userFacingError(validationErrors.join(" "));

    const previous = { date: booking.date, time: booking.time, status: booking.status };

    if (bookingData.pickupAddress) {
      booking.pickupLocation = await geocodeAddress(bookingData.pickupAddress, from, "Pickup");
    }
    if (bookingData.dropoffAddress) {
      booking.dropoffLocation = await geocodeAddress(bookingData.dropoffAddress, from, "Drop-off");
    }

    booking.date = newDate;
    booking.time = newTime;
    booking.status = "rescheduled";
    booking.reminderSentAt = null;
    booking.learnerConfirmedAt = null;
    booking.postalCode = user.postalCode || booking.postalCode;
    if (user.location?.latitude && user.location?.longitude) {
      booking.location = {
        latitude: user.location.latitude,
        longitude: user.location.longitude,
      };
    }

    try {
      await booking.save();
    } catch (err) {
      if (isDuplicateKey(err, "date")) throw slotTakenError(newDate, newTime);
      throw err;
    }

    try {
      await calendarService.updateEvent(booking.calendarEventId, bookingData, instructor);
    } catch (err) {
      logger.error(`Calendar update failed for ${bookingId}, undoing reschedule: ${err.message}`);
      Object.assign(booking, previous);
      try {
        await booking.save();
      } catch (e) {
        logger.error(`Undo reschedule failed for ${bookingId}: ${e.message}`);
      }
      throw err;
    }

    logger.info(`Booking ${bookingId} rescheduled for ${from}`);
    notifications.bookingChanged(instructor, "rescheduled", booking, previous).catch(() => {});
    return booking;
  }

  async createBooking(from, bookingData, instructor) {
    const validationErrors = await this.validateBooking(bookingData, instructor);
    if (validationErrors.length > 0) {
      throw userFacingError(validationErrors.join(" "));
    }

    const user = await User.findOne({ phone: from, instructorId: instructor.phoneNumberId });

    if (!user) {
      throw new Error("User not found. Please complete your profile first.");
    }

    const weeklyCap = user.schedulingPrefs?.maxLessonsPerWeek;
    if (weeklyCap) {
      const day = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(bookingData.date, "12:00"), "d"));
      const monday = timezoneUtils.addDays(bookingData.date, -((day + 6) % 7));
      const thisWeek = await Booking.countDocuments({
        userPhone: from,
        instructorId: instructor.phoneNumberId,
        status: { $in: ACTIVE_STATUSES },
        date: { $gte: monday, $lte: timezoneUtils.addDays(monday, 6) },
      });
      if (thisWeek >= weeklyCap) {
        throw userFacingError(`You've reached your limit of ${weeklyCap} lesson${weeklyCap > 1 ? "s" : ""} that week. Please pick a date in another week.`);
      }
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

    if (bookingData.pickupCoords && bookingData.pickupAddress) {
      pickupLocation = {
        address: bookingData.pickupAddress,
        latitude: bookingData.pickupCoords.lat,
        longitude: bookingData.pickupCoords.long,
      };
    } else if (bookingData.pickupAddress) {
      pickupLocation = await geocodeAddress(bookingData.pickupAddress, from, "Pickup");
    }

    if (bookingData.dropoffAddress) {
      dropoffLocation = await geocodeAddress(bookingData.dropoffAddress, from, "Drop-off");
    }

    let routeFit = null;
    try {
      const at = pickupLocation.latitude !== undefined
        ? { lat: pickupLocation.latitude, long: pickupLocation.longitude }
        : { lat: user.location.latitude, long: user.location.longitude };
      routeFit = await routeOptimizer.evaluateSlot(bookingData.date, bookingData.time, instructor, at);
    } catch (err) {
      logger.warn(`Route fit for booking not recorded: ${err.message}`);
    }

    const lessonType = await resolveLessonType(
      instructor.phoneNumberId,
      bookingData.lessonType,
      user.schedulingPrefs?.defaultLessonTypeId
    );

    const doc = {
      userPhone: bookingData.userPhone,
      date: bookingData.date,
      time: bookingData.time,
      instructorId: instructor.phoneNumberId,
      calendarEventId: null,
      status: "confirmed",
      postalCode: user.postalCode,
      location: {
        latitude: user.location.latitude,
        longitude: user.location.longitude,
      },
      pickupLocation,
      dropoffLocation,
      lessonTypeId: lessonType?._id || null,
      lessonTypeName: lessonType?.name || "",
      price: lessonType ? lessonType.price : null,
      addedDriveMin: routeFit?.addedDrive != null ? Math.round(routeFit.addedDrive * 10) / 10 : null,
      routeScoreReason: routeFit?.reason || "",
    };

    // Claim the slot in Mongo first: the unique index on instructor/date/time
    // stops two learners booking it at once. Retry only on a bookingId clash.
    let newBooking;
    for (let attempt = 1; !newBooking; attempt++) {
      try {
        newBooking = await Booking.create({ ...doc, bookingId: `DL-${newBookingId()}` });
      } catch (err) {
        if (isDuplicateKey(err, "bookingId") && attempt < MAX_ID_ATTEMPTS) continue;
        if (isDuplicateKey(err, "date")) throw slotTakenError(bookingData.date, bookingData.time);
        throw err;
      }
    }

    let calendarEvent;
    try {
      calendarEvent = await calendarService.createEvent(bookingData, instructor);
    } catch (err) {
      logger.error(`Calendar event failed for ${newBooking.bookingId}, releasing slot: ${err.message}`);
      try {
        await Booking.deleteOne({ _id: newBooking._id });
      } catch (e) {
        logger.error(`Could not release ${newBooking.bookingId}: ${e.message}`);
      }
      throw err;
    }

    newBooking.calendarEventId = calendarEvent.id;
    await Booking.updateOne({ _id: newBooking._id }, { calendarEventId: calendarEvent.id });

    notifications.bookingChanged(instructor, "booked", newBooking).catch(() => {});

    return {
      booking: newBooking,
      calendarEvent,
      bookingData,
      lessonType,
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
