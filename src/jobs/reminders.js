// Lesson reminders: ~24h before each lesson (and optionally ~2h before),
// with buttons to confirm, reschedule or cancel.
//
// WhatsApp only allows free-form messages within 24h of the learner's last
// message. Outside that window we must use Meta-approved templates, named by:
//   WHATSAPP_REMINDER_TEMPLATE        body {{1}} instructor, {{2}} day, {{3}} time, {{4}} pickup;
//                                     3 quick-reply buttons (confirm, reschedule, cancel)
//   WHATSAPP_SHORT_REMINDER_TEMPLATE  body {{1}} instructor, {{2}} time, {{3}} pickup
//   WHATSAPP_TEMPLATE_LANG            defaults to en_GB
// See docs/whatsapp-templates.md for the wording to submit.
const Booking = require("../models/bookingModel");
const { to12h } = require("../utils/timeFormat");
const { getInstructor } = require("../models/instructorModel");
const whatsappService = require("../services/whatsappService");
const settings = require("../services/instructorSettings");
const sessionStore = require("../services/sessionStore");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

const ACTIVE_STATUSES = ["confirmed", "rescheduled"];
const RUN_EVERY_MS = 15 * 60 * 1000;

const formatDay = (date) =>
  timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "dddd D MMMM");

function hoursUntil(booking, now) {
  return (timezoneUtils.createDateInTimezone(booking.date, booking.time).getTime() - now) / 3600000;
}

async function sendReminder(booking, instructor, kind) {
  const name = instructor.name || "your instructor";
  const day = formatDay(booking.date);
  const pickup = booking.pickupLocation?.address || "";
  const id = booking.bookingId;
  const lang = process.env.WHATSAPP_TEMPLATE_LANG || "en_GB";
  const inWindow = await sessionStore.inServiceWindow(booking.userPhone, booking.instructorId);

  if (kind === "long") {
    if (inWindow) {
      await whatsappService.sendButtons(
        booking.userPhone,
        `👋 Reminder: your driving lesson with ${name} is on ${day} at ${to12h(booking.time)}` +
          `${pickup ? `, pickup at ${pickup}` : ""}. Can you still make it?`,
        [
          { id: `rem:confirm:${id}`, title: "I'll be there" },
          { id: `rem:move:${id}`, title: "Reschedule" },
          { id: `rem:cancel:${id}`, title: "Cancel" },
        ],
        instructor
      );
      return true;
    }
    const template = process.env.WHATSAPP_REMINDER_TEMPLATE;
    if (!template) return false;
    await whatsappService.sendTemplate(
      booking.userPhone,
      template,
      lang,
      [name, day, to12h(booking.time), pickup || "your usual pickup"],
      [`rem:confirm:${id}`, `rem:move:${id}`, `rem:cancel:${id}`],
      instructor
    );
    return true;
  }

  if (inWindow) {
    await whatsappService.sendTextMessage(
      booking.userPhone,
      `🚗 See you soon! Your lesson with ${name} starts at ${to12h(booking.time)}${pickup ? `, pickup at ${pickup}` : ""}.`,
      instructor
    );
    return true;
  }
  const template = process.env.WHATSAPP_SHORT_REMINDER_TEMPLATE;
  if (!template) return false;
  await whatsappService.sendTemplate(
    booking.userPhone,
    template,
    lang,
    [name, to12h(booking.time), pickup || "your usual pickup"],
    [],
    instructor
  );
  return true;
}

/**
 * Sends any reminders that are due. Each booking is claimed atomically before
 * sending, so two servers can't send the same reminder.
 */
async function runOnce(now = Date.now()) {
  const result = { sent: 0, skippedNoTemplate: 0, failed: 0 };
  if (!isDbReady()) return result;

  const today = timezoneUtils.getCurrentDateString();
  const dates = [today, timezoneUtils.addDays(today, 1), timezoneUtils.addDays(today, 2)];
  const bookings = await Booking.find({
    status: { $in: ACTIVE_STATUSES },
    date: { $in: dates },
    $or: [{ reminderSentAt: null }, { shortReminderSentAt: null }],
  }).lean();

  for (const booking of bookings) {
    const instructor = await getInstructor(booking.instructorId);
    if (!instructor) continue;
    const mode = settings.resolveBotSettings(instructor).reminders;
    if (mode === "off") continue;

    const hours = hoursUntil(booking, now);
    let kind = null;
    if (!booking.reminderSentAt && hours > 20 && hours <= 25) kind = "long";
    else if (mode === "24h+2h" && !booking.shortReminderSentAt && hours > 1 && hours <= 2.5) kind = "short";
    if (!kind) continue;

    const field = kind === "long" ? "reminderSentAt" : "shortReminderSentAt";
    const claimed = await Booking.findOneAndUpdate({ _id: booking._id, [field]: null }, { [field]: new Date() });
    if (!claimed) continue;

    try {
      if (await sendReminder(booking, instructor, kind)) {
        result.sent++;
      } else {
        result.skippedNoTemplate++;
        await Booking.updateOne({ _id: booking._id }, { [field]: null });
      }
    } catch (err) {
      result.failed++;
      logger.error(`Reminder for ${booking.bookingId} failed: ${err.message}`);
      await Booking.updateOne({ _id: booking._id }, { [field]: null }).catch(() => {});
    }
  }

  if (result.sent || result.failed) logger.info(`Reminders: ${result.sent} sent, ${result.failed} failed`);
  if (result.skippedNoTemplate) {
    logger.warn(
      `Reminders: ${result.skippedNoTemplate} not sent — learner hasn't messaged in 24h and no WhatsApp reminder template is configured`
    );
  }
  return result;
}

/**
 * A learner tapped a reminder button. action: confirm | move | cancel.
 */
async function handleReply(ctx, action, bookingId, controller) {
  const booking = await Booking.findOne({ bookingId, userPhone: ctx.from, instructorId: ctx.instructorId });
  if (!booking || !ACTIVE_STATUSES.includes(booking.status)) {
    await ctx.send("That lesson isn't booked any more. Say \"show my bookings\" to see your lessons.");
    return;
  }

  if (action === "confirm") {
    booking.learnerConfirmedAt = new Date();
    await booking.save();
    await ctx.send(`Great, see you on ${formatDay(booking.date)} at ${to12h(booking.time)}! 👍`);
    return;
  }

  if (action === "move") {
    if (!ctx.bot.allowReschedule) {
      await ctx.send(`To move a lesson, please contact ${ctx.instructor.name} directly.`);
      return;
    }
    const reply = `No problem. What day and time would suit you instead? I'll move booking ${bookingId}.`;
    await ctx.send(reply);
    controller._remember(ctx, `I want to reschedule ${bookingId}`, `${reply}\n[ACTION:NULL]\n{}`);
    return;
  }

  if (action === "cancel") {
    if (!ctx.bot.allowCancel) {
      await ctx.send(`To cancel a lesson, please contact ${ctx.instructor.name} directly.`);
      return;
    }
    await controller.cancelBooking(ctx, { bookingId });
  }
}

let timer = null;
function startReminderJob() {
  if (timer) return;
  const tick = () => runOnce().catch((err) => logger.error(`Reminder job failed: ${err.message}`));
  setTimeout(tick, 60 * 1000);
  timer = setInterval(tick, RUN_EVERY_MS);
}

module.exports = { runOnce, handleReply, startReminderJob, sendReminder };
