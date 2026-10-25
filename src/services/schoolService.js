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
    // Off until she can really work (setup, number, calendar), as on their own dashboard
    donnaEnabled: settings.resolveBotSettings(instructor).donnaEnabled && setup.ready,
    calendarExpired: setup.calendarExpired,
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

/**
 * The owner's live Stripe subscription, found in Stripe if our records missed it
 * (the webhook that saves it never arrived). Saves it, and updates `owner` too.
 */
async function recoverSubscription(owner) {
  if (owner.subscriptionId || !owner.stripeCustomerId || !process.env.STRIPE_SECRET_KEY) return owner.subscriptionId || null;
  const subs = await getStripe().subscriptions.list({ customer: owner.stripeCustomerId, status: "all", limit: 20 });
  const live = subs.data.find((s) => ["active", "trialing", "past_due"].includes(s.status));
  if (!live) return null;
  const trialEndsAt = live.trial_end ? new Date(live.trial_end * 1000) : null;
  await Instructor.findByIdAndUpdate(owner._id, { subscriptionId: live.id, subscriptionStatus: live.status, trialEndsAt });
  Object.assign(owner, { subscriptionId: live.id, subscriptionStatus: live.status, trialEndsAt });
  return live.id;
}

/** A comped Driving School plan (given free by an admin) that's still running. */
const compedSchool = (owner) =>
  owner?.comp?.plan === "driving-school" && (!owner.comp.until || new Date(owner.comp.until) > new Date());

/**
 * Owner without a subscription: Stripe Checkout to pay for seats. A comped school
 * pays only for the seats; otherwise it starts the plan with the seats.
 */
async function seatsCheckout(owner, requested) {
  const { school } = await requireSchool(owner, "school.billing", "Only the school owner can add seats");
  const extra = Number(requested);
  if (!Number.isInteger(extra) || extra < 1 || extra > MAX_EXTRA_SEATS) throw schoolError(`Extra seats must be a whole number from 1 to ${MAX_EXTRA_SEATS}`);
  if (await recoverSubscription(owner)) throw schoolError("Your subscription is active now. Refresh the page to add seats.", 409, { code: "HAS_SUBSCRIPTION" });

  const [plan, seatPrice] = await Promise.all([pricing.getPlan("driving-school"), pricing.ensureExtraSeatPrice()]);
  if (!seatPrice) throw schoolError("Adding seats isn't available right now. Please try again later.", 503);
  const seatsOnly = compedSchool(owner);
  if (!seatsOnly && !plan?.stripePriceId) throw schoolError("Adding seats isn't available right now. Please try again later.", 503);

  const stripe = getStripe();
  let customer = owner.stripeCustomerId;
  if (!customer) {
    customer = (await stripe.customers.create({ email: owner.email, name: owner.name, metadata: { instructorId: String(owner._id) } })).id;
    await Instructor.findByIdAndUpdate(owner._id, { stripeCustomerId: customer });
  }
  const base = (process.env.FRONTEND_URL || "http://localhost:8080").replace(/\/+$/, "");
  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer,
    line_items: [...(seatsOnly ? [] : [{ price: plan.stripePriceId, quantity: 1 }]), { price: seatPrice, quantity: extra }],
    success_url: `${base}/team?seats=added`,
    cancel_url: `${base}/team`,
    client_reference_id: String(owner._id),
    metadata: { plan: "driving-school", kind: "school-seats", schoolId: String(school._id), extraSeats: String(extra) },
  });
  return { url: session.url };
}

async function overview(instructor) {
  const school = await schoolFor(instructor);
  if (!school) return null;
  const isOwner = String(school.ownerId) === String(instructor._id);
  // Our records may have missed the owner's subscription: check with Stripe
  if (isOwner && !instructor.subscriptionId) await recoverSubscription(instructor).catch(() => null);
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
    // Owners can buy seats: make sure there's a price to buy them at
    isOwner ? pricing.ensureExtraSeatPrice().catch(() => null) : pricing.extraSeatPriceId(),
    pricing.getPlan("driving-school"),
  ]);

  const summaries = await Promise.all(members.map(memberSummary));
  const schoolDonnaOn = school.donnaEnabled !== false;

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
      // On the free trial, new seats are charged now; the monthly payment starts at the trial's end
      trialEndsAt: isOwner && instructor.subscriptionStatus === "trialing" ? instructor.trialEndsAt || null : null,
      // Why an owner can't add seats themselves (the page explains it)
      seatsUnavailable: !isOwner ? null : !instructor.subscriptionId ? "no_subscription" : !seatPrice ? "not_set_up" : null,
      // No subscription: seats are bought through checkout (a comped school pays for the seats only)
      seatsCheckout: isOwner && !instructor.subscriptionId ? (compedSchool(instructor) ? "seats_only" : "plan_and_seats") : null,
    },
    role: person.schoolRole,
    roleLabel: SCHOOL_ROLE_LABELS[person.schoolRole] || null,
    permissions: ["school.view", "school.invite", "school.remove", "school.viewAll", "school.billing", "school.roles", "school.rename", "school.donna"].filter((p) => can(person, p)),
    owner: owner ? { name: owner.name, email: owner.email } : null,
    // The school-wide switch: off stops Donna for every instructor
    donnaEnabled: schoolDonnaOn,
    seats,
    members: summaries.map((m) => ({ ...m, donnaEnabled: m.donnaEnabled && schoolDonnaOn })),
    invites: invites.map((i) => ({ id: String(i._id), email: i.email, sentAt: i.createdAt, expiresAt: i.expiresAt, link: inviteLink(i.token) })),
    onboarding: schoolOnboarding(seats, summaries),
  };
}

/**
 * A school is onboarded once at least one instructor has joined and set Donna up
 * completely (settings, WhatsApp number and calendar). The owner doesn't set Donna
 * up themselves.
 */
function schoolOnboarding(seats, members) {
  const ready = members.filter((m) => m.setup?.complete && m.phoneNumber && m.calendarConnected);
  const steps = {
    invited: seats.used > 0,
    joined: seats.members > 0,
    ready: ready.length > 0,
  };
  return { ...steps, complete: steps.joined && steps.ready, readyCount: ready.length };
}

/** The owner (or a manager) switches Donna on or off for the whole school. */
async function setSchoolDonna(requester, enabled) {
  const { school } = await requireSchool(requester, "school.donna", "Only the school owner or a manager can do that");
  await School.findByIdAndUpdate(school._id, { donnaEnabled: !!enabled });
  require("./donnaStatus").clearSchoolDonnaCache(school._id);
  await audit(requester.email, enabled ? "school.donna.on" : "school.donna.off", String(school._id));
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
    planSelected: true,
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
  const seatPrice = await pricing.ensureExtraSeatPrice().catch(() => null);

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
  await recoverSubscription(owner).catch(() => null);
  if (!owner.subscriptionId) throw schoolError("Start your Driving School subscription first, then add seats.", 409, { code: "NO_SUBSCRIPTION" });

  const stripe = getStripe();
  const subscription = await stripe.subscriptions.retrieve(owner.subscriptionId);
  const item = subscription.items.data.find((i) => pricing.isSeatItem(i, { ...plan, extraSeatPriceId: seatPrice }));

  // On the free trial nothing is billed yet, so new seats are paid for now (once),
  // and join the monthly payment from the first one after the trial. Removing a
  // seat during the trial just drops it from that payment.
  const onTrial = subscription.status === "trialing";
  const added = extra - (item ? item.quantity || 0 : 0);
  if (onTrial && added > 0) {
    await chargeSeatsNow(stripe, subscription, added, plan?.extraSeatAmount || 1000, school);
  }
  const proration = onTrial ? "none" : "create_prorations";

  if (item && extra === 0) {
    await stripe.subscriptionItems.del(item.id, { proration_behavior: proration });
  } else if (item) {
    await stripe.subscriptionItems.update(item.id, { quantity: extra, proration_behavior: proration });
  } else if (extra > 0) {
    await stripe.subscriptionItems.create({
      subscription: subscription.id,
      price: seatPrice,
      quantity: extra,
      proration_behavior: proration,
    });
  }

  await School.findByIdAndUpdate(school._id, { extraSeats: extra, seatLimit: included + extra });
  await audit(owner.email, "school.seats", String(school._id), { extraSeats: extra });
  return { extraSeats: extra, seatLimit: included + extra };
}

/**
 * Charge for seats added during the free trial, on the card given at checkout.
 * Throws (and charges nothing) if the payment doesn't go through.
 */
async function chargeSeatsNow(stripe, subscription, count, seatAmount, school) {
  const customer = typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;
  const invoice = await stripe.invoices.create({
    customer,
    collection_method: "charge_automatically",
    auto_advance: false,
    pending_invoice_items_behavior: "exclude",
    ...(subscription.default_payment_method && {
      default_payment_method: typeof subscription.default_payment_method === "string" ? subscription.default_payment_method : subscription.default_payment_method.id,
    }),
    description: `Extra instructor seat${count === 1 ? "" : "s"} during your free trial`,
    metadata: { schoolId: String(school._id), kind: "trial-seats" },
  });
  await stripe.invoiceItems.create({
    customer,
    invoice: invoice.id,
    amount: seatAmount * count,
    currency: "gbp",
    description: `${count} extra instructor seat${count === 1 ? "" : "s"} (free trial period)`,
  });
  try {
    await stripe.invoices.finalizeInvoice(invoice.id);
    await stripe.invoices.pay(invoice.id);
  } catch (err) {
    try {
      await stripe.invoices.voidInvoice(invoice.id);
    } catch { /* already gone */ }
    throw schoolError("We couldn't take the payment for the new seat. Check your card in Account → Billing and try again.", 402, { code: "SEAT_PAYMENT_FAILED" });
  }
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
/** One of the requester's instructors that they may make changes for (owner or manager). */
async function manageableInstructor(requester, instructorId) {
  if (!instructorId || String(instructorId) === String(requester._id)) return requester;
  if (!requester.schoolId || !can(requester, "school.manage")) return null;
  return Instructor.findOne({ _id: instructorId, schoolId: requester.schoolId, schoolRole: { $in: SEAT_ROLES }, active: true }).lean();
}

/** Every learner across the school's instructors, with whose learner they are. */
async function schoolLearners(requester) {
  const { school } = await requireSchool(requester, "school.viewAll", "Only the school owner or a manager can see all learners");
  const members = await Instructor.find({ schoolId: school._id, schoolRole: { $in: SEAT_ROLES }, active: true }).lean();
  const { learnerSummaries } = require("./learnerSummary");
  const lists = await Promise.all(
    members.map(async (m) =>
      (await learnerSummaries(m)).map((l) => ({ ...l, instructor: { id: String(m._id), name: m.name } }))
    )
  );
  return lists.flat();
}

async function viewableInstructor(requester, instructorId) {
  if (!instructorId || String(instructorId) === String(requester._id)) return requester;
  if (can(requester, "admin.view")) return Instructor.findOne({ _id: instructorId }).lean().catch(() => null);
  if (!requester.schoolId || !can(requester, "school.viewAll")) return null;
  return Instructor.findOne({ _id: instructorId, schoolId: requester.schoolId, schoolRole: { $in: SEAT_ROLES }, active: true }).lean();
}

module.exports = {
  requireSchool,
  setSchoolDonna,
  manageableInstructor,
  schoolLearners,
  seatsCheckout,
  recoverSubscription,
  schoolOnboarding,
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
