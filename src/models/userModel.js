const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  instructorId: { type: String, required: true, index: true },
  name: String,
  age: Number,
  dob: String,
  postalCode: String,
  detailsCompleted: { type: Boolean, default: false },
  onboardingStarted: { type: Boolean, default: false },
  currentStep: { type: String, default: null },
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },
  lessonRate: { type: Number },
  targetHours: { type: Number },
  testDate: { type: String, default: null },
  notes: { type: String },

}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);
