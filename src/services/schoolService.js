const crypto = require("crypto");
const School = require("../models/schoolModel");
const SchoolInvite = require("../models/schoolInviteModel");
const Instructor = require("../models/instructorSchema");
const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const PhoneNumber = require("../models/phoneNumberModel");
const { getSetupStatus } = require("./setupStatus");
const phoneNumberService = require("./phoneNumberService");
const settings = require("./instructorSettings");
const timezoneUtils = require("../utils/timezoneUtils");
const { invalidateInstructorCache } = require("../models/instructorModel");
const { can, SCHOOL_ROLE_LABELS } = require("./permissions");
const pricing = require("./pricingService");
const { audit } = require("./auditLog");

const INVITE_DAYS = 14;
const INCLUDED_SEATS = 3;      // default; admins can change it on the Driving School plan
const MAX_EXTRA_SEATS = 50;    // sanity cap
// Instructors in a school: plain instructors ("member") and managers both use a seat
const SEAT_ROLES = ["member", "manager"];
const getStripe = () => new (require("stripe"))(process.env.STRIPE_SECRET_KEY);
const ACTIVE = ["confirmed", "rescheduled", "completed"];

function schoolError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, userFacing: true }, extra);
}

/**
 * The school this instructor owns or belongs to. A driving-school plan owner
 * without a school yet gets one created on first use.
 */
async function schoolFor(instructor, { create = true } = {}) {
  if (instructor.schoolId) {
    const school = await School.findById(instructor.schoolId);
    if (school) return school;
  }
  if (!create || instructor.plan !== "driving-school" || SEAT_ROLES.includes(instructor.schoolRole)) return null;

  const school = await School.create({
    name: instructor.schoolName || `${(instructor.name || "My").split(" ")[0]}'s Driving School`,
    ownerId: instructor._id,
  });
  await Instructor.findByIdAndUpdate(instructor._id, { schoolId: school._id, schoolRole: "owner" });
  return school;
}

async function seatsUsed(school) {
  const [members, invites] = await Promise.all([
    Instructor.countDocuments({ schoolId: school._id, schoolRole: { $in: SEAT_ROLES }, active: true }),
    SchoolInvite.countDocuments({ schoolId: school._id, status: "pending", expiresAt: { $gt: new Date() } }),
  ]);
  return { members, invites, used: members + invites, limit: school.seatLimit };
}

function thisWeek() {
  const today = timezoneUtils.getCurrentDateString();
  const day = Number(timezoneUtils.formatDate(timezoneUtils.createDateInTimezone(today, "12:00"), "d"));
  const monday = timezoneUtils.addDays(today, -((day + 6) % 7));
  return { from: monday, to: timezoneUtils.addDays(monday, 6), today };
}

async function memberSummary(instructor) {
  const id = instructor.phoneNumberId;
  const week = thisWeek();
  const [setup, learners, lessonsThisWeek, upcoming] = await Promise.all([
    getSetupStatus(instructor),
    User.countDocuments({ instructorId: id, detailsCompleted: true }),
    Booking.countDocuments({ instructorId: id, status: { $in: ACTIVE }, date: { $gte: week.from, $lte: week.to } }),
    Booking.countDocuments({ instructorId: id, status: { $in: ["confirmed", "rescheduled"] }, date: { $gte: week.today } }),
  ]);
  return {
    id: String(instructor._id),
    name: instructor.name,
    email: instructor.email,
    role: instructor.schoolRole,
    roleLabel: SCHOOL_ROLE_LABELS[instructor.schoolRole] || null,
    phoneNumber: phoneNumberService.isFullyProvisioned(instructor) ? instructor.phone || null : null,
    calendarConnected: !!instructor.googleRefreshToken,
    donnaEnabled: settings.resolveBotSettings(instructor).donnaEnabled,
    setup,
    learners,
    lessonsThisWeek,
    upcomingLessons: upcoming,
    joinedAt: instructor.createdAt || null,
  };
}

/** Load the requester's school and check a permission; throws a 403 otherwise. */
async function requireSchool(instructor, permission, message = "You don't have permission to do that") {
  const school = await schoolFor(instructor, { create: permission === "school.invite" || permission === "school.view" });
  if (!school) throw schoolError("You're not part of a driving school", 404);
  // The school's owner is whoever the school says, whatever the instructor record claims
  const isOwner = String(school.ownerId) === String(instructor._id);
  const person = { ...instructor, schoolId: school._id, schoolRole: isOwner ? "owner" : instructor.schoolRole };
  if (!can(person, permission)) throw schoolError(message, 403);
  return { school, person, isOwner };
}

async function overview(instructor) {
  const school = await schoolFor(instructor);
  if (!school) return null;
  const isOwner = String(school.ownerId) === String(instructor._id);
  const person = { ...instructor, schoolId: school._id, schoolRole: isOwner ? "owner" : instructor.schoolRole };
  const seeTeam = can(person, "school.viewAll");
  const manageInvites = can(person, "school.invite");

  const [members, owner, seats, invites, included, seatPrice, plan] = await Promise.all([
    seeTeam ? Instructor.find({ schoolId: school._id, schoolRole: { $in: SEAT_ROLES }, active: true }).lean() : [],
    isOwner ? instructor : Instructor.findById(school.ownerId).lean(),
    seatsUsed(school),
    manageInvites
      ? SchoolInvite.find({ schoolId: school._id, status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 }).lean()
      : [],
    pricing.includedSeats(),
    pricing.extraSeatPriceId(),
    pricing.getPlan("driving-school"),
  ]);

  return {
    school: {
      id: String(school._id),
      name: school.name,
      seatLimit: school.seatLimit,
      includedSeats: included,
      extraSeats: school.extraSeats || 0,
      planAmount: plan?.amount ?? 2000,
      extraSeatAmount: plan?.extraSeatAmount ?? 1000,
      canBuySeats: !!seatPrice && !!(isOwner && instructor.subscriptionId),
    },
    role: person.schoolRole,
    roleLabel: SCHOOL_ROLE_LABELS[person.schoolRole] || null,
    permissions: ["school.view", "school.invite", "school.remove", "school.viewAll", "school.billing", "school.roles", "school.rename"].filter((p) => can(person, p)),
    owner: owner ? { name: owner.name, email: owner.email } : null,
    seats,
    members: await Promise.all(members.map(memberSummary)),
    invites: invites.map((i) => ({ id: String(i._id), email: i.email, sentAt: i.createdAt, expiresAt: i.expiresAt, link: inviteLink(i.token) })),
  };
}

function inviteLink(token) {
  const base = (process.env.FRONTEND_URL || process.env.DASHBOARD_URL || "http://localhost:8080").replace(/\/+$/, "");
  return `${base}/join/${token}`;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function invite(requester, rawEmail) {
  const { school } = await requireSchool(requester, "school.invite", "Only the school owner or a manager can invite instructors");

  const email = String(rawEmail || "").trim().toLowerCase();
  if (!EMAIL.test(email)) throw schoolError("Enter a valid email address");
  const schoolOwner = String(school.ownerId) === String(requester._id) ? requester : await Instructor.findById(school.ownerId).lean();
  if (schoolOwner && email === String(schoolOwner.email).toLowerCase()) {
    throw schoolError(schoolOwner === requester ? "You manage this school already, so you don't need a seat" : "That's the school owner, who doesn't need a seat");
  }

  const existingMember = await Instructor.findOne({ email, schoolId: school._id, schoolRole: { $in: SEAT_ROLES } }).lean();
  if (existingMember) throw schoolError(`${email} is already one of your instructors`);
  const pending = await SchoolInvite.findOne({ schoolId: school._id, email, status: "pending", expiresAt: { $gt: new Date() } });
  if (pending) return { invite: pending, link: inviteLink(pending.token), alreadySent: true };

  const seats = await seatsUsed(school);
  if (seats.used >= school.seatLimit) {
    throw schoolError(
      `All ${school.seatLimit} instructor seats are in use. Add a seat or remove an instructor to free one.`,
      409,
      { code: "SEATS_FULL" }
    );
  }

  const created = await SchoolInvite.create({
    schoolId: school._id,
    email,
    token: crypto.randomBytes(24).toString("hex"),
    expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000),
  });
  return { invite: created, link: inviteLink(created.token), school };
}

async function cancelInvite(requester, inviteId) {
  const { school } = await requireSchool(requester, "school.invite", "Only the school owner or a manager can do that");
  const updated = await SchoolInvite.findOneAndUpdate(
    { _id: inviteId, schoolId: school._id, status: "pending" },
    { status: "revoked" },
    { new: true }
  );
  if (!updated) throw schoolError("Invite not found", 404);
  return updated;
}

async function inviteInfo(token) {
  const invite = await SchoolInvite.findOne({ token }).lean();
  if (!invite || invite.status !== "pending" || invite.expiresAt < new Date()) return null;
  const school = await School.findById(invite.schoolId).lean();
  if (!school) return null;
  const owner = await Instructor.findById(school.ownerId).lean();
  return { schoolName: school.name, ownerName: owner?.name || null, email: invite.email, expiresAt: invite.expiresAt };
}

async function acceptInvite(instructor, token) {
  const invite = await SchoolInvite.findOne({ token });
  if (!invite || invite.status !== "pending" || invite.expiresAt < new Date()) {
    throw schoolError("This invite has expired or been cancelled. Ask your school for a new one.", 410);
  }
  if (String(instructor.email).toLowerCase() !== invite.email) {
    throw schoolError(`This invite is for ${invite.email}. Sign in with that Google account to join.`, 403, { code: "WRONG_ACCOUNT" });
  }
  const school = await School.findById(invite.schoolId);
  if (!school) throw schoolError("This school no longer exists", 410);
  if (instructor.schoolId && String(instructor.schoolId) !== String(school._id)) {
    throw schoolError("You're already part of another driving school", 409);
  }
  if (String(school.ownerId) === String(instructor._id)) throw schoolError("You own this school already", 409);

  // The invite itself holds a seat, so accepting can't go over the limit
  const owner = await Instructor.findById(school.ownerId).lean();
  await Instructor.findByIdAndUpdate(instructor._id, {
    schoolId: school._id,
    schoolRole: "member",
    plan: "driving-school",
    subscriptionStatus: owner?.subscriptionStatus || "active",
  });
  invite.status = "accepted";
  invite.acceptedBy = instructor._id;
  await invite.save();
  invalidateInstructorCache(instructor.phoneNumberId);
  return { schoolName: school.name, hadOwnSubscription: !!instructor.subscriptionId && ["active", "trialing"].includes(instructor.subscriptionStatus) };
}

async function removeMember(requester, memberId) {
  const { school, isOwner } = await requireSchool(requester, "school.remove", "Only the school owner or a manager can do that");
  const member = await Instructor.findOne({ _id: memberId, schoolId: school._id, schoolRole: { $in: SEAT_ROLES } });
  if (!member) throw schoolError("Instructor not found in your school", 404);
  if (String(member._id) === String(requester._id)) throw schoolError("You can't remove yourself. Ask the owner.", 400);
  // Managers can remove instructors, but only the owner can remove a manager
  if (member.schoolRole === "manager" && !isOwner) throw schoolError("Only the school owner can remove a manager", 403);

  // The school paid for their number; release it (their learners and history stay with them)
  const pn = await PhoneNumber.findOne({ assignedTo: member._id, status: "assigned" });
  if (pn) await phoneNumberService.revokeNumber(pn._id);

  await Instructor.findByIdAndUpdate(member._id, { schoolId: null, schoolRole: null, plan: "pdi", subscriptionStatus: null });
  invalidateInstructorCache(member.phoneNumberId);
  await audit(requester.email, "school.remove", member.email, { schoolId: String(school._id) });
  return { id: String(member._id), name: member.name };
}

/** Owner only: make an instructor a manager, or back to an instructor. */
async function setMemberRole(requester, memberId, role) {
  const { school } = await requireSchool(requester, "school.roles", "Only the school owner can change roles");
  const stored = { manager: "manager", instructor: "member", member: "member" }[role];
  if (!stored) throw schoolError("Role must be manager or instructor");
  const member = await Instructor.findOne({ _id: memberId, schoolId: school._id, schoolRole: { $in: SEAT_ROLES } });
  if (!member) throw schoolError("Instructor not found in your school", 404);
  await Instructor.findByIdAndUpdate(member._id, { schoolRole: stored });
  await audit(requester.email, "school.role", member.email, { from: member.schoolRole, to: stored, schoolId: String(school._id) });
  return { id: String(member._id), name: member.name, role: stored, roleLabel: SCHOOL_ROLE_LABELS[stored] };
}

/**
 * Set how many extra instructor seats (£10/month each) the school pays for, on
 * top of the 3 included. Updates the owner's Stripe subscription (prorated) and
 * the school's seat limit. Can't go below the seats already in use.
 */
async function setExtraSeats(owner, requested) {
  const { school } = await requireSchool(owner, "school.billing", "Only the school owner can change seats");
  const [included, plan] = await Promise.all([pricing.includedSeats(), pricing.getPlan("driving-school")]);
  const seatPrice = plan?.extraSeatPriceId || process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT;

  const extra = Number(requested);
  if (!Number.isInteger(extra) || extra < 0 || extra > MAX_EXTRA_SEATS) {
    throw schoolError(`Extra seats must be a whole number from 0 to ${MAX_EXTRA_SEATS}`);
  }
  const seats = await seatsUsed(school);
  if (included + extra < seats.used) {
    throw schoolError(
      `You're using ${seats.used} seats, so you need at least ${seats.used - included} extra. Remove an instructor or cancel an invite first.`,
      409,
      { code: "SEATS_IN_USE" }
    );
  }
  if (!seatPrice) throw schoolError("Adding seats isn't set up yet. Please contact support.", 503);
  if (!owner.subscriptionId) throw schoolError("Start your Driving School subscription first, then add seats.", 409, { code: "NO_SUBSCRIPTION" });

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(owner.subscriptionId);
  const item = subscription.items.data.find((i) => pricing.isSeatItem(i, { ...plan, extraSeatPriceId: seatPrice }));
  if (item && extra === 0) {
    await stripe.subscriptionItems.del(item.id, { proration_behavior: "create_prorations" });
  } else if (item) {
    await stripe.subscriptionItems.update(item.id, { quantity: extra, proration_behavior: "create_prorations" });
  } else if (extra > 0) {
    await stripe.subscriptionItems.create({
      subscription: subscription.id,
      price: seatPrice,
      quantity: extra,
      proration_behavior: "create_prorations",
    });
  }

  await School.findByIdAndUpdate(school._id, { extraSeats: extra, seatLimit: included + extra });
  await audit(owner.email, "school.seats", String(school._id), { extraSeats: extra });
  return { extraSeats: extra, seatLimit: included + extra };
}

/** Keep the seat limit in line with the Stripe subscription (e.g. changed in Stripe directly). */
async function syncSeatsFromSubscription(owner, subscription) {
  if (owner?.schoolRole !== "owner" || !owner.schoolId) return;
  const plan = await pricing.getPlan("driving-school");
  const seatPrice = plan?.extraSeatPriceId || process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT;
  if (!seatPrice) return;
  const item = subscription?.items?.data?.find((i) => pricing.isSeatItem(i, { ...plan, extraSeatPriceId: seatPrice }));
  const extra = item ? item.quantity || 0 : 0;
  const included = await pricing.includedSeats();
  await School.findByIdAndUpdate(owner.schoolId, { extraSeats: extra, seatLimit: included + extra });
}

/** Members' access follows the owner's subscription. */
async function syncMembersSubscription(owner) {
  if (owner?.schoolRole !== "owner" || !owner.schoolId) return;
  await Instructor.updateMany(
    { schoolId: owner.schoolId, schoolRole: { $in: SEAT_ROLES } },
    { $set: { subscriptionStatus: owner.subscriptionStatus } }
  );
}

/**
 * For read-only views: an instructor the requester may look at — themselves, an
 * instructor in their school (owner or manager), or anyone (Donna Drive staff).
 */
async function viewableInstructor(requester, instructorId) {
  if (!instructorId || String(instructorId) === String(requester._id)) return requester;
  if (can(requester, "admin.view")) return Instructor.findOne({ _id: instructorId }).lean().catch(() => null);
  if (!requester.schoolId || !can(requester, "school.viewAll")) return null;
  return Instructor.findOne({ _id: instructorId, schoolId: requester.schoolId, schoolRole: { $in: SEAT_ROLES }, active: true }).lean();
}

module.exports = {
  schoolFor,
  overview,
  invite,
  cancelInvite,
  inviteInfo,
  acceptInvite,
  removeMember,
  setMemberRole,
  requireSchool,
  SEAT_ROLES,
  syncMembersSubscription,
  syncSeatsFromSubscription,
  setExtraSeats,
  viewableInstructor,
  INCLUDED_SEATS,
  inviteLink,
};
