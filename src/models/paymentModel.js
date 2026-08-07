// models/paymentModel.js
const mongoose = require("mongoose");

const paymentSchema = new mongoose.Schema({
  paymentId: { type: String, required: true, unique: true },
  instructorId: { type: String, required: true, index: true },
  userPhone: { type: String, required: true },
  bookingId: { type: String, default: null },     // links to booking if payment was at a lesson
  amount: { type: Number, required: true },
  method: {
    type: String,
    enum: ["cash", "bank", "card", "other"],
    default: "cash",
  },
  date: { type: String, required: true },          // "2026-08-10"
  note: { type: String, default: "" },
}, { timestamps: true });

paymentSchema.index({ instructorId: 1, userPhone: 1 });

module.exports = mongoose.model("Payment", paymentSchema);
