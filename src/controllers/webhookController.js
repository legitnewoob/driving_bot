const whatsappService = require("../services/whatsappService");
const aiService = require("../services/gemini/aiService");
const bookingService = require("../services/bookingService");
const calendarService = require("../services/calendarService");
const { ensureUserDetails } = require("../services/userDetailsService");
const getChatLogger = require("../utils/chatLogger");
const getDbChatLogger = require("../utils/dbChatLogger");

const {
  getUserSession,
  updateUserSession,
  getInstructor,
} = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils");

class WebhookController {

  // ─── THE ONLY CHANGE NEEDED EVERYWHERE ───────────────────────────────────
  // Instead of calling whatsappService.sendTextMessage(from, text) directly,
  // all methods now call this._send(from, text).
  // In mock mode it captures the reply. In prod it calls WhatsApp as normal.
  _send(from, text) {
    if (this._isMock && this._mockReplyCallback) {
      this._mockReplyCallback(text);
      return Promise.resolve();
    }
    return whatsappService.sendTextMessage(from, text);
  }

  /* ========== HELPER METHOD ========== */

  clearUserConversationHistoryAndContext(from) {
    const session = getUserSession(from);
    if (session.conversationHistory.length > 0) {
      session.conversationHistory = [];
      console.log(`🧹 Clearing conversation history for ${from}`);
    }
    updateUserSession(from, session);
    aiService.clearPendingContext(from);
  }

  clearOnlyUserConversationHistory(from) {
    const session = getUserSession(from);
    session.conversationHistory = [];
    updateUserSession(from, session);
  }

  /* ========== BOOKING ACTIONS ========== */

  async next_available_slot(from) {
    console.log("Let's find the next available appointment...");
    const earliestSlot = await calendarService.findEarliestAvailableSlot(
      process.env.PHONE_NUMBER_ID
    );
    if (earliestSlot) {
      console.log(`The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}.`);
      aiService.updatePendingContext(from, earliestSlot);
      this.clearOnlyUserConversationHistory(from);
      await this._send(from, `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}. Would you like to book it?`);
    } else {
      console.log("Sorry, no appointments are available in the near future.");
      await this._send(from, "Sorry, no appointments are available in the near future. Please check back later.");
    }
  }

  async showBookings(from) {
    const bookings = await bookingService.getBookingsByUser(from);
    if (!bookings.length) {
      await this._send(from, "📭 *No bookings found*\n\nYou don't have any upcoming bookings.\n\n_Ready to schedule your next appointment? Just let me know!_ 💬");
      this.clearUserConversationHistoryAndContext(from);
      return;
    }

    const sortedBookings = bookings.sort(
      (a, b) => timezoneUtils.toTimezone(a.date) - timezoneUtils.toTimezone(b.date)
    );

    const nowStr = timezoneUtils.getCurrentDateString();
    const now = timezoneUtils.getCurrentDate();

    let message = `*🗓️ YOUR BOOKINGS* (${sortedBookings.length})\n`;
    message += "━━━━━━━━━━━━━━━━━\n\n";

    sortedBookings.forEach((booking, index) => {
      const bookingId = booking.bookingId;
      const dateStr = timezoneUtils.formatDate(booking.date, "YYYY-MM-DD");
      const isToday = timezoneUtils.isToday(dateStr);
      const isTomorrow = timezoneUtils.isTomorrow(dateStr);
      const isPast = timezoneUtils.toTimezone(booking.date) < now && !isToday;

      let dateDisplay;
      if (isToday) {
        dateDisplay = "🔥 *TODAY*";
      } else if (isTomorrow) {
        dateDisplay = "⭐ *TOMORROW*";
      } else {
        const formattedDate = timezoneUtils.formatDate(booking.date, "ddd, MMM D");
        dateDisplay = isPast ? `✅ ${formattedDate}` : `📅 ${formattedDate}`;
      }

      let statusIcon = isPast ? "✅" : isToday ? "🔥" : "📌";
      message += `${statusIcon} *${isPast ? "Completed" : "Booking #"} ${index + 1}*\n`;
      message += `🆔 ${bookingId}\n`;
      message += `${dateDisplay}\n`;
      message += `⏰ ${booking.time}\n`;

      if (booking.service) message += `🎯 Service: *${booking.service}*\n`;
      if (booking.postalCode) message += `📍 ${booking.postalCode}\n`;
      if (booking.status) {
        const statusEmoji =
          booking.status.toLowerCase() === "confirmed" ? "✅" :
            booking.status.toLowerCase() === "pending" ? "⏳" :
              booking.status.toLowerCase() === "cancelled" ? "❌" : "📋";
        message += `${statusEmoji} Status: ${booking.status}\n`;
      }
      if (booking.notes) message += `📝 ${booking.notes}\n`;
      if (index < sortedBookings.length - 1) message += "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n";
      message += "\n";
    });

    const upcomingCount = sortedBookings.filter(
      (b) => timezoneUtils.toTimezone(b.date) >= now &&
        (b.status === "confirmed" || b.status === "rescheduled")
    ).length;

    if (upcomingCount > 0) {
      message += `_You have ${upcomingCount} upcoming appointment${upcomingCount > 1 ? "s" : ""}_ ⏰\n`;
      message += "_Need to reschedule? Just let me know!_ 💬";
    } else {
      message += "_All bookings completed! Ready to schedule your next appointment?_ 🚀";
    }

    await this._send(from, message);
    this.clearUserConversationHistoryAndContext(from);
  }

  async updateBooking(from, bookingData) {
    const updated = await bookingService.rescheduleBooking(from, bookingData);
    if (!updated) {
      return this._send(from, "⚠️ No booking found to update.");
    }
    await this._send(from, `✅ Booking updated to ${bookingData.newDate} at ${bookingData.newTime}`);
    this.clearUserConversationHistoryAndContext(from);
  }

  async cancelBooking(from, bookingData) {
    try {
      console.log("HERE", bookingData);
      const bookingId = bookingData?.bookingId || "";
      if (!bookingId) {
        return this._send(from, "⚠️ Please provide a valid booking ID to cancel.");
      }
      const booking = await bookingService.cancelBooking(bookingId);
      if (!booking) {
        return this._send(from, `⚠️ No booking found with ID: ${bookingId}`);
      }
      if (booking.status === "cancelled") {
        await this._send(from, `✅ Your booking (ID: ${bookingId}) has been cancelled successfully.`);
        this.clearUserConversationHistoryAndContext(from);
        return;
      }
      return this._send(from, "⚠️ Could not cancel the booking. Please try again later.");
    } catch (err) {
      console.error("Cancel booking controller error:", err.message);
      return this._send(from, "⚠️ Something went wrong while cancelling your booking. Please try again.");
    }
  }

  async processBooking(from, bookingData) {
    try {
      console.log("📝 Processing booking for:", from, bookingData);
      const booking = await bookingService.createBooking(from, bookingData);
      console.log(booking);
      const confirmationMessage = [
        "🎉 Booking Confirmed!",
        "",
        `🆔 Booking ID: ${booking.booking.bookingId}`,
        "✅ Your driving lesson has been successfully booked:",
        "",
        `👨‍🏫 Instructor: ${booking.instructor.name}`,
        `📅 Date: ${timezoneUtils.formatDate(
          timezoneUtils.createDateInTimezone(bookingData.date, "12:00"),
          "dddd, MMMM D, YYYY"
        )}`,
        `🕐 Time: ${bookingData.time}`,
        "",
        "Good luck with your driving lesson! 🚗💨",
      ].join("\n");

      await this._send(from, confirmationMessage);
      this.clearUserConversationHistoryAndContext(from);
    } catch (error) {
      console.log(error);
      console.error("❌ Booking error:", error.message);
      const errorMessage = error.message.includes("validation")
        ? `❌ ${error.message}`
        : "❌ Sorry, there was an error processing your booking. Please try again.";
      await this._send(from, errorMessage);
    }
  }

  /* ========== WEBHOOK VERIFICATION ========== */

  async verifyWebhook(req, res) {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
      console.log("Webhook verified successfully!");
      return res.status(200).send(challenge);
    }
    res.status(403).send("Forbidden");
  }

  /* ========== WEBHOOK HANDLER ========== */

  async handleWebhook(req, res) {
    try {
      const body = req.body;
      if (body.object === "whatsapp_business_account") {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            if (change.field === "messages") {
              for (const message of change.value.messages || []) {
                const from = message.from;
                const messageType = message.type;
                let messageContent = "";

                if (messageType === "text") {
                  messageContent = message.text.body;
                } else if (messageType === "interactive") {
                  if (message.interactive.type === "button_reply") {
                    messageContent = message.interactive.button_reply.title;
                  } else if (message.interactive.type === "list_reply") {
                    messageContent = message.interactive.list_reply.title;
                  }
                }

                if (messageContent) {
                  const instructor = process.env.PHONE_NUMBER_ID;
                  try {
                    const chatLogger = getChatLogger(from);
                    const dbChatLogger = getDbChatLogger(instructor, from);
                    chatLogger.info(`${messageContent}`);
                    dbChatLogger.user(`${messageContent}`);
                  } catch (logErr) {
                    console.warn("[webhook] Logger skipped:", logErr.message);
                  }
                  await this.handleIncomingMessage(from, messageContent);
                }
              }
            }
          }
        }
      }
      res.status(200).send("OK");
    } catch (error) {
      console.error("Webhook error:", error);
      res.status(500).send("Internal Server Error");
    }
  }

  /* ========== MESSAGE HANDLER ========== */

  async handleIncomingMessage(from, messageContent, isMock = false, mockReplyCallback = null) {
    // Store on instance so _send can access them without passing around everywhere
    this._isMock = isMock;
    this._mockReplyCallback = mockReplyCallback;

    try {
      console.log('MESSAGE CONTENT', messageContent);
      console.log(`📱 Message from ${from}: "${messageContent}"`);

      // 🧠 Step 1: Check user profile before AI flow (skip in mock mode)
      const { inProgress, user, justCompleted } = await ensureUserDetails(
        from,
        messageContent,
        this._send.bind(this)   // ← works in both mock and real mode
      );
      if (inProgress) {
        console.log("⏳ Waiting for user details to be completed...");
        return;
      }
      if (justCompleted) {
        console.log("✅ User details just completed. Clearing context...");
        this.clearUserConversationHistoryAndContext(from);
        await this._send(from, "🚗 How can I assist you today?");
        return;
      }

      // ✅ Step 2: AI logic
      const session = getUserSession(from);
      const aiResponse = await aiService.getResponse(
        messageContent,
        session.conversationHistory,
        from
      );

      const { hasAction, actionType, bookingData, responseText } =
        aiService.extractActions(aiResponse);

      if (responseText) {
        await this._send(from, responseText);
      }

      const willPerformAction =
        hasAction &&
        ["book", "show_bookings", "update_booking", "cancel_booking"].includes(actionType);

      if (hasAction) {
        switch (actionType) {
          case "book":
            bookingData.userPhone = from;
            await this.processBooking(from, bookingData);
            break;
          case "show_bookings":
            await this.showBookings(from);
            break;
          case "update_booking":
            await this.updateBooking(from, bookingData);
            break;
          case "cancel_booking":
            await this.cancelBooking(from, bookingData);
            break;
          case "next_available_slot":
            await this.next_available_slot(from);
            break;
          case "null":
            break;
        }
      }

      if (!willPerformAction) {
        session.conversationHistory.push(
          { role: "user", content: messageContent },
          { role: "assistant", content: aiResponse }
        );
        const conversationHistoryLength = 10;
        if (session.conversationHistory.length > conversationHistoryLength) {
          session.conversationHistory = session.conversationHistory.slice(-conversationHistoryLength);
        }
        updateUserSession(from, session);
      }
    } catch (error) {
      console.error("❌ Error handling message:", error.message);
      await this._send(from, "⚠️ Sorry, I'm having trouble processing your message. Please try again.");
    } finally {
      // Clean up mock state after request completes
      this._isMock = false;
      this._mockReplyCallback = null;
    }
  }
}

module.exports = new WebhookController();