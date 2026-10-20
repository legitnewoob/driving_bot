const mongoose = require("mongoose");

// Someone on the launch waitlist (an instructor or driving school waiting to be let
// in). Not to be confused with WaitlistEntry, a learner waiting for a lesson slot.
const launchSignupSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ["adi", "pdi", "school", null], default: null },
    schoolSize: { type: String, enum: ["2-5", "6-15", "16+", null], default: null },
    area: { type: String, default: "", trim: true },
    currentTool: { type: [String], default: [] },
    marketingConsent: { type: Boolean, default: false },

    // Order they joined in; their place in the queue is this minus referral boosts
    position: { type: Number, required: true, index: true },
    referralCode: { type: String, required: true, unique: true },
    referredBy: { type: String, default: null, index: true },
    referrals: { type: Number, default: 0 },
    // Three friends joined: goes in the next batch whatever their place
    priority: { type: Boolean, default: false },

    source: {
      utm_source: String,
      utm_medium: String,
      utm_campaign: String,
      referrer: String,
      landingPath: String,
    },

    status: { type: String, enum: ["waiting", "invited", "joined", "removed"], default: "waiting", index: true },
    invite: {
      tokenHash: { type: String, default: null, index: true },
      sentAt: { type: Date, default: null },
      expiresAt: { type: Date, default: null },
      remindedAt: { type: Date, default: null },
      usedAt: { type: Date, default: null },
      promoCode: { type: String, default: null },
      by: { type: String, default: null },
    },
    instructorId: { type: mongoose.Schema.Types.ObjectId, ref: "Instructor", default: null },

    // Secret for the no-password status page and unsubscribe links in emails
    accessToken: { type: String, required: true, unique: true },
    emails: {
      confirmationSentAt: { type: Date, default: null },
      movedUpAt: { type: Date, default: null },
      launchSentAt: { type: Date, default: null },
    },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

launchSignupSchema.index({ status: 1, priority: -1, position: 1 });

module.exports = mongoose.model("LaunchSignup", launchSignupSchema);
