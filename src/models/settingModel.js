const mongoose = require("mongoose");

// App-wide settings changed from the admin panel (e.g. launch.mode), one document per key
const settingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
    by: { type: String, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Setting", settingSchema);
