/**
 * Start fresh: remove every customer and their data from one database, keeping
 * staff accounts (super admins, admins, support) and app settings.
 *
 * Deleted: instructors (except staff), schools, school invites, learners, bookings,
 * payments, chat logs, conversation sessions, lesson types, notifications,
 * learner waitlist entries, launch waitlist (and its counter), contact requests,
 * one-time sign-in codes.
 * Changed: WhatsApp numbers held by deleted instructors go back to the pool;
 * kept staff lose any school link.
 * Kept: staff accounts, plans, prices, sales, promo codes, settings (launch mode),
 * the number pool, audit log, processed Stripe/WhatsApp event ids.
 * Stripe: live subscriptions of deleted customers are cancelled (needs STRIPE_SECRET_KEY).
 *
 * --to-waitlist: before removing them, put every customer who ever signed up
 * (active or deleted, one place per email, earliest sign-up first) on the launch
 * waitlist, quietly (no email). Their accounts and data still go, so they come
 * back in through an invite like everyone else.
 *
 * Usage (reads MONGO_URI / STRIPE_SECRET_KEY from the environment, else driving_bot/.env):
 *   node scripts/resetCustomers.js --db <name> [--to-waitlist]                    # report only
 *   node scripts/resetCustomers.js --db <name> [--to-waitlist] --confirm <name>   # do it (backup first)
 */
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "../.env") });
const mongoose = require("mongoose");
const { EJSON } = require("bson");

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const dbName = arg("--db");
const confirm = arg("--confirm");
const REAL = !!confirm;
const TO_WAITLIST = process.argv.includes("--to-waitlist");

/** One waitlist place per person, earliest sign-up first. */
function waitlistFrom(removed) {
  const people = new Map();
  for (const i of removed) {
    const email = String((i.deletedAt ? i.deletedIdentity?.email : i.email) || "").trim().toLowerCase();
    if (!email || email.endsWith(".invalid") || SUPER_ADMINS.includes(email)) continue;
    const name = (i.deletedAt ? i.deletedIdentity?.name : i.name) || email.split("@")[0];
    const type = i.schoolRole === "owner" || i.plan === "driving-school" ? "school" : i.plan === "adi" ? "adi" : i.plan === "pdi" ? "pdi" : null;
    const at = i.createdAt ? new Date(i.createdAt) : new Date();
    const prev = people.get(email);
    // Their earliest sign-up sets their place; a non-deleted account's details win
    if (!prev) people.set(email, { email, name, type, at, active: !i.deletedAt });
    else {
      if (at < prev.at) prev.at = at;
      if (!i.deletedAt && !prev.active) Object.assign(prev, { name, type, active: true });
    }
  }
  return [...people.values()].sort((a, b) => a.at - b.at);
}

function referralCode(name, taken) {
  const base = String(name || "").toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "").slice(0, 8) || "dd";
  for (;;) {
    const code = base + crypto.randomBytes(2).toString("hex").slice(0, 3);
    if (!taken.has(code)) {
      taken.add(code);
      return code;
    }
  }
}

const SUPER_ADMINS = (process.env.SUPER_ADMIN_EMAILS || "agrawalraj918@gmail.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// Whole collections emptied (customer data)
const WIPE = [
  "schools",
  "schoolinvites",
  "users",
  "bookings",
  "payments",
  "chatlogs",
  "conversationsessions",
  "lessontypes",
  "notifications",
  "waitlistentries",
  "launchsignups",
  "authcodes",
];
const crypto = require("crypto");
const LIVE_SUBSCRIPTION = ["active", "trialing", "past_due", "unpaid", "incomplete"];

async function main() {
  if (!dbName) throw new Error("Give the database: --db <name>");
  if (REAL && confirm !== dbName) throw new Error(`--confirm must repeat the database name exactly (${dbName})`);
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");

  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const host = mongoose.connection.host;
  const existing = new Set((await db.listCollections().toArray()).map((c) => c.name));

  console.log(`\n${REAL ? "🧹 RESET" : "🔍 REPORT ONLY (nothing is changed)"}: database "${dbName}" on ${host}`);
  const allDbs = await db.admin().listDatabases().then((r) => r.databases.map((d) => d.name)).catch(() => null);
  if (allDbs) console.log(`Databases on this cluster: ${allDbs.join(", ")}`);
  if (!existing.has("instructors")) {
    console.log(`\n⚠️  "${dbName}" has no instructors collection. Wrong database name?`);
  }

  // Who stays
  const instructors = await db.collection("instructors").find({}).toArray();
  const isStaff = (i) =>
    (i.staffRole === "admin" || i.staffRole === "support" || SUPER_ADMINS.includes(String(i.email || "").toLowerCase())) && i.active !== false;
  const keep = instructors.filter(isStaff);
  const remove = instructors.filter((i) => !isStaff(i));

  const latest = instructors.map((i) => i.createdAt).filter(Boolean).sort((a, b) => b - a)[0];
  console.log(`\nInstructors: ${instructors.length} (active ${instructors.filter((i) => i.active).length}, deleted ${instructors.filter((i) => i.deletedAt).length}); newest sign-up ${latest ? new Date(latest).toISOString().slice(0, 10) : "—"}`);
  console.log(`  Keep (staff): ${keep.map((i) => `${i.email} [${i.staffRole || "super admin"}]`).join(", ") || "none"}`);
  console.log(`  Delete: ${remove.length}`);
  for (const i of remove.slice(0, 40)) {
    const who = i.deletedAt ? `(deleted) ${i.deletedIdentity?.email || ""}` : i.email;
    console.log(`    - ${who} | ${i.plan || "?"}${i.schoolRole ? ` ${i.schoolRole}` : ""} | ${i.subscriptionStatus || "no subscription"}`);
  }
  if (remove.length > 40) console.log(`    … and ${remove.length - 40} more`);

  // Stripe
  const toCancel = remove.filter((i) => i.subscriptionId && LIVE_SUBSCRIPTION.includes(i.subscriptionStatus));
  const stripeKey = process.env.STRIPE_SECRET_KEY || "";
  const stripeMode = stripeKey.startsWith("sk_live") || stripeKey.startsWith("rk_live") ? "LIVE" : stripeKey ? "test" : "none";
  console.log(`\nStripe subscriptions to cancel: ${toCancel.length} (Stripe key here: ${stripeMode})`);
  for (const i of toCancel) console.log(`    - ${i.email} ${i.subscriptionId} (${i.subscriptionStatus})`);

  // Counts
  console.log("\nCollections emptied:");
  for (const name of WIPE) {
    const n = existing.has(name) ? await db.collection(name).countDocuments() : 0;
    console.log(`  ${name.padEnd(22)} ${n}`);
  }
  const removeIds = remove.map((i) => i._id);
  const heldNumbers = existing.has("phonenumbers") ? await db.collection("phonenumbers").countDocuments({ assignedTo: { $in: removeIds } }) : 0;
  console.log(`WhatsApp numbers returned to the pool: ${heldNumbers}`);
  console.log("Kept: plans, prices, sales, promo codes, settings, number pool, audit log, contact-us messages.");

  const queue = TO_WAITLIST ? waitlistFrom(remove) : [];
  if (TO_WAITLIST) {
    console.log(`\nMoved to the waitlist (quietly, no email), in this order:`);
    queue.forEach((p, n) => console.log(`  #${n + 1} ${p.email} | ${p.name} | ${p.type || "?"} | first signed up ${p.at.toISOString().slice(0, 10)}${p.active ? "" : " (account was deleted)"}`));
  }

  if (!REAL) {
    console.log(`\nNothing changed. To do it: node scripts/resetCustomers.js --db ${dbName}${TO_WAITLIST ? " --to-waitlist" : ""} --confirm ${dbName}\n`);
    return;
  }

  if (toCancel.length && stripeMode === "none") {
    throw new Error("There are live subscriptions but no STRIPE_SECRET_KEY: cancel them first, or set the key. Nothing was changed.");
  }

  // Backup first: everything that's about to change
  const dir = path.join(__dirname, "../backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `reset-${dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  const backup = { db: dbName, host, at: new Date().toISOString(), instructors: remove, phonenumbers: [] };
  for (const name of WIPE) backup[name] = existing.has(name) ? await db.collection(name).find({}).toArray() : [];
  if (existing.has("phonenumbers")) backup.phonenumbers = await db.collection("phonenumbers").find({ assignedTo: { $in: removeIds } }).toArray();
  backup.keptStaff = keep;
  fs.writeFileSync(file, EJSON.stringify(backup, { relaxed: false }));
  console.log(`\n💾 Backup: ${file}`);

  // Stripe cancellations (before any data goes, so a failure stops the run)
  if (toCancel.length) {
    const stripe = new (require("stripe"))(stripeKey);
    for (const i of toCancel) {
      try {
        await stripe.subscriptions.cancel(i.subscriptionId);
        console.log(`   ✅ Cancelled ${i.subscriptionId} (${i.email})`);
      } catch (err) {
        if (err.code === "resource_missing" || /No such subscription|already been canceled|canceled subscription/i.test(err.message)) {
          console.log(`   ↪︎ ${i.subscriptionId} already gone`);
        } else {
          throw new Error(`Stripe cancel failed for ${i.email} (${i.subscriptionId}): ${err.message}. Stopped before deleting anything.`);
        }
      }
    }
  }

  if (existing.has("phonenumbers")) {
    const r = await db.collection("phonenumbers").updateMany(
      { assignedTo: { $in: removeIds } },
      { $set: { status: "available", assignedTo: null, assignedAt: null } }
    );
    console.log(`   📱 Released ${r.modifiedCount} numbers`);
  }
  for (const name of WIPE) {
    if (!existing.has(name)) continue;
    const r = await db.collection(name).deleteMany({});
    console.log(`   🗑️  ${name}: ${r.deletedCount}`);
  }
  const ri = await db.collection("instructors").deleteMany({ _id: { $in: removeIds } });
  console.log(`   🗑️  instructors: ${ri.deletedCount}`);
  if (keep.length) {
    await db.collection("instructors").updateMany(
      { _id: { $in: keep.map((i) => i._id) } },
      { $set: { schoolId: null, schoolRole: null } }
    );
  }
  if (existing.has("counters")) await db.collection("counters").deleteOne({ _id: "launchSignup" });

  if (queue.length) {
    const taken = new Set();
    const now = new Date();
    await db.collection("launchsignups").insertMany(
      queue.map((p, n) => ({
        email: p.email,
        name: p.name,
        type: p.type,
        schoolSize: null,
        area: "",
        currentTool: [],
        marketingConsent: false,
        position: n + 1,
        referralCode: referralCode(p.name, taken),
        referredBy: null,
        referrals: 0,
        priority: false,
        source: { landingPath: "moved-from-account" },
        status: "waiting",
        invite: { tokenHash: null, sentAt: null, expiresAt: null, remindedAt: null, usedAt: null, promoCode: null, by: null },
        instructorId: null,
        accessToken: crypto.randomBytes(24).toString("hex"),
        emails: { confirmationSentAt: null, movedUpAt: null, launchSentAt: null },
        unsubscribedAt: null,
        createdAt: p.at,
        updatedAt: now,
      }))
    );
    await db.collection("counters").updateOne({ _id: "launchSignup" }, { $set: { seq: queue.length } }, { upsert: true });
    console.log(`   📋 Added ${queue.length} people to the waitlist`);
  }
  if (existing.has("auditlogs")) {
    await db.collection("auditlogs").insertOne({
      actor: "script",
      action: "customers.reset",
      target: dbName,
      details: { deletedInstructors: ri.deletedCount, movedToWaitlist: queue.length, keptStaff: keep.map((i) => i.email), cancelledSubscriptions: toCancel.length, backup: path.basename(file) },
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  console.log(`\n✅ Done. ${dbName} now has ${keep.length} staff account(s) and no customers.\n`);
}

main()
  .catch((err) => {
    console.error(`\n❌ ${err.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
