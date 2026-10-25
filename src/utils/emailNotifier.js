// emailNotifier.js
// ─────────────────
// Sends email notifications for critical system errors (e.g. invalid_grant).
// Uses nodemailer with Gmail App Password — completely free, no API setup.
//
// Required env vars:
//   NOTIFY_EMAIL_USER     - Gmail address to send from (e.g. yourbot@gmail.com)
//   NOTIFY_EMAIL_PASS     - Gmail App Password (16 chars, from Google Account > Security > App Passwords)
//   NOTIFY_EMAIL_TO       - Recipient email (your personal Gmail)
//
// Optional, and preferred in production:
//   RESEND_API_KEY        - send through Resend's HTTPS API instead of Gmail SMTP.
//                           Railway blocks outbound SMTP on most plans, so Gmail
//                           can't connect from there; HTTPS always can.
//   EMAIL_FROM            - sender for Resend, e.g. "Donna Drive <hello@donnadrive.co.uk>"
//                           (the domain must be verified in Resend)
//   EMAIL_REPLY_TO        - where replies go when an email doesn't set its own,
//                           e.g. a Gmail inbox (otherwise replies go to EMAIL_FROM)
//
// Local testing:
//   EMAIL_OUTBOX=local    - don't send anything: write each email to .outbox/ as an
//                           HTML file instead (see GET /dev/outbox). Ignored in production.

const fs = require("fs");
const path = require("path");
const nodemailer = require("nodemailer");
const logger = require("./logger-advanced");

const OUTBOX_DIR = path.join(__dirname, "../../.outbox");

function outboxEnabled() {
  return process.env.EMAIL_OUTBOX === "local" && process.env.NODE_ENV !== "production";
}

/** Local testing: keep the email as a file instead of sending it. */
function writeToOutbox({ to, subject, html, replyTo, from, headers }) {
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const slug = subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const file = path.join(OUTBOX_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}.html`);
    const meta = { to, from, subject, replyTo: replyTo || null, headers: headers || null, at: new Date().toISOString() };
    fs.writeFileSync(file, `<!-- ${JSON.stringify(meta).replace(/--/g, "- -")} -->\n${html}`);
    logger.info(`Email kept in outbox (EMAIL_OUTBOX=local): ${subject} → ${to} (${file})`);
    return true;
  } catch (err) {
    logger.error(`Email outbox write failed: ${err.message}`);
    return false;
  }
}

/** EMAIL_FROM with a different display name, e.g. "Raj from Donna Drive <hello@...>". */
function fromWithName(name) {
  const base = process.env.EMAIL_FROM || "Donna Drive <onboarding@resend.dev>";
  if (!name) return base;
  const address = (base.match(/<([^>]+)>/) || [null, base])[1].trim();
  return `${name} <${address}>`;
}

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
    // Fail fast instead of hanging the request when SMTP is blocked (as on Railway)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return _transporter;
}

/**
 * A plain-text copy of an HTML email. Sending both (instead of HTML only) is
 * what personal email looks like, and helps keep mail out of Promotions.
 */
function htmlToText(html) {
  return String(html || "")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      return !text || text === href ? href : `${text}: ${href}`;
    })
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Send through Resend's HTTPS API (works where SMTP ports are blocked). */
async function sendViaResend({ to, subject, html, replyTo, from = fromWithName(null), headers }) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [to],
        subject,
        html,
        text: htmlToText(html),
        ...(replyTo && { reply_to: replyTo }),
        ...(headers && { headers }),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      logger.error(`Email (Resend) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    logger.info(`Email sent: ${subject}`);
    return true;
  } catch (err) {
    logger.error(`Email (Resend) failed: ${err.message}`);
    return false;
  }
}

/**
 * Send an email notification.
 *
 * @param {string} subject - Email subject line
 * @param {string} html    - Email body (HTML)
 * @param {string} [dedupeKey] - Optional key to prevent duplicate emails within cooldown
 * @param {string} [toOverride] - Recipient (defaults to the team's address)
 * @param {string} [replyTo]
 * @param {{ fromName?: string, headers?: Object }} [options] - sender display name, extra headers (e.g. List-Unsubscribe)
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
async function sendNotification(subject, html, dedupeKey = null, toOverride = null, replyTo = null, options = {}) {
  // Dedupe check
  if (dedupeKey) {
    const lastSent = _sentRecently.get(dedupeKey);
    if (lastSent && Date.now() - lastSent < COOLDOWN_MS) {
      logger.info(`Email notification skipped (cooldown): ${dedupeKey}`);
      return false;
    }
  }

  const to = toOverride || process.env.NOTIFY_EMAIL_TO || process.env.NOTIFY_EMAIL_USER;
  const from = fromWithName(options.fromName);
  // Replies go to a real inbox when one is set (people replying helps future emails land in Primary)
  replyTo = replyTo || process.env.EMAIL_REPLY_TO || null;

  if (outboxEnabled()) {
    const kept = writeToOutbox({ to: to || "(team)", subject, html, replyTo, from, headers: options.headers });
    if (kept && dedupeKey) _sentRecently.set(dedupeKey, Date.now());
    return kept;
  }

  // Resend first; if it refuses (e.g. the domain isn't verified yet), fall back to
  // Gmail, which works locally even though Railway blocks it
  if (process.env.RESEND_API_KEY) {
    const sent = await sendViaResend({ to, subject, html, replyTo, from, headers: options.headers });
    if (sent) {
      if (dedupeKey) _sentRecently.set(dedupeKey, Date.now());
      return true;
    }
  }

  const transporter = getTransporter();
  if (!transporter) {
    logger.warn("Email notification skipped: NOTIFY_EMAIL_USER or NOTIFY_EMAIL_PASS not set");
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"Driving Bot Alerts" <${process.env.NOTIFY_EMAIL_USER}>`,
      to,
      subject,
      html,
      text: htmlToText(html),
      ...(replyTo && { replyTo }),
      ...(options.headers && { headers: options.headers }),
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
  // Everything below goes into HTML: escape what instructors control
  const name = escapeHtml(instructor?.name || "Unknown");
  const phoneNumberId = escapeHtml(instructor?.phoneNumberId || "N/A");
  const phone = escapeHtml(instructor?.phone || "N/A");
  const email = escapeHtml(instructor?.email || "N/A");
  service = escapeHtml(service);
  errorMessage = escapeHtml(errorMessage);
  // Only the instructor can reconnect (it's their Google account), from their dashboard
  const reAuthUrl = `${process.env.DASHBOARD_URL || process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard`;

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
      <p>The instructor needs to reconnect Google Calendar from their dashboard (we've emailed them too):</p>
      <p style="margin: 16px 0;">
        <a href="${reAuthUrl}" style="background: #1976d2; color: white; padding: 12px 24px; 
           text-decoration: none; border-radius: 4px; display: inline-block;">
          Open the dashboard
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
 * Send a re-authentication prompt directly to the instructor's own email.
 * Called alongside notifyInvalidGrant so both admin and instructor are alerted.
 *
 * @param {Object} instructor - Instructor object (needs name, email)
 */
async function notifyInstructorReauth(instructor) {
  const name = instructor?.name || "there";
  const email = instructor?.email;
  if (!email) return false;

  const dashboardUrl = process.env.DASHBOARD_URL || process.env.BASE_URL || "http://localhost:8080";
  const reconnectUrl = `${dashboardUrl}/dashboard`;

  const subject = "Donna is paused: reconnect your Google Calendar";

  const html = `
    <div style="font-family: -apple-system, Segoe UI, Arial, sans-serif; max-width: 560px; margin: 0 auto; color: #1f2937; font-size: 15px; line-height: 1.6;">
      <p>Hi ${escapeHtml(name)},</p>
      <p>Your Google Calendar connection has expired, so Donna can't see your diary or book lessons. <strong>She's paused</strong>:
        learners who message you are asked to contact you directly, and their messages are forwarded to you.</p>
      <p>She'll start again by herself as soon as you reconnect.</p>
      <p>Sign in to your dashboard and click <strong>Connect Google Calendar</strong>. It takes about 30 seconds:<br/>
        <a href="${reconnectUrl}">${reconnectUrl}</a></p>
      <p>You'll also see this on your dashboard and in the Portal. If you've already reconnected, you can ignore this. Any questions, just reply.</p>
      <p>Donna Drive</p>
    </div>
  `;

  return sendNotification(subject, html, `instructor_reauth:${email}`, email);
}

/**
 * Tell an instructor that a learner they've paused Donna for has messaged.
 * At most one email per learner per cooldown window.
 */
// reason: "paused" (Donna paused for this learner) or "off" (Donna switched off for everyone)
async function notifyInstructorLearnerMessage(instructor, learner, messageText, { reason = "paused" } = {}) {
  const email = instructor?.email;
  if (!email) return false;
  const who = learner?.name || learner?.phone || "A learner";
  const escape = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  const off = reason === "off" || reason === "calendar";
  const calendar = reason === "calendar";
  const subject = calendar
    ? `${who} messaged you (Donna is paused: reconnect your Google Calendar)`
    : off
      ? `${who} messaged you (Donna is switched off)`
      : `${who} messaged you (Donna is paused for them)`;
  const why = calendar
    ? "Donna is paused because your Google Calendar connection has expired, so she told them to contact you directly."
    : off
      ? "Donna is switched off, so she told them to contact you directly."
      : "You've paused Donna for this learner, so she hasn't replied.";
  const next = calendar
    ? "Reply to them on WhatsApp, and reconnect Google Calendar from your dashboard so Donna can start again."
    : off
      ? "Reply to them on WhatsApp, or switch Donna back on from your dashboard or the Portal."
      : "Reply to them on WhatsApp, or turn Donna back on from the Learners page.";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p>Hi ${escape(instructor.name || "there")},</p>
      <p><strong>${escape(who)}</strong> (${escape(learner?.phone || "")}) sent a message. ${why}</p>
      <blockquote style="border-left: 3px solid #ddd; margin: 16px 0; padding: 8px 12px; color: #333;">${escape(messageText).slice(0, 1000)}</blockquote>
      <p style="color: #555; font-size: 14px;">${next}</p>
      <p style="color: #999; font-size: 11px;">You'll get at most one of these per learner per hour.</p>
    </div>
  `;
  return sendNotification(subject, html, `${calendar ? "calendar_paused" : off ? "donna_off" : "paused_learner"}:${email}:${learner?.phone}`, email);
}

const escapeHtml = (t) => String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/** Invite an instructor to join a driving school on Donna Drive. */
async function sendSchoolInvite({ to, schoolName, ownerName, link }) {
  const subject = `${ownerName || schoolName} invited you to join ${schoolName} on Donna Drive`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p>Hi,</p>
      <p><strong>${escapeHtml(ownerName || "Your driving school")}</strong> has invited you to join
      <strong>${escapeHtml(schoolName)}</strong> on Donna Drive.</p>
      <p>Donna answers your learners on WhatsApp, books lessons around your diary and keeps your calendar up to date.
      Your school covers the cost.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(link)}">Join ${escapeHtml(schoolName)} on Donna Drive</a>
      </p>
      <p style="color: #555; font-size: 13px;">Sign in with the Google account for ${escapeHtml(to)}. This invite expires in 14 days.</p>
    </div>
  `;
  return sendNotification(subject, html, null, to);
}

/** A website "Contact us" message, to the team; replying goes straight to the person. */
async function sendContactRequest({ name, email, message }) {
  const subject = `Contact us: ${name}${message ? ` — ${message.slice(0, 60)}` : ""}`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="margin: 0 0 12px;">New message from the website</h2>
      <p><strong>Name:</strong> ${escapeHtml(name)}<br/>
      <strong>Email:</strong> <a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></p>
      <p style="white-space: pre-wrap; background: #f6f6f6; padding: 12px; border-radius: 8px;">${escapeHtml(message || "(no message)")}</p>
      <p style="color: #555; font-size: 13px;">Reply to this email to answer them directly.</p>
    </div>
  `;
  return sendNotification(subject, html, null, process.env.CONTACT_EMAIL_TO || null, email);
}

/** Tell ops the WhatsApp number pool ran out while an instructor was waiting for one. */
async function sendPriceChangeNotice({ to, name, planName, what, fromAmount, toAmount, effectiveAt }) {
  const gbp = (p) => `£${(p / 100).toFixed(p % 100 ? 2 : 0)}`;
  const when = new Date(effectiveAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const subject = `Your Donna Drive ${planName} price is changing`;
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p>Hi ${escapeHtml((name || "").split(" ")[0] || "there")},</p>
      <p>From <strong>${when}</strong>, the ${escapeHtml(what)} on the ${escapeHtml(planName)} plan is changing from
      <strong>${gbp(fromAmount)}</strong> to <strong>${gbp(toAmount)}</strong> a month.</p>
      <p>You'll pay the new price from your first renewal after that date. Nothing changes before then, and you
      can cancel any time from Account → Manage Subscription.</p>
      <p>Thanks for using Donna Drive.</p>
    </div>
  `;
  return sendNotification(subject, html, null, to);
}

async function notifyNumberPoolEmpty(instructor) {
  const subject = "⚠️ Donna Drive: no WhatsApp numbers left in the pool";
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <p><strong>${escapeHtml(instructor?.name || "An instructor")}</strong> (${escapeHtml(instructor?.email || "")}) tried to get a WhatsApp number, but none are available.</p>
      <p>Add numbers with <code>POST /api/admin/phone-numbers</code>, then let them know.</p>
    </div>
  `;
  return sendNotification(subject, html, "number_pool_empty");
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
  OUTBOX_DIR,
  htmlToText,
  outboxEnabled,
  sendPriceChangeNotice,
  sendNotification,
  notifyInvalidGrant,
  notifyInstructorReauth,
  notifyInstructorLearnerMessage,
  sendSchoolInvite,
  sendContactRequest,
  escapeHtml,
  notifyNumberPoolEmpty,
  clearCooldowns,
  resetTransporter,
};
