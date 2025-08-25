const bookingService = require("../services/bookingService");
const whatsappService = require("../services/whatsappService");

class BookingActions {
  async showBookings(from) {
    const bookings = await bookingService.getBookingsByUser(from);

    if (!bookings.length) {
      return whatsappService.sendTextMessage(
        from,
        "📭 *No bookings found*\n\nYou don't have any upcoming bookings."
      );
    }

    const sortedBookings = bookings.sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    let message = `*🗓️ YOUR BOOKINGS* (${sortedBookings.length})\n\n`;

    sortedBookings.forEach((b, i) => {
      const date = new Date(b.date).toLocaleDateString("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
      });
      message += `📌 Booking ${i + 1}: ${date} at ${b.time}\n`;
    });

    await whatsappService.sendTextMessage(from, message);
  }

  async updateBooking(from, bookingData) {
    const updated = await bookingService.updateBooking(from, bookingData);
    if (!updated) {
      return whatsappService.sendTextMessage(from, "⚠️ No booking found to update.");
    }
    await whatsappService.sendTextMessage(
      from,
      `✅ Booking updated to ${bookingData.date} at ${bookingData.time}`
    );
  }

  async cancelBooking(from, bookingData) {
    const cancelled = await bookingService.cancelBooking(from, bookingData);
    if (!cancelled) {
      return whatsappService.sendTextMessage(from, "⚠️ No booking found to cancel.");
    }
    await whatsappService.sendTextMessage(
      from,
      `❌ Booking cancelled: ${cancelled.date} at ${cancelled.time}`
    );
  }

  async processBooking(from, bookingData) {
    const booking = await bookingService.createBooking(bookingData);
    const confirmationMessage = `🎉 Booking confirmed for ${bookingData.date} at ${bookingData.time}`;
    await whatsappService.sendTextMessage(from, confirmationMessage);
  }
}

module.exports = new BookingActions();