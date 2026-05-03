const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, unique: true },
  instructorId: { type: String, required: true, index: true },
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

});

module.exports = mongoose.model("User", userSchema);