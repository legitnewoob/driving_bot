// Tells instructors about bookings Donna makes or changes: a portal
// notification (polled by the bell) and, if they want it, an email.
const Notification = require("../models/notificationModel");
const { to12h } = require("../utils/timeFormat");
const User = require("../models/userModel");
const settings = require("./instructorSettings");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { sendNotification } = require("../utils/emailNotifier");
const { isDbReady } = require("../utils/db");

const escape = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (date) => timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "ddd D MMM");

async function learnerName(instructorId, phone) {
  if (!isDbReady()) return phone;
  try {
    const user = await User.findOne({ phone, instructorId }).lean();
    return user?.name || phone;
  } catch {
    return phone;
  }
}

/**
 * Records a portal notification and optionally emails the instructor.
 * Never throws: notifications must not break a booking.
 */
async function notify(instructor, { type, message, clientId, bookingId = null, learnerPhone = null, emailSubject = null }) {
  const prefs = settings.resolveBotSettings(instructor).notifications;
  try {
    if (isDbReady()) {
      await Notification.create({
        instructorId: instructor.phoneNumberId,
        type,
        message,
        clientId,
        bookingId,
        learnerPhone,
      });
    }
  } catch (err) {
    logger.warn(`Portal notification failed: ${err.message}`);
  }

  if (prefs.email && instructor.email && emailSubject) {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <p>Hi ${escape(instructor.name || "there")},</p>
        <p>${escape(message)}</p>
        <p style="color: #999; font-size: 11px;">Sent by Donna. Change which emails you get in Donna Settings on your dashboard.</p>
      </div>`;
    sendNotification(emailSubject, html, null, instructor.email).catch(() => {});
  }
}

async function bookingChanged(instructor, kind, booking, previous = null) {
  if (!instructor) return;
  const prefs = settings.resolveBotSettings(instructor).notifications;
  if (!prefs[kind]) return;

  const name = await learnerName(instructor.phoneNumberId, booking.userPhone);
  const when = `${fmtDate(booking.date)} at ${to12h(booking.time)}`;
  let message;
  let clientId;
  if (kind === "booked") {
    message = `New booking: ${name} — ${when}${booking.lessonTypeName ? ` (${booking.lessonTypeName})` : ""}`;
    clientId = `notif-${booking.bookingId}`; // matches the portal's own new-booking id
  } else if (kind === "cancelled") {
    message = `${name} cancelled their lesson on ${when}${booking.lateCancellation ? " — late cancellation" : ""}`;
    clientId = `notif-cancel-${booking.bookingId}`;
  } else {
    message = `${name} moved their lesson from ${previous ? `${fmtDate(previous.date)} at ${to12h(previous.time)}` : "its old time"} to ${when}`;
    clientId = `notif-move-${booking.bookingId}-${booking.date}-${booking.time}`;
  }

  await notify(instructor, {
    type: kind,
    message,
    clientId,
    bookingId: booking.bookingId,
    learnerPhone: booking.userPhone,
    emailSubject: `Donna: ${message}`,
  });
}

module.exports = { notify, bookingChanged };
