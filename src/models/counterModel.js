const mongoose = require("mongoose");

// Atomic sequences, e.g. waitlist positions: findOneAndUpdate({ _id }, { $inc: { seq: 1 } })
const counterSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  seq: { type: Number, default: 0 },
});

module.exports = mongoose.model("Counter", counterSchema);
