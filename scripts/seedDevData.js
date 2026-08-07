/**
 * Dev Database Seed / Reset Script
 *
 * Drops Bookings, Payments, Users, and ChatLogs collections,
 * then inserts clean dev seed data so the development environment
 * always starts in a usable state.
 *
 * Usage:
 *   node scripts/seedDevData.js          # interactive confirmation
 *   node scripts/seedDevData.js --force  # skip confirmation
 *
 * NOTE: This does NOT touch the Instructors collection.
 *       Use `npm run instructor:add` for that.
 */

require("../src/config/env");
const mongoose = require("mongoose");
const Booking = require("../src/models/bookingModel");
const Payment = require("../src/models/paymentModel");
const User = require("../src/models/userModel");
const Instructor = require("../src/models/instructorSchema");

// ─── Seed Data (functions so instructorId is injected at runtime) ────────────

function getUsers(INSTRUCTOR_ID) { return [
  { phone: "447712345678", instructorId: INSTRUCTOR_ID, name: "Sarah Mitchell", age: 22, dob: "2004-03-12", postalCode: "SW1A 1AA", detailsCompleted: true, location: { latitude: 51.5014, longitude: -0.1419 } },
  { phone: "447823456789", instructorId: INSTRUCTOR_ID, name: "James Okonkwo", age: 19, dob: "2007-06-08", postalCode: "E1 6AN", detailsCompleted: true, location: { latitude: 51.5155, longitude: -0.0722 } },
  { phone: "447934567890", instructorId: INSTRUCTOR_ID, name: "Emma Rhodes", age: 24, dob: "2002-01-20", postalCode: "N1 9GU", detailsCompleted: true, location: { latitude: 51.5362, longitude: -0.1033 } },
  { phone: "447745678901", instructorId: INSTRUCTOR_ID, name: "Tyler Patel", age: 20, dob: "2006-09-15", postalCode: "SE1 7PB", detailsCompleted: true, location: { latitude: 51.5045, longitude: -0.0865 } },
  { phone: "447856789012", instructorId: INSTRUCTOR_ID, name: "Chloe Bennett", age: 17, dob: "2009-04-03", postalCode: "W1D 3AF", detailsCompleted: true, location: { latitude: 51.5134, longitude: -0.1312 } },
  { phone: "447967890123", instructorId: INSTRUCTOR_ID, name: "Marcus Webb", age: 25, dob: "2001-11-28", postalCode: "EC2R 8AH", detailsCompleted: true, location: { latitude: 51.5139, longitude: -0.0831 } },
]; }

function futureDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function pastDate(daysAgo) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function getBookings(INSTRUCTOR_ID) { return [
  // Sarah Mitchell — mix of completed + upcoming
  { bookingId: "DL-S001", userPhone: "447712345678", instructorId: INSTRUCTOR_ID, date: pastDate(14), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Victoria Station" }, topicsCovered: ["Junctions", "Roundabouts"], rating: 4, progressNotes: "Excellent progress on roundabouts.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 14 * 86400000) },
  { bookingId: "DL-S002", userPhone: "447712345678", instructorId: INSTRUCTOR_ID, date: pastDate(7), time: "09:00", status: "completed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Hyde Park Corner" }, topicsCovered: ["Motorway", "Lane discipline"], rating: 4, progressNotes: "First motorway lesson. Handled merging well.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 7 * 86400000) },
  { bookingId: "DL-S003", userPhone: "447712345678", instructorId: INSTRUCTOR_ID, date: futureDate(3), time: "09:00", status: "confirmed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Trafalgar Square" } },
  { bookingId: "DL-S004", userPhone: "447712345678", instructorId: INSTRUCTOR_ID, date: futureDate(10), time: "14:00", status: "confirmed", postalCode: "SW1A 1AA", pickupLocation: { address: "Buckingham Palace Rd" }, dropoffLocation: { address: "Westminster Bridge" } },

  // James Okonkwo
  { bookingId: "DL-J001", userPhone: "447823456789", instructorId: INSTRUCTOR_ID, date: pastDate(10), time: "10:00", status: "completed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Mile End Rd" }, topicsCovered: ["Clutch control", "Hill starts"], rating: 3, progressNotes: "Clutch control improving. Hill starts still hesitant.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 10 * 86400000) },
  { bookingId: "DL-J002", userPhone: "447823456789", instructorId: INSTRUCTOR_ID, date: futureDate(5), time: "10:00", status: "confirmed", postalCode: "E1 6AN", pickupLocation: { address: "Whitechapel Rd" }, dropoffLocation: { address: "Stepney Green" } },

  // Emma Rhodes
  { bookingId: "DL-E001", userPhone: "447934567890", instructorId: INSTRUCTOR_ID, date: pastDate(21), time: "10:00", status: "completed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Angel Station" }, topicsCovered: ["Test prep", "Manoeuvres"], rating: 5, progressNotes: "All manoeuvres clean. Nearly test-ready.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 21 * 86400000) },
  { bookingId: "DL-E002", userPhone: "447934567890", instructorId: INSTRUCTOR_ID, date: futureDate(2), time: "10:00", status: "confirmed", postalCode: "N1 9GU", pickupLocation: { address: "Upper St" }, dropoffLocation: { address: "Highbury Corner" } },

  // Tyler Patel
  { bookingId: "DL-T001", userPhone: "447745678901", instructorId: INSTRUCTOR_ID, date: pastDate(5), time: "08:30", status: "completed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "London Bridge" }, topicsCovered: ["Town driving", "Roundabouts"], rating: 3, progressNotes: "Roundabouts improving. Stalled once — nerves.", paymentReceived: false, paymentAmount: 0, completedAt: new Date(Date.now() - 5 * 86400000) },
  { bookingId: "DL-T002", userPhone: "447745678901", instructorId: INSTRUCTOR_ID, date: futureDate(7), time: "08:30", status: "confirmed", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Elephant & Castle" } },
  { bookingId: "DL-T003", userPhone: "447745678901", instructorId: INSTRUCTOR_ID, date: pastDate(3), time: "14:00", status: "cancelled", postalCode: "SE1 7PB", pickupLocation: { address: "Borough High St" }, dropoffLocation: { address: "Bermondsey" } },

  // Chloe Bennett
  { bookingId: "DL-C001", userPhone: "447856789012", instructorId: INSTRUCTOR_ID, date: pastDate(8), time: "09:00", status: "completed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Regent St" }, topicsCovered: ["Clutch control", "Road positioning"], rating: 3, progressNotes: "Very first lesson. Great attitude.", paymentReceived: true, paymentAmount: 45, completedAt: new Date(Date.now() - 8 * 86400000) },
  { bookingId: "DL-C002", userPhone: "447856789012", instructorId: INSTRUCTOR_ID, date: futureDate(4), time: "09:00", status: "confirmed", postalCode: "W1D 3AF", pickupLocation: { address: "Oxford St" }, dropoffLocation: { address: "Tottenham Court Rd" } },

  // Marcus Webb
  { bookingId: "DL-M001", userPhone: "447967890123", instructorId: INSTRUCTOR_ID, date: pastDate(12), time: "09:00", status: "completed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Old St" }, topicsCovered: ["Parallel parking", "Bay parking"], rating: 3, progressNotes: "Bay parking solid. Parallel needs work.", paymentReceived: true, paymentAmount: 48, completedAt: new Date(Date.now() - 12 * 86400000) },
  { bookingId: "DL-M002", userPhone: "447967890123", instructorId: INSTRUCTOR_ID, date: futureDate(6), time: "11:30", status: "confirmed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Barbican" } },
  { bookingId: "DL-M003", userPhone: "447967890123", instructorId: INSTRUCTOR_ID, date: futureDate(13), time: "09:00", status: "confirmed", postalCode: "EC2R 8AH", pickupLocation: { address: "Moorgate" }, dropoffLocation: { address: "Liverpool St" } },
]; }

function getPayments(INSTRUCTOR_ID) { return [
  // Sarah — 2 lesson payments
  { paymentId: "PAY-DL-S001", instructorId: INSTRUCTOR_ID, userPhone: "447712345678", bookingId: "DL-S001", amount: 45, method: "cash", date: pastDate(14), note: "Received at lesson" },
  { paymentId: "PAY-DL-S002", instructorId: INSTRUCTOR_ID, userPhone: "447712345678", bookingId: "DL-S002", amount: 45, method: "bank", date: pastDate(7), note: "Received at lesson" },
  { paymentId: "PAY-S-BLOCK", instructorId: INSTRUCTOR_ID, userPhone: "447712345678", bookingId: null, amount: 120, method: "bank", date: pastDate(20), note: "Block of 4 lessons" },

  // James — 1 lesson payment
  { paymentId: "PAY-DL-J001", instructorId: INSTRUCTOR_ID, userPhone: "447823456789", bookingId: "DL-J001", amount: 45, method: "cash", date: pastDate(10), note: "Received at lesson" },

  // Emma — block payment
  { paymentId: "PAY-DL-E001", instructorId: INSTRUCTOR_ID, userPhone: "447934567890", bookingId: "DL-E001", amount: 48, method: "bank", date: pastDate(21), note: "Received at lesson" },
  { paymentId: "PAY-E-BLOCK", instructorId: INSTRUCTOR_ID, userPhone: "447934567890", bookingId: null, amount: 192, method: "bank", date: pastDate(25), note: "Block payment" },

  // Chloe — 1 lesson payment
  { paymentId: "PAY-DL-C001", instructorId: INSTRUCTOR_ID, userPhone: "447856789012", bookingId: "DL-C001", amount: 45, method: "cash", date: pastDate(8), note: "Received at lesson" },

  // Marcus — 1 lesson + block
  { paymentId: "PAY-DL-M001", instructorId: INSTRUCTOR_ID, userPhone: "447967890123", bookingId: "DL-M001", amount: 48, method: "cash", date: pastDate(12), note: "Received at lesson" },
  { paymentId: "PAY-M-BLOCK", instructorId: INSTRUCTOR_ID, userPhone: "447967890123", bookingId: null, amount: 128, method: "bank", date: pastDate(18), note: "Block payment" },
]; }

// ─── Main ────────────────────────────────────────────────────────────────────

async function run() {
  const force = process.argv.includes("--force");

  if (!force) {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => {
      rl.question("⚠️  This will DROP Bookings, Payments, Users & ChatLogs collections. Continue? (y/N) ", resolve);
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
  console.log("✅ Connected to MongoDB");
  console.log(`   URI: ${uri.replace(/\/\/.*@/, "//***:***@")}`);
  console.log(`   Database: ${mongoose.connection.name}`);
  console.log(`   Host: ${mongoose.connection.host}`);

  // Look up the instructor from DB to get the real phoneNumberId
  const instructor = await Instructor.findOne({ active: true }).lean();
  if (!instructor) {
    console.error("❌ No active instructor found in DB. Run 'npm run instructor:add' first.");
    await mongoose.disconnect();
    process.exit(1);
  }
  const INSTRUCTOR_ID = instructor.phoneNumberId;
  console.log(`   Instructor: ${instructor.name} (${INSTRUCTOR_ID})`);

  // Build seed data with the real instructor ID
  const USERS = getUsers(INSTRUCTOR_ID);
  const BOOKINGS = getBookings(INSTRUCTOR_ID);
  const PAYMENTS = getPayments(INSTRUCTOR_ID);

  // Drop collections (ignore errors if they don't exist)
  const drops = ["bookings", "payments", "users", "chatlogs"];
  for (const name of drops) {
    try {
      await mongoose.connection.db.dropCollection(name);
      console.log(`   🗑️  Dropped ${name}`);
    } catch {
      console.log(`   ⏭️  ${name} — doesn't exist, skipping`);
    }
  }

  // Insert seed data
  await User.insertMany(USERS);
  console.log(`   ✅ Inserted ${USERS.length} users`);

  await Booking.insertMany(BOOKINGS);
  console.log(`   ✅ Inserted ${BOOKINGS.length} bookings`);

  await Payment.insertMany(PAYMENTS);
  console.log(`   ✅ Inserted ${PAYMENTS.length} payments`);

  console.log("\n🎉 Dev database seeded successfully!");
  console.log(`   Instructor: ${instructor.name} (${INSTRUCTOR_ID})`);
  console.log(`   Users: ${USERS.length} | Bookings: ${BOOKINGS.length} | Payments: ${PAYMENTS.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(err => {
  console.error("❌ Seed script failed:", err.message);
  process.exit(1);
});
