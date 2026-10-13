const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema(
  {
    instructorId: { type: String, required: true, index: true },
    type: { type: String, required: true }, // booked | cancelled | rescheduled | handover | paused_message
    message: { type: String, required: true },
    clientId: { type: String, required: true }, // stable id so clients can de-duplicate
    bookingId: { type: String, default: null },
    learnerPhone: { type: String, default: null },
    createdAt: { type: Date, default: Date.now, expires: 30 * 24 * 60 * 60 },
  },
  { versionKey: false }
);

notificationSchema.index({ instructorId: 1, createdAt: -1 });

module.exports = mongoose.model("Notification", notificationSchema);
