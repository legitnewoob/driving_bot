const whatsappService = require("../services/whatsappService");
const aiService = require("../services/gemini/aiService");
const bookingService = require("../services/bookingService");
const calendarService = require("../services/calendarService");
const { ensureUserDetails } = require("../services/userDetailsService");
const getChatLogger = require("../utils/chatLogger");
const getDbChatLogger = require("../utils/dbChatLogger");
const logger = require("../utils/logger-advanced");

const {
  getUserSession,
  updateUserSession,
  getInstructor,
} = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils");
const routeOptimizer = require("../services/routeOptimizer");
const settings = require("../services/instructorSettings");
const sessionStore = require("../services/sessionStore");
const notifications = require("../services/notificationService");
const User = require("../models/userModel");
const Booking = require("../models/bookingModel");
const ProcessedMessage = require("../models/processedMessageModel");
const { notifyInstructorLearnerMessage } = require("../utils/emailNotifier");
const { runExclusive } = require("../utils/keyedQueue");
const { isDbReady } = require("../utils/db");

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu;
const HISTORY_LENGTH = 10;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SILENT_TYPES = new Set(["reaction", "system", "ephemeral", "unknown"]);

function stripEmoji(text) {
  return text
    .replace(EMOJI, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]{2,}/g, " ").trim())
    .join("\n");
}

function formatDay(date) {
  return timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(date, "12:00"), "ddd D MMM");
}

/**
 * Turns a WhatsApp message into what the bot understands:
 * text (typed, tapped or synthesised), an optional shared location,
 * the id of a tapped button/row, or the type of a message we can't read.
 */
function parseIncoming(message) {
  switch (message.type) {
    case "text":
      return { text: message.text?.body || "" };
    case "interactive": {
      const reply = message.interactive?.button_reply || message.interactive?.list_reply;
      return reply ? { text: reply.title, buttonId: reply.id } : {};
    }
    case "button":
      return { text: message.button?.text || "", buttonId: message.button?.payload };
    case "location": {
      const loc = message.location || {};
      if (typeof loc.latitude !== "number" || typeof loc.longitude !== "number") return {};
      const label = loc.address || loc.name || `${loc.latitude.toFixed(5)}, ${loc.longitude.toFixed(5)}`;
      return {
        text: `📍 Shared location: ${label}`,
        location: { lat: loc.latitude, long: loc.longitude, label },
      };
    }
    default:
      return SILENT_TYPES.has(message.type) ? {} : { unsupportedType: message.type || "unknown" };
  }
}

class WebhookController {
  /* ========== PER-MESSAGE CONTEXT ========== */

  // Everything a single message needs. Nothing is stored on the controller,
  // so concurrent messages for different instructors can't mix.
  _makeContext({ from, instructor, isMock, mockReplyCallback }) {
    const bot = settings.resolveBotSettings(instructor);
    const format = (text) => (bot.emojis ? text : stripEmoji(text));
    const mock = (text, interactive) => {
      if (mockReplyCallback) mockReplyCallback(text, interactive);
      return Promise.resolve();
    };

    return {
      from,
      instructor,
      instructorId: instructor.phoneNumberId,
      bot,
      isMock,
      send: (text) =>
        isMock ? mock(format(text)) : whatsappService.sendTextMessage(from, format(text), instructor),
      sendButtons: (text, buttons) =>
        isMock
          ? mock(`${format(text)}\n${buttons.map((b) => `[${b.title}]`).join(" ")}`, { type: "buttons", body: format(text), buttons })
          : whatsappService.sendButtons(from, format(text), buttons, instructor),
      sendList: (text, buttonLabel, rows) =>
        isMock
          ? mock(`${format(text)}\n${rows.map((r) => `• ${r.title}`).join("\n")}`, { type: "list", body: format(text), buttonLabel, rows })
          : whatsappService.sendList(from, format(text), buttonLabel, rows, instructor),
    };
  }

  /* ========== CONVERSATION STATE ========== */

  clearUserConversationHistoryAndContext(from, instructorId) {
    const session = getUserSession(from, instructorId);
    session.conversationHistory = [];
    updateUserSession(from, session, instructorId);
    aiService.clearPendingContext(from);
  }

  clearOnlyUserConversationHistory(from, instructorId) {
    const session = getUserSession(from, instructorId);
    session.conversationHistory = [];
    updateUserSession(from, session, instructorId);
  }

  _remember(ctx, userText, assistantText) {
    const session = getUserSession(ctx.from, ctx.instructorId);
    session.conversationHistory.push(
      { role: "user", content: userText },
      { role: "assistant", content: assistantText }
    );
    session.conversationHistory = session.conversationHistory.slice(-HISTORY_LENGTH);
    updateUserSession(ctx.from, session, ctx.instructorId);
  }

  /* ========== BOOKING ACTIONS ========== */

  async next_available_slot(ctx) {
    logger.info("Finding next available appointment...");
    let earliestSlot = null;
    try {
      earliestSlot = await routeOptimizer.findEarliestOfferedSlot(ctx.instructor, ctx.from);
    } catch (err) {
      logger.warn(`Route-aware earliest slot failed, using calendar only: ${err.message}`);
    }
    if (!earliestSlot) {
      earliestSlot = await calendarService.findEarliestAvailableSlot(ctx.instructor);
    }
    if (earliestSlot) {
      logger.info(`Next available slot for ${ctx.from}: ${earliestSlot.date} at ${earliestSlot.time}`);
      aiService.updatePendingContext(ctx.from, earliestSlot);
      this.clearOnlyUserConversationHistory(ctx.from, ctx.instructorId);
      await ctx.sendButtons(
        `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}. Would you like to book it?`,
        [
          { id: "confirm:yes", title: "Yes, book it" },
          { id: "confirm:no", title: "Another time" },
        ]
      );
    } else {
      await ctx.send("Sorry, no appointments are available in the near future. Please check back later.");
    }
  }

  async showBookings(ctx) {
    const bookings = await bookingService.getBookingsByUser(ctx.from, ctx.instructorId);
    if (!bookings.length) {
      await ctx.send("📭 *No bookings found*\n\nYou don't have any upcoming bookings.\n\n_Ready to schedule your next appointment? Just let me know!_ 💬");
      this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
      return;
    }

    const now = timezoneUtils.getCurrentDate();

    const sortedBookings = bookings.sort(
      (a, b) => timezoneUtils.toTimezone(a.date) - timezoneUtils.toTimezone(b.date)
    );

    const pastBookings = sortedBookings.filter(booking => {
      const dateStr = timezoneUtils.formatDate(booking.date, "YYYY-MM-DD");
      const isToday = timezoneUtils.isToday(dateStr);
      return !isToday && timezoneUtils.toTimezone(booking.date) < now;
    });

    const upcomingBookings = sortedBookings.filter(booking => {
      const dateStr = timezoneUtils.formatDate(booking.date, "YYYY-MM-DD");
      const isToday = timezoneUtils.isToday(dateStr);
      return isToday || timezoneUtils.toTimezone(booking.date) >= now;
    });

    let message = `*📆 YOUR BOOKINGS* (${sortedBookings.length})\n`;
    message += "━━━━━━━━━━━━━━━━━\n\n";

    if (pastBookings.length > 0) {
      const lastCompleted = pastBookings[pastBookings.length - 1];
      const lastDate = timezoneUtils.formatDate(lastCompleted.date, "ddd, MMM D");
      message += `✅ *${pastBookings.length} Completed Booking${pastBookings.length > 1 ? "s" : ""}*\n`;
      message += `🕓 Last: ${lastDate}\n`;
      if (upcomingBookings.length > 0) message += "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n";
      message += "\n";
    }

    upcomingBookings.forEach((booking, index) => {
      const dateStr = timezoneUtils.formatDate(booking.date, "YYYY-MM-DD");
      const isToday = timezoneUtils.isToday(dateStr);
      const isTomorrow = timezoneUtils.isTomorrow(dateStr);

      let dateDisplay;
      if (isToday) {
        dateDisplay = "🔥 *TODAY*";
      } else if (isTomorrow) {
        dateDisplay = "⭐ *TOMORROW*";
      } else {
        dateDisplay = `📅 ${timezoneUtils.formatDate(booking.date, "ddd, MMM D")}`;
      }

      const statusIcon = isToday ? "🔥" : "📌";
      message += `${statusIcon} *Booking #${index + 1}*\n`;
      message += `🆔 ${booking.bookingId}\n`;
      message += `${dateDisplay}\n`;
      message += `⏰ ${booking.time}\n`;

      if (booking.lessonTypeName) message += `🎯 Lesson: *${booking.lessonTypeName}*\n`;
      if (booking.pickupLocation?.address) message += `📍 Pickup: ${booking.pickupLocation.address}\n`;
      if (booking.dropoffLocation?.address) message += `🏁 Drop-off: ${booking.dropoffLocation.address}\n`;
      if (booking.status) {
        const statusEmoji =
          booking.status.toLowerCase() === "confirmed" ? "✅" :
            booking.status.toLowerCase() === "cancelled" ? "❌" : "📋";
        message += `${statusEmoji} Status: ${booking.status}\n`;
      }
      if (index < upcomingBookings.length - 1) message += "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n";
      message += "\n";
    });

    const upcomingCount = upcomingBookings.filter(
      b => b.status === "confirmed" || b.status === "rescheduled"
    ).length;

    if (upcomingCount > 0) {
      message += `_You have ${upcomingCount} upcoming appointment${upcomingCount > 1 ? "s" : ""}_ ⏰\n`;
      message += "_Need to reschedule? Just let me know!_ 💬";
    } else {
      message += "_All bookings completed! Ready to schedule your next appointment?_ 🚀";
    }

    await ctx.send(message);
    this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
  }

  async updateBooking(ctx, bookingData) {
    try {
      const updated = await bookingService.rescheduleBooking(ctx.from, bookingData, ctx.instructorId);
      if (!updated) {
        await ctx.send(`⚠️ No booking found with ID ${bookingData?.bookingId || "(none given)"}. Say "show my bookings" to see your lessons.`);
        return;
      }
      await ctx.send(`✅ Booking ${updated.bookingId} moved to ${formatDay(bookingData.newDate)} at ${bookingData.newTime}`);
      this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
    } catch (err) {
      logger.error(`Reschedule error for ${ctx.from}: ${err.message}`);
      await ctx.send(
        err.userFacing
          ? `❌ ${err.message}`
          : "❌ Sorry, I couldn't move that lesson just now. Please try again in a minute."
      );
    }
  }

  async cancelBooking(ctx, bookingData) {
    const bookingId = bookingData?.bookingId || "";
    if (!bookingId) {
      return ctx.send("⚠️ Please tell me the booking ID you'd like to cancel (it starts with DL-).");
    }
    try {
      const existing = await Booking.findOne({ bookingId, userPhone: ctx.from, instructorId: ctx.instructorId });
      if (!existing || existing.status === "cancelled" || existing.status === "completed") {
        return ctx.send(`⚠️ No booking found with ID ${bookingId}. Say "show my bookings" to see your lessons.`);
      }

      if (bookingService.isLateCancellation(existing, ctx.instructor) && !bookingData.acknowledgedLateFee) {
        const hours = ctx.bot.cancellationNoticeHours;
        const fee = ctx.bot.lateCancellationFee;
        const warning =
          `⚠️ Your lesson on ${formatDay(existing.date)} at ${existing.time} is less than ${hours} hours away. ` +
          (fee ? `Cancelling now may be charged £${fee}. ` : `${ctx.instructor.name} may still charge for it. `) +
          `Do you still want to cancel ${bookingId}?`;
        await ctx.sendButtons(warning, [
          { id: `latecancel:yes:${bookingId}`, title: "Yes, cancel it" },
          { id: "latecancel:no", title: "Keep my lesson" },
        ]);
        this._remember(ctx, `I want to cancel ${bookingId}`, `${warning}\n[ACTION:NULL]\n{}`);
        return;
      }

      const booking = await bookingService.cancelBooking(bookingId, {
        userPhone: ctx.from,
        instructorId: ctx.instructorId,
        instructor: ctx.instructor,
      });
      if (!booking) {
        return ctx.send(`⚠️ No booking found with ID ${bookingId}.`);
      }
      await ctx.send(`✅ Your booking (ID: ${bookingId}) has been cancelled successfully.`);
      this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
    } catch (err) {
      logger.error(`Cancel booking error: ${err.message}`);
      return ctx.send("⚠️ Something went wrong while cancelling your booking. Please try again.");
    }
  }

  async processBooking(ctx, bookingData) {
    try {
      logger.info(`Processing booking for ${ctx.from}: ${bookingData.date} at ${bookingData.time}`);
      const pending = aiService.pendingContext[ctx.from];
      if (pending?.pickupCoords && bookingData.pickupAddress && bookingData.pickupAddress === pending.pickupAddress) {
        bookingData.pickupCoords = pending.pickupCoords;
      }

      const result = await bookingService.createBooking(ctx.from, bookingData, ctx.instructor);
      const lines = [
        "🎉 Booking Confirmed!",
        "",
        `🆔 Booking ID: ${result.booking.bookingId}`,
        "✅ Your driving lesson has been successfully booked:",
        "",
        `👨‍🏫 Instructor: ${ctx.instructor.name}`,
        `📅 Date: ${timezoneUtils.formatDate(
          timezoneUtils.createDateInTimezone(bookingData.date, "12:00"),
          "dddd, MMMM D, YYYY"
        )}`,
        `🕐 Time: ${bookingData.time}`,
      ];
      if (result.lessonType) {
        lines.push(`🎯 Lesson: ${result.lessonType.name} (£${result.lessonType.price})`);
      }
      if (bookingData.pickupAddress) {
        lines.push(`📍 Pickup: ${bookingData.pickupAddress}`);
      }
      if (bookingData.dropoffAddress) {
        lines.push(`🏁 Drop-off: ${bookingData.dropoffAddress}`);
      }
      lines.push("", "Good luck with your driving lesson! 🚗💨");

      await ctx.send(lines.join("\n"));
      this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
    } catch (error) {
      logger.error(`Booking error for ${ctx.from}: ${error.message}`);
      const errorMessage = error.userFacing || error.message.includes("validation")
        ? `❌ ${error.message}`
        : "❌ Sorry, there was an error processing your booking. Please try again.";
      await ctx.send(errorMessage);
    }
  }

  async handover(ctx, user) {
    if (!ctx.bot.handover) {
      await ctx.send(`You can reach ${ctx.instructor.name} directly on their own number. I'm happy to help with bookings in the meantime!`);
      return;
    }
    try {
      if (user) {
        await User.updateOne(
          { phone: ctx.from, instructorId: ctx.instructorId },
          { $set: { "schedulingPrefs.donnaPaused": true } }
        );
      }
    } catch (err) {
      logger.warn(`Couldn't pause Donna for ${ctx.from}: ${err.message}`);
    }
    await notifications.notify(ctx.instructor, {
      type: "handover",
      message: `${user?.name || ctx.from} asked to talk to you. Donna is paused for them until you turn her back on.`,
      clientId: `notif-handover-${ctx.from}-${Date.now()}`,
      learnerPhone: ctx.from,
      emailSubject: `${user?.name || ctx.from} wants to talk to you`,
    });
    await ctx.send(`I've let ${ctx.instructor.name} know — they'll get back to you directly. 👍`);
  }

  async joinWaitlist(ctx, data) {
    const waitlistService = require("../services/waitlistService");
    try {
      await waitlistService.join(ctx.instructor, ctx.from, data || {});
      await ctx.send("👍 You're on the list. If an earlier slot opens up, I'll message you straight away.");
    } catch (err) {
      logger.error(`Waitlist join failed for ${ctx.from}: ${err.message}`);
      await ctx.send("Sorry, I couldn't add you to the waiting list just now. Please try again.");
    }
  }

  /* ========== TAPPED BUTTONS / LIST ROWS ========== */

  // Returns true if the tap was fully handled here; otherwise the caller
  // continues with `rewrite` as the message text for the AI.
  async _handleTap(ctx, user, buttonId) {
    const [kind, ...rest] = buttonId.split(":");

    if (kind === "slot" && rest.length === 3) {
      const [date, hh, mm] = rest;
      const time = `${hh}:${mm}`;
      if (DATE.test(date) && TIME.test(time)) {
        return { handled: false, rewrite: `I'd like ${time} on ${date}` };
      }
    }

    if (kind === "latecancel") {
      if (rest[0] === "yes" && rest[1]) {
        await this.cancelBooking(ctx, { bookingId: rest[1], acknowledgedLateFee: true });
      } else {
        await ctx.send("No problem, your lesson is still booked. 👍");
        this.clearUserConversationHistoryAndContext(ctx.from, ctx.instructorId);
      }
      return { handled: true };
    }

    if (kind === "rem") {
      const reminders = require("../jobs/reminders");
      await reminders.handleReply(ctx, rest[0], rest[1], this);
      return { handled: true };
    }

    if (kind === "wl") {
      const waitlistService = require("../services/waitlistService");
      await waitlistService.handleReply(ctx, user, rest, this);
      return { handled: true };
    }

    return { handled: false };
  }

  /* ========== WEBHOOK VERIFICATION ========== */

  async verifyWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      logger.info("Webhook verified");
      return res.status(200).send(challenge);
    }
    res.status(403).send("Forbidden");
  }

  /* ========== WEBHOOK HANDLER ========== */

  // Meta retries webhooks that are slow to answer, so acknowledge first and
  // then process. Repeated message ids are skipped.
  async handleWebhook(req, res) {
    res.status(200).send("OK");

    const body = req.body;
    if (body?.object !== "whatsapp_business_account") return;

    const jobs = [];
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const phoneNumberId = change.value?.metadata?.phone_number_id;
        for (const message of change.value?.messages || []) {
          jobs.push(this._processWebhookMessage(message, phoneNumberId));
        }
      }
    }
    await Promise.all(jobs);
  }

  async _firstTimeSeen(messageId) {
    if (!messageId || !isDbReady()) return true;
    try {
      await ProcessedMessage.create({ _id: messageId });
      return true;
    } catch (err) {
      if (err?.code === 11000) return false;
      logger.warn(`Duplicate check failed for ${messageId}: ${err.message}`);
      return true;
    }
  }

  async _processWebhookMessage(message, phoneNumberId) {
    try {
      if (!(await this._firstTimeSeen(message.id))) {
        logger.info(`Skipping repeated WhatsApp message ${message.id}`);
        return;
      }

      const incoming = parseIncoming(message);
      if (!incoming.text && !incoming.unsupportedType) return;

      if (incoming.text) {
        try {
          getChatLogger(message.from).info(`${incoming.text}`);
          getDbChatLogger(phoneNumberId, message.from).user(`${incoming.text}`);
        } catch (logErr) {
          logger.warn(`Chat logger skipped: ${logErr.message}`);
        }
      }

      await this.handleIncomingMessage(message.from, incoming.text || "", phoneNumberId, false, null, {
        messageId: message.id,
        location: incoming.location,
        buttonId: incoming.buttonId,
        unsupportedType: incoming.unsupportedType,
      });
    } catch (error) {
      logger.error(`Webhook message error: ${error.message}`);
    }
  }

  /* ========== MESSAGE HANDLER ========== */

  /**
   * Handles one learner message. Messages from the same learner are
   * processed one at a time, in order.
   * @param {object} extra - { messageId, location, buttonId, unsupportedType }
   */
  handleIncomingMessage(from, messageContent, instructorPhoneId, isMock = false, mockReplyCallback = null, extra = {}) {
    return runExclusive(from, () =>
      this._handleMessage(from, messageContent, instructorPhoneId, isMock, mockReplyCallback, extra)
    );
  }

  async _handleMessage(from, messageContent, instructorPhoneId, isMock, mockReplyCallback, extra) {
    logger.info(`Message from ${from} (instructor: ${instructorPhoneId}): "${messageContent}"`);

    const instructor = await getInstructor(instructorPhoneId);
    if (!instructor) {
      logger.error(`No instructor found for phoneNumberId: ${instructorPhoneId}`);
      return;
    }

    const ctx = this._makeContext({ from, instructor, isMock, mockReplyCallback });

    if (extra.messageId && !isMock) {
      whatsappService.markReadAndTyping(extra.messageId, instructor).catch(() => {});
    }

    await sessionStore.load(from, ctx.instructorId);

    try {
      if (extra.unsupportedType) {
        await ctx.send("Sorry, I can only read text messages and shared locations for now. Could you type that for me? 🙂");
        return;
      }

      // Not taking new learners → tell new numbers and stop
      if (!ctx.bot.acceptingNewLearners) {
        const existing = await User.findOne({ phone: from, instructorId: ctx.instructorId });
        if (!existing) {
          await ctx.send(
            `Hi! Thanks for getting in touch. ${instructor.name} isn't taking on new learners at the moment, so I can't book lessons for you right now. Please check back later.`
          );
          return;
        }
      }

      // Sign-up questions before anything else
      const { inProgress, user, justCompleted } = await ensureUserDetails(
        from,
        messageContent,
        (_to, text) => ctx.send(text),
        ctx.instructorId,
        ctx.bot.customGreeting
      );
      if (inProgress) return;
      if (justCompleted) {
        this.clearUserConversationHistoryAndContext(from, ctx.instructorId);
        await ctx.send("🚗 How can I assist you today?");
        return;
      }

      // Instructor has paused Donna for this learner
      if (user?.schedulingPrefs?.donnaPaused) {
        logger.info(`Donna paused for ${from} (instructor ${ctx.instructorId}); not replying`);
        notifyInstructorLearnerMessage(instructor, user, messageContent).catch(() => {});
        notifications
          .notify(instructor, {
            type: "paused_message",
            message: `${user.name || from}: "${messageContent.slice(0, 120)}" (Donna is paused for them)`,
            clientId: `notif-paused-${from}-${extra.messageId || Date.now()}`,
            learnerPhone: from,
          })
          .catch(() => {});
        return;
      }

      let text = messageContent;
      if (extra.buttonId) {
        const tap = await this._handleTap(ctx, user, extra.buttonId);
        if (tap.handled) return;
        if (tap.rewrite) text = tap.rewrite;
      }

      if (extra.location) {
        aiService.updatePendingPickupDropoff(from, {
          pickupAddress: extra.location.label,
          pickupCoords: { lat: extra.location.lat, long: extra.location.long },
        });
      }

      // AI
      const session = getUserSession(from, ctx.instructorId);
      const aiResponse = await aiService.getResponse(
        text,
        session.conversationHistory,
        from,
        instructor,
        user
      );

      const { hasAction, actionType, bookingData, responseText } = aiService.extractActions(aiResponse);

      // Remember pickup/drop-off from any action JSON so slot scoring can use them
      if (bookingData?.pickupAddress || bookingData?.dropoffAddress) {
        aiService.updatePendingPickupDropoff(from, {
          pickupAddress: bookingData.pickupAddress,
          dropoffAddress: bookingData.dropoffAddress,
        });
      }

      if (responseText) {
        await this._sendReply(ctx, responseText, bookingData);
      }

      const willPerformAction =
        hasAction &&
        ["book", "show_bookings", "update_booking", "cancel_booking", "handover", "waitlist"].includes(actionType);

      if (hasAction) {
        switch (actionType) {
          case "book":
            bookingData.userPhone = from;
            await this.processBooking(ctx, bookingData);
            break;
          case "show_bookings":
            await this.showBookings(ctx);
            break;
          case "update_booking":
            if (!ctx.bot.allowReschedule) {
              await ctx.send(`To move a lesson, please contact ${instructor.name} directly.`);
              break;
            }
            await this.updateBooking(ctx, bookingData);
            break;
          case "cancel_booking":
            if (!ctx.bot.allowCancel) {
              await ctx.send(`To cancel a lesson, please contact ${instructor.name} directly.`);
              break;
            }
            await this.cancelBooking(ctx, bookingData);
            break;
          case "next_available_slot":
            await this.next_available_slot(ctx);
            break;
          case "handover":
            await this.handover(ctx, user);
            break;
          case "waitlist":
            await this.joinWaitlist(ctx, bookingData);
            break;
          case "null":
            break;
        }
      }

      if (!willPerformAction) {
        this._remember(ctx, text, aiResponse);
      }
    } catch (error) {
      logger.error("Error handling message from " + from + ": " + error.message);
      await ctx.send("⚠️ Sorry, I'm having trouble processing your message. Please try again.");
    } finally {
      await sessionStore.save(from, ctx.instructorId);
    }
  }

  // Sends Donna's reply, as tappable times or yes/no buttons when she asked for them.
  async _sendReply(ctx, responseText, data) {
    const date = data?.offerDate;
    const times = Array.isArray(data?.offerSlots)
      ? data.offerSlots.filter((t) => typeof t === "string" && TIME.test(t)).slice(0, 10)
      : [];

    if (times.length >= 2 && typeof date === "string" && DATE.test(date)) {
      return ctx.sendList(
        responseText,
        "Choose a time",
        times.map((t) => ({ id: `slot:${date}:${t}`, title: `${formatDay(date)}, ${t}` }))
      );
    }
    if (data?.askConfirm === true) {
      return ctx.sendButtons(responseText, [
        { id: "confirm:yes", title: "Yes, book it" },
        { id: "confirm:no", title: "No, change it" },
      ]);
    }
    return ctx.send(responseText);
  }
}

module.exports = new WebhookController();
module.exports.parseIncoming = parseIncoming;
