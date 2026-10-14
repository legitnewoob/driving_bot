const Instructor = require("../models/instructorSchema");
const PhoneNumber = require("../models/phoneNumberModel");
const phoneNumberService = require("./phoneNumberService");
const { invalidateInstructorCache } = require("../models/instructorModel");
const logger = require("../utils/logger-advanced");
const { audit } = require("./auditLog");

/**
 * Delete an instructor's account. The record is kept (bookings and payments
 * point at it), but everything that ties it to the person is removed, so signing
 * in again with the same Google account starts a brand-new account.
 */
async function deleteAccount(instructor) {
  // Stop billing
  if (instructor.subscriptionId && process.env.STRIPE_SECRET_KEY) {
    try {
      const stripe = new (require("stripe"))(process.env.STRIPE_SECRET_KEY);
      await stripe.subscriptions.cancel(instructor.subscriptionId);
    } catch (err) {
      logger.warn(`Account deletion: couldn't cancel subscription ${instructor.subscriptionId}: ${err.message}`);
    }
  }

  // Release their WhatsApp number back to the pool
  if (phoneNumberService.isFullyProvisioned(instructor)) {
    const pn = await PhoneNumber.findOne({ assignedTo: instructor._id, status: "assigned" });
    if (pn) await phoneNumberService.revokeNumber(pn._id);
  }

  const id = String(instructor._id);
  const update = {
    $set: {
      active: false,
      deletedAt: new Date(),
      email: `deleted+${id}@deleted.donnadrive.invalid`,
      deletedIdentity: {
        email: String(instructor.email || "").toLowerCase() || null,
        name: instructor.name || null,
        googleId: instructor.googleId || null,
      },
      name: "Deleted account",
      subscriptionStatus: instructor.subscriptionId ? "canceled" : instructor.subscriptionStatus || null,
      // Leaving a school frees their seat
      schoolId: instructor.schoolRole === "owner" ? instructor.schoolId : null,
      schoolRole: instructor.schoolRole === "owner" ? "owner" : null,
      staffRole: null,
    },
    $unset: { googleId: 1, apiKey: 1, googleRefreshToken: 1, whatsappToken: 1, phone: 1, homeAddress: 1, baseAddress: 1 },
  };
  await Instructor.updateOne({ _id: instructor._id }, update);
  invalidateInstructorCache(instructor.phoneNumberId);
  await audit(instructor.email, "account.delete", instructor.email, { accountId: id, plan: instructor.plan });
  logger.info(`Account ${id} deleted`);
}

/** Earlier accounts this person deleted (matched by email or Google account). */
async function previousAccounts({ email, googleId }) {
  const or = [];
  if (email) or.push({ "deletedIdentity.email": String(email).toLowerCase() });
  if (googleId) or.push({ "deletedIdentity.googleId": googleId });
  if (!or.length) return [];
  const docs = await Instructor.find({ deletedAt: { $ne: null }, $or: or }, { _id: 1 }).lean();
  return docs.map((d) => d._id);
}

module.exports = { deleteAccount, previousAccounts };
