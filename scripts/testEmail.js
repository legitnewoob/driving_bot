/**
 * Test Email Notification — Manual Script
 * ─────────────────────────────────────────
 * Sends a real test email to verify your Gmail App Password setup.
 *
 * Usage:
 *   node scripts/testEmail.js
 *
 * Required env vars (in your .env or envs/.env.development):
 *   NOTIFY_EMAIL_USER  - Gmail address to send from
 *   NOTIFY_EMAIL_PASS  - Gmail App Password (16 chars)
 *   NOTIFY_EMAIL_TO    - Recipient email (your personal Gmail)
 */

require("dotenv").config();
// Also try loading from envs/.env.development if present
const path = require("path");
const fs = require("fs");
const devEnv = path.join(__dirname, "..", "envs", ".env.development");
if (fs.existsSync(devEnv)) {
  require("dotenv").config({ path: devEnv, override: true });
}

const { sendNotification, notifyInvalidGrant, clearCooldowns } = require("../src/utils/emailNotifier");

async function main() {
  const user = process.env.NOTIFY_EMAIL_USER;
  const pass = process.env.NOTIFY_EMAIL_PASS;
  const to = process.env.NOTIFY_EMAIL_TO || user;

  console.log("\n📧 Email Notification Test");
  console.log("─────────────────────────");
  console.log(`  From: ${user || "(not set)"}`);
  console.log(`  Pass: ${pass ? "***" + pass.slice(-4) : "(not set)"}`);
  console.log(`  To:   ${to || "(not set)"}`);
  console.log();

  if (!user || !pass) {
    console.error("❌ Missing NOTIFY_EMAIL_USER or NOTIFY_EMAIL_PASS in environment.");
    console.error("   Set them in your .env or envs/.env.development file.");
    process.exit(1);
  }

  // Clear any cooldowns so we can send multiple tests
  clearCooldowns();

  // ── Test 1: Simple notification ──────────────────────────────────────
  console.log("1️⃣  Sending simple test email...");
  const r1 = await sendNotification(
    "✅ Test Email — Driving Bot",
    `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #2e7d32;">✅ Email Notifications Working!</h2>
        <p>This is a test email from your Driving Bot.</p>
        <p>If you can see this, email notifications are correctly configured.</p>
        <table style="border-collapse: collapse; width: 100%; margin: 16px 0;">
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">Sent at</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${new Date().toISOString()}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">From</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${user}</td></tr>
          <tr><td style="padding: 8px; border: 1px solid #ddd; font-weight: bold;">To</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${to}</td></tr>
        </table>
        <p style="color: #999; font-size: 11px;">This is a test notification from scripts/testEmail.js</p>
      </div>
    `
  );
  console.log(r1 ? "   ✅ Sent successfully!" : "   ❌ Failed to send.");

  // ── Test 2: Simulated invalid_grant alert ────────────────────────────
  console.log("\n2️⃣  Sending simulated invalid_grant alert...");
  const r2 = await notifyInvalidGrant(
    {
      name: "Test Instructor",
      phoneNumberId: "000000000",
      phone: "447700000001",
      email: "test@example.com",
    },
    "Calendar",
    "Error: invalid_grant — Token has been expired or revoked."
  );
  console.log(r2 ? "   ✅ Sent successfully!" : "   ❌ Failed to send.");

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("\n─────────────────────────");
  if (r1 && r2) {
    console.log("✅ All emails sent! Check your inbox at:", to);
  } else {
    console.log("⚠️  Some emails failed. Check the output above.");
  }
  console.log();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
