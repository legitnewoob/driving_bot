const mongoose = require("mongoose");

const instructorSchema = new mongoose.Schema({
  phoneNumberId: { type: String, required: true, unique: true, index: true },
  phone: { type: String, unique: true, sparse: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true },
  googleCalendarId: { type: String, required: true },
  googleRefreshToken: { type: String, required: true },
  whatsappToken: { type: String, required: true },
  spreadsheetId: { type: String },
  availableTimes: {
    type: [String],
    default: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
  },
  specialties: {
    type: [String],
    default: ["Basic driving", "Highway driving", "Parking", "City driving"],
  },
  baseLocation: {
    latitude: { type: Number, required: true },
    longitude: { type: Number, required: true },
  },
  rates: {
    basic: { type: Number, default: 50 },
    highway: { type: Number, default: 60 },
    parking: { type: Number, default: 45 },
  },
  timezone: { type: String, default: "Europe/London" },
  active: { type: Boolean, default: true },
}, { timestamps: true });

module.exports = mongoose.model("Instructor", instructorSchema);
