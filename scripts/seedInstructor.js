/**
 * Instructor Management CLI
 *
 * Usage:
 *   node scripts/seedInstructor.js add       # Add new instructor (interactive)
 *   node scripts/seedInstructor.js list      # List all instructors
 *   node scripts/seedInstructor.js update    # Update existing instructor
 *   node scripts/seedInstructor.js delete    # Delete instructor
 */

require("../src/config/env");
const { Command } = require("commander");
const inquirer = require("inquirer").default;
const mongoose = require("mongoose");
const Instructor = require("../src/models/instructorSchema");

const program = new Command();

// Validation helpers
function isValidEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function isValidPhone(phone) {
  if (!phone) return true; // Phone is optional
  const re = /^\+?[1-9]\d{1,14}$/;
  return re.test(phone.replace(/[\s-]/g, ""));
}

function isValidLatitude(value) {
  const num = parseFloat(value);
  return !isNaN(num) && Math.abs(num) <= 90;
}

function isValidLongitude(value) {
  const num = parseFloat(value);
  return !isNaN(num) && Math.abs(num) <= 180;
}

// Connect to MongoDB
async function connectDb() {
  const mongoUri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error("MONGO_URI or MONGODB_URI env var is required");
    process.exit(1);
  }
  await mongoose.connect(mongoUri);
  console.log("Connected to MongoDB");
}

// Format instructor for display
function formatInstructor(instructor) {
  return {
    ID: instructor._id.toString(),
    Name: instructor.name,
    Email: instructor.email,
    Phone: instructor.phone || "(not set)",
    "Phone Number ID": instructor.phoneNumberId,
    Active: instructor.active ? "Yes" : "No",
    Timezone: instructor.timezone,
  };
}

// List all instructors
async function listInstructors() {
  await connectDb();
  const instructors = await Instructor.find().sort({ name: 1 });

  if (instructors.length === 0) {
    console.log("\nNo instructors found.");
    await mongoose.disconnect();
    return;
  }

  console.log(`\nFound ${instructors.length} instructor(s):\n`);
  console.table(instructors.map(formatInstructor));

  await mongoose.disconnect();
}

// Add new instructor interactively
async function addInstructor() {
  await connectDb();

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "phoneNumberId",
      message: "WhatsApp Phone Number ID:",
      validate: (input) => input.trim() ? true : "Phone Number ID is required",
    },
    {
      type: "input",
      name: "phone",
      message: "Personal Phone Number (optional, for OAuth):",
      validate: (input) => {
        if (!input.trim()) return true;
        return isValidPhone(input) ? true : "Invalid phone number format";
      },
    },
    {
      type: "input",
      name: "name",
      message: "Instructor Name:",
      validate: (input) => input.trim() ? true : "Name is required",
    },
    {
      type: "input",
      name: "email",
      message: "Email:",
      validate: (input) => isValidEmail(input) ? true : "Invalid email format",
    },
    {
      type: "input",
      name: "googleCalendarId",
      message: "Google Calendar ID (email):",
      default: (answers) => answers.email,
      validate: (input) => isValidEmail(input) ? true : "Invalid email format",
    },
    {
      type: "password",
      name: "googleRefreshToken",
      message: "Google OAuth Refresh Token:",
      validate: (input) => input.trim() ? true : "Refresh token is required",
    },
    {
      type: "password",
      name: "whatsappToken",
      message: "WhatsApp Access Token:",
      validate: (input) => input.trim() ? true : "WhatsApp token is required",
    },
    {
      type: "input",
      name: "spreadsheetId",
      message: "Google Spreadsheet ID (optional):",
    },
    {
      type: "input",
      name: "latitude",
      message: "Base Location Latitude:",
      default: "53.0168046",
      validate: (input) => isValidLatitude(input) ? true : "Invalid latitude (must be between -90 and 90)",
    },
    {
      type: "input",
      name: "longitude",
      message: "Base Location Longitude:",
      default: "-2.2190649",
      validate: (input) => isValidLongitude(input) ? true : "Invalid longitude (must be between -180 and 180)",
    },
    {
      type: "input",
      name: "timezone",
      message: "Timezone:",
      default: "Europe/London",
    },
    {
      type: "confirm",
      name: "active",
      message: "Make instructor active?",
      default: true,
    },
    {
      type: "checkbox",
      name: "availableTimes",
      message: "Select available time slots:",
      choices: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"],
      default: ["09:00", "10:00", "11:00", "14:00", "15:00", "16:00"],
    },
    {
      type: "checkbox",
      name: "specialties",
      message: "Select specialties:",
      choices: ["Basic driving", "Highway driving", "Parking", "City driving", "Night driving", "Refresher lessons"],
      default: ["Basic driving", "Highway driving", "Parking", "City driving"],
    },
    {
      type: "number",
      name: "rateBasic",
      message: "Basic lesson rate (£):",
      default: 50,
    },
    {
      type: "number",
      name: "rateHighway",
      message: "Highway lesson rate (£):",
      default: 60,
    },
    {
      type: "number",
      name: "rateParking",
      message: "Parking lesson rate (£):",
      default: 45,
    },
  ]);

  const instructorData = {
    phoneNumberId: answers.phoneNumberId.trim(),
    phone: answers.phone.trim() || undefined,
    name: answers.name.trim(),
    email: answers.email.trim(),
    googleCalendarId: answers.googleCalendarId.trim(),
    googleRefreshToken: answers.googleRefreshToken.trim(),
    whatsappToken: answers.whatsappToken.trim(),
    spreadsheetId: answers.spreadsheetId.trim() || undefined,
    baseLocation: {
      latitude: parseFloat(answers.latitude),
      longitude: parseFloat(answers.longitude),
    },
    timezone: answers.timezone.trim(),
    active: answers.active,
    availableTimes: answers.availableTimes,
    specialties: answers.specialties,
    rates: {
      basic: answers.rateBasic,
      highway: answers.rateHighway,
      parking: answers.rateParking,
    },
  };

  // Check if phoneNumberId already exists
  const existing = await Instructor.findOne({ phoneNumberId: instructorData.phoneNumberId });
  if (existing) {
    console.error(`\nError: An instructor with Phone Number ID "${instructorData.phoneNumberId}" already exists.`);
    console.log("Use 'update' command to modify existing instructors.");
    await mongoose.disconnect();
    process.exit(1);
  }

  const result = await Instructor.create(instructorData);

  console.log("\n✓ Instructor created successfully:");
  console.log(`  Name:           ${result.name}`);
  console.log(`  Email:          ${result.email}`);
  console.log(`  Phone:          ${result.phone || "(not set)"}`);
  console.log(`  PhoneNumberId:  ${result.phoneNumberId}`);
  console.log(`  CalendarId:     ${result.googleCalendarId}`);
  console.log(`  Base Location:  (${result.baseLocation.latitude}, ${result.baseLocation.longitude})`);
  console.log(`  Active:         ${result.active}`);
  console.log(`  ID:             ${result._id}`);

  await mongoose.disconnect();
}

// Update existing instructor
async function updateInstructor() {
  await connectDb();
  const instructors = await Instructor.find().sort({ name: 1 });

  if (instructors.length === 0) {
    console.log("\nNo instructors found. Use 'add' command to create one.");
    await mongoose.disconnect();
    return;
  }

  const { selectedId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedId",
      message: "Select instructor to update:",
      choices: instructors.map((i) => ({
        name: `${i.name} (${i.email})`,
        value: i._id.toString(),
      })),
    },
  ]);

  const instructor = await Instructor.findById(selectedId);
  if (!instructor) {
    console.error("\nInstructor not found.");
    await mongoose.disconnect();
    return;
  }

  const answers = await inquirer.prompt([
    {
      type: "input",
      name: "phoneNumberId",
      message: "WhatsApp Phone Number ID:",
      default: instructor.phoneNumberId,
      validate: (input) => input.trim() ? true : "Phone Number ID is required",
    },
    {
      type: "input",
      name: "phone",
      message: "Personal Phone Number (optional, for OAuth):",
      default: instructor.phone || "",
      validate: (input) => {
        if (!input.trim()) return true;
        return isValidPhone(input) ? true : "Invalid phone number format";
      },
    },
    {
      type: "input",
      name: "name",
      message: "Instructor Name:",
      default: instructor.name,
      validate: (input) => input.trim() ? true : "Name is required",
    },
    {
      type: "input",
      name: "email",
      message: "Email:",
      default: instructor.email,
      validate: (input) => isValidEmail(input) ? true : "Invalid email format",
    },
    {
      type: "input",
      name: "googleCalendarId",
      message: "Google Calendar ID (email):",
      default: instructor.googleCalendarId,
      validate: (input) => isValidEmail(input) ? true : "Invalid email format",
    },
    {
      type: "password",
      name: "googleRefreshToken",
      message: "Google OAuth Refresh Token:",
      default: instructor.googleRefreshToken,
      validate: (input) => input.trim() ? true : "Refresh token is required",
    },
    {
      type: "password",
      name: "whatsappToken",
      message: "WhatsApp Access Token:",
      default: instructor.whatsappToken,
      validate: (input) => input.trim() ? true : "WhatsApp token is required",
    },
    {
      type: "input",
      name: "spreadsheetId",
      message: "Google Spreadsheet ID (optional):",
      default: instructor.spreadsheetId || "",
    },
    {
      type: "input",
      name: "latitude",
      message: "Base Location Latitude:",
      default: instructor.baseLocation.latitude.toString(),
      validate: (input) => isValidLatitude(input) ? true : "Invalid latitude (must be between -90 and 90)",
    },
    {
      type: "input",
      name: "longitude",
      message: "Base Location Longitude:",
      default: instructor.baseLocation.longitude.toString(),
      validate: (input) => isValidLongitude(input) ? true : "Invalid longitude (must be between -180 and 180)",
    },
    {
      type: "input",
      name: "timezone",
      message: "Timezone:",
      default: instructor.timezone,
    },
    {
      type: "confirm",
      name: "active",
      message: "Make instructor active?",
      default: instructor.active,
    },
    {
      type: "checkbox",
      name: "availableTimes",
      message: "Select available time slots:",
      choices: ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00"],
      default: instructor.availableTimes,
    },
    {
      type: "checkbox",
      name: "specialties",
      message: "Select specialties:",
      choices: ["Basic driving", "Highway driving", "Parking", "City driving", "Night driving", "Refresher lessons"],
      default: instructor.specialties,
    },
    {
      type: "number",
      name: "rateBasic",
      message: "Basic lesson rate (£):",
      default: instructor.rates.basic,
    },
    {
      type: "number",
      name: "rateHighway",
      message: "Highway lesson rate (£):",
      default: instructor.rates.highway,
    },
    {
      type: "number",
      name: "rateParking",
      message: "Parking lesson rate (£):",
      default: instructor.rates.parking,
    },
  ]);

  instructor.phoneNumberId = answers.phoneNumberId.trim();
  instructor.phone = answers.phone.trim() || undefined;
  instructor.name = answers.name.trim();
  instructor.email = answers.email.trim();
  instructor.googleCalendarId = answers.googleCalendarId.trim();
  instructor.googleRefreshToken = answers.googleRefreshToken.trim();
  instructor.whatsappToken = answers.whatsappToken.trim();
  instructor.spreadsheetId = answers.spreadsheetId.trim() || undefined;
  instructor.baseLocation = {
    latitude: parseFloat(answers.latitude),
    longitude: parseFloat(answers.longitude),
  };
  instructor.timezone = answers.timezone.trim();
  instructor.active = answers.active;
  instructor.availableTimes = answers.availableTimes;
  instructor.specialties = answers.specialties;
  instructor.rates = {
    basic: answers.rateBasic,
    highway: answers.rateHighway,
    parking: answers.rateParking,
  };

  await instructor.save();

  console.log("\n✓ Instructor updated successfully:");
  console.log(`  Name:           ${instructor.name}`);
  console.log(`  Email:          ${instructor.email}`);
  console.log(`  Phone:          ${instructor.phone || "(not set)"}`);
  console.log(`  PhoneNumberId:  ${instructor.phoneNumberId}`);
  console.log(`  CalendarId:     ${instructor.googleCalendarId}`);
  console.log(`  Base Location:  (${instructor.baseLocation.latitude}, ${instructor.baseLocation.longitude})`);
  console.log(`  Active:         ${instructor.active}`);
  console.log(`  ID:             ${instructor._id}`);

  await mongoose.disconnect();
}

// Delete instructor
async function deleteInstructor() {
  await connectDb();
  const instructors = await Instructor.find().sort({ name: 1 });

  if (instructors.length === 0) {
    console.log("\nNo instructors found.");
    await mongoose.disconnect();
    return;
  }

  const { selectedId } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedId",
      message: "Select instructor to delete:",
      choices: instructors.map((i) => ({
        name: `${i.name} (${i.email})`,
        value: i._id.toString(),
      })),
    },
  ]);

  const instructor = await Instructor.findById(selectedId);
  if (!instructor) {
    console.error("\nInstructor not found.");
    await mongoose.disconnect();
    return;
  }

  const { confirm } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirm",
      message: `Are you sure you want to delete "${instructor.name}"?`,
      default: false,
    },
  ]);

  if (!confirm) {
    console.log("\nDeletion cancelled.");
    await mongoose.disconnect();
    return;
  }

  await Instructor.findByIdAndDelete(selectedId);
  console.log(`\n✓ Instructor "${instructor.name}" deleted successfully.`);

  await mongoose.disconnect();
}

// Setup CLI commands
program
  .name("seedInstructor")
  .description("Instructor management CLI")
  .version("1.0.0");

program
  .command("add")
  .description("Add a new instructor interactively")
  .action(addInstructor);

program
  .command("list")
  .description("List all instructors")
  .action(listInstructors);

program
  .command("update")
  .description("Update an existing instructor")
  .action(updateInstructor);

program
  .command("delete")
  .description("Delete an instructor")
  .action(deleteInstructor);

// Default to add if no command specified
if (process.argv.length === 2) {
  program.parse(["node", "seedInstructor.js", "add"]);
} else {
  program.parse();
}
