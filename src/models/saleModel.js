const mongoose = require("mongoose");

// An automatic sale: applied at checkout to the chosen plans between the dates,
// and shown on the pricing page.
const saleSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    bannerText: { type: String, default: "" },
    percentOff: { type: Number, default: null },
    amountOff: { type: Number, default: null }, // pence
    duration: { type: String, enum: ["once", "repeating", "forever"], default: "repeating" },
    durationMonths: { type: Number, default: null },
    plans: { type: [String], default: [] },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date, required: true },
    stripeCouponId: { type: String, default: null },
    active: { type: Boolean, default: true },
    by: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("Sale", saleSchema);
