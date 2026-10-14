const mongoose = require("mongoose");

// A driving school: an owner who manages it plus up to `seatLimit` instructors.
// Each instructor keeps their own Donna (number, settings, calendar, learners).
const schoolSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "Instructor", required: true, unique: true },
    // The owner doesn't use a seat; these are for the instructors they invite.
    // seatLimit = INCLUDED_SEATS (3, in the £20 plan) + extraSeats (£10/month each)
    seatLimit: { type: Number, default: 3 },
    extraSeats: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model("School", schoolSchema);
