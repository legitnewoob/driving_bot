#!/usr/bin/env node
/**
 * Generate (or rotate) an API key for an instructor.
 *
 * Usage:
 *   node scripts/generateApiKey.js <instructorPhoneNumberId>
 *
 * The key is printed to stdout so it can be copied into the Portal's .env.
 */

const crypto = require("crypto");
const path = require("path");

// Load env before anything else
require("../src/config/env");

const connectDB = require("../src/config/database");
const Instructor = require("../src/models/instructorSchema");

async function main() {
  const id = process.argv[2];
  if (!id) {
    console.error("Usage: node scripts/generateApiKey.js <instructorPhoneNumberId>");
    process.exit(1);
  }

  await connectDB();

  const instructor = await Instructor.findOne({ phoneNumberId: id });
  if (!instructor) {
    console.error(`Instructor with phoneNumberId "${id}" not found.`);
    process.exit(1);
  }

  const apiKey = `ddp_${crypto.randomBytes(24).toString("hex")}`;
  const hashedKey = crypto.createHash("sha256").update(apiKey).digest("hex");
  instructor.apiKey = hashedKey;
  await instructor.save();

  console.log(`\nAPI key generated for ${instructor.name} (${id}):\n`);
  console.log(`  ${apiKey}\n`);
  console.log("Add this to the Portal's .env file:");
  console.log(`  VITE_INSTRUCTOR_API_KEY=${apiKey}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
