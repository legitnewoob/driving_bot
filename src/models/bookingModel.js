// models/bookingModel.js
const mongoose = require("mongoose");

const bookingSchema = new mongoose.Schema({
  bookingId: { type: String, required: true, unique: true },
  userPhone: { type: String, required: true },
  date: { type: String, required: true },   // "2025-08-27"
  time: { type: String, required: true },   // "09:00"
  instructorId: { type: String, required: true },
  calendarEventId: { type: String },        // Google Calendar event ID for easy reschedule/cancel
  status: { 
    type: String, 
    enum: ["confirmed", "cancelled", "rescheduled", "completed"], 
    default: "confirmed" 
  },
  postalCode: { type: String, required: true },

  // Fields for location details (legacy – user profile location)
  location: {
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
  },

  // Pickup location for this booking
  pickupLocation: {
    address: { type: String, required: false },
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
  },

  // Drop-off location for this booking
  dropoffLocation: {
    address: { type: String, required: false },
    latitude: { type: Number, required: false },
    longitude: { type: Number, required: false },
  },

  // Lesson completion fields (filled in by instructor via Portal)
  topicsCovered: { type: [String], default: [] },
  rating: { type: Number, min: 1, max: 5, default: null },
  progressNotes: { type: String, default: "" },
  paymentReceived: { type: Boolean, default: false },
  paymentAmount: { type: Number, default: 0 },
  completedAt: { type: Date, default: null },
  lessonTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "LessonType", default: null },
  // Lesson length in minutes. Null on older bookings: they use the instructor's lessonDurationMin.
  durationMin: { type: Number, default: null },
  // The drive into this lesson from the one before, and the gap left for it (packed mode)
  driveInMin: { type: Number, default: null },
  gapBeforeMin: { type: Number, default: null },
  addedDriveMin: { type: Number, default: null },
  routeScoreReason: { type: String, default: "" },
  lessonTypeName: { type: String, default: "" },
  price: { type: Number, default: null },
  // Who booked it: Donna on WhatsApp, or the instructor in the Portal or dashboard (null: before this was recorded)
  source: { type: String, enum: ["whatsapp", "portal", "dashboard", null], default: null },
  lateCancellation: { type: Boolean, default: false },
  reminderSentAt: { type: Date, default: null },
  shortReminderSentAt: { type: Date, default: null },
  learnerConfirmedAt: { type: Date, default: null },
}, { timestamps: true });

// One active booking per instructor slot. Cancelled/completed bookings don't
// count, so a cancelled slot can be rebooked. ($in in a partial index needs MongoDB 6+.)
bookingSchema.index(
  { instructorId: 1, date: 1, time: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["confirmed", "rescheduled"] } } }
);
bookingSchema.index({ reminderSentAt: 1, date: 1, status: 1 });
// Range queries for dashboards and school analytics
bookingSchema.index({ instructorId: 1, date: 1, status: 1 });

module.exports = mongoose.model("Booking", bookingSchema);