const crypto = require("crypto");

/**
 * Sign a JWT using HS256 (matches the verification in middleware/jwtAuth.js).
 * No external packages required.
 */
function signToken(payload, secret, expiresInSeconds = 7 * 24 * 3600) {
  const header = { alg: "HS256", typ: "JWT" };

  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString("base64url");
  const payloadB64 = Buffer.from(JSON.stringify(fullPayload)).toString("base64url");

  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  return `${headerB64}.${payloadB64}.${signature}`;
}

module.exports = { signToken };
