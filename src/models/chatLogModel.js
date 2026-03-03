const mongoose = require("mongoose");

const chatLogSchema = new mongoose.Schema(
  {
    instructor : {
        type: String,
        required: true,
        index: true
    },
    phoneNumber: {
      type: String,
      required: true,
      index: true
    },
    role: {
      type: String,
      enum: ["user", "assistant", "system"],
      required: true
    },
    message: {
      type: String,
      required: true
    },
    date: {
      type: String, // YYYY-MM-DD (for easy filtering)
      index: true
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  { versionKey: false }
);

module.exports = mongoose.model("ChatLog", chatLogSchema);