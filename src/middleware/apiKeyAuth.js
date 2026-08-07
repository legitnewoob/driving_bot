const crypto = require("crypto");
const Instructor = require("../models/instructorSchema");
const logger = require("../utils/logger-advanced");

/**
 * API-key authentication middleware for the mobile Portal.
 *
 * Each instructor has an `apiKey` field in their document.
 * The Portal sends it as `x-api-key: <key>`.
 *
 * On success, attaches `req.instructor` (full lean doc).
 */
async function apiKeyAuth(req, res, next) {
  const key = req.headers["x-api-key"];

  if (!key) {
    return res.status(401).json({ success: false, error: "Missing x-api-key header" });
  }

  try {
    const hashedKey = crypto.createHash("sha256").update(key).digest("hex");
    const instructor = await Instructor.findOne({ apiKey: hashedKey, active: true }).lean();

    if (!instructor) {
      return res.status(403).json({ success: false, error: "Invalid API key" });
    }

    req.instructor = instructor;
    next();
  } catch (err) {
    logger.error(`apiKeyAuth error: ${err.message}`);
    res.status(500).json({ success: false, error: "Authentication failed" });
  }
}

module.exports = apiKeyAuth;
