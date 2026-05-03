// refreshWhatsAppToken.js
// ────────────────────────
// Exchanges the current WhatsApp token for a fresh long-lived token via
// the Meta Graph API, then updates ALL active instructors in the database.
//
// One shared token is used for every instructor's WhatsApp Business account.
// The token is refreshed on server startup and every 7 days thereafter.

const axios = require("axios");
const logger = require("./logger-advanced");

const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
let _refreshTimer = null;

/**
 * Exchange the current token for a new long-lived token.
 *
 * @param {string} currentToken - The token to exchange (short-lived or existing long-lived)
 * @returns {Promise<string>} The new long-lived access token
 */
async function exchangeForLongLivedToken(currentToken) {
  const APP_ID = process.env.META_APP_ID;
  const APP_SECRET = process.env.META_APP_SECRET;

  if (!APP_ID || !APP_SECRET) {
    throw new Error("Missing META_APP_ID or META_APP_SECRET in environment");
  }
  if (!currentToken) {
    throw new Error("No current WhatsApp token available for exchange");
  }

  const url =
    `https://graph.facebook.com/v22.0/oauth/access_token` +
    `?grant_type=fb_exchange_token` +
    `&client_id=${APP_ID}` +
    `&client_secret=${APP_SECRET}` +
    `&fb_exchange_token=${currentToken}`;

  const { data } = await axios.get(url);
  return data.access_token;
}

/**
 * Refresh the WhatsApp token and update all active instructors in the DB.
 *
 * Flow:
 *  1. Grab the current token from any active instructor (they all share the same one)
 *  2. Exchange it via Meta Graph API for a fresh long-lived token
 *  3. Update every active instructor's whatsappToken in the database
 *  4. Invalidate the instructor cache so subsequent reads pick up the new token
 */
async function refreshAndUpdateAll() {
  // Lazy-require to avoid circular dependency at module load time
  const Instructor = require("../models/instructorSchema");
  const { invalidateInstructorCache } = require("../models/instructorModel");

  try {
    // 1. Get current token from any active instructor
    const anyInstructor = await Instructor.findOne({ active: true });
    if (!anyInstructor) {
      logger.warn("WhatsApp token refresh: no active instructors found — skipping");
      return;
    }

    const currentToken = anyInstructor.whatsappToken;

    // 2. Exchange for a new long-lived token
    logger.info("WhatsApp token refresh: exchanging current token for a new long-lived token...");
    const newToken = await exchangeForLongLivedToken(currentToken);

    // 3. Update all active instructors
    const result = await Instructor.updateMany(
      { active: true },
      { $set: { whatsappToken: newToken } }
    );

    logger.info(
      `WhatsApp token refresh: updated ${result.modifiedCount} instructor(s) with new token`
    );

    // 4. Invalidate cache for every updated instructor
    const instructors = await Instructor.find({ active: true }).select("phoneNumberId").lean();
    for (const inst of instructors) {
      invalidateInstructorCache(inst.phoneNumberId);
    }

    logger.info("WhatsApp token refresh: complete");
  } catch (err) {
    const errDetail = err.response?.data
      ? JSON.stringify(err.response.data)
      : err.message;
    logger.error(`WhatsApp token refresh failed: ${errDetail}`);
    // Don't crash the server — the old token may still be valid for a while
  }
}

/**
 * Start the WhatsApp token refresh schedule.
 * Runs once immediately, then every 7 days.
 */
function startTokenRefreshSchedule() {
  // Run immediately on startup
  refreshAndUpdateAll();

  // Schedule recurring refresh
  _refreshTimer = setInterval(refreshAndUpdateAll, REFRESH_INTERVAL_MS);

  // Allow the process to exit even if the timer is active
  if (_refreshTimer.unref) {
    _refreshTimer.unref();
  }

  logger.info(
    `WhatsApp token refresh scheduled: every ${REFRESH_INTERVAL_MS / (24 * 60 * 60 * 1000)} days`
  );
}

/**
 * Stop the scheduled refresh (useful for testing / graceful shutdown).
 */
function stopTokenRefreshSchedule() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}

// If script is run directly from CLI (legacy support)
if (require.main === module) {
  require("../config/env");
  const mongoose = require("mongoose");
  (async () => {
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    await refreshAndUpdateAll();
    await mongoose.disconnect();
    process.exit(0);
  })().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}

module.exports = {
  exchangeForLongLivedToken,
  refreshAndUpdateAll,
  startTokenRefreshSchedule,
  stopTokenRefreshSchedule,
};