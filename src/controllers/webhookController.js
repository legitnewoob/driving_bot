const whatsappService = require("../services/whatsappService");
const aiService = require("../services/gemini/aiService");
const bookingService = require("../services/bookingService");
const calendarService = require("../services/calendarService");
const { ensureUserDetails } = require("../services/userDetailsService");
const getChatLogger = require("../utils/chatLogger");

const {
  getUserSession,
  updateUserSession,
  getInstructor,
} = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils");

class WebhookController {
  /* ========== HELPER METHOD ========== */

  clearUserConversationHistoryAndContext(from) {
    const session = getUserSession(from);
    session.conversationHistory = [];
    updateUserSession(from, session);
    console.log(`📝 Cleared conversation history for ${from}`);
    // Also clear AI service pending context
    aiService.clearPendingContext(from);
  }

  clearOnlyUserConversationHistory(from) {
    const session = getUserSession(from);
    session.conversationHistory = [];
    updateUserSession(from, session);
    console.log(`📝 Cleared conversation history for ${from}`);
  }

  /* ========== BOOKING ACTIONS ========== */

  async next_available_slot(from) {
    console.log("Let's find the next available appointment...");

    const earliestSlot = await calendarService.findEarliestAvailableSlot(
      process.env.PHONE_NUMBER_ID
    );

    if (earliestSlot) {
      // Here you can store the result or format a message for the user
      // For example, store it in a user session:
      // userSession.nextAvailableSlot = earliestSlot;
      console.log(
        `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}.`
      );
      aiService.updatePendingContext(from, earliestSlot);
      this.clearOnlyUserConversationHistory(from);
      whatsappService.sendTextMessage(from , `The next available appointment is on ${earliestSlot.date} at ${earliestSlot.time}. Would you like to book it?`);
    } else {
      console.log("Sorry, no appointments are available in the near future.");
      return "Sorry, no appointments are available in the near future. Please check back later.";
    }
  }

  async showBookings(from) {
    const bookings = await bookingService.getBookingsByUser(from);
    // console.log(bookings);
    if (!bookings.length) {
      await whatsappService.sendTextMessage(
        from,
        "📭 *No bookings found*\n\nYou don't have any upcoming bookings.\n\n_Ready to schedule your next appointment? Just let me know!_ 💬"
      );

      // Clear conversation history and pending context after showing empty bookings
      this.clearUserConversationHistoryAndContext(from);
      return;
    }

    // Sort bookings by date (earliest first)
    // const sortedBookings = bookings.sort(
    //   (a, b) => new Date(a.date) - new Date(b.date)
    // );
    const sortedBookings = bookings.sort(
      (a, b) =>
        timezoneUtils.toTimezone(a.date) - timezoneUtils.toTimezone(b.date)
    );

    // const now = new Date();
    const nowStr = timezoneUtils.getCurrentDateString();
    const now = timezoneUtils.getCurrentDate(); // actual Date object in timezone

    let message = `*🗓️ YOUR BOOKINGS* (${sortedBookings.length})\n`;
    message += "━━━━━━━━━━━━━━━━━\n\n";

    sortedBookings.forEach((booking, index) => {
      const bookingId = booking.bookingId;
      const dateStr = timezoneUtils.formatDate(booking.date, "YYYY-MM-DD");
      const isToday = timezoneUtils.isToday(dateStr);
      const isTomorrow = timezoneUtils.isTomorrow(dateStr);
      const isPast = timezoneUtils.toTimezone(booking.date) < now && !isToday;

      // Smart date formatting
      let dateDisplay;
      if (isToday) {
        dateDisplay = "🔥 *TODAY*";
      } else if (isTomorrow) {
        dateDisplay = "⭐ *TOMORROW*";
      } else {
        const formattedDate = timezoneUtils.formatDate(
          booking.date,
          "ddd, MMM D"
        );
        dateDisplay = isPast ? `✅ ${formattedDate}` : `📅 ${formattedDate}`;
      }

      // Status indicator
      let statusIcon = isPast ? "✅" : isToday ? "🔥" : "📌";

      message += `${statusIcon} *${isPast ? "Completed" : "Booking #"} ${
        index + 1
      }*\n`;
      message += `🆔 ${bookingId}\n`;
      message += `${dateDisplay}\n`;
      message += `⏰ ${booking.time}\n`;

      // Add optional details with better formatting
      if (booking.service) message += `🎯 Service: *${booking.service}*\n`;
      if (booking.postalCode) message += `📍 ${booking.postalCode}\n`;
      if (booking.status) {
        const statusEmoji =
          booking.status.toLowerCase() === "confirmed"
            ? "✅"
            : booking.status.toLowerCase() === "pending"
            ? "⏳"
            : booking.status.toLowerCase() === "cancelled"
            ? "❌"
            : "📋";
        message += `${statusEmoji} Status: ${booking.status}\n`;
      }
      if (booking.notes) message += `📝 ${booking.notes}\n`;

      // Add separator between bookings (except for last one)
      if (index < sortedBookings.length - 1) {
        message += "┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈\n";
      }
      message += "\n";
    });

    // Add helpful footer
    const upcomingCount = sortedBookings.filter(
      (b) =>
        timezoneUtils.toTimezone(b.date) >= now &&
        (b.status === "confirmed" || b.status === "rescheduled")
    ).length;

    if (upcomingCount > 0) {
      message += `_You have ${upcomingCount} upcoming appointment${
        upcomingCount > 1 ? "s" : ""
      }_ ⏰\n`;
      message += "_Need to reschedule? Just let me know!_ 💬";
    } else {
      message +=
        "_All bookings completed! Ready to schedule your next appointment?_ 🚀";
    }

    await whatsappService.sendTextMessage(from, message);

    // Clear conversation history and pending context after showing bookings
    this.clearUserConversationHistoryAndContext(from);
  }

  async updateBooking(from, bookingData) {
    const updated = await bookingService.rescheduleBooking(from, bookingData);

    if (!updated) {
      return whatsappService.sendTextMessage(
        from,
        "⚠️ No booking found to update."
      );
    }

    await whatsappService.sendTextMessage(
      from,
      `✅ Booking updated to ${bookingData.newDate} at ${bookingData.newTime}`
    );

    // Clear conversation history and pending context after successful update
    this.clearUserConversationHistoryAndContext(from);
  }

  // controller/service layer where WhatsApp reply is sent
  async cancelBooking(from, bookingData) {
    try {
      console.log("HERE", bookingData);

      const bookingId = bookingData?.bookingId || "";
      if (!bookingId) {
        return whatsappService.sendTextMessage(
          from,
          "⚠️ Please provide a valid booking ID to cancel."
        );
      }

      const booking = await bookingService.cancelBooking(bookingId);

      if (!booking) {
        return whatsappService.sendTextMessage(
          from,
          `⚠️ No booking found with ID: ${bookingId}`
        );
      }

      if (booking.status === "cancelled") {
        await whatsappService.sendTextMessage(
          from,
          `✅ Your booking (ID: ${bookingId}) has been cancelled successfully.`
        );

        // Clear conversation history and pending context after successful cancellation
        this.clearUserConversationHistoryAndContext(from);
        return;
      }

      // fallback (should not usually happen)
      return whatsappService.sendTextMessage(
        from,
        "⚠️ Could not cancel the booking. Please try again later."
      );
    } catch (err) {
      console.error("Cancel booking controller error:", err.message);
      return whatsappService.sendTextMessage(
        from,
        "⚠️ Something went wrong while cancelling your booking. Please try again."
      );
    }
  }

  async processBooking(from, bookingData) {
    try {
      
      console.log("📝 Processing booking for:", from, bookingData);
      const booking = await bookingService.createBooking(from , bookingData);
      console.log(booking);
      const confirmationMessage = [
        "🎉 Booking Confirmed!",
        "",
        `🆔 Booking ID: ${booking.booking.bookingId}`,
        "✅ Your driving lesson has been successfully booked:",
        "",

        `👨‍🏫 Instructor: ${booking.instructor.name}`,
        `📅 Date: ${new Date(bookingData.date).toLocaleDateString("en-US", {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}`,
        `🕐 Time: ${bookingData.time}`,
        "",
        "📧 A calendar invitation has been sent to your instructor.",
        "",
        "Good luck with your driving lesson! 🚗💨",
      ].join("\n");

      await whatsappService.sendTextMessage(from, confirmationMessage);

      // Clear conversation history and pending context after successful booking
      this.clearUserConversationHistoryAndContext(from);
    } catch (error) {
      console.log(error);
      console.error("❌ Booking error:", error.message);

      const errorMessage = error.message.includes("validation")
        ? `❌ ${error.message}`
        : "❌ Sorry, there was an error processing your booking. Please try again.";

      await whatsappService.sendTextMessage(from, errorMessage);

      // Don't clear context on booking errors - user might want to retry with same date/time
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
                  const chatLogger = getChatLogger(from);
                  chatLogger.info(`(USER) → ${messageContent}`);
                  //console.log(`📩 Incoming: ${from} → ${messageContent}`);
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

  async handleIncomingMessage(from, messageContent) {
    try {
      console.log('MESSAGE CONTENT' , messageContent);
      console.log(`📱 Message from ${from}: "${messageContent}"`);

      // 🧠 Step 1: Check user profile before AI flow
    const { inProgress, user , justCompleted} = await ensureUserDetails(from, messageContent);
    if (inProgress) {
      console.log("⏳ Waiting for user details to be completed...");
      // ⏸ Stop here — don't send message to Gemini yet
      return;
    }

    if (justCompleted) {

      console.log("✅ User details just completed. Clearing context...");
      // Now safe to clear conversation history here
      this.clearUserConversationHistoryAndContext(from);

      whatsappService.sendTextMessage(from, "🚗 How can I assist you today?");

      return;
    } 

    // ✅ Step 2: Continue your existing AI-based logic
    const session = getUserSession(from);
    const aiResponse = await aiService.getResponse(
      messageContent,
      session.conversationHistory,
      from
    );

      // console.log("🤖 AI Response:", aiResponse);

      const { hasAction, actionType, bookingData, responseText } =
        aiService.extractActions(aiResponse);

      if (responseText) {
        await whatsappService.sendTextMessage(from, responseText);
      }

      // Check if an action will be performed - if so, don't update conversation history
      // as it will be cleared after the action completes
      const willPerformAction =
        hasAction &&
        ["book", "show_bookings", "update_booking", "cancel_booking"].includes(
          actionType
        );

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
            // await whatsappService.sendTextMessage(from, "⚠️ ACTION IS NULL");
            break;
        }
      }

      // Only maintain conversation history if no action was performed
      // (actions will clear the history themselves)
      if (!willPerformAction) {
        session.conversationHistory.push(
          { role: "user", content: messageContent },
          { role: "assistant", content: aiResponse }
        );

        const conversationHistoryLength = 10;
        if (session.conversationHistory.length > conversationHistoryLength) {
          session.conversationHistory = session.conversationHistory.slice(
            -conversationHistoryLength
          );
        }

        updateUserSession(from, session);
      }
    } catch (error) {
      console.error("❌ Error handling message:", error.message);

      await whatsappService.sendTextMessage(
        from,
        "⚠️ Sorry, I'm having trouble processing your message. Please try again."
      );
    }
  }
}

module.exports = new WebhookController();
