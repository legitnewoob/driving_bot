/**
 * Takes launch-waitlist invites back: everyone still "invited" (sent an invite,
 * not signed up yet) goes back to "waiting" at their old place in the queue, and
 * their invite link stops working. People who already signed up are untouched.
 *
 * Usage (reads MONGO_URI from the environment, else driving_bot/.env):
 *   node scripts/revertInvites.js                                         # list databases with a waitlist
 *   node scripts/revertInvites.js --db <name> --keep a@x.com,b@y.com      # report only
 *   node scripts/revertInvites.js --db <name> --keep ... --confirm <name> # do it (backup first)
 */
const path = require("path");
const fs = require("fs");

const CLEARED_INVITE = { tokenHash: null, sentAt: null, expiresAt: null, remindedAt: null, usedAt: null, promoCode: null, by: null };

async function main() {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  const mongoose = require("mongoose");
  const { EJSON } = require("bson");

  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
  };
  const dbName = arg("--db");
  const confirm = arg("--confirm");
  const keep = (arg("--keep") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (confirm && confirm !== dbName) throw new Error("--confirm must repeat the --db name");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");

  if (!dbName) {
    await mongoose.connect(uri);
    const { databases } = await mongoose.connection.db.admin().listDatabases();
    console.log("Databases with a launch waitlist:");
    for (const d of databases.filter((x) => !["admin", "local", "config"].includes(x.name))) {
      const db = mongoose.connection.client.db(d.name);
      const has = (await db.listCollections({ name: "launchsignups" }).toArray()).length;
      if (!has) continue;
      const invited = await db.collection("launchsignups").countDocuments({ status: "invited" });
      console.log(`  ${d.name}: ${invited} invited`);
    }
    await mongoose.disconnect();
    return;
  }

  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const host = mongoose.connection.host;
  console.log(`Database: ${dbName} on ${host}${confirm ? "" : " (report only)"}`);
  console.log(`Keeping: ${keep.length ? keep.join(", ") : "(nobody)"}\n`);

  const col = db.collection("launchsignups");
  const invited = await col.find({ status: "invited" }).sort({ position: 1 }).toArray();
  const kept = invited.filter((e) => keep.includes(e.email));
  const revert = invited.filter((e) => !keep.includes(e.email));
  const missing = keep.filter((e) => !invited.some((x) => x.email === e));

  console.log(`Invited now: ${invited.length}`);
  console.log(`Stay invited (${kept.length}): ${kept.map((e) => e.email).join(", ") || "-"}`);
  if (missing.length) {
    const other = await col.find({ email: { $in: missing } }, { projection: { email: 1, status: 1 } }).toArray();
    for (const e of missing) {
      const found = other.find((o) => o.email === e);
      console.log(`  note: ${e} is ${found ? `"${found.status}", not invited` : "not on the waitlist"}`);
    }
  }
  console.log(`Back to waiting (${revert.length}):`);
  for (const e of revert) {
    const sent = e.invite?.sentAt ? new Date(e.invite.sentAt).toISOString().slice(0, 10) : "?";
    console.log(`  #${e.position}  ${e.email}  (${e.name}, invited ${sent})`);
  }

  if (!confirm) {
    console.log(`\nNothing changed. To do it: node scripts/revertInvites.js --db ${dbName} --keep ${keep.join(",")} --confirm ${dbName}\n`);
    await mongoose.disconnect();
    return;
  }
  if (!revert.length) {
    console.log("\nNothing to do.");
    await mongoose.disconnect();
    return;
  }

  const dir = path.join(__dirname, "../backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `revert-invites-${dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, EJSON.stringify({ db: dbName, host, at: new Date().toISOString(), keep, entries: revert }, { relaxed: false }));
  console.log(`\n💾 Backup: ${file}`);

  // Only those still invited: anyone who signed up in the meantime is left alone
  const res = await col.updateMany(
    { _id: { $in: revert.map((e) => e._id) }, status: "invited" },
    { $set: { status: "waiting", invite: CLEARED_INVITE, updatedAt: new Date() } }
  );
  console.log(`✅ ${res.modifiedCount} moved back to waiting`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
