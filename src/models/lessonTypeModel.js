const mongoose = require("mongoose");

const lessonTypeSchema = new mongoose.Schema({
  instructorId: { type: String, required: true },
  name: { type: String, required: true },
  price: { type: Number, required: true },
  description: { type: String, default: "" },
  active: { type: Boolean, default: true },
  sortOrder: { type: Number, default: 0 },
}, { timestamps: true });

lessonTypeSchema.index({ instructorId: 1, sortOrder: 1 });

module.exports = mongoose.model("LessonType", lessonTypeSchema);
