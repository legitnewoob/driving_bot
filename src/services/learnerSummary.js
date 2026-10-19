// Each learner of an instructor at a glance: lessons, next lesson, what they've
// paid and owe. Used by the instructor's Learners page and the school-wide one.
const moment = require("moment-timezone");
const User = require("../models/userModel");
const Booking = require("../models/bookingModel");
const Payment = require("../models/paymentModel");
const timezoneUtils = require("../utils/timezoneUtils");

const DEFAULT_LESSON_RATE = parseFloat(process.env.DEFAULT_LESSON_RATE) || 50;

async function learnerSummaries(instructor) {
  const instructorId = instructor.phoneNumberId;
  const rate = instructor.rates?.basic || DEFAULT_LESSON_RATE;
  const today = moment.tz(getInstructorTimezone(instructor)).format("YYYY-MM-DD");

  const [users, bookings, payments] = await Promise.all([
    User.find({ instructorId }).lean(),
    Booking.find({ instructorId }).lean(),
    Payment.find({ instructorId }).lean(),
  ]);

  return users
    .filter((u) => u.detailsCompleted)
    .map((u) => {
      const userBookings = bookings.filter((b) => b.userPhone === u.phone);
      const userPayments = payments.filter((p) => p.userPhone === u.phone);

      const completed = userBookings.filter((b) => b.status === "completed");
      const lessonsCompleted = completed.length;

      const nextBooking = userBookings
        .filter((b) => b.date >= today && (b.status === "confirmed" || b.status === "rescheduled"))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))[0];

      const totalPaid = userPayments.reduce((sum, p) => sum + p.amount, 0);
      const totalCharged = completed.reduce((sum, b) => sum + (b.price ?? rate), 0);
      const outstanding = Math.max(0, totalCharged - totalPaid);
      // Paid ahead, e.g. a block of lessons bought upfront
      const credit = Math.max(0, totalPaid - totalCharged);

      let progressLevel = "new";
      if (lessonsCompleted >= 7) progressLevel = "test-ready";
      else if (lessonsCompleted > 0) progressLevel = "active";

      return {
        phone: u.phone,
        name: u.name || null,
        age: u.age || null,
        postalCode: u.postalCode || null,
        instructorNotes: u.instructorNotes || "",
        createdAt: u.createdAt || null,
        lessonsCompleted,
        nextLesson: nextBooking ? { date: nextBooking.date, time: nextBooking.time } : null,
        totalPaid,
        totalCharged,
        outstanding,
        credit,
        paymentStatus: outstanding <= 0 ? "paid" : "owes",
        progressLevel,
        priority: !!u.schedulingPrefs?.priority,
        donnaPaused: !!u.schedulingPrefs?.donnaPaused,
      };
    });
}

function getInstructorTimezone(instructor) {
  return instructor?.timezone || timezoneUtils.timezone || "Europe/London";
}

module.exports = { learnerSummaries };
