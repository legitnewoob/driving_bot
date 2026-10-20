/**
 * Donna Drive admin panel: the business overview and customer management.
 */
const Instructor = require("../models/instructorSchema");
const School = require("../models/schoolModel");
const Booking = require("../models/bookingModel");
const User = require("../models/userModel");
const PhoneNumber = require("../models/phoneNumberModel");
const AuditLog = require("../models/auditLogModel");
const pricing = require("./pricingService");
const { getSetupStatus } = require("./setupStatus");
const { staffRoleOf, isSuperAdmin, superAdminEmails } = require("./permissions");
const { audit } = require("./auditLog");
const { invalidateInstructorCache } = require("../models/instructorModel");
const timezoneUtils = require("../utils/timezoneUtils");

const getStripe = () => new (require("stripe"))(process.env.STRIPE_SECRET_KEY);
const DAY = 86400000;
const SCHOOL_SEATS = ["member", "manager"];
const PAYING = ["active", "past_due"];

function adminError(message, status = 400) {
  return Object.assign(new Error(message), { status, userFacing: true });
}

const hasNumber = { phoneNumberId: { $not: /^signup_/ } };
const compActive = () => ({ "comp.plan": { $ne: null }, $or: [{ "comp.until": null }, { "comp.until": { $gt: new Date() } }] });

/** Customers who pay us directly (school instructors are covered by their owner). */
const billedSelf = { schoolRole: { $nin: SCHOOL_SEATS } };

/** Super admins run Donna Drive; they aren't customers, so they're left out of the numbers. */
const notOwners = () => ({ email: { $nin: superAdminEmails() } });

function isoDay(d) {
  return new Date(d).toISOString().slice(0, 10);
}

async function overview() {
  const now = new Date();
  const since30 = new Date(now - 30 * DAY);
  const today = timezoneUtils.getCurrentDateString();
  const in7 = timezoneUtils.addDays(today, 7);
  const ago30 = timezoneUtils.addDays(today, -30);

  const [
    total, byPlanRaw, paying, trialing, pastDue, comped, canceled30, signups30Raw,
    withNumber, withCalendar, donnaOff, suspended, returning, deleted30, plans, schools, seatAgg, numbersRaw,
    lessonsNext7, lessons30, learners, recent, trialsEnding,
  ] = await Promise.all([
    Instructor.countDocuments({ ...notOwners(), active: true }),
    Instructor.aggregate([{ $match: { active: true, ...notOwners() } }, { $group: { _id: "$plan", n: { $sum: 1 } } }]),
    Instructor.find({ ...notOwners(), active: true, subscriptionStatus: { $in: PAYING }, ...billedSelf }, { plan: 1, schoolId: 1, schoolRole: 1 }).lean(),
    Instructor.countDocuments({ ...notOwners(), active: true, subscriptionStatus: "trialing", ...billedSelf }),
    Instructor.countDocuments({ ...notOwners(), active: true, subscriptionStatus: "past_due", ...billedSelf }),
    Instructor.countDocuments({ ...notOwners(), active: true, ...compActive() }),
    Instructor.countDocuments({ ...notOwners(), canceledAt: { $gte: since30 } }),
    Instructor.aggregate([
      { $match: { createdAt: { $gte: since30 }, ...notOwners() } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, n: { $sum: 1 } } },
    ]),
    Instructor.countDocuments({ ...notOwners(), active: true, ...hasNumber }),
    Instructor.countDocuments({ ...notOwners(), active: true, googleRefreshToken: { $nin: [null, ""] } }),
    Instructor.countDocuments({ ...notOwners(), active: true, "botSettings.donnaEnabled": false }),
    Instructor.countDocuments({ ...notOwners(), suspended: true }),
    Instructor.countDocuments({ ...notOwners(), active: true, "previousAccountIds.0": { $exists: true } }),
    Instructor.countDocuments({ ...notOwners(), deletedAt: { $gte: since30 } }),
    pricing.getPlans(),
    School.countDocuments({}),
    School.aggregate([{ $group: { _id: null, limit: { $sum: "$seatLimit" }, extra: { $sum: "$extraSeats" } } }]),
    PhoneNumber.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    Booking.countDocuments({ status: { $in: ["confirmed", "rescheduled"] }, date: { $gte: today, $lte: in7 } }),
    Booking.countDocuments({ status: { $in: ["confirmed", "rescheduled", "completed"] }, date: { $gte: ago30, $lte: today } }),
    User.countDocuments({ detailsCompleted: true }),
    Instructor.find(notOwners()).sort({ createdAt: -1 }).limit(8).lean(),
    Instructor.find({ ...notOwners(), subscriptionStatus: "trialing", trialEndsAt: { $gte: now, $lte: new Date(+now + 7 * DAY) } })
      .sort({ trialEndsAt: 1 }).limit(10).lean(),
  ]);

  const plan = Object.fromEntries(plans.map((p) => [p.slug, p]));
  const schoolOwnersPaying = paying.filter((p) => p.plan === "driving-school" && p.schoolId).map((p) => p.schoolId);
  const extraSeatsPaying = schoolOwnersPaying.length
    ? (await School.aggregate([{ $match: { _id: { $in: schoolOwnersPaying } } }, { $group: { _id: null, n: { $sum: "$extraSeats" } } }]))[0]?.n || 0
    : 0;
  // List-price MRR: what active subscriptions pay before any discount
  const mrr =
    paying.reduce((sum, p) => sum + (plan[p.plan]?.amount || 0), 0) +
    extraSeatsPaying * (plan["driving-school"]?.extraSeatAmount || 0);

  const signupsByDay = Object.fromEntries(signups30Raw.map((r) => [r._id, r.n]));
  const signups = [];
  for (let i = 29; i >= 0; i--) {
    const day = isoDay(+now - i * DAY);
    signups.push({ date: day, count: signupsByDay[day] || 0 });
  }

  const byPlan = Object.fromEntries(byPlanRaw.map((r) => [r._id || "pdi", r.n]));
  const numbers = Object.fromEntries(numbersRaw.map((r) => [r._id, r.n]));
  const membersInSchools = await Instructor.countDocuments({ ...notOwners(), active: true, schoolRole: { $in: SCHOOL_SEATS } });
  const waitlist = await require("./launchService").stats().catch(() => null);

  return {
    instructors: { total, byPlan, suspended, returning, deletedLast30: deleted30 },
    revenue: {
      mrr,
      arr: mrr * 12,
      paying: paying.length,
      trialing,
      pastDue,
      comped,
      canceledLast30: canceled30,
      currency: "gbp",
    },
    signups,
    signupsLast30: signups.reduce((s, d) => s + d.count, 0),
    waitlist: waitlist && { total: waitlist.total, waiting: waitlist.waiting, invited: waitlist.invited, joined: waitlist.joined },
    funnel: [
      ...(waitlist?.total ? [{ key: "waitlist", label: "Joined the waitlist", count: waitlist.total }] : []),
      { key: "signedUp", label: "Signed up", count: total },
      { key: "number", label: "Got a WhatsApp number", count: withNumber },
      { key: "calendar", label: "Connected calendar", count: withCalendar },
      { key: "paying", label: "Paying or trialing", count: paying.length + trialing },
    ],
    donnaOff,
    schools: { total: schools, instructors: membersInSchools, seats: seatAgg[0]?.limit || 0, extraSeats: seatAgg[0]?.extra || 0 },
    numbers: { available: numbers.available || 0, assigned: numbers.assigned || 0, reserved: numbers.reserved || 0 },
    lessons: { next7Days: lessonsNext7, last30Days: lessons30 },
    learners,
    recentSignups: recent.map(row),
    trialsEnding: trialsEnding.map(row),
  };
}

function statusOf(i) {
  if (i.suspended) return "suspended";
  if (i.deletedAt || i.active === false) return "deleted";
  if (i.comp?.plan && (!i.comp.until || new Date(i.comp.until) > new Date())) return "comped";
  if (SCHOOL_SEATS.includes(i.schoolRole)) return "school";
  if (i.plan === "pdi" || !i.subscriptionStatus) return "free";
  return i.subscriptionStatus;
}

function row(i) {
  const deleted = !!i.deletedAt;
  return {
    id: String(i._id),
    // Deleted accounts show who they belonged to (admin-only record)
    name: deleted ? i.deletedIdentity?.name || "Deleted account" : i.name,
    email: deleted ? i.deletedIdentity?.email || i.email : i.email,
    deletedAt: i.deletedAt || null,
    // Signed up again after deleting an earlier account
    returning: !!i.previousAccountIds?.length,
    plan: i.plan || "pdi",
    status: statusOf(i),
    subscriptionStatus: i.subscriptionStatus || null,
    schoolRole: i.schoolRole || null,
    staffRole: staffRoleOf(i),
    superAdmin: isSuperAdmin(i),
    hasNumber: !!i.phoneNumberId && !String(i.phoneNumberId).startsWith("signup_"),
    phone: i.phoneNumberId && !String(i.phoneNumberId).startsWith("signup_") ? i.phone || null : null,
    calendarConnected: !!i.googleRefreshToken,
    donnaEnabled: i.botSettings?.donnaEnabled !== false,
    comp: i.comp?.plan ? { plan: i.comp.plan, until: i.comp.until, note: i.comp.note } : null,
    trialEndsAt: i.trialEndsAt || null,
    active: i.active !== false,
    suspended: !!i.suspended,
    createdAt: i.createdAt,
  };
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listCustomers({ search = "", plan, status, staff, page = 1, limit = 25 } = {}) {
  const q = {};
  const and = [];
  if (search.trim()) {
    const re = new RegExp(escapeRegex(search.trim()), "i");
    and.push({ $or: [{ name: re }, { email: re }, { phone: re }, { "deletedIdentity.email": re }, { "deletedIdentity.name": re }] });
  }
  if (plan) q.plan = plan;
  // Super admins only show up when looking at staff
  if (staff !== "true") and.push(notOwners());
  if (staff === "true") and.push({ $or: [{ staffRole: { $in: ["admin", "support"] } }, { email: { $in: superAdminEmails() } }] });
  switch (status) {
    case "paying": Object.assign(q, { subscriptionStatus: { $in: PAYING } }, billedSelf); break;
    case "trialing": Object.assign(q, { subscriptionStatus: "trialing" }, billedSelf); break;
    case "past_due": Object.assign(q, { subscriptionStatus: "past_due" }); break;
    case "canceled": Object.assign(q, { subscriptionStatus: "canceled" }); break;
    case "free": Object.assign(q, { plan: "pdi" }); break;
    case "comped": and.push(compActive()); break;
    case "school": q.schoolRole = { $in: SCHOOL_SEATS }; break;
    case "suspended": q.suspended = true; break;
    case "deleted": q.deletedAt = { $ne: null }; break;
    case "returning": q["previousAccountIds.0"] = { $exists: true }; break;
    default: break;
  }
  if (and.length) q.$and = and;
  limit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  page = Math.max(parseInt(page, 10) || 1, 1);
  const [docs, total] = await Promise.all([
    Instructor.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Instructor.countDocuments(q),
  ]);
  return { data: docs.map(row), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

async function loadCustomer(id) {
  const i = await Instructor.findById(id).catch(() => null);
  if (!i) throw adminError("Customer not found", 404);
  return i;
}

async function customerDetail(id) {
  const i = await Instructor.findById(id).lean().catch(() => null);
  if (!i) throw adminError("Customer not found", 404);
  const today = timezoneUtils.getCurrentDateString();
  const [setup, learners, lessonsTotal, upcoming, lastLesson, school, history, number] = await Promise.all([
    getSetupStatus(i),
    User.countDocuments({ instructorId: i.phoneNumberId, detailsCompleted: true }),
    Booking.countDocuments({ instructorId: i.phoneNumberId, status: { $in: ["confirmed", "rescheduled", "completed"] } }),
    Booking.countDocuments({ instructorId: i.phoneNumberId, status: { $in: ["confirmed", "rescheduled"] }, date: { $gte: today } }),
    Booking.findOne({ instructorId: i.phoneNumberId, status: { $in: ["confirmed", "rescheduled", "completed"] }, date: { $lte: today } })
      .sort({ date: -1, time: -1 }).lean(),
    i.schoolId ? School.findById(i.schoolId).lean() : null,
    AuditLog.find({ target: { $in: [String(i._id), i.email, i.deletedIdentity?.email].filter(Boolean) } }).sort({ createdAt: -1 }).limit(20).lean(),
    PhoneNumber.findOne({ assignedTo: i._id }).lean(),
  ]);
  // Earlier accounts they deleted, and (for a deleted account) the account they came back as
  const previous = i.previousAccountIds?.length
    ? await Instructor.find({ _id: { $in: i.previousAccountIds } }).sort({ createdAt: -1 }).lean()
    : [];
  const rejoinedAs = i.deletedAt
    ? await Instructor.findOne({ previousAccountIds: i._id, deletedAt: null }, { name: 1, email: 1, createdAt: 1 }).lean()
    : null;
  const previousAccounts = await Promise.all(
    previous.map(async (p) => ({
      id: String(p._id),
      plan: p.plan || "pdi",
      createdAt: p.createdAt,
      deletedAt: p.deletedAt,
      lessons: await Booking.countDocuments({ instructorId: p.phoneNumberId, status: { $in: ["confirmed", "rescheduled", "completed"] } }),
    }))
  );

  const stripeBase = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live") ? "https://dashboard.stripe.com" : "https://dashboard.stripe.com/test";
  return {
    ...row(i),
    timezone: i.timezone,
    setup,
    usage: { learners, lessonsTotal, upcoming, lastLessonDate: lastLesson?.date || null },
    school: school ? { id: String(school._id), name: school.name, role: i.schoolRole, seatLimit: school.seatLimit, extraSeats: school.extraSeats } : null,
    number: number ? { phoneNumber: number.phoneNumber, region: number.region, assignedAt: number.assignedAt } : null,
    stripe: i.stripeCustomerId
      ? { customerId: i.stripeCustomerId, subscriptionId: i.subscriptionId || null, url: `${stripeBase}/customers/${i.stripeCustomerId}` }
      : null,
    history,
    previousAccounts,
    rejoinedAs: rejoinedAs ? { id: String(rejoinedAs._id), name: rejoinedAs.name, email: rejoinedAs.email, createdAt: rejoinedAs.createdAt } : null,
  };
}

async function extendTrial(id, days, actor) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > 90) throw adminError("Days must be 1 to 90");
  const i = await loadCustomer(id);
  if (!i.subscriptionId) throw adminError("They don't have a subscription to extend. Comp a plan instead.");
  const stripe = getStripe();
  const sub = await stripe.subscriptions.retrieve(i.subscriptionId);
  if (sub.status !== "trialing") throw adminError("They're not on a trial. Comp a plan or add a discount instead.");
  const from = Math.max(sub.trial_end || 0, Math.floor(Date.now() / 1000));
  const trialEnd = from + n * 86400;
  await stripe.subscriptions.update(sub.id, { trial_end: trialEnd, proration_behavior: "none" });
  i.trialEndsAt = new Date(trialEnd * 1000);
  await i.save();
  await audit(actor, "customer.extend-trial", i.email, { days: n, trialEndsAt: i.trialEndsAt });
  return row(i.toObject());
}

async function setComp(id, { plan, until, note }, actor) {
  if (!["adi", "driving-school"].includes(plan)) throw adminError("Plan must be adi or driving-school");
  const untilDate = until ? new Date(until) : null;
  if (untilDate && (isNaN(untilDate) || untilDate <= new Date())) throw adminError("The end date must be in the future");
  const i = await loadCustomer(id);
  if (SCHOOL_SEATS.includes(i.schoolRole)) throw adminError("Their driving school covers them. Comp the school owner instead.");
  i.comp = { plan, until: untilDate, note: String(note || "").slice(0, 200) };
  i.plan = plan;
  i.planSelected = true;
  await i.save();
  invalidateInstructorCache(i.phoneNumberId);
  if (plan === "driving-school") await require("./schoolService").schoolFor(i.toObject());
  await audit(actor, "customer.comp", i.email, { plan, until: untilDate, note });
  return row(i.toObject());
}

async function removeComp(id, actor) {
  const i = await loadCustomer(id);
  if (!i.comp?.plan) throw adminError("They don't have a comp");
  const was = i.comp.plan;
  i.comp = { plan: null, until: null, note: "" };
  // Without a live subscription they're back on the free plan
  if (!["active", "trialing", "past_due"].includes(i.subscriptionStatus)) i.plan = "pdi";
  await i.save();
  invalidateInstructorCache(i.phoneNumberId);
  await audit(actor, "customer.uncomp", i.email, { plan: was });
  return row(i.toObject());
}

async function setSuspended(id, suspended, actor, actorEmail) {
  const i = await loadCustomer(id);
  if (suspended && isSuperAdmin(i)) throw adminError("A super admin can't be suspended", 403);
  if (suspended && actorEmail && i.email === actorEmail) throw adminError("You can't suspend yourself", 400);
  i.suspended = !!suspended;
  i.active = !suspended;
  await i.save();
  invalidateInstructorCache(i.phoneNumberId);
  await audit(actor, suspended ? "customer.suspend" : "customer.reactivate", i.email);
  return row(i.toObject());
}

/**
 * Delete a customer's account for them: the same as "Delete account" on their
 * own dashboard. Billing is cancelled, their WhatsApp number goes back to the
 * pool and their identity is removed, so signing in again with the same Google
 * account starts a fresh account.
 */
async function deleteCustomer(id, actor, actorEmail) {
  const i = await loadCustomer(id);
  if (i.deletedAt) throw adminError("This account is already deleted", 409);
  if (isSuperAdmin(i)) throw adminError("A super admin account can't be deleted", 403);
  if (actorEmail && i.email === actorEmail) throw adminError("You can't delete your own account from here", 400);
  if (i.schoolRole === "owner" && i.schoolId) {
    const others = await Instructor.countDocuments({ schoolId: i.schoolId, schoolRole: { $in: SCHOOL_SEATS }, active: true });
    if (others > 0) throw adminError(`Their school still has ${others} instructor${others === 1 ? "" : "s"}. Remove them from the school first.`, 409);
  }
  const email = i.email;
  await require("./accountDeletion").deleteAccount(i);
  // A suspended account that's deleted shouldn't stay blocked: the person can start again
  await Instructor.updateOne({ _id: i._id }, { suspended: false });
  await audit(actor, "customer.delete", email, { accountId: String(i._id) });
  return { id: String(i._id), deleted: true };
}

async function listStaff() {
  const people = await Instructor.find({ $or: [{ staffRole: { $in: ["admin", "support"] } }, { email: { $in: superAdminEmails() } }] }).lean();
  const found = new Set(people.map((p) => p.email.toLowerCase()));
  const pending = superAdminEmails().filter((e) => !found.has(e)).map((email) => ({ id: null, name: null, email, staffRole: "admin", superAdmin: true, signedUp: false }));
  return [
    ...people.map((p) => ({ id: String(p._id), name: p.name, email: p.email, staffRole: staffRoleOf(p), superAdmin: isSuperAdmin(p), signedUp: true })),
    ...pending,
  ];
}

async function setStaffRole(email, role, actor, actorEmail) {
  const target = String(email || "").trim().toLowerCase();
  if (!target) throw adminError("Enter an email");
  if (![null, "admin", "support"].includes(role ?? null)) throw adminError("Role must be admin, support or none");
  if (superAdminEmails().includes(target)) throw adminError("Super admins are set on the server and can't be changed here", 403);
  if (actorEmail && target === actorEmail.toLowerCase()) throw adminError("You can't change your own role", 400);
  const i = await Instructor.findOne({ email: new RegExp(`^${escapeRegex(target)}$`, "i") });
  if (!i) throw adminError("No account with that email. Ask them to sign in to Donna Drive once with Google, then try again.", 404);
  const from = i.staffRole;
  i.staffRole = role || null;
  await i.save();
  await audit(actor, "staff.role", i.email, { from, to: i.staffRole });
  return { id: String(i._id), name: i.name, email: i.email, staffRole: i.staffRole, superAdmin: false, signedUp: true };
}

async function auditLog({ page = 1, limit = 50, action } = {}) {
  limit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
  page = Math.max(parseInt(page, 10) || 1, 1);
  const q = action ? { action: new RegExp(`^${escapeRegex(action)}`) } : {};
  const [data, total] = await Promise.all([
    AuditLog.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(q),
  ]);
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

module.exports = {
  overview,
  listCustomers,
  customerDetail,
  extendTrial,
  setComp,
  removeComp,
  setSuspended,
  deleteCustomer,
  listStaff,
  setStaffRole,
  auditLog,
  statusOf,
};
