const mongoose = require("mongoose");

const SESSION_TIMEOUT_MINUTES = Number(process.env.SESSION_TIMEOUT_MINUTES) || 60;

const conversationSessionSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    instructorId: { type: String, required: true },
    conversationHistory: {
      type: [{ role: String, content: String, _id: false }],
      default: [],
    },
    pending: { type: mongoose.Schema.Types.Mixed, default: null },
    lastActivity: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSessionSchema.index({ phone: 1, instructorId: 1 }, { unique: true });
conversationSessionSchema.index({ lastActivity: 1 }, { expireAfterSeconds: SESSION_TIMEOUT_MINUTES * 60 });

module.exports = mongoose.model("ConversationSession", conversationSessionSchema);
