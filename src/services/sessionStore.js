// Persists each learner's conversation (history + half-finished booking
// details) to Mongo so it survives restarts and works across servers.
// The in-memory stores in instructorModel / aiService stay the working copy:
// load() before handling a message, save() after.
const ConversationSession = require("../models/conversationSessionModel");
const { userSessions } = require("../models/instructorModel");
const aiService = require("./gemini/aiService");
const timezoneUtils = require("../utils/timezoneUtils");
const logger = require("../utils/logger-advanced");
const { isDbReady } = require("../utils/db");

const timeoutMs = () => (Number(process.env.SESSION_TIMEOUT_MINUTES) || 60) * 60 * 1000;
const sessionKey = (phone, instructorId) => `${phone}::${instructorId}`;

async function load(phone, instructorId) {
  if (!isDbReady()) return;
  try {
    const doc = await ConversationSession.findOne({ phone, instructorId }).lean();
    const fresh = doc && Date.now() - new Date(doc.lastActivity).getTime() < timeoutMs();

    userSessions[sessionKey(phone, instructorId)] = {
      conversationHistory: fresh ? doc.conversationHistory || [] : [],
      lastActivity: timezoneUtils.getCurrentDate(),
    };
    if (fresh && doc.pending) {
      aiService.pendingContext[phone] = { ...doc.pending, _updatedAt: Date.now() };
    } else {
      delete aiService.pendingContext[phone];
    }
  } catch (err) {
    logger.warn(`Session load failed for ${phone}: ${err.message}`);
  }
}

async function save(phone, instructorId) {
  if (!isDbReady()) return;
  try {
    const session = userSessions[sessionKey(phone, instructorId)];
    const { _updatedAt, ...pending } = aiService.pendingContext[phone] || {};
    await ConversationSession.updateOne(
      { phone, instructorId },
      {
        $set: {
          conversationHistory: session?.conversationHistory || [],
          pending: Object.keys(pending).length ? pending : null,
          lastActivity: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    logger.warn(`Session save failed for ${phone}: ${err.message}`);
  }
}

const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Whether we can send this learner free-form messages: WhatsApp only allows
 * that within 24h of their last message; otherwise a template is required.
 */
async function inServiceWindow(phone, instructorId) {
  if (!isDbReady()) return false;
  try {
    const doc = await ConversationSession.findOne({ phone, instructorId }).select("lastActivity").lean();
    return !!doc && Date.now() - new Date(doc.lastActivity).getTime() < SERVICE_WINDOW_MS;
  } catch {
    return false;
  }
}

module.exports = { load, save, sessionKey, inServiceWindow };
