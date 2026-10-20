const crypto = require("crypto");

/**
 * Authentication middleware for protecting routes
 */

const same = (a, b) => {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

/**
 * Basic HTTP authentication for the status page. Needs ADMIN_USERNAME and an
 * ADMIN_PASSWORD of 12+ characters; there are no default credentials, so
 * without them the page is off.
 */
const basicAuth = (req, res, next) => {
  const validUsername = process.env.ADMIN_USERNAME || "admin";
  const validPassword = process.env.ADMIN_PASSWORD || "";
  if (validPassword.length < 12) {
    return res.status(503).send("Status page is off: set ADMIN_PASSWORD (12+ characters) to use it.");
  }

  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin Access"');
    return res.status(401).send("Authentication required");
  }

  const credentials = Buffer.from(authHeader.slice(6).trim(), "base64").toString("utf8");
  const sep = credentials.indexOf(":");
  const username = sep === -1 ? credentials : credentials.slice(0, sep);
  const password = sep === -1 ? "" : credentials.slice(sep + 1);

  // Check both, always, so timing doesn't reveal which was wrong
  const ok = same(username, validUsername) & same(password, validPassword);
  if (ok) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="Admin Access"');
  return res.status(401).send("Invalid credentials");
};

module.exports = { basicAuth };
