// Waiting list: learners ask to hear about earlier slots; when a lesson is
// cancelled, the best-fitting few (by route) are offered it. First to tap
// "Book it" gets it — the booking's unique slot index settles any race.
const WaitlistEntry = require("../models/waitlistEntryModel");
const { to12h } = require("../utils/timeFormat");
const Booking = require("../models/bookingModel");
const whatsappService = require("./whatsappService");
const routeOptimizer = require("./routeOptimizer");
const settings = require("./instructorSettings");
const sessionStore = require("./sessionStore");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const MAX_OFFERS = 3;
const ACTIVE_STATUSES = ["confirmed", "rescheduled"];

const formatDay = (date) =>
  timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "ddd D MMM");

async function join(instructor, phone, { fromDate, toDate, preferredTimes } = {}) {
  const entry = {
    instructorId: instructor.phoneNumberId,
    phone,
    fromDate: DATE.test(fromDate || "") ? fromDate : null,
    toDate: DATE.test(toDate || "") ? toDate : null,
    preferredTimes: Array.isArray(preferredTimes) ? preferredTimes.filter((t) => TIME.test(t)) : [],
    status: "waiting",
    offer: { date: null, time: null, at: null },
    expiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  };
  await WaitlistEntry.findOneAndUpdate(
    { instructorId: entry.instructorId, phone, status: { $in: ["waiting", "offered"] } },
    entry,
    { upsert: true }
  );
  return entry;
}

/**
 * A slot has just freed up: offer it to the best-fitting waiting learners.
 * Returns the phones it was offered to.
 */
async function offerSlot(instructor, date, time, excludePhone = null) {
  if (!isDbReady() || !instructor) return [];
  if (!settings.resolveBotSettings(instructor).donnaEnabled) return [];
  if (settings.isWithinNotice(instructor, date)) return [];

  const candidates = (await WaitlistEntry.find({ instructorId: instructor.phoneNumberId, status: "waiting" }).lean())
    .filter((e) => e.phone !== excludePhone)
    .filter((e) => (!e.fromDate || e.fromDate <= date) && (!e.toDate || e.toDate >= date))
    .filter((e) => !e.preferredTimes?.length || e.preferredTimes.includes(time));
  if (!candidates.length) return [];

  const ranked = [];
  for (const entry of candidates) {
    try {
      const { userLoc } = await routeOptimizer.resolveUserContext(instructor, entry.phone);
      const fit = userLoc ? await routeOptimizer.evaluateSlot(date, time, instructor, userLoc) : null;
      if (fit && !fit.feasible) continue;
      ranked.push({ entry, addedDrive: fit?.addedDrive ?? Infinity });
    } catch (err) {
      logger.warn(`Waitlist ranking failed for ${entry.phone}: ${err.message}`);
    }
  }
  ranked.sort((a, b) => a.addedDrive - b.addedDrive);

  const offeredTo = [];
  for (const { entry } of ranked.slice(0, MAX_OFFERS)) {
    try {
      const sent = await sendOffer(instructor, entry.phone, date, time);
      if (!sent) continue;
      await WaitlistEntry.updateOne(
        { _id: entry._id },
        { status: "offered", offer: { date, time, at: new Date() } }
      );
      offeredTo.push(entry.phone);
    } catch (err) {
      logger.error(`Waitlist offer to ${entry.phone} failed: ${err.message}`);
    }
  }
  if (offeredTo.length) logger.info(`Offered ${date} ${time} to ${offeredTo.length} waiting learner(s)`);
  return offeredTo;
}

async function sendOffer(instructor, phone, date, time) {
  const take = `wl:take:${date}:${time}`;
  const skip = "wl:skip";
  if (await sessionStore.inServiceWindow(phone, instructor.phoneNumberId)) {
    await whatsappService.sendButtons(
      phone,
      `Good news! A lesson with ${instructor.name} just opened up: ${formatDay(date)} at ${to12h(time)}. Would you like it? First to reply gets it.`,
      [
        { id: take, title: "Book it" },
        { id: skip, title: "No thanks" },
      ],
      instructor
    );
    return true;
  }
  const template = process.env.WHATSAPP_SLOT_OFFER_TEMPLATE;
  if (!template) return false;
  await whatsappService.sendTemplate(
    phone,
    template,
    process.env.WHATSAPP_TEMPLATE_LANG || "en_GB",
    [instructor.name, formatDay(date), to12h(time)],
    [take, skip],
    instructor
  );
  return true;
}

/**
 * Learner tapped a waitlist button. parts: ["take", date, hh, mm] or ["skip"].
 */
async function handleReply(ctx, user, parts, controller) {
  const entry = await WaitlistEntry.findOne({ instructorId: ctx.instructorId, phone: ctx.from, status: "offered" });

  if (parts[0] !== "take") {
    if (entry) await WaitlistEntry.updateOne({ _id: entry._id }, { status: "waiting" });
    await ctx.send("No problem — I'll keep you on the list. 👍");
    return;
  }

  const [, date, hh, mm] = parts;
  const time = `${hh}:${mm}`;
  if (!DATE.test(date || "") || !TIME.test(time)) {
    await ctx.send("Sorry, I couldn't read that offer. Tell me the day and time you'd like instead.");
    return;
  }

  const saved = user?.schedulingPrefs?.savedPlaces?.[0];
  await controller.processBooking(ctx, {
    date,
    time,
    userPhone: ctx.from,
    pickupAddress: saved?.address || user?.postalCode || undefined,
  });

  const booked = await Booking.findOne({
    userPhone: ctx.from,
    instructorId: ctx.instructorId,
    date,
    time,
    status: { $in: ACTIVE_STATUSES },
  });
  if (entry) {
    await WaitlistEntry.updateOne({ _id: entry._id }, { status: booked ? "booked" : "waiting" });
  }
}

module.exports = { join, offerSlot, handleReply };
