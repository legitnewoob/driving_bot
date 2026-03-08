const User = require("../models/userModel");
const whatsappService = require("../services/whatsappService");
const mapsService = require("../services/mapsService");

const steps = ["name", "age", "dob", "postalCode"];

// sendFn defaults to real WhatsApp — in mock mode, pass this._send.bind(this)
async function ensureUserDetails(from, messageContent, sendFn = null) {
  const send = sendFn || ((to, text) => whatsappService.sendTextMessage(to, text));

  // Handle data deletion request
  if (messageContent && messageContent.trim().toLowerCase() === "delete my data") {
    await User.deleteOne({ phone: from });
    await send(from, "🗑️ Your data has been deleted.");
    return { inProgress: true, deleted: true };
  }

  let user = await User.findOne({ phone: from });

  // If new user → start flow
  if (!user) {
    user = new User({ phone: from, currentStep: steps[0] });
    await user.save();
    await send(from, "👋 Hi! Let's get started.\nPlease tell me your *name*:");
    return { inProgress: true };
  }

  // If user details already complete
  if (user.detailsCompleted) return { inProgress: false, user };

  const currentStep = user.currentStep;

  // Save current step answer
  if (messageContent && !steps.includes(messageContent.toLowerCase())) {
    user[currentStep] = messageContent.trim();
    const nextIndex = steps.indexOf(currentStep) + 1;
    user.currentStep = steps[nextIndex] || null;

    // ✅ If user just finished last step
    if (!user.currentStep) {
      user.detailsCompleted = true;

      // ✅ Fetch and save coordinates
      try {
        const { lat, lng, message } = await mapsService.getCoordinatesFromPostalCode(user.postalCode);
        user.location = { latitude: lat, longitude: lng };
        await send(from, message);
      } catch (err) {
        console.error("❌ Error getting coordinates:", err.message);
        await send(from, "⚠️ Couldn't fetch your location from the postal code.");
      }

      await user.save();
      await send(from, "✅ Thanks! Your details are saved. You can now manage bookings freely.");
      return { inProgress: false, user, justCompleted: true };
    }

    await user.save();
  }

  // Ask next question
  if (user.currentStep) {
    await send(from, `Please provide your *${user.currentStep}*`);
  }

  return { inProgress: true };
}

module.exports = { ensureUserDetails };