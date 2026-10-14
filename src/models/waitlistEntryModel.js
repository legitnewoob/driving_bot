const mongoose = require("mongoose");

const waitlistEntrySchema = new mongoose.Schema(
  {
    instructorId: { type: String, required: true },
    phone: { type: String, required: true },
    fromDate: { type: String, default: null },
    toDate: { type: String, default: null },
    preferredTimes: { type: [String], default: [] },
    status: { type: String, enum: ["waiting", "offered", "booked"], default: "waiting" },
    offer: {
      date: { type: String, default: null },
      time: { type: String, default: null },
      at: { type: Date, default: null },
    },
    expiresAt: { type: Date, default: () => new Date(Date.now() + 30 * 24 * 3600 * 1000) },
  },
  { timestamps: true }
);

waitlistEntrySchema.index({ instructorId: 1, status: 1 });
waitlistEntrySchema.index({ instructorId: 1, phone: 1 });
waitlistEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("WaitlistEntry", waitlistEntrySchema);
