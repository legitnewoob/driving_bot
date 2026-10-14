/**
 * Plans, prices and sales. The database holds what admins set; checkout, the
 * school seat logic and the website pricing page all read from here.
 *
 * Price changes: Stripe prices can't be edited, so a change creates a new
 * price. New sign-ups use it at once. Existing subscribers are moved by the
 * price-change job when `effectiveAt` passes (a rise gives notice), with
 * proration off, so they pay the new price from their next renewal.
 */
const Plan = require("../models/planModel");
const PriceChange = require("../models/priceChangeModel");
const Sale = require("../models/saleModel");
const PromoCode = require("../models/promoCodeModel");
const School = require("../models/schoolModel");
const Instructor = require("../models/instructorSchema");
const { isDbReady } = require("../utils/db");
const { audit } = require("./auditLog");
const logger = require("../utils/logger-advanced");

const getStripe = () => new (require("stripe"))(process.env.STRIPE_SECRET_KEY);
const CACHE_MS = 60 * 1000;
const LIVE_STATUSES = ["active", "trialing", "past_due"];

function noticeDays() {
  const n = parseInt(process.env.PRICE_RISE_NOTICE_DAYS, 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

function pricingError(message, status = 400, extra = {}) {
  return Object.assign(new Error(message), { status, userFacing: true }, extra);
}

// Today's plans; the first start copies these into the database.
function defaultPlans() {
  return [
    {
      slug: "pdi", name: "PDI", subtitle: "Perfect while you're training", amount: 0, trialDays: 0,
      popular: false, button: "Get Started", sortOrder: 0,
      features: ["Unlimited WhatsApp conversations", "Google Calendar sync", "Lesson booking", "Until you qualify"],
    },
    {
      slug: "adi", name: "ADI", subtitle: "For qualified instructors", amount: 1000, trialDays: 30,
      popular: true, button: "Start Free Trial", sortOrder: 1,
      stripePriceId: process.env.STRIPE_PRICE_ADI || null,
      features: ["Everything in PDI", "Student Portal", "Smart Routes", "Automatic reminders", "Priority support"],
    },
    {
      slug: "driving-school", name: "Driving Schools", subtitle: "Up to 3 instructors", amount: 2000, trialDays: 30,
      popular: false, button: "Get started", sortOrder: 2,
      stripePriceId: process.env.STRIPE_PRICE_SCHOOL || null,
      includedSeats: 3, extraSeatAmount: 1000,
      extraSeatPriceId: process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT || null,
      features: [
        "Everything in ADI, for each instructor",
        "3 instructors included, then £10/month each",
        "Team page to invite and manage instructors",
        "See every instructor's learners and lessons",
        "One bill for the whole school",
      ],
    },
  ].map((p) => ({ currency: "gbp", interval: "month", pastPriceIds: [], pastExtraSeatPriceIds: [], includedSeats: 0, extraSeatAmount: 0, ...p }));
}

let _plans = null;
let _plansAt = 0;
let _sales = null;
let _salesAt = 0;

function clearCache() {
  _plans = null;
  _sales = null;
}

/** Create any missing plans, and fill in Stripe price IDs from env when unset. */
async function ensurePlans() {
  if (!isDbReady()) return;
  for (const def of defaultPlans()) {
    const existing = await Plan.findOne({ slug: def.slug });
    if (!existing) {
      await Plan.create(def);
      continue;
    }
    const fill = {};
    if (!existing.stripePriceId && def.stripePriceId) fill.stripePriceId = def.stripePriceId;
    if (!existing.extraSeatPriceId && def.extraSeatPriceId) fill.extraSeatPriceId = def.extraSeatPriceId;
    if (Object.keys(fill).length) await Plan.updateOne({ _id: existing._id }, { $set: fill });
  }
  clearCache();
}

async function getPlans() {
  if (!isDbReady()) return defaultPlans();
  if (_plans && Date.now() - _plansAt < CACHE_MS) return _plans;
  let plans = await Plan.find({}).sort({ sortOrder: 1 }).lean();
  if (!plans.length) {
    await ensurePlans();
    plans = await Plan.find({}).sort({ sortOrder: 1 }).lean();
  }
  _plans = plans.length ? plans : defaultPlans();
  _plansAt = Date.now();
  return _plans;
}

async function getPlan(slug) {
  return (await getPlans()).find((p) => p.slug === slug) || null;
}

async function includedSeats() {
  const plan = await getPlan("driving-school");
  return plan?.includedSeats ?? 3;
}

async function extraSeatPriceId() {
  const plan = await getPlan("driving-school");
  return plan?.extraSeatPriceId || process.env.STRIPE_PRICE_SCHOOL_EXTRA_SEAT || null;
}

/** Is this subscription item the plan's base price (current or older)? */
function isBaseItem(item, plan) {
  const id = item?.price?.id;
  return !!id && (id === plan.stripePriceId || (plan.pastPriceIds || []).includes(id));
}

/** Is this subscription item an extra-seat line (current or older price)? */
function isSeatItem(item, plan) {
  const id = item?.price?.id;
  if (!id || !plan) return false;
  if (id === plan.extraSeatPriceId || (plan.pastExtraSeatPriceIds || []).includes(id)) return true;
  return !!plan.extraSeatProductId && (item.price.product === plan.extraSeatProductId || item.price.product?.id === plan.extraSeatProductId);
}

// ── Sales ────────────────────────────────────────────────────────────────

async function activeSales(now = new Date()) {
  if (!isDbReady()) return [];
  if (_sales && Date.now() - _salesAt < CACHE_MS) {
    return _sales.filter((s) => s.startsAt <= now && s.endsAt > now);
  }
  _sales = await Sale.find({ active: true, endsAt: { $gt: new Date() } }).sort({ startsAt: 1 }).lean();
  _salesAt = Date.now();
  return _sales.filter((s) => s.startsAt <= now && s.endsAt > now);
}

/** The sale that applies to a plan right now (the biggest discount if several overlap). */
async function saleFor(slug, now = new Date()) {
  const plan = await getPlan(slug);
  const sales = (await activeSales(now)).filter((s) => !s.plans.length || s.plans.includes(slug));
  if (!sales.length) return null;
  return sales.sort((a, b) => discounted(plan?.amount || 0, a) - discounted(plan?.amount || 0, b))[0];
}

function discounted(amount, discount) {
  if (!discount) return amount;
  if (discount.percentOff) return Math.round(amount * (1 - discount.percentOff / 100));
  if (discount.amountOff) return Math.max(0, amount - discount.amountOff);
  return amount;
}

function describeDuration(d) {
  if (d.duration === "once") return "for your first month";
  if (d.duration === "forever") return "for as long as you stay";
  return `for ${d.durationMonths} month${d.durationMonths === 1 ? "" : "s"}`;
}

/** What the website pricing page shows. */
async function publicPricing() {
  const plans = await getPlans();
  const now = new Date();
  const out = [];
  for (const p of plans) {
    const sale = p.amount > 0 ? await saleFor(p.slug, now) : null;
    out.push({
      slug: p.slug,
      name: p.name,
      subtitle: p.subtitle,
      features: p.features,
      popular: p.popular,
      button: p.button,
      amount: p.amount,
      currency: p.currency,
      interval: p.interval,
      trialDays: p.trialDays,
      includedSeats: p.includedSeats || 0,
      extraSeatAmount: p.extraSeatAmount || 0,
      sale: sale
        ? {
            name: sale.name,
            percentOff: sale.percentOff,
            amountOff: sale.amountOff,
            amount: discounted(p.amount, sale),
            duration: sale.duration,
            durationMonths: sale.durationMonths,
            label: `${sale.percentOff ? `${sale.percentOff}% off` : `£${(sale.amountOff / 100).toFixed(0)} off`} ${describeDuration(sale)}`,
            endsAt: sale.endsAt,
          }
        : null,
    });
  }
  const banner = (await activeSales(now))[0] || null;
  return {
    plans: out,
    sale: banner ? { name: banner.name, bannerText: banner.bannerText || banner.name, endsAt: banner.endsAt, plans: banner.plans } : null,
  };
}

// ── Stripe helpers ───────────────────────────────────────────────────────

async function productFor(stripe, productId, priceId, name) {
  if (productId) return productId;
  if (priceId) {
    const price = await stripe.prices.retrieve(priceId);
    return typeof price.product === "string" ? price.product : price.product.id;
  }
  const product = await stripe.products.create({ name });
  return product.id;
}

async function newStripePrice(stripe, { productId, amount, currency, interval, nickname }) {
  const price = await stripe.prices.create({
    product: productId,
    currency,
    unit_amount: amount,
    recurring: { interval },
    nickname,
  });
  return price.id;
}

// ── Admin: edit a plan ───────────────────────────────────────────────────

const TEXT_FIELDS = ["name", "subtitle", "button"];

function validAmount(v) {
  return Number.isInteger(v) && v >= 0 && v <= 100000;
}

/**
 * Apply an admin's changes to a plan. `amount` and `extraSeatAmount` are pence.
 * Returns { plan, priceChanges }.
 */
async function updatePlan(slug, changes = {}, actor = "system") {
  const plan = await Plan.findOne({ slug });
  if (!plan) throw pricingError("Plan not found", 404);

  const set = {};
  for (const f of TEXT_FIELDS) {
    if (changes[f] === undefined) continue;
    const v = String(changes[f]).trim();
    if (f === "name" && !v) throw pricingError("Plan name can't be empty");
    if (v.length > 120) throw pricingError(`${f} is too long`);
    set[f] = v;
  }
  if (changes.features !== undefined) {
    if (!Array.isArray(changes.features) || changes.features.length > 12) throw pricingError("Features must be a list of up to 12 lines");
    set.features = changes.features.map((x) => String(x).trim()).filter(Boolean).map((x) => x.slice(0, 120));
  }
  if (changes.popular !== undefined) set.popular = !!changes.popular;
  if (changes.trialDays !== undefined) {
    const d = Number(changes.trialDays);
    if (!Number.isInteger(d) || d < 0 || d > 90) throw pricingError("Trial days must be 0 to 90");
    set.trialDays = d;
  }
  if (changes.includedSeats !== undefined) {
    if (slug !== "driving-school") throw pricingError("Only the Driving School plan has seats");
    const n = Number(changes.includedSeats);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw pricingError("Included seats must be 1 to 50");
    set.includedSeats = n;
  }

  const priceChanges = [];
  const stripe = (changes.amount !== undefined && changes.amount !== plan.amount) ||
    (changes.extraSeatAmount !== undefined && changes.extraSeatAmount !== plan.extraSeatAmount)
    ? getStripe()
    : null;

  if (changes.amount !== undefined && changes.amount !== plan.amount) {
    const amount = Number(changes.amount);
    if (slug === "pdi") throw pricingError("The PDI plan is free");
    if (!validAmount(amount) || amount < 100) throw pricingError("Price must be at least £1");
    const productId = await productFor(stripe, plan.stripeProductId, plan.stripePriceId, `Donna Drive ${plan.name}`);
    const priceId = await newStripePrice(stripe, {
      productId, amount, currency: plan.currency, interval: plan.interval, nickname: `${plan.name} £${(amount / 100).toFixed(2)}/${plan.interval}`,
    });
    const past = [...new Set([...(plan.pastPriceIds || []), plan.stripePriceId].filter(Boolean))];
    priceChanges.push(await schedule({ plan: slug, kind: "base", fromAmount: plan.amount, toAmount: amount, fromPriceIds: past, toPriceId: priceId, by: actor }));
    Object.assign(set, { amount, stripeProductId: productId, stripePriceId: priceId, pastPriceIds: past });
  }

  if (changes.extraSeatAmount !== undefined && changes.extraSeatAmount !== plan.extraSeatAmount) {
    if (slug !== "driving-school") throw pricingError("Only the Driving School plan has seats");
    const amount = Number(changes.extraSeatAmount);
    if (!validAmount(amount) || amount < 100) throw pricingError("Seat price must be at least £1");
    const productId = await productFor(stripe, plan.extraSeatProductId, plan.extraSeatPriceId, "Extra instructor seat");
    const priceId = await newStripePrice(stripe, {
      productId, amount, currency: plan.currency, interval: plan.interval, nickname: `Extra instructor seat £${(amount / 100).toFixed(2)}/${plan.interval}`,
    });
    const past = [...new Set([...(plan.pastExtraSeatPriceIds || []), plan.extraSeatPriceId].filter(Boolean))];
    priceChanges.push(await schedule({ plan: slug, kind: "seat", fromAmount: plan.extraSeatAmount, toAmount: amount, fromPriceIds: past, toPriceId: priceId, by: actor }));
    Object.assign(set, { extraSeatAmount: amount, extraSeatProductId: productId, extraSeatPriceId: priceId, pastExtraSeatPriceIds: past });
  }

  const updated = await Plan.findOneAndUpdate({ slug }, { $set: set }, { new: true }).lean();

  // Included seats changed: every school's limit follows (their extra seats stay)
  if (set.includedSeats !== undefined && set.includedSeats !== plan.includedSeats) {
    await School.updateMany({}, [{ $set: { seatLimit: { $add: [set.includedSeats, { $ifNull: ["$extraSeats", 0] }] } } }]);
  }

  clearCache();
  await audit(actor, "plan.update", slug, { changes, priceChanges: priceChanges.map((c) => String(c._id)) });
  return { plan: updated, priceChanges };
}

/**
 * Record a price change for existing subscribers. A rise takes effect after the
 * notice period (subscribers are emailed now); a cut takes effect straight away.
 * An earlier change for the same line that hasn't happened yet is replaced.
 */
async function schedule({ plan, kind, fromAmount, toAmount, fromPriceIds, toPriceId, by }) {
  const rise = toAmount > fromAmount;
  const effectiveAt = new Date(Date.now() + (rise ? noticeDays() : 0) * 86400000);
  await PriceChange.updateMany({ plan, kind, status: "scheduled" }, { $set: { status: "cancelled" } });
  const change = await PriceChange.create({ plan, kind, fromAmount, toAmount, fromPriceIds, toPriceId, effectiveAt, by });
  if (rise) {
    change.notified = await notifySubscribers(change).catch((err) => {
      logger.error(`Price change notice failed: ${err.message}`);
      return 0;
    });
    await change.save();
  } else {
    await applyChange(change);
  }
  return change;
}

function subscriberQuery(change) {
  const q = { plan: change.plan, subscriptionId: { $ne: null }, subscriptionStatus: { $in: LIVE_STATUSES }, active: true };
  // School instructors are covered by the owner's subscription
  q.schoolRole = change.kind === "seat" ? "owner" : { $nin: ["member", "manager"] };
  return q;
}

async function notifySubscribers(change) {
  const { sendPriceChangeNotice } = require("../utils/emailNotifier");
  const plan = await getPlan(change.plan);
  const subscribers = await Instructor.find(subscriberQuery(change)).lean();
  let sent = 0;
  for (const s of subscribers) {
    const ok = await sendPriceChangeNotice({
      to: s.email,
      name: s.name,
      planName: plan?.name || change.plan,
      what: change.kind === "seat" ? "price of each extra instructor seat" : "monthly price",
      fromAmount: change.fromAmount,
      toAmount: change.toAmount,
      effectiveAt: change.effectiveAt,
    }).catch(() => false);
    if (ok !== false) sent++;
  }
  return sent;
}

/**
 * Move every live subscription on this line to the new price. Proration is off,
 * so nothing is charged now and the next renewal uses the new price.
 */
async function applyChange(change) {
  const stripe = getStripe();
  const subscribers = await Instructor.find(subscriberQuery(change)).lean();
  let migrated = 0;
  let failed = 0;
  for (const s of subscribers) {
    try {
      const sub = await stripe.subscriptions.retrieve(s.subscriptionId);
      const items = (sub.items?.data || []).filter((i) => change.fromPriceIds.includes(i.price?.id));
      if (!items.length) continue;
      await stripe.subscriptions.update(sub.id, {
        items: items.map((i) => ({ id: i.id, price: change.toPriceId, quantity: i.quantity })),
        proration_behavior: "none",
      });
      migrated++;
    } catch (err) {
      failed++;
      logger.error(`Price change ${change._id}: couldn't move ${s.email}: ${err.message}`);
    }
  }
  change.status = "applied";
  change.appliedAt = new Date();
  change.migrated = migrated;
  change.failed = failed;
  await change.save();
  logger.info(`Price change ${change.plan}/${change.kind} applied: ${migrated} moved, ${failed} failed`);
  return change;
}

/** Hourly: apply any rises whose notice has ended. */
async function applyDuePriceChanges() {
  if (!isDbReady()) return 0;
  const due = await PriceChange.find({ status: "scheduled", effectiveAt: { $lte: new Date() } });
  for (const change of due) await applyChange(change);
  return due.length;
}

async function cancelPriceChange(id, actor) {
  const change = await PriceChange.findOneAndUpdate({ _id: id, status: "scheduled" }, { $set: { status: "cancelled" } }, { new: true });
  if (!change) throw pricingError("Only a scheduled change can be cancelled", 404);
  // New sign-ups stay on the new price; existing subscribers simply aren't moved.
  await audit(actor, "price-change.cancel", id, { plan: change.plan, kind: change.kind });
  return change;
}

// ── Discounts ────────────────────────────────────────────────────────────

function validateDiscount(input) {
  const d = {
    percentOff: input.percentOff != null && input.percentOff !== "" ? Number(input.percentOff) : null,
    amountOff: input.amountOff != null && input.amountOff !== "" ? Number(input.amountOff) : null,
    duration: input.duration || "repeating",
    durationMonths: input.durationMonths != null && input.durationMonths !== "" ? Number(input.durationMonths) : null,
    plans: Array.isArray(input.plans) ? input.plans.filter((p) => ["adi", "driving-school"].includes(p)) : [],
  };
  if ((d.percentOff == null) === (d.amountOff == null)) throw pricingError("Set either a percentage or an amount off");
  if (d.percentOff != null && !(d.percentOff > 0 && d.percentOff <= 100)) throw pricingError("Percentage must be 1 to 100");
  if (d.amountOff != null && !(Number.isInteger(d.amountOff) && d.amountOff > 0)) throw pricingError("Amount off must be in pence and above 0");
  if (!["once", "repeating", "forever"].includes(d.duration)) throw pricingError("Duration must be once, repeating or forever");
  if (d.duration === "repeating" && !(Number.isInteger(d.durationMonths) && d.durationMonths >= 1 && d.durationMonths <= 36)) {
    throw pricingError("Months must be 1 to 36");
  }
  if (d.duration !== "repeating") d.durationMonths = null;
  return d;
}

async function createCoupon(stripe, d, name) {
  const plans = await getPlans();
  const products = plans
    .filter((p) => (d.plans.length ? d.plans.includes(p.slug) : p.amount > 0))
    .flatMap((p) => [p.stripeProductId, p.slug === "driving-school" ? p.extraSeatProductId : null])
    .filter(Boolean);
  const coupon = await stripe.coupons.create({
    name: name.slice(0, 40),
    ...(d.percentOff != null ? { percent_off: d.percentOff } : { amount_off: d.amountOff, currency: "gbp" }),
    duration: d.duration,
    ...(d.duration === "repeating" && { duration_in_months: d.durationMonths }),
    ...(products.length && { applies_to: { products } }),
  });
  return coupon.id;
}

async function createSale(input, actor) {
  const d = validateDiscount(input);
  const name = String(input.name || "").trim();
  if (!name) throw pricingError("Give the sale a name");
  const startsAt = new Date(input.startsAt || Date.now());
  const endsAt = new Date(input.endsAt);
  if (isNaN(startsAt) || isNaN(endsAt) || endsAt <= startsAt) throw pricingError("The end date must be after the start date");
  if (endsAt <= new Date()) throw pricingError("The end date must be in the future");

  await fillProductIds();
  const stripeCouponId = await createCoupon(getStripe(), d, name);
  const sale = await Sale.create({ name, bannerText: String(input.bannerText || "").trim().slice(0, 160), ...d, startsAt, endsAt, stripeCouponId, by: actor });
  clearCache();
  await audit(actor, "sale.create", sale._id, { name, ...d, startsAt, endsAt });
  return sale;
}

/** Name, banner and dates can change; the discount itself can't (end it and make a new one). */
async function updateSale(id, input, actor) {
  const sale = await Sale.findById(id);
  if (!sale) throw pricingError("Sale not found", 404);
  if (input.name !== undefined) sale.name = String(input.name).trim() || sale.name;
  if (input.bannerText !== undefined) sale.bannerText = String(input.bannerText).trim().slice(0, 160);
  if (input.startsAt !== undefined) sale.startsAt = new Date(input.startsAt);
  if (input.endsAt !== undefined) sale.endsAt = new Date(input.endsAt);
  if (input.active !== undefined) sale.active = !!input.active;
  if (isNaN(sale.startsAt) || isNaN(sale.endsAt) || sale.endsAt <= sale.startsAt) throw pricingError("The end date must be after the start date");
  await sale.save();
  clearCache();
  await audit(actor, "sale.update", id, input);
  return sale;
}

/** End a sale now. Customers who already got the discount keep it for its duration. */
async function endSale(id, actor) {
  const sale = await Sale.findByIdAndUpdate(id, { $set: { active: false } }, { new: true });
  if (!sale) throw pricingError("Sale not found", 404);
  clearCache();
  await audit(actor, "sale.end", id, { name: sale.name });
  return sale;
}

async function listSales() {
  return Sale.find({}).sort({ startsAt: -1 }).limit(100).lean();
}

const CODE = /^[A-Z0-9_-]{3,30}$/;

async function createPromoCode(input, actor) {
  const d = validateDiscount({ duration: "once", ...input });
  const code = String(input.code || "").trim().toUpperCase();
  if (!CODE.test(code)) throw pricingError("Codes are 3–30 letters, numbers, - or _");
  if (await PromoCode.findOne({ code })) throw pricingError("That code already exists", 409);
  const maxRedemptions = input.maxRedemptions ? Number(input.maxRedemptions) : null;
  if (maxRedemptions != null && !(Number.isInteger(maxRedemptions) && maxRedemptions > 0)) throw pricingError("Max uses must be a whole number");
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  if (expiresAt && (isNaN(expiresAt) || expiresAt <= new Date())) throw pricingError("The expiry must be in the future");

  await fillProductIds();
  const stripe = getStripe();
  const stripeCouponId = await createCoupon(stripe, d, `Code ${code}`);
  const promo = await stripe.promotionCodes.create({
    coupon: stripeCouponId,
    code,
    ...(maxRedemptions && { max_redemptions: maxRedemptions }),
    ...(expiresAt && { expires_at: Math.floor(expiresAt.getTime() / 1000) }),
  });
  const saved = await PromoCode.create({ code, ...d, maxRedemptions, expiresAt, stripeCouponId, stripePromotionCodeId: promo.id, by: actor });
  await audit(actor, "promo.create", code, { ...d, maxRedemptions, expiresAt });
  return saved;
}

async function deactivatePromoCode(id, actor) {
  const promo = await PromoCode.findById(id);
  if (!promo) throw pricingError("Code not found", 404);
  if (promo.stripePromotionCodeId) await getStripe().promotionCodes.update(promo.stripePromotionCodeId, { active: false });
  promo.active = false;
  await promo.save();
  await audit(actor, "promo.deactivate", promo.code);
  return promo;
}

/** Uses of each code, from Stripe. */
async function listPromoCodes() {
  const codes = await PromoCode.find({}).sort({ createdAt: -1 }).limit(100).lean();
  const stripe = process.env.STRIPE_SECRET_KEY ? getStripe() : null;
  return Promise.all(
    codes.map(async (c) => {
      let timesRedeemed = null;
      if (stripe && c.stripePromotionCodeId) {
        timesRedeemed = await stripe.promotionCodes.retrieve(c.stripePromotionCodeId).then((p) => p.times_redeemed).catch(() => null);
      }
      return { ...c, timesRedeemed };
    })
  );
}

/** Coupons are limited to our products, so make sure we know the product IDs. */
async function fillProductIds() {
  const plans = await Plan.find({ amount: { $gt: 0 } });
  let stripe = null;
  for (const plan of plans) {
    const set = {};
    if (!plan.stripeProductId && plan.stripePriceId) {
      stripe = stripe || getStripe();
      set.stripeProductId = await productFor(stripe, null, plan.stripePriceId).catch(() => null);
    }
    if (!plan.extraSeatProductId && plan.extraSeatPriceId) {
      stripe = stripe || getStripe();
      set.extraSeatProductId = await productFor(stripe, null, plan.extraSeatPriceId).catch(() => null);
    }
    if (Object.values(set).some(Boolean)) await Plan.updateOne({ _id: plan._id }, { $set: set });
  }
  clearCache();
}

/** Checkout discount: an active sale's coupon, otherwise let customers type a code. */
async function checkoutDiscount(slug) {
  const sale = await saleFor(slug);
  if (sale?.stripeCouponId) return { discounts: [{ coupon: sale.stripeCouponId }] };
  return { allow_promotion_codes: true };
}

module.exports = {
  defaultPlans,
  ensurePlans,
  getPlans,
  getPlan,
  includedSeats,
  extraSeatPriceId,
  isBaseItem,
  isSeatItem,
  publicPricing,
  updatePlan,
  applyDuePriceChanges,
  applyChange,
  cancelPriceChange,
  createSale,
  updateSale,
  endSale,
  listSales,
  createPromoCode,
  deactivatePromoCode,
  listPromoCodes,
  checkoutDiscount,
  saleFor,
  discounted,
  noticeDays,
  clearCache,
};
