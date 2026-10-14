/**
 * Pre-dev hook — runs before `npm run dev`.
 *
 * If SEED_ON_DEV=true in your .env, this drops and re-seeds
 * Bookings, Payments, Users & ChatLogs with clean dev data.
 *
 * Set SEED_ON_DEV=false (or remove it) to skip seeding.
 */

require("../src/config/env");
const path = require("path");

const seedOnDev = (process.env.SEED_ON_DEV || "").trim().toLowerCase();

if (seedOnDev === "true" || seedOnDev === "1") {
  console.log("🌱 SEED_ON_DEV is enabled — resetting dev database...\n");
  const { execSync } = require("child_process");
  try {
    execSync("node scripts/seedDevData.js --force", {
      cwd: path.join(__dirname, ".."),
      stdio: "inherit",
    });
  } catch (err) {
    console.error("❌ Pre-dev seed failed:", err.message);
    process.exit(1);
  }
} else {
  console.log("⏭️  SEED_ON_DEV is not enabled — skipping database seed.");
}
