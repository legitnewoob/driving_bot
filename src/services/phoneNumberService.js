const mongoose = require("mongoose");
const PhoneNumber = require("../models/phoneNumberModel");
const Instructor = require("../models/instructorSchema");
const { invalidateInstructorCache } = require("../models/instructorModel");

// Everything stored per instructor is keyed by their phoneNumberId, which changes
// when a number is assigned (from a temporary signup_… id) or revoked. Move it
// along so lesson types, learners, bookings etc. created before aren't orphaned.
const KEYED_BY_INSTRUCTOR = [
  "../models/lessonTypeModel",
  "../models/bookingModel",
  "../models/userModel",
  "../models/paymentModel",
  "../models/notificationModel",
  "../models/waitlistEntryModel",
  "../models/conversationSessionModel",
];

async function moveInstructorData(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return;
  for (const path of KEYED_BY_INSTRUCTOR) {
    const Model = require(path);
    await Model.updateMany({ instructorId: fromId }, { $set: { instructorId: toId } });
  }
}

async function assignNumber(instructorId, { region = "GB" } = {}) {
  const existing = await PhoneNumber.findOne({ assignedTo: instructorId, status: "assigned" }).lean();
  if (existing) return existing;

  const claim = (filter) =>
    PhoneNumber.findOneAndUpdate(
      { status: "available", ...filter },
      { status: "assigned", assignedTo: instructorId, assignedAt: new Date() },
      { new: true, sort: { createdAt: 1 } }
    );
  // Prefer the instructor's region, but any free number beats none
  const phoneNumber = (await claim({ region })) || (await claim({}));

  if (!phoneNumber) return null;

  const instructor = await Instructor.findById(instructorId).lean();
  const updateFields = {
    phoneNumberId: phoneNumber.phoneNumberId,
    phone: phoneNumber.phoneNumber,
  };
  // The weekly refresh keeps the pool's token current; the env token is only a fallback
  const token = phoneNumber.whatsappToken || process.env.WHATSAPP_TOKEN;
  if (token) updateFields.whatsappToken = token;

  await Instructor.findByIdAndUpdate(instructorId, updateFields);
  await moveInstructorData(instructor?.phoneNumberId, phoneNumber.phoneNumberId);
  if (instructor?.phoneNumberId) invalidateInstructorCache(instructor.phoneNumberId);
  invalidateInstructorCache(phoneNumber.phoneNumberId);

  return phoneNumber;
}

async function getAssignedNumber(instructorId) {
  return PhoneNumber.findOne({ assignedTo: instructorId, status: "assigned" }).lean();
}

async function revokeNumber(phoneNumberDocId) {
  const phoneNumber = await PhoneNumber.findById(phoneNumberDocId);
  if (!phoneNumber || phoneNumber.status !== "assigned") return null;

  const instructorId = phoneNumber.assignedTo;
  const oldPhoneNumberId = phoneNumber.phoneNumberId;

  phoneNumber.status = "available";
  phoneNumber.assignedTo = null;
  phoneNumber.assignedAt = null;
  await phoneNumber.save();

  if (instructorId) {
    const placeholderId = `signup_${new mongoose.Types.ObjectId()}`;
    await Instructor.findByIdAndUpdate(instructorId, {
      phoneNumberId: placeholderId,
      whatsappToken: null,
    });
    await moveInstructorData(oldPhoneNumberId, placeholderId);
    invalidateInstructorCache(oldPhoneNumberId);
  }

  return phoneNumber;
}

async function addToPool(numbers) {
  const docs = numbers.map(n => ({
    phoneNumber: n.phoneNumber,
    phoneNumberId: n.phoneNumberId,
    whatsappToken: n.whatsappToken || null,
    label: n.label || null,
    region: n.region || "GB",
    status: "available",
  }));
  return PhoneNumber.insertMany(docs, { ordered: false });
}

function isFullyProvisioned(instructor) {
  return instructor.phoneNumberId && !instructor.phoneNumberId.startsWith("signup_");
}

module.exports = { assignNumber, getAssignedNumber, revokeNumber, addToPool, isFullyProvisioned, moveInstructorData };
