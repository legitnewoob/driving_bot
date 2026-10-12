const mongoose = require("mongoose");

const processedEventSchema = new mongoose.Schema({
  eventId: { type: String, required: true, unique: true, index: true },
  processedAt: { type: Date, default: Date.now, index: { expireAfterSeconds: 86400 } },
});

module.exports = mongoose.model("ProcessedEvent", processedEventSchema);
