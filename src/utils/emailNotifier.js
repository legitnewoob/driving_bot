// emailNotifier.js
// ─────────────────
// Sends email notifications for critical system errors (e.g. invalid_grant).
// Uses nodemailer with Gmail App Password — completely free, no API setup.
//
// Required env vars:
//   NOTIFY_EMAIL_USER     - Gmail address to send from (e.g. yourbot@gmail.com)
//   NOTIFY_EMAIL_PASS     - Gmail App Password (16 chars, from Google Account > Security > App Passwords)
//   NOTIFY_EMAIL_TO       - Recipient email (your personal Gmail)

const nodemailer = require("nodemailer");
const logger = require("./logger-advanced");

// Rate-limit: don't spam the same error repeatedly
const _sentRecently = new Map();
const COOLDOWN_MS = 60 * 60 * 1000; // 1 hour between duplicate alerts

/**
 * Create a reusable transporter (lazy-initialized).
 */
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;

  const user = process.env.NOTIFY_EMAIL_USER;
  const pass = process.env.NOTIFY_EMAIL_PASS;

  if (!user || !pass) {
    return null;
  }

  _transporter = nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });

  return _transporter;
}

/**
 * Send an email notification.
 *
 * @param {string} subject - Email subject line
 * @param {string} html    - Email body (HTML)
 * @param {string} [dedupeKey] - Optional key to prevent duplicate emails within cooldown
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
async function sendNotification(subject, html, dedupeKey = null) {
  // Dedupe check
  if (dedupeKey) {
    const lastSent = _sentRecently.get(dedupeKey);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
      logger.info(`Email notification skipped (cooldown): ${dedupeKey}`);
      return false;
    }
  }

  const transporter = getTransporter();
  if (!transporter) {
    logger.warn("Email notification skipped: NOTIFY_EMAIL_USER or NOTIFY_EMAIL_PASS not set");
    return false;
  }

  const to = process.env.NOTIFY_EMAIL_TO || process.env.NOTIFY_EMAIL_USER;

  try {
    await transporter.sendMail({
      from: `"Driving Bot Alerts" <${process.env.NOTIFY_EMAIL_USER}>`,
      to,
      subject,
      html,
    });

    if (dedupeKey) {
      _sentRecently.set(dedupeKey, Date.now());
    }

    logger.info(`Email notification sent: ${subject}`);
    return true;
  } catch (err) {
    logger.error(`Email notification failed: ${err.message}`);
    return false;
  }
}

/**
 * Send an invalid_grant alert for a specific instructor.
 *
 * @param {Object} instructor - Instructor object (needs name, phoneNumberId, phone, email)
 * @param {string} service    - Which service hit the error ("Calendar" or "Sheets")
 * @param {string} errorMessage - The original error message
 */
async function notifyInvalidGrant(instructor, service, errorMessage) {
  const name = instructor?.name || "Unknown";
  const phoneNumberId = instructor?.phoneNumberId || "N/A";
  const phone = instructor?.phone || "N/A";
  const email = instructor?.email || "N/A";
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  const reAuthUrl = `${baseUrl}/auth/google?phone=${phone}`;

  const subject = `⚠️ Invalid Grant — ${name} (${service})`;

  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #d32f2f;">⚠️ Google Token Expired</h2>
      <p>The Google refresh token for <strong>${name}</strong> has expired or been revoked.
         The <strong>${service}</strong> service is unable to access Google APIs for this instructor.</p>
      
      <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Instructor</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${name}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Phone Number ID</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${phoneNumberId}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Phone</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${phone}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Email</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${email}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Service</td>
            <td style="padding: 8px; border: 1px solid #ddd;">${service}</td></tr>
        <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Error</td>
            <td style="padding: 8px; border: 1px solid #ddd; color: #d32f2f;">${errorMessage}</td></tr>
      </table>

      <h3>How to fix</h3>
      <p>The instructor needs to re-authorize Google access by visiting:</p>
      <p style="margin: 16px 0;">
        <a href="${reAuthUrl}" style="background: #1976d2; color: white; padding: 12px 24px; 
           text-decoration: none; border-radius: 4px; display: inline-block;">
          Re-authorize Google Access
        </a>
      </p>
      <p style="color: #666; font-size: 12px;">Direct link: <a href="${reAuthUrl}">${reAuthUrl}</a></p>
      
      <hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;">
      <p style="color: #999; font-size: 11px;">
        This is an automated alert from Driving Bot. 
        You will not receive another alert for this instructor for at least 1 hour.
      </p>
    </div>
  `;

  return sendNotification(subject, html, `invalid_grant:${phoneNumberId}`);
}

/**
 * Clear the dedupe/cooldown map (useful for testing).
 */
function clearCooldowns() {
  _sentRecently.clear();
}

/**
 * Reset the transporter (useful for testing).
 */
function resetTransporter() {
  _transporter = null;
}

module.exports = {
  sendNotification,
  notifyInvalidGrant,
  clearCooldowns,
  resetTransporter,
};
