/**
 * Says sorry to waitlist people whose invite went out by mistake (and was taken
 * back with scripts/revertInvites.js). Only emails people still "waiting".
 *
 * Usage (reads MONGO_URI from the environment, else driving_bot/.env):
 *   node scripts/sendInviteApology.js --db <name> --emails a@x.com,b@y.com           # report only
 *   node scripts/sendInviteApology.js --db <name> --emails ... --send <name>          # send
 */
const path = require("path");

async function main() {
  require("dotenv").config({ path: path.join(__dirname, "../.env") });
  const mongoose = require("mongoose");
  const { sendInviteApology } = require("../src/utils/waitlistEmails");

  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
  };
  const dbName = arg("--db");
  const send = arg("--send");
  const emails = (arg("--emails") || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!dbName || !emails.length) throw new Error("Pass --db <name> and --emails a,b,c");
  if (send && send !== dbName) throw new Error("--send must repeat the --db name");

  await mongoose.connect(process.env.MONGO_URI, { dbName });
  const entries = await mongoose.connection.db.collection("launchsignups").find({ email: { $in: emails } }).toArray();
  const ok = entries.filter((e) => e.status === "waiting" && !e.unsubscribedAt);
  for (const e of emails) {
    const found = entries.find((x) => x.email === e);
    const why = !found ? "not on the waitlist" : found.status !== "waiting" ? `status is "${found.status}"` : found.unsubscribedAt ? "unsubscribed" : null;
    console.log(`${why ? "skip" : "send"}  ${e}${why ? `  (${why})` : `  (${found.name})`}`);
  }
  if (!send) {
    console.log(`\nNothing sent. To send: node scripts/sendInviteApology.js --db ${dbName} --emails ${emails.join(",")} --send ${dbName}`);
    await mongoose.disconnect();
    return;
  }
  let sent = 0;
  for (const e of ok) if (await sendInviteApology(e)) sent++;
  console.log(`\n✅ Sent ${sent} of ${ok.length}`);
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
