const whatsappService = require("../services/whatsappService");
const aiService = require("../services/aiService");
const bookingService = require("../services/bookingService");
const {
  getUserSession,
  updateUserSession,
  getInstructor,
} = require("../models/instructorModel");

class WebhookController {
  /* ========== BOOKING ACTIONS ========== */

  //   async showBookings(from) {
  //     const bookings = await bookingService.getBookingsByUser(from);

  //     if (!bookings.length) {
  //       return whatsappService.sendTextMessage(from, "📭 You have no bookings.");
  //     }

  //     const message = bookings
  //       .map(
  //         (b) => `📅  ${new Date(b.date).toLocaleDateString()}  at  ${b.time}`
  //       )
  //       .join("\n");

  //     await whatsappService.sendTextMessage(
  //       from,
  //       "Here are your bookings:\n" + message
  //     );
  //   }

  async showBookings(from) {
    const bookings = await bookingService.getBookingsByUser(from);
    // console.log(bookings);
    if (!bookings.length) {
      return whatsappService.sendTextMessage(
        from,
        "📭 *No bookings found*\n\nYou don't have any upcoming bookings.\n\n_Ready to schedule your next appointment? Just let me know!_ 💬"
      );
    }

    // Sort bookings by date (earliest first)
    const sortedBookings = bookings.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );
    const now = new Date();

    let message = `*🗓️ YOUR BOOKINGS* (${sortedBookings.length})\n`;
    message += "━━━━━━━━━━━━━━━━━\n\n";

    sortedBookings.forEach((booking, index) => {
      const bookingId = booking.bookingId;
      const date = new Date(booking.date);
      const isToday = date.toDateString() === now.toDateString();
      const isTomorrow =
        date.toDateString() ===
        new Date(now.getTime() + 86400000).toDateString();
      const isPast = date < now && !isToday;

      // Smart date formatting
      let dateDisplay;
      if (isToday) {
        dateDisplay = "🔥 *TODAY*";
      } else if (isTomorrow) {
        dateDisplay = "⭐ *TOMORROW*";
      } else {
        const formattedDate = date.toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
        });
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
      if (booking.location) message += `📍 ${booking.location}\n`;
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
    (b) => new Date(b.date) >= now && b.status === "confirmed"
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
  }

  async updateBooking(from, bookingData) {
    const updated = await bookingService.updateBooking(from, bookingData);

    if (!updated) {
      return whatsappService.sendTextMessage(
        from,
        "⚠️ No booking found to update."
      );
    }

    await whatsappService.sendTextMessage(
      from,
      `✅ Booking updated to ${bookingData.date} at ${bookingData.time}`
    );
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
        return whatsappService.sendTextMessage(
          from,
          `✅ Your booking (ID: ${bookingId}) has been cancelled successfully.`
        );
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
      const booking = await bookingService.createBooking(bookingData);
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
        `🚗 Lesson Type: ${
          bookingData.lessonType.charAt(0).toUpperCase() +
          bookingData.lessonType.slice(1)
        } driving`,
        `💰 Price: ${booking.lessonPrice}`,
        "",
        "📧 A calendar invitation has been sent to your instructor.",
        "",
        "Good luck with your driving lesson! 🚗💨",
      ].join("\n");

      await whatsappService.sendTextMessage(from, confirmationMessage);
    } catch (error) {
      console.error("❌ Booking error:", error.message);

      const errorMessage = error.message.includes("validation")
        ? `❌ ${error.message}`
        : "❌ Sorry, there was an error processing your booking. Please try again.";

      await whatsappService.sendTextMessage(from, errorMessage);
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

      // console.log(JSON.stringify(body));
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
                  console.log(`📩 Incoming: ${from} → ${messageContent}`);
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
      console.log(`📱 Message from ${from}: "${messageContent}"`);

      const session = getUserSession(from);

      const aiResponse = await aiService.getResponse(
        messageContent,
        session.conversationHistory,
        from
      );

      console.log("🤖 AI Response:", aiResponse);

      const { hasAction, actionType, bookingData, responseText } =
        aiService.extractActions(aiResponse);

      if (responseText) {
        await whatsappService.sendTextMessage(from, responseText);
      }

      if (hasAction) {
        switch (actionType) {
          case "book":
            bookingData.userPhone = from;
            await this.processBooking(from, bookingData);
            break;

          case "show_bookings":
            await this.showBookings(from);
            break;

          case "update":
            await this.updateBooking(from, bookingData);
            break;

          case "cancel_booking":
            await this.cancelBooking(from, bookingData);
            break;

          case "null":
            // await whatsappService.sendTextMessage(from, "⚠️ ACTION IS NULL");
            break;
        }
      }

      // Maintain conversation history (last 20 turns)
      session.conversationHistory.push(
        { role: "user", content: messageContent },
        { role: "assistant", content: aiResponse }
      );

      if (session.conversationHistory.length > 20) {
        session.conversationHistory = session.conversationHistory.slice(-20);
      }

      updateUserSession(from, session);
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
