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
  baseAddress: { type: String, default: "" },
  routeSettings: {
    preset: { type: String, enum: ["off", "relaxed", "balanced", "tight", "custom"], default: "balanced" },
    lessonDurationMin: { type: Number, default: 60 },
    travelGraceMin: { type: Number, default: 10 },
    maxAddedDriveMin: { type: Number, default: 20 },
    homeLegWeight: { type: String, enum: ["off", "half", "full"], default: "half" },
    fragmentationPenalty: { type: String, enum: ["off", "low", "medium", "high"], default: "medium" },
    serviceArea: {
      // Radius as the instructor typed it, in `unit`. radiusMiles is the older
      // miles-only field, still honoured when radius isn't set.
      radius: { type: Number, default: null },
      unit: { type: String, enum: ["miles", "km"], default: "miles" },
      radiusMiles: { type: Number, default: null },
      postcodeDistricts: { type: [String], default: [] },
    },
    suggestOtherDays: { type: Boolean, default: true },
    lookAheadDays: { type: Number, default: 10 },
  },
  botSettings: {
    workingHours: {
      type: new mongoose.Schema({
        mon: [String], tue: [String], wed: [String], thu: [String],
        fri: [String], sat: [String], sun: [String],
      }, { _id: false }),
      default: null,
    },
    breaks: { type: [{ from: String, to: String, _id: false }], default: [] },
    maxLessonsPerDay: { type: Number, default: null },
    minNoticeHours: { type: Number, default: 24 },
    bookingWindowDays: { type: Number, default: 90 },
    holiday: {
      enabled: { type: Boolean, default: false },
      from: { type: String, default: null },
      to: { type: String, default: null },
      message: { type: String, default: "" },
    },
    acceptingNewLearners: { type: Boolean, default: true },
    allowCancel: { type: Boolean, default: true },
    allowReschedule: { type: Boolean, default: true },
    tone: { type: String, enum: ["friendly", "professional", "brief"], default: "friendly" },
    emojis: { type: Boolean, default: true },
    customGreeting: { type: String, default: "" },
    aboutLessons: { type: String, default: "" },
    cancellationNoticeHours: { type: Number, default: 48 },
    lateCancellationFee: { type: Number, default: null },
    reminders: { type: String, enum: ["off", "24h", "24h+2h"], default: "24h" },
    notifications: {
      booked: { type: Boolean, default: true },
      cancelled: { type: Boolean, default: true },
      rescheduled: { type: Boolean, default: true },
      email: { type: Boolean, default: true },
    },
    handover: { type: Boolean, default: true },
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
