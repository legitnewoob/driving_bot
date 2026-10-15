const mongoose = require("mongoose");

// A message from the website's "Contact us" form. Kept even when the email to
// the team goes through, so nothing is lost if email delivery fails.
const contactRequestSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    message: { type: String, default: "", trim: true },
    emailed: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ContactRequest", contactRequestSchema);
