/**
 * Generate (or rotate) an API key for an instructor, used by the dashboard
 * to authenticate against /api/learners.
 *
 * Usage:
 *   node scripts/generateApiKey.js <phoneNumberId>
 */

require("dotenv").config();
const mongoose = require("mongoose");
const { nanoid } = require("nanoid");
const Instructor = require("../src/models/instructorSchema");

async function run() {
  const phoneNumberId = process.argv[2];
  if (!phoneNumberId) {
    console.error("Usage: node scripts/generateApiKey.js <phoneNumberId>");
    process.exit(1);
  }

  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGO_URI or MONGODB_URI env var is required");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  const apiKey = nanoid(32);

  const instructor = await Instructor.findOneAndUpdate(
    { phoneNumberId },
    { apiKey },
    { new: true }
  );

  if (!instructor) {
    console.error(`No instructor found with phoneNumberId: ${phoneNumberId}`);
    process.exit(1);
  }

  console.log(`\nAPI key generated for ${instructor.name}:`);
  console.log(`  ${apiKey}`);

  await mongoose.disconnect();
  console.log("\nDone.");
}

run().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
