// refreshWhatsAppToken.js
// ────────────────────────
// Exchanges the current WhatsApp token for a fresh long-lived token via
// the Meta Graph API, then updates ALL active instructors in the database.
//
// One shared token is used for every instructor's WhatsApp Business account.
// The token is refreshed on server startup and every 7 days thereafter.
// If the stored token no longer works, WHATSAPP_TOKEN from the env is used instead,
// so dropping a fresh token into the env and restarting is enough to recover.

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
  if (data.expires_in) {
    logger.info(`WhatsApp token refresh: new token valid for about ${Math.round(data.expires_in / 86400)} days`);
  }
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
async function refreshAndUpdateAll({ sourceToken = null, dryRun = false } = {}) {
  // Lazy-require to avoid circular dependency at module load time
  const Instructor = require("../models/instructorSchema");
  const { invalidateInstructorCache } = require("../models/instructorModel");

  try {
    // 1. Use the given token (e.g. a brand-new one from Meta), else the one instructors share
    let currentToken = sourceToken;
    if (!currentToken) {
      const anyInstructor = await Instructor.findOne({ active: true });
      if (!anyInstructor) {
        logger.warn("WhatsApp token refresh: no active instructors found — skipping");
        return;
      }
      currentToken = anyInstructor.whatsappToken;
    }

    // 2. Exchange for a new long-lived token. If the stored token has expired or
    // belongs to another app, fall back to a fresh WHATSAPP_TOKEN from the env.
    logger.info("WhatsApp token refresh: exchanging current token for a new long-lived token...");
    let newToken;
    try {
      newToken = await exchangeForLongLivedToken(currentToken);
    } catch (err) {
      const envToken = process.env.WHATSAPP_TOKEN;
      if (sourceToken || !envToken || envToken === currentToken) throw err;
      const reason = err.response?.data?.error?.message || err.message;
      logger.warn(`WhatsApp token refresh: stored token was rejected (${reason}); trying WHATSAPP_TOKEN from the env`);
      newToken = await exchangeForLongLivedToken(envToken);
    }

    if (dryRun) {
      logger.info("WhatsApp token refresh: dry run — exchange worked, nothing saved");
      return newToken;
    }

    // 3. Update all active instructors
    const result = await Instructor.updateMany(
      { active: true },
      { $set: { whatsappToken: newToken } }
    );

    logger.info(
      `WhatsApp token refresh: updated ${result.modifiedCount} instructor(s) with new token`
    );

    // Keep the phone-number pool's copy fresh too, so newly assigned numbers get a working token
    const PhoneNumber = require("../models/phoneNumberModel");
    await PhoneNumber.updateMany({ whatsappToken: { $ne: null } }, { $set: { whatsappToken: newToken } });

    // 4. Invalidate cache for every updated instructor
    const instructors = await Instructor.find({ active: true }).select("phoneNumberId").lean();
    for (const inst of instructors) {
      invalidateInstructorCache(inst.phoneNumberId);
    }

    logger.info("WhatsApp token refresh: complete");
    return newToken;
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

// CLI:
//   node src/utils/refreshWhatsappToken.js                 refresh the token instructors already share
//   node src/utils/refreshWhatsappToken.js --new           exchange WHATSAPP_TOKEN from the env (e.g. a new
//                                                          token from Meta) and save it on all active instructors
//   add --dry-run to only test the exchange (nothing saved)
if (require.main === module) {
  require("../config/env");
  const mongoose = require("mongoose");
  const args = process.argv.slice(2);
  const useNew = args.includes("--new");
  const dryRun = args.includes("--dry-run");
  (async () => {
    if (useNew && !process.env.WHATSAPP_TOKEN) throw new Error("--new needs WHATSAPP_TOKEN in the env");
    await mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI);
    console.log(`Database: ${mongoose.connection.name}${dryRun ? " (dry run, nothing will be saved)" : ""}`);
    const token = await refreshAndUpdateAll({ sourceToken: useNew ? process.env.WHATSAPP_TOKEN : null, dryRun });
    console.log(token ? "Done. New token saved." + (dryRun ? " (not saved: dry run)" : "") : "Failed — see the log above.");
    await mongoose.disconnect();
    process.exit(token ? 0 : 1);
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