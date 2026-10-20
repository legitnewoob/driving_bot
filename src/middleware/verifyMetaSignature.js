const crypto = require("crypto");
const logger = require("../utils/logger-advanced");

/**
 * WhatsApp webhooks must really come from Meta. Meta signs each POST body with
 * the app secret (X-Hub-Signature-256: sha256=<hex HMAC>); without this check
 * anyone could post fake learner messages to any instructor's Donna.
 *
 * Needs the raw request body (app.js keeps it as req.rawBody for /webhook).
 * WHATSAPP_SIGNATURE_CHECK=off turns the check off: emergency use only.
 */
let warnedMissing = false;

function verifyMetaSignature(req, res, next) {
  if (process.env.WHATSAPP_SIGNATURE_CHECK === "off") return next();

  const secret = process.env.META_APP_SECRET;
  if (!secret) {
    if (!warnedMissing) {
      logger.error("META_APP_SECRET is not set: WhatsApp webhooks can't be verified and are being refused");
      warnedMissing = true;
    }
    return res.sendStatus(403);
  }

  const header = String(req.headers["x-hub-signature-256"] || "");
  const raw = req.rawBody;
  if (!header.startsWith("sha256=") || !Buffer.isBuffer(raw)) {
    logger.warn("WhatsApp webhook without a valid signature: refused");
    return res.sendStatus(403);
  }

  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(raw).digest("hex"));
  const given = Buffer.from(header.slice("sha256=".length));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    logger.warn("WhatsApp webhook with a wrong signature: refused");
    return res.sendStatus(403);
  }
  next();
}

module.exports = verifyMetaSignature;
