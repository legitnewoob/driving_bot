const mongoose = require("mongoose");

// One driving time between two places (rounded to ~11 m), from Google's Routes
// API. Road times between the same two houses barely change week to week, so
// they're kept for 30 days instead of being paid for on every availability check.
const driveTimeSchema = new mongoose.Schema({
  _id: { type: String }, // "lat,lng|lat,lng" as built by distanceMatrixService.cacheKey
  minutes: { type: Number, required: true },
  traffic: { type: Boolean, default: false },
  fetchedAt: { type: Date, default: Date.now, expires: 30 * 24 * 60 * 60 },
});

module.exports = mongoose.model("DriveTime", driveTimeSchema);
