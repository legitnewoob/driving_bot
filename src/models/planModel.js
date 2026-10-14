const mongoose = require("mongoose");

// A paid plan as sold on the pricing page. Admins edit these; checkout and the
// website read them. Stripe prices can't change, so a new price replaces
// `stripePriceId` and the old one moves to `pastPriceIds` (still matched on
// existing subscriptions until they're moved over).
const planSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true }, // pdi | adi | driving-school
    name: { type: String, required: true },
    subtitle: { type: String, default: "" },
    features: { type: [String], default: [] },
    popular: { type: Boolean, default: false },
    button: { type: String, default: "Get started" },
    amount: { type: Number, default: 0 }, // pence per interval; 0 = free
    currency: { type: String, default: "gbp" },
    interval: { type: String, enum: ["month", "year"], default: "month" },
    trialDays: { type: Number, default: 30 },
    stripeProductId: { type: String, default: null },
    stripePriceId: { type: String, default: null },
    pastPriceIds: { type: [String], default: [] },
    // Driving school only
    includedSeats: { type: Number, default: 0 },
    extraSeatAmount: { type: Number, default: 0 },
    extraSeatProductId: { type: String, default: null },
    extraSeatPriceId: { type: String, default: null },
    pastExtraSeatPriceIds: { type: [String], default: [] },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Plan", planSchema);
