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
    // Master switch: when false Donna stops replying and booking (e.g. an emergency)
    donnaEnabled: { type: Boolean, default: true },
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
  // Driving schools: the owner manages; members are the school's instructors
  schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", default: null, index: true },
  // member = instructor; manager = instructor who can also invite/remove instructors
  schoolRole: { type: String, enum: ["owner", "manager", "member", null], default: null },
  // Donna Drive staff (admin panel). Super admins come from SUPER_ADMIN_EMAILS.
  staffRole: { type: String, enum: ["admin", "support", null], default: null },
  // A plan given free by an admin; counts as an active subscription until `until` (null = no end)
  comp: {
    plan: { type: String, enum: ["pdi", "adi", "driving-school", null], default: null },
    until: { type: Date, default: null },
    note: { type: String, default: "" },
  },
  // New sign-ups start false and can't use the dashboard, Portal or Donna until they
  // pick a plan (free, finished checkout, joined a school or comped). Left unset on
  // older accounts, which counts as chosen.
  planSelected: { type: Boolean },
  // Admin suspension: blocks sign-in (signing in again doesn't reactivate)
  suspended: { type: Boolean, default: false },
  trialEndsAt: { type: Date, default: null },
  // Set when the instructor deletes their account (identity removed, see accountDeletion)
  deletedAt: { type: Date, default: null },
  // Who a deleted account belonged to: admin-only, never used to sign in. Lets
  // admins see when someone signs up again after deleting.
  deletedIdentity: {
    email: { type: String, default: null, lowercase: true, index: true },
    name: { type: String, default: null },
    googleId: { type: String, default: null, index: true },
  },
  // On a new account: earlier accounts by the same person that they deleted
  previousAccountIds: { type: [mongoose.Schema.Types.ObjectId], default: undefined },
  canceledAt: { type: Date, default: null },
  // The paid plan they started checkout for and haven't finished paying (offered again next sign-in)
  pendingPlan: { type: String, default: null },
  // Referrals ("give a month, get a month"): their own link code, the code of
  // whoever referred them, and when that referral's free months were paid out
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: { type: String, default: null },
  referralRewardedAt: { type: Date, default: null },
  referralFreeMonths: { type: Number, default: 0 },
  stripeCustomerId: { type: String, unique: true, sparse: true },
  subscriptionId: { type: String },
  subscriptionStatus: {
    type: String,
    enum: ["active", "past_due", "canceled", "incomplete", "trialing", null],
    default: null,
  },
}, { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } });

// Plan access: a free plan (priced £0), a live Stripe subscription, or a comp from an admin
instructorSchema.methods.hasActivePlan = function () {
  if (require("../services/pricingService").isFreePlan(this.plan)) return true;
  if (["active", "trialing"].includes(this.subscriptionStatus)) return true;
  return !!(this.comp?.plan && (!this.comp.until || this.comp.until > new Date()));
};

instructorSchema.virtual("onboardingComplete").get(function () {
  const hasPhone = this.phoneNumberId && !this.phoneNumberId.startsWith("signup_");
  const hasSub = this.hasActivePlan();
  const hasCal = !!this.googleRefreshToken;
  return hasPhone && hasSub && hasCal;
});

instructorSchema.virtual("onboardingStatus").get(function () {
  return {
    phoneAssigned: !!(this.phoneNumberId && !this.phoneNumberId.startsWith("signup_")),
    subscriptionActive: this.hasActivePlan(),
    calendarConnected: !!this.googleRefreshToken,
    calendarTokenExpired: !!this.calendarTokenExpired,
  };
});

module.exports = mongoose.model("Instructor", instructorSchema);
