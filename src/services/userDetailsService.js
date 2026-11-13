const User = require("../models/userModel");
const whatsappService = require("../services/whatsappService");
const mapsService = require("../services/mapsService");
const logger = require("../utils/logger-advanced");
const { parseName, parseAge, parsePostcode } = require("../utils/learnerDetails");

// Asked in this order; a step that's already filled in (e.g. added in the Portal) is skipped
const steps = ["name", "age", "postalCode"];
const DELETE_CONFIRM_MS = 10 * 60 * 1000;

const firstName = (user) => String(user.name || "").split(" ")[0];

const questions = {
  name: () => "What's your *full name*?",
  age: (user) => `Thanks${firstName(user) ? `, ${firstName(user)}` : ""}! How *old* are you?`,
  postalCode: () => "And what's your *postcode*? (e.g. ST5 1AB)",
};

const UNDER_AGE =
  "Thanks! You need to be 17 to have driving lessons on the road (16 if you get the enhanced rate of PIP mobility), " +
  "so I can't book you in just yet. Message me again when you're old enough 🚗";
const SIXTEEN_NOTE =
  "Just so you know, lessons on the road start at 17 unless you get the enhanced rate of PIP mobility. Your instructor can talk it through with you.";

// Under the first message, so learners know who runs the service
const POWERED_BY = "_Powered by Donna Drive · donnadrive.co.uk_";

const nextMissing = (user) => steps.find((s) => user[s] == null || user[s] === "") || null;

// sendFn defaults to real WhatsApp — in mock mode, pass this._send.bind(this)
async function ensureUserDetails(from, messageContent, sendFn = null, instructorId = null, greeting = "") {
  const send = sendFn || ((to, text) => whatsappService.sendTextMessage(to, text));
  const text = String(messageContent || "").trim();
  const query = { phone: from, ...(instructorId && { instructorId }) };

  // Data deletion: ask first, delete on YES
  if (/^delete my data[.!]?$/i.test(text)) {
    const existing = await User.findOne(query);
    if (!existing) {
      await send(from, "I don't have any details saved for you.");
      return { inProgress: true };
    }
    existing.deleteRequestedAt = new Date();
    await existing.save();
    await send(
      from,
      "Are you sure? This deletes your name, age, postcode and preferences.\n\nReply *YES* to delete them, or anything else to keep them."
    );
    return { inProgress: true };
  }

  let user = await User.findOne(query);

  if (user?.deleteRequestedAt) {
    const recent = Date.now() - new Date(user.deleteRequestedAt).getTime() < DELETE_CONFIRM_MS;
    if (recent && /^(yes|y|yes please|confirm|delete)[.!]?$/i.test(text)) {
      await User.deleteOne(query);
      await send(from, "🗑️ Your data has been deleted.");
      return { inProgress: true, deleted: true };
    }
    user.deleteRequestedAt = null;
    await user.save();
    if (recent) await send(from, "OK, I've kept your details.");
  }

  // New number → start sign-up
  if (!user) {
    user = new User({ ...query, instructorId, currentStep: steps[0] });
    try {
      await user.save();
    } catch (err) {
      // Two messages at once: the other one already started sign-up. Anything
      // else refused as a duplicate is a real problem, so don't hide it
      if (err.code === 11000 && (await User.findOne(query))) return { inProgress: true };
      logger.error(`Couldn't create learner ${from} for ${instructorId}: ${err.message}`);
      throw err;
    }
    const intro = greeting?.trim() ? greeting.trim() : "👋 Hi! Let's get started.";
    await send(from, `${intro}\nI just need 3 quick details to get you set up.\n\n${questions.name(user)}\n\n${POWERED_BY}`);
    return { inProgress: true };
  }

  if (user.detailsCompleted) return { inProgress: false, user };

  // Not on a question we ask (older sign-ups at date of birth, Portal adds):
  // move to the first missing detail and ask it, without using this message
  if (!steps.includes(user.currentStep)) {
    user.currentStep = nextMissing(user);
    if (!user.currentStep) return finish(user, from, send);
    await user.save();
    await send(from, questions[user.currentStep](user));
    return { inProgress: true };
  }

  const step = user.currentStep;
  let note = "";
  let address = null;

  if (step === "name") {
    const { value } = parseName(text);
    if (!value) {
      await send(from, "Sorry, I didn't catch your name 🙂 Please send just your first and last name, e.g. *Jordan Smith*.");
      return { inProgress: true };
    }
    user.name = value;
  }

  if (step === "age") {
    const { value, error } = parseAge(text);
    if (error === "too_young") {
      await send(from, UNDER_AGE);
      return { inProgress: true };
    }
    if (error) {
      await send(from, "Please send your age as a number, e.g. *18*.");
      return { inProgress: true };
    }
    user.age = value;
    if (value === 16) note = `${SIXTEEN_NOTE}\n\n`;
  }

  if (step === "postalCode") {
    const { value } = parsePostcode(text);
    if (!value) {
      await send(from, "That doesn't look like a UK postcode. Please send it like *ST5 1AB*.");
      return { inProgress: true };
    }
    try {
      const { lat, lng, formattedAddress } = await mapsService.getCoordinatesFromPostalCode(value);
      user.location = { latitude: lat, longitude: lng };
      address = formattedAddress;
    } catch (err) {
      if (/ZERO_RESULTS/.test(err.message)) {
        await send(from, `I couldn't find *${value}*. Could you check it and send it again?`);
        return { inProgress: true };
      }
      // Maps is down or misconfigured: don't hold the learner up over it
      logger.error(`Error getting coordinates for ${value}: ${err.message}`);
    }
    user.postalCode = value;
  }

  user.currentStep = nextMissing(user);
  if (!user.currentStep) return finish(user, from, send, note, address);

  await user.save();
  await send(from, `${note}${questions[user.currentStep](user)}`);
  return { inProgress: true };
}

async function finish(user, from, send, note = "", address = null) {
  user.currentStep = null;
  user.detailsCompleted = true;
  await user.save();
  const name = firstName(user);
  await send(from, `${note}✅ Thanks${name ? ` ${name}` : ""}, you're all set!${address ? `\n📍 ${address}` : ""}`);
  return { inProgress: false, user, justCompleted: true };
}

module.exports = { ensureUserDetails };
