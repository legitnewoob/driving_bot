const Booking = require("../models/bookingModel");
const { getInstructor } = require("../models/instructorModel");
const whatsappService = require("./whatsappService");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");

const REMINDERS = [
  { hours: 48, field: "reminder48hSent", template: "lesson_reminder_48h" },
  { hours: 24, field: "reminder24hSent", template: "lesson_reminder_24h" },
];

/**
 * Check for upcoming confirmed bookings and send 24h/48h WhatsApp reminders.
 * Safe to call repeatedly — uses reminder*Sent flags to avoid duplicates.
 */
async function sendLessonReminders() {
  const candidates = await Booking.find({
    status: "confirmed",
    $or: [{ reminder48hSent: false }, { reminder24hSent: false }],
  });

  for (const booking of candidates) {
    const hoursUntil = timezoneUtils.getHoursUntil(booking.date, booking.time);
    if (hoursUntil <= 0) continue;

    for (const reminder of REMINDERS) {
      if (booking[reminder.field]) continue;
      if (hoursUntil > reminder.hours) continue;

      await sendReminder(booking, reminder);
    }
  }
}

async function sendReminder(booking, reminder) {
  try {
    const instructor = await getInstructor(booking.instructorId);
    if (!instructor) {
      logger.error(`Reminder skipped: no instructor found for ${booking.instructorId} (booking ${booking.bookingId})`);
      return;
    }

    const lessonDate = timezoneUtils.formatDate(
      timezoneUtils.createDateInTimezone(booking.date, booking.time),
      "dddd, MMMM D"
    );

    await whatsappService.sendTemplateMessage(
      booking.userPhone,
      reminder.template,
      [instructor.name, lessonDate, booking.time, booking.pickupLocation?.address || booking.postalCode],
      instructor
    );

    booking[reminder.field] = true;
    await booking.save();

    logger.info(`Sent ${reminder.hours}h reminder for booking ${booking.bookingId}`);
  } catch (err) {
    logger.error(`Failed to send ${reminder.hours}h reminder for booking ${booking.bookingId}: ${err.message}`);
  }
}

module.exports = { sendLessonReminders };
