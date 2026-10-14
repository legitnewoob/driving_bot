const mongoose = require("mongoose");

// One document per WhatsApp message id we've handled, so Meta's retries of a
// slow webhook are skipped. Expires after a day.
const processedMessageSchema = new mongoose.Schema({
  _id: { type: String },
  createdAt: { type: Date, default: Date.now, expires: 24 * 60 * 60 },
});

module.exports = mongoose.model("ProcessedMessage", processedMessageSchema);
