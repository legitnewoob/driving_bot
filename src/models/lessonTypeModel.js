const mongoose = require("mongoose");

const lessonTypeSchema = new mongoose.Schema({
  instructorId: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  // Lesson length in minutes. Each active type has its own length, so the length
  // picks the type. Older types may have none until the instructor sets one.
  durationMin: { type: Number, default: null },
  description: { type: String, default: "" },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

lessonTypeSchema.index({ instructorId: 1, sortOrder: 1 });
// No two active lesson types of one instructor share a length
lessonTypeSchema.index(
  { instructorId: 1, durationMin: 1 },
  { unique: true, partialFilterExpression: { active: true, durationMin: { $type: "number" } } }
);

// The lessons every new instructor starts with (lengths in minutes, prices in £)
lessonTypeSchema.statics.DEFAULTS = [
  { name: "Beginner", durationMin: 120, price: 80, description: "" },
  { name: "Moderate", durationMin: 90, price: 60, description: "" },
  { name: "Novice", durationMin: 60, price: 40, description: "" },
];

module.exports = mongoose.model("LessonType", lessonTypeSchema);
