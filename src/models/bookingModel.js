// models/bookingModel.js
const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  bookingId: { type: String, required: true },
  userPhone: { type: String, required: true },
  date: { type: String, required: true },   // "2025-08-27"
  time: { type: String, required: true },   // "09:00"
  instructorId: { type: String, required: true },
  calendarEventId: { type: String },        // Google Calendar event ID for easy reschedule/cancel
  status: { 
    type: String, 
    enum: ["confirmed", "cancelled", "rescheduled"], 
    default: "confirmed" 
  },
  postalCode: { type: String, required: true },

  // Fields for location details
  location: {
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
  }
}, { timestamps: true });

module.exports = mongoose.model("Booking", bookingSchema);