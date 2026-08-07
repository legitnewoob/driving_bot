const crypto = require("crypto");

/**
 * Decode a base64url string to an object.
 */
function base64UrlDecode(str) {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
}

/**
 * Verify an HS256/HS384/HS512 JWT using Node's built-in crypto.
 * No jsonwebtoken package required.
 */
function verifyToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid token format");
  }

  const [headerB64, payloadB64, signature] = parts;

  const header = base64UrlDecode(headerB64);
  if (!header.alg || !header.alg.startsWith("HS")) {
    throw new Error("Unsupported JWT algorithm");
  }

  // Map HS256 -> sha256, HS384 -> sha384, HS512 -> sha512
  const algorithm = `sha${header.alg.replace("HS", "")}`;

  const expectedSignature = crypto
    .createHmac(algorithm, secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  const expectedBuf = Buffer.from(expectedSignature);
  const actualBuf = Buffer.from(signature);

  if (
    expectedBuf.length !== actualBuf.length ||
    !crypto.timingSafeEqual(expectedBuf, actualBuf)
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = base64UrlDecode(payloadB64);

  if (payload.exp && Date.now() >= payload.exp * 1000) {
    throw new Error("Token expired");
  }

  return payload;
}

/**
 * Express middleware that verifies a Bearer JWT when JWT_SECRET is configured.
 * If no secret is set, the middleware passes through (useful for local dev
 * with an instructorId query param). Attach decoded payload to req.user.
 */
function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    const secret = process.env.JWT_SECRET;

    if (!secret) {
      console.warn("JWT_SECRET is not set; skipping token verification");
    } else {
      try {
        req.user = verifyToken(token, secret);
      } catch (err) {
        return res.status(401).json({ success: false, error: err.message });
      }
    }
  }

  next();
}

module.exports = jwtAuth;
