/**
 * Seed script to add an instructor to the database.
 *
 * Usage:
 *   node scripts/seedInstructor.js
 *
 * Reads from environment variables (or edit the defaults below).
 * Run once per instructor you want to register.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Instructor = require("../src/models/instructorSchema");

async function seed() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGO_URI or MONGODB_URI env var is required");
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");

  // ── Instructor data ───────────────────────────────────────────────────
  // Edit these values or pass them via env vars before running.
  const data = {
    phoneNumberId: process.env.PHONE_NUMBER_ID || "CHANGE_ME",
    phone: process.env.INSTRUCTOR_PHONE || "",
    name: process.env.INSTRUCTOR_NAME || "Default Instructor",
    email: process.env.INSTRUCTOR_EMAIL || "instructor@example.com",
    googleCalendarId: process.env.INSTRUCTOR_EMAIL || "instructor@example.com",
    googleRefreshToken: process.env.GOOGLE_REFRESH_TOKEN || "CHANGE_ME",
    whatsappToken: process.env.WHATSAPP_TOKEN || "CHANGE_ME",
    spreadsheetId: process.env.GOOGLE_SPREADSHEET_ID || "",
    availableTimes: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
    specialties: ["Basic driving", "Highway driving", "Parking", "City driving"],
    baseLocation: {
      latitude: parseFloat(process.env.LATITUDE_DEFAULT) || 53.0168046,
      longitude: parseFloat(process.env.LONGITUDE_DEFAULT) || -2.2190649,
    },
    rates: { basic: 50, highway: 60, parking: 45 },
    timezone: process.env.APP_TIMEZONE || "Europe/London",
    active: true,
  };

  // Upsert: update if exists, create if not
  const result = await Instructor.findOneAndUpdate(
    { phoneNumberId: data.phoneNumberId },
    data,
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(`\nInstructor upserted:`);
  console.log(`  Name:           ${result.name}`);
  console.log(`  Phone:          ${result.phone || "(not set)"}`);
  console.log(`  PhoneNumberId:  ${result.phoneNumberId}`);
  console.log(`  CalendarId:     ${result.googleCalendarId}`);
  console.log(`  Base Location:  (${result.baseLocation.latitude}, ${result.baseLocation.longitude})`);
  console.log(`  Active:         ${result.active}`);
  console.log(`  ID:             ${result._id}`);

  await mongoose.disconnect();
  console.log("\nDone.");
}

seed().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
