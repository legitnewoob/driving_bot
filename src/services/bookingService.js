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

const toMin = (t) => {
  const [h, m] = String(t || "").split(":").map(Number);
  return h * 60 + (m || 0);
};

/**
 * Another active lesson on the same day that overlaps this one, if any. The
 * unique index only stops two lessons at the *same* time; with different
 * lengths (and packed start times) two learners booking at once could still
 * claim overlapping times, so each booking checks again after claiming.
 */
async function overlappingLesson(booking, instructor) {
  let others;
  try {
    others = await Booking.find({
      instructorId: booking.instructorId,
      date: booking.date,
      status: { $in: ACTIVE_STATUSES },
      bookingId: { $ne: booking.bookingId },
    });
  } catch (err) {
    logger.warn(`Overlap re-check skipped for ${booking.bookingId}: ${err.message}`);
    return null;
  }
  if (!Array.isArray(others)) return null;
  const s = toMin(booking.time);
  const e = s + settings.bookingDuration(booking, instructor);
  return others.find((o) => {
    const os = toMin(o.time);
    return os < e && os + settings.bookingDuration(o, instructor) > s;
  }) || null;
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

async function resolveLessonType(instructorId, requestedName, defaultId, requestedId = null) {
  if (!requestedName && !defaultId && !requestedId) return null;
  if (!isDbReady()) return null;
  try {
    if (requestedId) {
      const byId = await LessonType.findOne({ _id: requestedId, instructorId, active: true }).lean().catch(() => null);
      if (byId) return byId;
    }
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

  /**
   * Problems with a booking's date and time, as learner-facing messages.
   * opts.durationMin is the lesson's length; opts.userLoc / opts.dropoffLoc are
   * where it starts and ends (packed mode checks the drive gaps with them).
   */
  async validateBooking(bookingData, instructor, opts = {}) {
    const availableDates = getAvailableDates(instructor);
    const durationMin = opts.durationMin || bookingData.durationMin || null;
    const lessonMin = durationMin || settings.resolveRouteSettings(instructor).lessonDurationMin;
    const packed = settings.isPacked(instructor);

    const errors = [];

    if (!bookingData.date) errors.push("Date is required");
    if (!bookingData.time) errors.push("Time is required");

    if (errors.length > 0) return errors;

    if (!availableDates.includes(bookingData.date)) {
      errors.push(
        `Date is not available. ${instructor.name || "The instructor"} works ${settings.describeWorkingDays(instructor)}.`
      );
    }

    const dayTimes = settings.timesForDate(instructor, bookingData.date, lessonMin);
    if (packed) {
      const ok = errors.length === 0 && await routeOptimizer.isPackedStartAvailable({
        date: bookingData.date,
        time: bookingData.time,
        instructor,
        durationMin: lessonMin,
        userLoc: opts.userLoc || null,
        dropoffLoc: opts.dropoffLoc || null,
        excludeBookingId: opts.excludeBookingId || null,
      });
      if (!ok && errors.length === 0) {
        errors.push(`${to12h(bookingData.time)} on ${bookingData.date} isn't free for a lesson that long. Please pick one of the offered times.`);
      }
    } else if (!dayTimes.includes(bookingData.time)) {
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
        events.filter((e) => !opts.ignoreEventId || e.id !== opts.ignoreEventId),
        lessonMin
      );

      if (!availability.isAvailable) {
        errors.push(
          `The time slot ${to12h(bookingData.time)} on ${bookingData.date} is already booked.`
        );

        const availableSlots = dayTimes.filter((time) => {
          const { isAvailable } = calendarService.checkSlotAgainstEvents(
            bookingData.date,
            time,
            events,
            lessonMin
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

    // Optional changes besides the time: a different lesson type (and so length),
    // and a new pickup or drop-off. Resolve them first so the checks use them.
    let lessonType = null;
    if (bookingData.lessonTypeId || bookingData.lessonType) {
      lessonType = await resolveLessonType(booking.instructorId, bookingData.lessonType, null, bookingData.lessonTypeId);
      if (!lessonType) throw userFacingError("I couldn't find that lesson type. Please pick one from the list.");
    }
    const durationMin = lessonType?.durationMin || booking.durationMin || null;

    let pickupLocation = null;
    let dropoffLocation = null;
    if (bookingData.pickupAddress) {
      pickupLocation = bookingData.pickupCoords
        ? { address: bookingData.pickupAddress, latitude: bookingData.pickupCoords.lat, longitude: bookingData.pickupCoords.long }
        : await geocodeAddress(bookingData.pickupAddress, from, "Pickup");
    }
    if (bookingData.dropoffAddress) {
      dropoffLocation = bookingData.dropoffCoords
        ? { address: bookingData.dropoffAddress, latitude: bookingData.dropoffCoords.lat, longitude: bookingData.dropoffCoords.long }
        : await geocodeAddress(bookingData.dropoffAddress, from, "Drop-off");
    }
    const toLoc = (l) => (l && typeof l.latitude === "number" ? { lat: l.latitude, long: l.longitude } : null);
    const startLoc = toLoc(pickupLocation) || toLoc(booking.pickupLocation) || toLoc(booking.location);
    const endLoc = toLoc(dropoffLocation) || toLoc(booking.dropoffLocation);

    const validationErrors = await this.validateBooking({
      ...booking.toObject(),
      date: newDate,
      time: newTime,
    }, instructor, {
      durationMin,
      userLoc: startLoc,
      dropoffLoc: endLoc,
      excludeBookingId: booking.bookingId,
      ignoreEventId: booking.calendarEventId,
    });
    if (validationErrors.length > 0) throw userFacingError(validationErrors.join(" "));

    const previous = {
      date: booking.date,
      time: booking.time,
      status: booking.status,
      durationMin: booking.durationMin,
      lessonTypeId: booking.lessonTypeId,
      lessonTypeName: booking.lessonTypeName,
      price: booking.price,
      pickupLocation: booking.pickupLocation,
      dropoffLocation: booking.dropoffLocation,
    };

    if (pickupLocation) booking.pickupLocation = pickupLocation;
    if (dropoffLocation) booking.dropoffLocation = dropoffLocation;
    if (lessonType) {
      booking.lessonTypeId = lessonType._id;
      booking.lessonTypeName = lessonType.name;
      booking.price = lessonType.price;
    }
    if (durationMin) booking.durationMin = durationMin;

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

    // Someone claimed an overlapping time at the same moment: put this one back
    if (await overlappingLesson(booking, instructor)) {
      Object.assign(booking, previous);
      try {
        await booking.save();
      } catch (e) {
        logger.error(`Undo reschedule failed for ${bookingId}: ${e.message}`);
      }
      throw slotTakenError(newDate, newTime);
    }

    try {
      await calendarService.updateEvent(booking.calendarEventId, { ...bookingData, durationMin }, instructor);
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
    require("./typicalDrive").refresh(instructor);
    return booking;
  }

  async createBooking(from, bookingData, instructor) {
    const user = await User.findOne({ phone: from, instructorId: instructor.phoneNumberId });

    // The lesson type sets the length, which every availability check needs
    const lessonType = await resolveLessonType(
      instructor.phoneNumberId,
      bookingData.lessonType,
      user?.schedulingPrefs?.defaultLessonTypeId,
      bookingData.lessonTypeId
    );
    const durationMin = lessonType?.durationMin || bookingData.durationMin || null;

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
    if (bookingData.dropoffCoords && bookingData.dropoffAddress) {
      dropoffLocation = {
        address: bookingData.dropoffAddress,
        latitude: bookingData.dropoffCoords.lat,
        longitude: bookingData.dropoffCoords.long,
      };
    } else if (bookingData.dropoffAddress) {
      dropoffLocation = await geocodeAddress(bookingData.dropoffAddress, from, "Drop-off");
    }

    const startLoc = pickupLocation.latitude !== undefined
      ? { lat: pickupLocation.latitude, long: pickupLocation.longitude }
      : user?.location?.latitude && user?.location?.longitude
        ? { lat: user.location.latitude, long: user.location.longitude }
        : null;
    const endLoc = dropoffLocation.latitude !== undefined
      ? { lat: dropoffLocation.latitude, long: dropoffLocation.longitude }
      : null;

    const validationErrors = await this.validateBooking(bookingData, instructor, {
      durationMin,
      userLoc: startLoc,
      dropoffLoc: endLoc,
    });
    if (validationErrors.length > 0) {
      throw userFacingError(validationErrors.join(" "));
    }

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

    let routeFit = null;
    try {
      const at = startLoc || { lat: user.location.latitude, long: user.location.longitude };
      routeFit = await routeOptimizer.evaluateSlot(bookingData.date, bookingData.time, instructor, at, {
        durationMin,
        dropoffLoc: endLoc,
      });
    } catch (err) {
      logger.warn(`Route fit for booking not recorded: ${err.message}`);
    }

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
      durationMin,
      // createBooking is how Donna books on WhatsApp; other callers say who they are
      source: ["whatsapp", "portal", "dashboard"].includes(bookingData.source) ? bookingData.source : "whatsapp",
      addedDriveMin: routeFit?.addedDrive != null ? Math.round(routeFit.addedDrive * 10) / 10 : null,
      routeScoreReason: routeFit?.reason || "",
      driveInMin: routeFit?.driveIn != null ? Math.round(routeFit.driveIn) : null,
      gapBeforeMin: routeFit?.gapBefore ?? null,
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

    // Someone claimed an overlapping time at the same moment: release this one
    if (await overlappingLesson(newBooking, instructor)) {
      try {
        await Booking.deleteOne({ _id: newBooking._id });
      } catch (e) {
        logger.error(`Could not release ${newBooking.bookingId}: ${e.message}`);
      }
      throw slotTakenError(bookingData.date, bookingData.time);
    }

    let calendarEvent;
    try {
      calendarEvent = await calendarService.createEvent({ ...bookingData, durationMin }, instructor);
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
    require("./typicalDrive").refresh(instructor);

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
module.exports.overlappingLesson = overlappingLesson;
