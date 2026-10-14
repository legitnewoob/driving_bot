const mongoose = require("mongoose");

const schoolInviteSchema = new mongoose.Schema(
  {
    schoolId: { type: mongoose.Schema.Types.ObjectId, ref: "School", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    token: { type: String, required: true, unique: true },
    status: { type: String, enum: ["pending", "accepted", "revoked"], default: "pending", index: true },
    expiresAt: { type: Date, required: true },
    acceptedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Instructor", default: null },
  },
  { timestamps: true }
);

schoolInviteSchema.index({ schoolId: 1, email: 1, status: 1 });

module.exports = mongoose.model("SchoolInvite", schoolInviteSchema);
