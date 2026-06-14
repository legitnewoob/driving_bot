const Instructor = require("../models/instructorSchema");

/**
 * Per-instructor API key authentication middleware.
 * Reads the `x-api-key` header, looks up the matching Instructor, and
 * attaches it to `req.instructor`. Responds 401 if missing/invalid.
 */
async function instructorAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) {
    return res.status(401).json({ success: false, error: "Missing API key" });
  }

  const instructor = await Instructor.findOne({ apiKey, active: true });
  if (!instructor) {
    return res.status(401).json({ success: false, error: "Invalid API key" });
  }

  req.instructor = instructor;
  next();
}

module.exports = instructorAuth;
