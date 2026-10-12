const mongoose = require("mongoose");

const phoneNumberSchema = new mongoose.Schema({
  phoneNumber: { type: String, required: true, unique: true, index: true },
  phoneNumberId: { type: String, required: true, unique: true, index: true },
  whatsappToken: { type: String, default: null },
  status: {
    type: String,
    enum: ["available", "reserved", "assigned"],
    default: "available",
    index: true,
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Instructor",
    default: null,
    index: true,
  },
  assignedAt: { type: Date, default: null },
  label: { type: String, default: null },
  region: { type: String, default: "GB" },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { timestamps: true });

phoneNumberSchema.index({ status: 1, region: 1 });

module.exports = mongoose.model("PhoneNumber", phoneNumberSchema);
