const mongoose = require("mongoose");

// Who changed what, for admin and school-role actions
const auditLogSchema = new mongoose.Schema(
  {
    actor: { type: String, required: true }, // email, or "admin-key" / "system"
    action: { type: String, required: true, index: true },
    target: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);
auditLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);
