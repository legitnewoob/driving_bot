const mongoose = require("mongoose");

// A code customers type at checkout (a Stripe promotion code on its own coupon).
const promoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    percentOff: { type: Number, default: null },
    amountOff: { type: Number, default: null },
    duration: { type: String, enum: ["once", "repeating", "forever"], default: "once" },
    durationMonths: { type: Number, default: null },
    plans: { type: [String], default: [] },
    maxRedemptions: { type: Number, default: null },
    expiresAt: { type: Date, default: null },
    stripeCouponId: String,
    stripePromotionCodeId: String,
    active: { type: Boolean, default: true },
    by: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("PromoCode", promoCodeSchema);
