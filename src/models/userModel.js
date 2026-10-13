const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  instructorId: { type: String, required: true },
  name: String,
  age: Number,
  dob: String,
  postalCode: String,
  detailsCompleted: { type: Boolean, default: false },
  currentStep: { type: String, default: null },
  location: {
    latitude: { type: Number },
    longitude: { type: Number }
  },
  instructorNotes: { type: String, default: "" },
  schedulingPrefs: {
    priority: { type: Boolean, default: false },
    maxAddedDriveMin: { type: Number, default: null },
    savedPlaces: {
      type: [{ label: String, address: String, latitude: Number, longitude: Number, _id: false }],
      default: [],
    },
    preferredDays: { type: [Number], default: [] },
    preferredTimes: { type: [String], default: [] },
    unavailable: {
      type: [{ days: [Number], from: String, to: String, _id: false }],
      default: [],
    },
    defaultLessonTypeId: { type: mongoose.Schema.Types.ObjectId, ref: "LessonType", default: null },
    maxLessonsPerWeek: { type: Number, default: null },
    donnaPaused: { type: Boolean, default: false },
  },

}, { timestamps: true });

userSchema.index({ phone: 1, instructorId: 1 }, { unique: true });

module.exports = mongoose.model("User", userSchema);