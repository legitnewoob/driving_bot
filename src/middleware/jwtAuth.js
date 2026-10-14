const crypto = require("crypto");

function base64UrlDecode(str) {
  return JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
}

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

function jwtAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "Authentication required" });
  }

  const token = authHeader.slice(7).trim();
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    console.error("JWT_SECRET is not set — rejecting request");
    return res.status(500).json({ success: false, error: "Server configuration error" });
  }

  try {
    req.user = verifyToken(token, secret);
  } catch (err) {
    return res.status(401).json({ success: false, error: err.message });
  }

  next();
}

module.exports = jwtAuth;
module.exports.verifyToken = verifyToken;
