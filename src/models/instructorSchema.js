const mongoose = require("mongoose");

const instructorSchema = new mongoose.Schema({
  phoneNumberId: { type: String, unique: true, sparse: true, index: true },
  phone: { type: String, unique: true, sparse: true, index: true },
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  googleId: { type: String, unique: true, sparse: true, index: true },
  googleCalendarId: { type: String },
  googleRefreshToken: { type: String },
  calendarTokenExpired: { type: Boolean, default: false },
  whatsappToken: { type: String },
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
    latitude: { type: Number },
    longitude: { type: Number },
  },
  rates: {
    basic: { type: Number, default: 50 },
    highway: { type: Number, default: 60 },
    parking: { type: Number, default: 45 },
  },
  timezone: { type: String, default: "Europe/London" },
  active: { type: Boolean, default: true },
  apiKey: { type: String, unique: true, sparse: true, index: true },
  plan: { type: String, enum: ["pdi", "adi", "driving-school"], default: "pdi" },
  stripeCustomerId: { type: String, unique: true, sparse: true },
  subscriptionId: { type: String },
  subscriptionStatus: {
    type: String,
    enum: ["active", "past_due", "canceled", "incomplete", "trialing", null],
    default: null,
  },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

instructorSchema.virtual("onboardingComplete").get(function () {
  const hasPhone = this.phoneNumberId && !this.phoneNumberId.startsWith("signup_");
  const hasSub = this.plan === "pdi" || ["active", "trialing"].includes(this.subscriptionStatus);
  const hasCal = !!this.googleRefreshToken;
  return hasPhone && hasSub && hasCal;
});

instructorSchema.virtual("onboardingStatus").get(function () {
  return {
    phoneAssigned: !!(this.phoneNumberId && !this.phoneNumberId.startsWith("signup_")),
    subscriptionActive: this.plan === "pdi" || ["active", "trialing"].includes(this.subscriptionStatus),
    calendarConnected: !!this.googleRefreshToken,
    calendarTokenExpired: !!this.calendarTokenExpired,
  };
});

module.exports = mongoose.model("Instructor", instructorSchema);
