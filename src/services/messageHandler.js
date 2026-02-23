const aiService = require("./aiService");
const whatsappService = require("./whatsappService");
const bookingActions = require("../actions/bookingActions");
const { getUserSession, updateUserSession } = require("../models/instructorModel");

class MessageHandler {
  async handleIncomingMessage(from, messageContent) {
    console.log(from, messageContent);
    const session = getUserSession(from);

    const aiResponse = await aiService.getResponse(
      messageContent,
      session.conversationHistory,
      from
    );

    const { hasAction, actionType, bookingData, responseText } =
      aiService.extractActions(aiResponse);

    if (responseText) {
      await whatsappService.sendTextMessage(from, responseText);
    }

    if (hasAction) {
      switch (actionType) {
        case "book":
          bookingData.userPhone = from;
          await bookingActions.processBooking(from, bookingData);
          break;
        case "show_bookings":
          await bookingActions.showBookings(from);
          break;
        case "update":
          await bookingActions.updateBooking(from, bookingData);
          break;
        case "cancel":
          await bookingActions.cancelBooking(from, bookingData);
          break;
        default:
          await whatsappService.sendTextMessage(from, "⚠️ Unknown action.");
      }
    }

    // update conversation history
    session.conversationHistory.push(
      { role: "user", content: messageContent },
      { role: "assistant", content: aiResponse }
    );
    if (session.conversationHistory.length > 20) {
      session.conversationHistory = session.conversationHistory.slice(-20);
    }
    updateUserSession(from, session);
  }
}

module.exports = new MessageHandler();