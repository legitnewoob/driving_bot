const mongoose = require("mongoose");

const authCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, index: true },
  instructorId: { type: mongoose.Schema.Types.ObjectId, ref: "Instructor", required: true },
  token: { type: String, required: true },
  apiKey: { type: String, required: true },
  used: { type: Boolean, default: false },
  expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
}, { timestamps: true });

module.exports = mongoose.model("AuthCode", authCodeSchema);
