/**
 * The launch waitlist: people join, share their link to move up, and are let in
 * by invite. Also "give a month, get a month" referrals, which carry on after
 * launch, and the gate that keeps sign-up closed until someone is invited.
 */
const crypto = require("crypto");
const LaunchSignup = require("../models/launchSignupModel");
const Counter = require("../models/counterModel");
const Instructor = require("../models/instructorSchema");
const SchoolInvite = require("../models/schoolInviteModel");
const PromoCode = require("../models/promoCodeModel");
const settings = require("./settings");
const { audit } = require("./auditLog");
const { isSuperAdmin } = require("./permissions");
const emails = require("../utils/waitlistEmails");
const logger = require("../utils/logger-advanced");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DAY = 24 * 60 * 60 * 1000;
const PLACES_PER_REFERRAL = 10;
const REFERRALS_FOR_PRIORITY = 3;
const INVITE_DAYS = 14;
const REMIND_AFTER_DAYS = 5;
const TYPES = ["adi", "pdi", "school"];
const SCHOOL_SIZES = ["2-5", "6-15", "16+"];
const TOOLS = ["whatsapp", "phone", "app", "other"];

function launchError(message, status = 400, code) {
  const err = new Error(message);
  err.userFacing = true;
  err.status = status;
  if (code) err.code = code;
  return err;
}

const hash = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");
const clean = (v, max) => String(v ?? "").trim().slice(0, max);
const isLive = (date) => !!date && new Date(`${date}T23:59:59Z`) > new Date();

/** Their place in the queue: the order they joined, moved up by referrals. */
function placeOf(entry) {
  return Math.max(1, (entry.position || 1) - PLACES_PER_REFERRAL * (entry.referrals || 0));
}

/** A short, friendly link code: "raj7k2". */
function makeReferralCode(name) {
  const base = String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z]/g, "")
    .slice(0, 8) || "dd";
  return `${base}${crypto.randomBytes(3).toString("base64").replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 3) || "x1"}`;
}

async function uniqueReferralCode(name) {
  for (let i = 0; i < 5; i++) {
    const code = makeReferralCode(name);
    const [a, b] = await Promise.all([LaunchSignup.exists({ referralCode: code }), Instructor.exists({ referralCode: code })]);
    if (!a && !b) return code;
  }
  return `dd${crypto.randomBytes(5).toString("hex")}`;
}

/** What the website shows about this person (never their tokens, except to themselves). */
function summary(entry, { withToken = false } = {}) {
  return {
    name: entry.name,
    email: entry.email,
    place: placeOf(entry),
    position: entry.position,
    referralCode: entry.referralCode,
    referrals: entry.referrals || 0,
    referralsToPriority: Math.max(0, REFERRALS_FOR_PRIORITY - (entry.referrals || 0)),
    priority: !!entry.priority,
    status: entry.status,
    type: entry.type || null,
    schoolSize: entry.schoolSize || null,
    area: entry.area || "",
    currentTool: entry.currentTool || [],
    marketingConsent: !!entry.marketingConsent,
    joinedAt: entry.createdAt,
    ...(withToken && { token: entry.accessToken }),
  };
}

// ── Public ──────────────────────────────────────────────────────────────

/** What the website needs to pick its buttons and banner. */
async function publicLaunch() {
  const s = await settings.getAll();
  const mode = s["launch.mode"];
  const [count, today] = await Promise.all([
    LaunchSignup.countDocuments({ status: { $ne: "removed" } }),
    LaunchSignup.countDocuments({ status: { $ne: "removed" }, createdAt: { $gte: new Date(Date.now() - DAY) } }),
  ]);
  return {
    mode,
    // A launch date only matters while sign-up is closed and the day hasn't passed
    date: mode !== "open" && isLive(s["launch.date"]) ? s["launch.date"] : null,
    message: mode !== "open" ? s["launch.message"] || "" : "",
    count,
    joinedToday: today,
  };
}

/** The person who owns a referral code: someone on the waitlist and/or an instructor. */
async function referrerFor(code) {
  if (!code) return {};
  const c = String(code).trim().toLowerCase();
  const [entry, instructor] = await Promise.all([
    LaunchSignup.findOne({ referralCode: c, status: { $ne: "removed" } }),
    Instructor.findOne({ referralCode: c, active: true }),
  ]);
  return { code: entry || instructor ? c : null, entry, instructor };
}

/** A friend joined with this person's link: move them up, and tell them (once a day at most). */
async function creditReferral(referrer, friend) {
  const before = placeOf(referrer);
  const updated = await LaunchSignup.findOneAndUpdate(
    { _id: referrer._id },
    { $inc: { referrals: 1 } },
    { new: true }
  );
  if (!updated) return;
  if (updated.referrals >= REFERRALS_FOR_PRIORITY && !updated.priority) {
    updated.priority = true;
    await LaunchSignup.updateOne({ _id: updated._id }, { priority: true });
  }
  const lastEmail = updated.emails?.movedUpAt;
  if (updated.status === "waiting" && !updated.unsubscribedAt && (!lastEmail || Date.now() - new Date(lastEmail) > DAY)) {
    const sent = await emails
      .sendWaitlistMovedUp(updated, { from: before, to: placeOf(updated), friendName: friend.name, referrals: updated.referrals })
      .catch(() => false);
    if (sent) await LaunchSignup.updateOne({ _id: updated._id }, { "emails.movedUpAt": new Date() });
  }
}

/**
 * Join the waitlist. Joining again with the same email changes nothing; the
 * response just says they're already on it (without their private link, which we
 * email to them again instead).
 */
async function join(input = {}) {
  const name = clean(input.name, 100);
  const email = clean(input.email, 200).toLowerCase();
  if (!name) throw launchError("Please tell us your name");
  if (!EMAIL.test(email)) throw launchError("Please enter a valid email address");

  const existing = await LaunchSignup.findOne({ email });
  if (existing && existing.status !== "removed") {
    // Resend their link so whoever owns the inbox can get back to their place
    // (at most once an hour, so the form can't be used to flood someone's inbox)
    const last = existing.emails?.confirmationSentAt;
    if (existing.status === "waiting" && (!last || Date.now() - new Date(last) > 60 * 60 * 1000)) {
      await LaunchSignup.updateOne({ _id: existing._id }, { "emails.confirmationSentAt": new Date() });
      emails.sendWaitlistConfirmation(existing, { place: placeOf(existing), launchDate: (await publicLaunch().catch(() => ({}))).date }).catch(() => {});
    }
    return { created: false, entry: { name: existing.name, place: placeOf(existing), status: existing.status } };
  }
  if (existing) throw launchError("We couldn't add this email. Please contact us.", 400);

  const already = await Instructor.findOne({ email, active: true }).lean();
  if (already) throw launchError("You already have a Donna Drive account. Sign in instead.", 409, "HAS_ACCOUNT");

  const { code: refCode, entry: refEntry } = await referrerFor(input.ref);
  const referredBy = refCode && refEntry?.email !== email ? refCode : null;

  const counter = await Counter.findOneAndUpdate({ _id: "launchSignup" }, { $inc: { seq: 1 } }, { upsert: true, new: true });
  const src = input.source || {};
  let entry;
  try {
    entry = await LaunchSignup.create({
      email,
      name,
      ...(TYPES.includes(input.type) && { type: input.type }),
      position: counter.seq,
      referralCode: await uniqueReferralCode(name),
      referredBy,
      accessToken: crypto.randomBytes(24).toString("hex"),
      source: {
        utm_source: clean(src.utm_source, 100),
        utm_medium: clean(src.utm_medium, 100),
        utm_campaign: clean(src.utm_campaign, 100),
        referrer: clean(src.referrer, 300),
        landingPath: clean(src.landingPath, 300),
      },
    });
  } catch (err) {
    // Two joins with the same email at once: the other one won
    if (err.code === 11000) {
      const winner = await LaunchSignup.findOne({ email });
      if (winner) return { created: false, entry: { name: winner.name, place: placeOf(winner), status: winner.status } };
    }
    throw err;
  }

  if (referredBy && refEntry) await creditReferral(refEntry, entry).catch((e) => logger.warn(`Referral credit failed: ${e.message}`));

  const launch = await publicLaunch().catch(() => ({}));
  const sent = await emails.sendWaitlistConfirmation(entry, { place: placeOf(entry), launchDate: launch.date }).catch(() => false);
  if (sent) await LaunchSignup.updateOne({ _id: entry._id }, { "emails.confirmationSentAt": new Date() });

  return { created: true, entry: summary(entry, { withToken: true }) };
}

async function byToken(token) {
  if (!token || typeof token !== "string") return null;
  return LaunchSignup.findOne({ accessToken: token, status: { $ne: "removed" } });
}

/** Their own status page (from the link in every email, or straight after joining). */
async function status(token) {
  const entry = await byToken(token);
  if (!entry) throw launchError("We couldn't find your place. Use the link in your latest email.", 404);
  const [launch, friends] = await Promise.all([
    publicLaunch(),
    LaunchSignup.find({ referredBy: entry.referralCode, status: { $ne: "removed" } }).sort({ createdAt: -1 }).limit(20).lean(),
  ]);
  return {
    ...summary(entry, { withToken: true }),
    friends: friends.map((f) => ({ name: String(f.name).split(" ")[0], joinedAt: f.createdAt })),
    launch,
  };
}

/** The optional "help us get you in sooner" answers. */
async function updateProfile(token, input = {}) {
  const entry = await byToken(token);
  if (!entry) throw launchError("We couldn't find your place. Use the link in your latest email.", 404);
  if ("type" in input) entry.type = TYPES.includes(input.type) ? input.type : null;
  if ("schoolSize" in input) entry.schoolSize = SCHOOL_SIZES.includes(input.schoolSize) ? input.schoolSize : null;
  if (entry.type !== "school") entry.schoolSize = null;
  if ("area" in input) entry.area = clean(input.area, 60);
  if ("currentTool" in input) entry.currentTool = [...new Set((Array.isArray(input.currentTool) ? input.currentTool : []).filter((t) => TOOLS.includes(t)))];
  if ("marketingConsent" in input) entry.marketingConsent = !!input.marketingConsent;
  await entry.save();
  return summary(entry, { withToken: true });
}

async function unsubscribe(token) {
  const entry = await byToken(token);
  if (!entry) return false;
  await LaunchSignup.updateOne({ _id: entry._id }, { unsubscribedAt: new Date(), marketingConsent: false });
  return true;
}

/** The invite link's landing page: is it still good, and who is it for. */
async function inviteInfo(token) {
  const entry = await validInvite(token);
  if (!entry) return { valid: false };
  const promo = await promoFor(entry.invite.promoCode);
  return { valid: true, name: entry.name, email: entry.email, expiresAt: entry.invite.expiresAt, promo: promo ? { code: promo.code, label: promoLabel(promo) } : null };
}

async function validInvite(token) {
  if (!token || typeof token !== "string") return null;
  const entry = await LaunchSignup.findOne({ "invite.tokenHash": hash(token) });
  if (!entry || entry.status !== "invited" || entry.invite.usedAt) return null;
  if (!entry.invite.expiresAt || new Date(entry.invite.expiresAt) < new Date()) return null;
  return entry;
}

// ── The sign-up gate ────────────────────────────────────────────────────

/**
 * May this new person create an account? Only asked when there's no account yet.
 * Open mode lets everyone in; otherwise they need an invite (the link, or the
 * invited email), a driving school's invite, or to be a super admin.
 * Returns { allowed, entry } or { allowed: false, onList, place }.
 */
async function signupAllowed({ email, inviteToken }) {
  const mode = await settings.get("launch.mode");
  const lower = String(email || "").toLowerCase();
  const onList = await LaunchSignup.findOne({ email: lower, status: { $ne: "removed" } });

  if (mode === "open") return { allowed: true, entry: onList };
  if (isSuperAdmin({ email: lower })) return { allowed: true, entry: onList };

  const byLink = await validInvite(inviteToken);
  if (byLink) return { allowed: true, entry: byLink };

  if (onList?.status === "invited" && onList.invite?.expiresAt && new Date(onList.invite.expiresAt) > new Date()) {
    return { allowed: true, entry: onList };
  }
  const schoolInvite = await SchoolInvite.findOne({ email: lower, status: "pending", expiresAt: { $gt: new Date() } }).lean();
  if (schoolInvite) return { allowed: true, entry: onList };

  return { allowed: false, onList: !!onList, place: onList ? placeOf(onList) : null, status: onList?.status || null };
}

/**
 * A new account was created. Mark their waitlist place as used, and carry their
 * referral code and who referred them over to the account.
 */
async function onSignup(instructor, { entry, ref } = {}) {
  try {
    const updates = {};
    if (entry) {
      await LaunchSignup.updateOne(
        { _id: entry._id },
        { status: "joined", instructorId: instructor._id, ...(entry.status === "invited" && { "invite.usedAt": new Date() }) }
      );
      if (!instructor.referralCode) updates.referralCode = entry.referralCode;
      if (entry.referredBy && entry.referredBy !== entry.referralCode) updates.referredBy = entry.referredBy;
    }
    if (!updates.referredBy && ref && !instructor.referredBy) {
      const { code, entry: refEntry, instructor: refInstructor } = await referrerFor(ref);
      const self = (refEntry && refEntry.email === instructor.email) || (refInstructor && String(refInstructor._id) === String(instructor._id));
      if (code && !self) updates.referredBy = code;
    }
    if (Object.keys(updates).length) {
      Object.assign(instructor, updates);
      await Instructor.updateOne({ _id: instructor._id }, updates);
    }
  } catch (err) {
    logger.warn(`Waitlist sign-up bookkeeping failed for ${instructor.email}: ${err.message}`);
  }
}

/**
 * Their account was deleted: their waitlist place (if they had one) goes back to
 * waiting, so while sign-up is closed they're treated like anyone else on the list.
 */
async function onAccountDeleted(instructor) {
  try {
    await LaunchSignup.updateOne(
      { instructorId: instructor._id },
      { status: "waiting", instructorId: null, "invite.tokenHash": null, "invite.usedAt": null, "invite.expiresAt": null }
    );
  } catch (err) {
    logger.warn(`Waitlist reset after deleting ${instructor._id} failed: ${err.message}`);
  }
}

// ── Referrals for instructors ───────────────────────────────────────────

/** An instructor's own link ("give a month, get a month"), made on first ask. */
async function referralFor(instructor) {
  let code = instructor.referralCode;
  if (!code) {
    code = await uniqueReferralCode(instructor.name);
    const saved = await Instructor.findOneAndUpdate(
      { _id: instructor._id, $or: [{ referralCode: null }, { referralCode: { $exists: false } }] },
      { referralCode: code },
      { new: true }
    );
    code = saved?.referralCode || (await Instructor.findById(instructor._id).lean())?.referralCode || code;
  }
  const [signedUp, rewarded] = await Promise.all([
    Instructor.countDocuments({ referredBy: code }),
    Instructor.countDocuments({ referredBy: code, referralRewardedAt: { $ne: null } }),
  ]);
  return {
    code,
    url: emails.shareUrl(code),
    signedUp,
    rewarded,
    freeMonths: instructor.referralFreeMonths || 0,
    maxFreeMonths: await settings.get("referral.maxFreeMonths"),
  };
}

const gbp = (pence) => `£${(pence / 100).toFixed(pence % 100 ? 2 : 0)}`;

/** One month of what this customer pays for their plan, in pence. */
async function monthOf(instructor) {
  const pricing = require("./pricingService");
  const plan = await pricing.getPlan(instructor.comp?.plan || instructor.plan).catch(() => null);
  return plan?.amount || 0;
}

async function credit(stripe, instructor, amount, description) {
  if (!instructor.stripeCustomerId || !amount) return false;
  await stripe.customers.createBalanceTransaction(instructor.stripeCustomerId, {
    amount: -amount,
    currency: "gbp",
    description,
  });
  return true;
}

/**
 * A referred customer's first real payment: both of them get a month free, as
 * Stripe credit that comes off their next invoices. Once per referred customer;
 * the referrer is capped at referral.maxFreeMonths.
 */
async function rewardReferral(stripe, instructor, invoice) {
  if (!instructor?.referredBy || instructor.referralRewardedAt) return null;
  if (!(invoice?.amount_paid > 0)) return null;
  if (invoice.metadata?.kind === "trial-seats") return null;
  if (!["subscription_cycle", "subscription_create"].includes(invoice.billing_reason)) return null;

  const referrer = await Instructor.findOne({ referralCode: instructor.referredBy, active: true });
  if (referrer && String(referrer._id) === String(instructor._id)) return null;

  // Claim it first so a retried webhook can't pay twice
  const claimed = await Instructor.findOneAndUpdate(
    { _id: instructor._id, referralRewardedAt: null },
    { referralRewardedAt: new Date() },
    { new: true }
  );
  if (!claimed) return null;

  const result = { friend: false, referrer: false };
  const friendAmount = await monthOf(instructor);
  if (await credit(stripe, instructor, friendAmount, "Referral: your free month").catch((e) => logger.error(`Referral credit (friend) failed: ${e.message}`))) {
    result.friend = true;
    await Instructor.updateOne({ _id: instructor._id }, { $inc: { referralFreeMonths: 1 } });
    emails.sendReferralReward({ to: instructor.email, name: instructor.name, amountLabel: gbp(friendAmount), asReferrer: false }).catch(() => {});
  }

  const cap = await settings.get("referral.maxFreeMonths");
  if (referrer && (referrer.referralFreeMonths || 0) < cap) {
    const amount = await monthOf(referrer);
    const done = await credit(stripe, referrer, amount, `Referral: ${instructor.name || instructor.email} started paying`).catch((e) =>
      logger.error(`Referral credit (referrer) failed: ${e.message}`)
    );
    if (done) {
      result.referrer = true;
      await Instructor.updateOne({ _id: referrer._id }, { $inc: { referralFreeMonths: 1 } });
      emails.sendReferralReward({ to: referrer.email, name: referrer.name, friendName: instructor.name, amountLabel: gbp(amount), asReferrer: true }).catch(() => {});
    }
  }
  await audit("system", "referral.reward", instructor.email, { referrer: referrer?.email || null, ...result });
  return result;
}

// ── Checkout ────────────────────────────────────────────────────────────

async function promoFor(code) {
  if (!code) return null;
  const promo = await PromoCode.findOne({ code: String(code).toUpperCase(), active: true }).lean();
  if (!promo?.stripePromotionCodeId) return null;
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) return null;
  return promo;
}

function promoLabel(p) {
  const off = p.percentOff ? `${p.percentOff}% off` : `${gbp(p.amountOff)} off`;
  if (p.duration === "forever") return `${off}, for good`;
  if (p.duration === "repeating" && p.durationMonths) return `${off} for ${p.durationMonths} month${p.durationMonths === 1 ? "" : "s"}`;
  return `${off} your first payment`;
}

/** The launch perk for someone who came in by invite, applied to their checkout. */
async function checkoutPerk(instructor, plan) {
  const entry = await LaunchSignup.findOne({ instructorId: instructor._id }).lean();
  const promo = await promoFor(entry?.invite?.promoCode);
  if (!promo) return null;
  if (promo.plans?.length && !promo.plans.includes(plan)) return null;
  return { discounts: [{ promotion_code: promo.stripePromotionCodeId }] };
}

// ── Admin ───────────────────────────────────────────────────────────────

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Who's next: priority first, then people who told us about themselves, then by place. */
function inviteOrder(a, b) {
  if (!!b.priority !== !!a.priority) return b.priority ? 1 : -1;
  if (!!b.type !== !!a.type) return b.type ? 1 : -1;
  return placeOf(a) - placeOf(b);
}

async function adminList(query = {}) {
  const filter = {};
  if (query.status && query.status !== "all") filter.status = query.status;
  else filter.status = { $ne: "removed" };
  if (TYPES.includes(query.type)) filter.type = query.type;
  if (query.area) filter.area = new RegExp(escapeRegex(String(query.area).slice(0, 60)), "i");
  if (query.search) {
    const re = new RegExp(escapeRegex(String(query.search).slice(0, 100)), "i");
    filter.$or = [{ name: re }, { email: re }, { referralCode: re }];
  }
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(query.limit, 10) || 50));

  const [rows, totals] = await Promise.all([LaunchSignup.find(filter).lean(), stats()]);
  rows.sort(inviteOrder);
  const now = new Date();
  return {
    data: rows.slice((page - 1) * limit, page * limit).map((e) => ({
      id: String(e._id),
      ...summary(e),
      source: e.source || {},
      invite: e.invite?.sentAt
        ? { sentAt: e.invite.sentAt, expiresAt: e.invite.expiresAt, expired: e.invite.expiresAt && new Date(e.invite.expiresAt) < now, remindedAt: e.invite.remindedAt, usedAt: e.invite.usedAt, promoCode: e.invite.promoCode }
        : null,
      unsubscribed: !!e.unsubscribedAt,
    })),
    total: rows.length,
    page,
    limit,
    stats: totals,
  };
}

async function stats() {
  const [byStatus, byType, perDay, top] = await Promise.all([
    LaunchSignup.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    LaunchSignup.aggregate([{ $match: { status: { $ne: "removed" } } }, { $group: { _id: "$type", n: { $sum: 1 } } }]),
    LaunchSignup.aggregate([
      { $match: { status: { $ne: "removed" }, createdAt: { $gte: new Date(Date.now() - 30 * DAY) } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Europe/London" } }, n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    LaunchSignup.find({ status: { $ne: "removed" }, referrals: { $gt: 0 } }).sort({ referrals: -1 }).limit(5).lean(),
  ]);
  const s = Object.fromEntries((byStatus || []).map((r) => [r._id, r.n]));
  const waiting = s.waiting || 0;
  const invited = s.invited || 0;
  const joined = s.joined || 0;
  return {
    total: waiting + invited + joined,
    waiting,
    invited,
    joined,
    removed: s.removed || 0,
    conversion: invited + joined ? Math.round((joined / (invited + joined)) * 100) : null,
    byType: Object.fromEntries((byType || []).map((r) => [r._id || "unknown", r.n])),
    perDay: (perDay || []).map((d) => ({ date: d._id, count: d.n })),
    topReferrers: (top || []).map((t) => ({ name: t.name, email: t.email, referrals: t.referrals })),
  };
}

/**
 * Send invites: chosen people ({ ids }) or the next N in line ({ next, type }).
 * Re-inviting someone whose invite expired sends a fresh link.
 */
async function invite({ ids, next, type } = {}, actor) {
  let entries;
  if (Array.isArray(ids) && ids.length) {
    entries = await LaunchSignup.find({ _id: { $in: ids.slice(0, 500) }, status: { $in: ["waiting", "invited"] } });
  } else {
    const n = Math.min(500, Math.max(1, parseInt(next, 10) || 0));
    if (!n) throw launchError("Choose who to invite");
    const waiting = await LaunchSignup.find({ status: "waiting", ...(TYPES.includes(type) && { type }) });
    entries = waiting.sort(inviteOrder).slice(0, n);
  }
  if (!entries.length) throw launchError("There's nobody to invite");

  const promoCode = await settings.get("launch.invitePromoCode");
  const promo = await promoFor(promoCode);
  const expiresAt = new Date(Date.now() + INVITE_DAYS * DAY);
  const site = (process.env.FRONTEND_URL || "http://localhost:8080").replace(/\/$/, "");

  let sent = 0;
  const failed = [];
  for (const entry of entries) {
    const token = crypto.randomBytes(24).toString("hex");
    entry.status = "invited";
    entry.invite = { tokenHash: hash(token), sentAt: new Date(), expiresAt, remindedAt: null, usedAt: null, promoCode: promo?.code || null, by: actor };
    await entry.save();
    const ok = await emails
      .sendWaitlistInvite(entry, { joinUrl: `${site}/join?invite=${token}`, promo: promo && { code: promo.code, label: promoLabel(promo) }, expiresAt })
      .catch(() => false);
    if (ok) sent++;
    else failed.push(entry.email);
  }
  await audit(actor, "waitlist.invite", `${entries.length} people`, { emails: entries.map((e) => e.email), promoCode: promo?.code || null, failed });
  return { invited: entries.length, emailed: sent, failed };
}

/** Spam or a duplicate: off the list, and any places it earned its referrer are taken back. */
async function remove(id, actor) {
  const entry = await LaunchSignup.findById(id);
  if (!entry) throw launchError("Not found", 404);
  if (entry.status === "joined") throw launchError("They've already signed up");
  if (entry.status === "removed") return summary(entry);
  entry.status = "removed";
  await entry.save();
  if (entry.referredBy) {
    const referrer = await LaunchSignup.findOneAndUpdate(
      { referralCode: entry.referredBy, referrals: { $gt: 0 } },
      { $inc: { referrals: -1 } },
      { new: true }
    );
    if (referrer && referrer.priority && referrer.referrals < REFERRALS_FOR_PRIORITY) {
      await LaunchSignup.updateOne({ _id: referrer._id }, { priority: false });
    }
  }
  await audit(actor, "waitlist.remove", entry.email);
  return summary(entry);
}

const csvCell = (v) => {
  const s = v == null ? "" : String(v);
  // Neutralise spreadsheet formulas
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

async function csv() {
  const rows = await LaunchSignup.find({}).sort({ position: 1 }).lean();
  const header = ["position", "place", "name", "email", "type", "school_size", "area", "current_tool", "marketing_consent", "status", "referrals", "priority", "referral_code", "referred_by", "utm_source", "utm_medium", "utm_campaign", "referrer", "joined_at", "invited_at", "unsubscribed"];
  const lines = rows.map((e) =>
    [
      e.position, placeOf(e), e.name, e.email, e.type, e.schoolSize, e.area, (e.currentTool || []).join(" "), e.marketingConsent ? "yes" : "no",
      e.status, e.referrals || 0, e.priority ? "yes" : "no", e.referralCode, e.referredBy, e.source?.utm_source, e.source?.utm_medium,
      e.source?.utm_campaign, e.source?.referrer, e.createdAt && new Date(e.createdAt).toISOString(), e.invite?.sentAt && new Date(e.invite.sentAt).toISOString(), e.unsubscribedAt ? "yes" : "no",
    ].map(csvCell).join(",")
  );
  return [header.join(","), ...lines].join("\n");
}

/** The admin panel's launch settings. */
async function launchSettings() {
  const s = await settings.getAll();
  const promos = await PromoCode.find({ active: true }).sort({ createdAt: -1 }).lean();
  return {
    mode: s["launch.mode"],
    date: s["launch.date"],
    message: s["launch.message"],
    invitePromoCode: s["launch.invitePromoCode"],
    maxFreeMonths: s["referral.maxFreeMonths"],
    promoCodes: promos
      .filter((p) => !p.expiresAt || new Date(p.expiresAt) > new Date())
      .map((p) => ({ code: p.code, label: promoLabel(p) })),
  };
}

async function updateLaunchSettings(input = {}, actor) {
  const values = {};
  if ("mode" in input) {
    if (!settings.LAUNCH_MODES.includes(input.mode)) throw launchError("Unknown mode");
    values["launch.mode"] = input.mode;
  }
  if ("date" in input) {
    const d = input.date ? String(input.date) : null;
    if (d && (!/^\d{4}-\d{2}-\d{2}$/.test(d) || isNaN(new Date(d)))) throw launchError("Pick a valid date");
    values["launch.date"] = d;
  }
  if ("message" in input) values["launch.message"] = clean(input.message, 140);
  if ("invitePromoCode" in input) {
    const code = input.invitePromoCode ? String(input.invitePromoCode).toUpperCase() : null;
    if (code && !(await promoFor(code))) throw launchError("That promo code isn't active");
    values["launch.invitePromoCode"] = code;
  }
  if ("maxFreeMonths" in input) {
    const n = Number(input.maxFreeMonths);
    if (!Number.isInteger(n) || n < 0 || n > 60) throw launchError("Free months cap must be 0–60");
    values["referral.maxFreeMonths"] = n;
  }
  if (!Object.keys(values).length) return launchSettings();
  const before = await settings.getAll();
  await settings.setMany(values, actor);
  await audit(actor, "launch.settings", "launch", {
    changes: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { from: before[k], to: v }])),
  });
  return launchSettings();
}

/** "We're live" to everyone still waiting who said yes to product news. Only once each. */
async function announceLaunch(actor) {
  if ((await settings.get("launch.mode")) !== "open") throw launchError("Open sign-up first, then announce it");
  const people = await LaunchSignup.find({
    status: { $in: ["waiting", "invited"] },
    marketingConsent: true,
    unsubscribedAt: null,
    "emails.launchSentAt": null,
  });
  let sent = 0;
  for (const entry of people) {
    if (await emails.sendLaunchAnnouncement(entry).catch(() => false)) {
      sent++;
      await LaunchSignup.updateOne({ _id: entry._id }, { "emails.launchSentAt": new Date() });
    }
  }
  await audit(actor, "launch.announce", `${sent} people`, { sent, of: people.length });
  return { sent, of: people.length };
}

// ── Jobs ────────────────────────────────────────────────────────────────

/** One reminder for invites still unused after 5 days. */
async function sendDueReminders() {
  const now = Date.now();
  const due = await LaunchSignup.find({
    status: "invited",
    "invite.usedAt": null,
    "invite.remindedAt": null,
    "invite.sentAt": { $lte: new Date(now - REMIND_AFTER_DAYS * DAY) },
    "invite.expiresAt": { $gt: new Date(now) },
    unsubscribedAt: null,
  });
  const site = (process.env.FRONTEND_URL || "http://localhost:8080").replace(/\/$/, "");
  let sent = 0;
  for (const entry of due) {
    // The original token is only stored hashed, so a reminder carries a fresh link
    const token = crypto.randomBytes(24).toString("hex");
    const promo = await promoFor(entry.invite.promoCode);
    await LaunchSignup.updateOne({ _id: entry._id }, { "invite.tokenHash": hash(token), "invite.remindedAt": new Date() });
    const ok = await emails
      .sendWaitlistReminder(entry, { joinUrl: `${site}/join?invite=${token}`, promo: promo && { code: promo.code, label: promoLabel(promo) }, expiresAt: entry.invite.expiresAt })
      .catch(() => false);
    if (ok) sent++;
  }
  return sent;
}

/** The team's daily summary (skipped on days nobody joined). */
async function sendDigest() {
  const joined = await LaunchSignup.find({ status: { $ne: "removed" }, createdAt: { $gte: new Date(Date.now() - DAY) } }).sort({ position: 1 }).lean();
  if (!joined.length) return false;
  const totals = await stats();
  return emails.sendWaitlistDigest({ joined, totals, top: totals.topReferrers });
}

module.exports = {
  PLACES_PER_REFERRAL,
  REFERRALS_FOR_PRIORITY,
  placeOf,
  publicLaunch,
  join,
  status,
  updateProfile,
  unsubscribe,
  inviteInfo,
  validInvite,
  signupAllowed,
  onSignup,
  onAccountDeleted,
  referralFor,
  rewardReferral,
  checkoutPerk,
  promoLabel,
  adminList,
  stats,
  invite,
  remove,
  csv,
  launchSettings,
  updateLaunchSettings,
  announceLaunch,
  sendDueReminders,
  sendDigest,
  hash,
};
