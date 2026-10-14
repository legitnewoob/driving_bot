const crypto = require("crypto");
const Instructor = require("../models/instructorSchema");
const logger = require("../utils/logger-advanced");
const { verifyToken } = require("./jwtAuth");

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
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7).trim() : null;

  // The Portal also sends the instructor's login token. Accept it, because each new
  // login replaces the API key, which would otherwise lock out the other app or device.
  if (bearer && process.env.JWT_SECRET) {
    try {
      const payload = verifyToken(bearer, process.env.JWT_SECRET);
      const instructor = payload.instructorId
        ? await Instructor.findOne({ _id: payload.instructorId, active: true }).lean()
        : await Instructor.findOne({ email: payload.email, active: true }).lean();
      if (instructor) {
        req.instructor = instructor;
        return next();
      }
    } catch {
      // Fall through to the API key
    }
  }

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
