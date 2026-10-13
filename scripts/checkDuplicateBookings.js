/**
 * Finds data that would stop the new unique booking indexes from building:
 *   - two bookings with the same bookingId
 *   - two active (confirmed/rescheduled) bookings in the same instructor slot
 *
 * Usage:
 *   node scripts/checkDuplicateBookings.js          # report only
 *   node scripts/checkDuplicateBookings.js --fix    # give duplicate bookingIds new ids
 *
 * Slot clashes are only reported: deciding which lesson to keep is a human call.
 */
require("../src/config/env");
const mongoose = require("mongoose");
const { customAlphabet } = require("nanoid");
const Booking = require("../src/models/bookingModel");

const newId = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);

async function main() {
  const fix = process.argv.includes("--fix");
  await mongoose.connect(process.env.MONGO_URI, process.env.DB_NAME ? { dbName: process.env.DB_NAME } : {});

  const idDupes = await Booking.aggregate([
    { $group: { _id: "$bookingId", ids: { $push: "$_id" }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(`Duplicate bookingIds: ${idDupes.length}`);
  for (const d of idDupes) {
    console.log(`  ${d._id}: ${d.count} bookings`);
    if (fix) {
      for (const _id of d.ids.slice(1)) {
        const replacement = `DL-${newId()}`;
        await Booking.updateOne({ _id }, { bookingId: replacement });
        console.log(`    renamed ${_id} → ${replacement}`);
      }
    }
  }

  const slotDupes = await Booking.aggregate([
    { $match: { status: { $in: ["confirmed", "rescheduled"] } } },
    {
      $group: {
        _id: { instructorId: "$instructorId", date: "$date", time: "$time" },
        bookings: { $push: { bookingId: "$bookingId", userPhone: "$userPhone" } },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
  ]);
  console.log(`Double-booked slots: ${slotDupes.length}`);
  for (const d of slotDupes) {
    console.log(`  ${d._id.instructorId} ${d._id.date} ${d._id.time}: ${d.bookings.map((b) => `${b.bookingId} (${b.userPhone})`).join(", ")}`);
  }
  if (slotDupes.length) console.log("Cancel or move one booking in each slot, then restart the server so the index builds.");

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
