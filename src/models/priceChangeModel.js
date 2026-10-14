const mongoose = require("mongoose");

// A price change for existing subscribers. New sign-ups get the new price at
// once; subscribers are moved when `effectiveAt` passes (rises give notice),
// and pay it from their next renewal.
const priceChangeSchema = new mongoose.Schema(
  {
    plan: { type: String, required: true },
    kind: { type: String, enum: ["base", "seat"], default: "base" },
    fromAmount: Number,
    toAmount: Number,
    fromPriceIds: { type: [String], default: [] },
    toPriceId: { type: String, required: true },
    effectiveAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ["scheduled", "applied", "cancelled"], default: "scheduled", index: true },
    notified: { type: Number, default: 0 },
    migrated: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    appliedAt: Date,
    by: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("PriceChange", priceChangeSchema);
