/**
 * Gives lesson types and bookings their own length, for mixed-length lessons.
 *
 * For each instructor:
 * - Lesson types without a length: the first (by sort order) gets the
 *   instructor's old single lesson length; the rest are switched off and
 *   named "(needs a length)" so the instructor picks one on the dashboard
 *   (two active types can't share a length).
 * - The default lessons (Beginner 2h, Moderate 1.5h, Novice 1h) are added for
 *   any length and name they don't have yet.
 * - Bookings without a length get their lesson type's length, else the
 *   instructor's old single length, so existing lessons keep their real length.
 *
 * Usage (reads MONGO_URI from the environment, else driving_bot/.env):
 *   node scripts/migrateLessonDurations.js --db <name>                    # report only
 *   node scripts/migrateLessonDurations.js --db <name> --confirm <name>   # do it (backup first)
 */
const path = require("path");
const fs = require("fs");

const DEFAULTS = [
  { name: "Beginner", durationMin: 120, price: 80, description: "" },
  { name: "Moderate", durationMin: 90, price: 60, description: "" },
  { name: "Novice", durationMin: 60, price: 40, description: "" },
];
const NEEDS_LENGTH = " (needs a length)";

const idOf = (v) => String(v?._id ?? v);

/**
 * What to change, worked out without touching the database.
 * instructors: [{ phoneNumberId, routeSettings }], lessonTypes, bookings: plain docs.
 */
function planMigration({ instructors, lessonTypes, bookings }) {
  const typeUpdates = []; // { _id, set }
  const newTypes = [];
  const bookingUpdates = []; // { _id, durationMin }
  const lengthOfType = new Map();

  for (const inst of instructors) {
    const id = inst.phoneNumberId;
    if (!id) continue;
    const fallback = inst.routeSettings?.lessonDurationMin || 60;
    const types = lessonTypes
      .filter((t) => t.instructorId === id)
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));

    const taken = new Set(types.filter((t) => t.active !== false && t.durationMin).map((t) => t.durationMin));
    types.filter((t) => t.durationMin).forEach((t) => lengthOfType.set(idOf(t), t.durationMin));

    for (const t of types.filter((x) => !x.durationMin)) {
      if (t.active !== false && !taken.has(fallback)) {
        typeUpdates.push({ _id: t._id, set: { durationMin: fallback } });
        taken.add(fallback);
        lengthOfType.set(idOf(t), fallback);
      } else if (t.active !== false) {
        typeUpdates.push({ _id: t._id, set: { active: false, name: `${t.name}${NEEDS_LENGTH}`.slice(0, 60) } });
      }
    }

    const names = new Set(types.map((t) => t.name.toLowerCase()));
    let sortOrder = types.reduce((max, t) => Math.max(max, t.sortOrder ?? 0), -1) + 1;
    for (const d of DEFAULTS) {
      if (taken.has(d.durationMin) || names.has(d.name.toLowerCase())) continue;
      newTypes.push({ ...d, instructorId: id, active: true, sortOrder: sortOrder++ });
      taken.add(d.durationMin);
    }

    for (const b of bookings.filter((x) => x.instructorId === id && !x.durationMin)) {
      const fromType = b.lessonTypeId ? lengthOfType.get(idOf(b.lessonTypeId)) : null;
      bookingUpdates.push({ _id: b._id, durationMin: fromType || fallback });
    }
  }
  return { typeUpdates, newTypes, bookingUpdates };
}

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
  if (!dbName) throw new Error("Pass --db <name>");
  if (confirm && confirm !== dbName) throw new Error("--confirm must repeat the --db name");

  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri, { dbName });
  const db = mongoose.connection.db;
  const host = mongoose.connection.host;
  console.log(`Database: ${dbName} on ${host}${confirm ? "" : " (report only)"}`);

  const instructors = await db.collection("instructors").find({}, { projection: { phoneNumberId: 1, routeSettings: 1, email: 1 } }).toArray();
  const lessonTypes = await db.collection("lessontypes").find({}).toArray();
  const bookings = await db.collection("bookings").find({ $or: [{ durationMin: null }, { durationMin: { $exists: false } }] }).toArray();

  const plan = planMigration({ instructors, lessonTypes, bookings });
  console.log(`Lesson types given a length: ${plan.typeUpdates.filter((u) => u.set.durationMin).length}`);
  console.log(`Lesson types switched off (need a length): ${plan.typeUpdates.filter((u) => u.set.active === false).length}`);
  console.log(`Default lesson types added: ${plan.newTypes.length}`);
  console.log(`Bookings given a length: ${plan.bookingUpdates.length}`);

  if (!confirm) {
    console.log(`\nNothing changed. To do it: node scripts/migrateLessonDurations.js --db ${dbName} --confirm ${dbName}\n`);
    await mongoose.disconnect();
    return;
  }

  const dir = path.join(__dirname, "../backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `lesson-durations-${dbName}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(file, EJSON.stringify({ db: dbName, host, at: new Date().toISOString(), lessonTypes, bookings }, { relaxed: false }));
  console.log(`\n💾 Backup: ${file}`);

  for (const u of plan.typeUpdates) await db.collection("lessontypes").updateOne({ _id: u._id }, { $set: u.set });
  if (plan.newTypes.length) {
    const now = new Date();
    await db.collection("lessontypes").insertMany(plan.newTypes.map((t) => ({ ...t, createdAt: now, updatedAt: now })));
  }
  for (const u of plan.bookingUpdates) await db.collection("bookings").updateOne({ _id: u._id }, { $set: { durationMin: u.durationMin } });
  // The unique "one active type per length" index
  await require("../src/models/lessonTypeModel").createIndexes();
  console.log("✅ Done");
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}

module.exports = { planMigration, DEFAULTS };
