const crypto = require("crypto");

function adminAuth(req, res, next) {
  const key = req.headers["x-admin-key"];
  const expected = process.env.ADMIN_API_KEY;

  if (!key || !expected || key.length !== expected.length) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  if (!crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected))) {
    return res.status(403).json({ success: false, error: "Forbidden" });
  }

  next();
}

module.exports = adminAuth;
