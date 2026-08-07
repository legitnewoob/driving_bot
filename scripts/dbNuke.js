/**
 * DB Nuke Script — drops the ENTIRE database.
 *
 * Usage:
 *   node scripts/dbNuke.js          # interactive confirmation
 *   node scripts/dbNuke.js --force  # skip confirmation
 */

require("../src/config/env");
const mongoose = require("mongoose");

async function run() {
  const force = process.argv.includes("--force");

  if (!force) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question("💀 This will DROP THE ENTIRE DATABASE. Are you sure? (y/N) ", resolve);
    });
    rl.close();
    if (answer.trim().toLowerCase() !== "y") {
      console.log("Aborted.");
      process.exit(0);
    }
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error("❌ MONGO_URI not set in .env");
    process.exit(1);
  }

  const opts = {};
  if (process.env.DB_NAME) opts.dbName = process.env.DB_NAME;

  await mongoose.connect(uri, opts);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`🔌 Connected to: ${dbName}`);

  await mongoose.connection.db.dropDatabase();
  console.log(`💀 Database "${dbName}" dropped.`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Nuke failed:", err.message);
  process.exit(1);
});
