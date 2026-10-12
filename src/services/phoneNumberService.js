const mongoose = require("mongoose");
const PhoneNumber = require("../models/phoneNumberModel");
const Instructor = require("../models/instructorSchema");
const { invalidateInstructorCache } = require("../models/instructorModel");

async function assignNumber(instructorId, { region = "GB" } = {}) {
  const existing = await PhoneNumber.findOne({ assignedTo: instructorId, status: "assigned" }).lean();
  if (existing) return existing;

  const phoneNumber = await PhoneNumber.findOneAndUpdate(
    { status: "available", region },
    { status: "assigned", assignedTo: instructorId, assignedAt: new Date() },
    { new: true, sort: { createdAt: 1 } }
  );

  if (!phoneNumber) return null;

  const updateFields = {
    phoneNumberId: phoneNumber.phoneNumberId,
    phone: phoneNumber.phoneNumber,
  };
  if (phoneNumber.whatsappToken) {
    updateFields.whatsappToken = phoneNumber.whatsappToken;
  }

  await Instructor.findByIdAndUpdate(instructorId, updateFields);
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
    await Instructor.findByIdAndUpdate(instructorId, {
      phoneNumberId: `signup_${new mongoose.Types.ObjectId()}`,
      whatsappToken: null,
    });
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

module.exports = { assignNumber, getAssignedNumber, revokeNumber, addToPool, isFullyProvisioned };
