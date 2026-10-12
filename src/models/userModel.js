const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  instructorId: { type: String, required: true },
  name: String,
  age: Number,
  dob: String,
  postalCode: String,
  detailsCompleted: { type: Boolean, default: false },
  currentStep: { type: String, default: null },
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },
  instructorNotes: { type: String, default: "" },

}, { timestamps: true });

userSchema.index({ phone: 1, instructorId: 1 }, { unique: true });

module.exports = mongoose.model("User", userSchema);