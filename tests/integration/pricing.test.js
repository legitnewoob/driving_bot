/**
 * Plans, price changes, sales and promo codes (admin-managed pricing).
 * New sign-ups get a new price at once; existing subscribers move at renewal,
 * after notice for a rise.
 */
jest.mock("../../src/utils/logger-advanced", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../../src/utils/db", () => ({ isDbReady: jest.fn(() => true) }));
jest.mock("../../src/models/planModel");
jest.mock("../../src/models/priceChangeModel");
jest.mock("../../src/models/saleModel");
jest.mock("../../src/models/promoCodeModel");
jest.mock("../../src/models/schoolModel");
jest.mock("../../src/models/instructorSchema");
jest.mock("../../src/services/auditLog", () => ({ audit: jest.fn() }));
jest.mock("../../src/utils/emailNotifier", () => ({ sendPriceChangeNotice: jest.fn().mockResolvedValue(true) }));
const mockStripe = {
  prices: { create: jest.fn(), retrieve: jest.fn() },
  products: { create: jest.fn() },
  subscriptions: { retrieve: jest.fn(), update: jest.fn() },
  coupons: { create: jest.fn() },
  promotionCodes: { create: jest.fn(), update: jest.fn(), retrieve: jest.fn() },
};
jest.mock("stripe", () => jest.fn(() => mockStripe));

const Plan = require("../../src/models/planModel");
const PriceChange = require("../../src/models/priceChangeModel");
const Sale = require("../../src/models/saleModel");
const PromoCode = require("../../src/models/promoCodeModel");
const School = require("../../src/models/schoolModel");
const Instructor = require("../../src/models/instructorSchema");
const { sendPriceChangeNotice } = require("../../src/utils/emailNotifier");
const pricing = require("../../src/services/pricingService");

const DAY = 86400000;
const adi = (extra = {}) => ({
  _id: "p-adi", slug: "adi", name: "ADI", amount: 1000, currency: "gbp", interval: "month", trialDays: 30,
  stripeProductId: "prod_adi", stripePriceId: "price_adi_10", pastPriceIds: [], sortOrder: 1, features: [], ...extra,
});
const school = (extra = {}) => ({
  _id: "p-school", slug: "driving-school", name: "Driving Schools", amount: 2000, currency: "gbp", interval: "month", trialDays: 30,
  stripeProductId: "prod_school", stripePriceId: "price_school_20", pastPriceIds: [], includedSeats: 3,
  extraSeatAmount: 1000, extraSeatProductId: "prod_seat", extraSeatPriceId: "price_seat_10", pastExtraSeatPriceIds: [], sortOrder: 2, features: [], ...extra,
});
const pdi = () => ({ _id: "p-pdi", slug: "pdi", name: "PDI", amount: 0, sortOrder: 0, features: [] });

function plans(list = [pdi(), adi(), school()]) {
  Plan.find.mockReturnValue({ sort: () => ({ lean: async () => list }) });
}
function sales(list = []) {
  Sale.find.mockReturnValue({ sort: () => ({ lean: async () => list }) });
}
const lean = (v) => ({ lean: async () => v });

beforeEach(() => {
  jest.clearAllMocks();
  pricing.clearCache();
  plans();
  sales();
  Instructor.find.mockReturnValue(lean([]));
  PriceChange.updateMany.mockResolvedValue({});
  PriceChange.create.mockImplementation(async (doc) => ({ _id: "pc-1", ...doc, save: jest.fn() }));
  Plan.findOneAndUpdate.mockImplementation((q, u) => lean({ ...u.$set }));
  mockStripe.prices.create.mockResolvedValue({ id: "price_new" });
  mockStripe.coupons.create.mockResolvedValue({ id: "coupon_1" });
  mockStripe.promotionCodes.create.mockResolvedValue({ id: "promo_1" });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("plans", () => {
  it("creates the default plans on first start, with env price IDs", async () => {
    process.env.STRIPE_PRICE_ADI = "price_env_adi";
    Plan.findOne.mockResolvedValue(null);
    await pricing.ensurePlans();
    expect(Plan.create).toHaveBeenCalledTimes(3);
    expect(Plan.create).toHaveBeenCalledWith(expect.objectContaining({ slug: "adi", amount: 1000, stripePriceId: "price_env_adi" }));
    expect(Plan.create).toHaveBeenCalledWith(expect.objectContaining({ slug: "driving-school", amount: 2000, includedSeats: 3, extraSeatAmount: 1000 }));
    delete process.env.STRIPE_PRICE_ADI;
  });

  it("doesn't overwrite plans an admin has edited", async () => {
    Plan.findOne.mockResolvedValue({ _id: "x", stripePriceId: "price_admin", extraSeatPriceId: "price_seat" });
    await pricing.ensurePlans();
    expect(Plan.create).not.toHaveBeenCalled();
    expect(Plan.updateOne).not.toHaveBeenCalled();
  });

  it("the included seats come from the school plan", async () => {
    plans([school({ includedSeats: 5 })]);
    expect(await pricing.includedSeats()).toBe(5);
  });

  it("recognises old and new seat prices on a subscription", () => {
    const p = school({ pastExtraSeatPriceIds: ["price_seat_8"] });
    expect(pricing.isSeatItem({ price: { id: "price_seat_10" } }, p)).toBe(true);
    expect(pricing.isSeatItem({ price: { id: "price_seat_8" } }, p)).toBe(true);
    expect(pricing.isSeatItem({ price: { id: "price_other", product: "prod_seat" } }, p)).toBe(true);
    expect(pricing.isSeatItem({ price: { id: "price_school_20", product: "prod_school" } }, p)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("changing a price", () => {
  beforeEach(() => {
    Plan.findOne.mockResolvedValue(adi());
  });

  it("text-only edits don't touch Stripe", async () => {
    await pricing.updatePlan("adi", { subtitle: "For ADIs", features: ["A", " ", "B"], trialDays: 14 }, "raj");
    expect(mockStripe.prices.create).not.toHaveBeenCalled();
    expect(Plan.findOneAndUpdate).toHaveBeenCalledWith({ slug: "adi" }, { $set: { subtitle: "For ADIs", features: ["A", "B"], trialDays: 14 } }, { new: true });
  });

  it("a rise makes a new Stripe price for new sign-ups and gives existing subscribers notice", async () => {
    Instructor.find.mockReturnValue(lean([{ email: "a@x.com", name: "Ann Lee" }, { email: "b@x.com", name: "Bo" }]));
    const before = Date.now();
    const { plan, priceChanges } = await pricing.updatePlan("adi", { amount: 1200 }, "raj");

    expect(mockStripe.prices.create).toHaveBeenCalledWith(expect.objectContaining({
      product: "prod_adi", unit_amount: 1200, currency: "gbp", recurring: { interval: "month" },
    }));
    expect(plan).toMatchObject({ amount: 1200, stripePriceId: "price_new", pastPriceIds: ["price_adi_10"] });

    const change = priceChanges[0];
    expect(change).toMatchObject({ plan: "adi", kind: "base", fromAmount: 1000, toAmount: 1200, fromPriceIds: ["price_adi_10"], toPriceId: "price_new" });
    expect(change.effectiveAt.getTime()).toBeGreaterThanOrEqual(before + 30 * DAY - 1000);
    expect(sendPriceChangeNotice).toHaveBeenCalledTimes(2);
    expect(sendPriceChangeNotice).toHaveBeenCalledWith(expect.objectContaining({ to: "a@x.com", fromAmount: 1000, toAmount: 1200 }));
    // Nobody is moved yet
    expect(mockStripe.subscriptions.update).not.toHaveBeenCalled();
  });

  it("the notice period comes from PRICE_RISE_NOTICE_DAYS", async () => {
    process.env.PRICE_RISE_NOTICE_DAYS = "14";
    const before = Date.now();
    const { priceChanges } = await pricing.updatePlan("adi", { amount: 1500 }, "raj");
    expect(priceChanges[0].effectiveAt.getTime()).toBeLessThan(before + 15 * DAY);
    delete process.env.PRICE_RISE_NOTICE_DAYS;
  });

  it("a cut moves existing subscribers straight away, from their next renewal (no proration)", async () => {
    Instructor.find.mockReturnValue(lean([{ email: "a@x.com", subscriptionId: "sub_a" }]));
    mockStripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_a", items: { data: [{ id: "si_1", price: { id: "price_adi_10" }, quantity: 1 }] } });
    const { priceChanges } = await pricing.updatePlan("adi", { amount: 800 }, "raj");
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_a", {
      items: [{ id: "si_1", price: "price_new", quantity: 1 }],
      proration_behavior: "none",
    });
    expect(priceChanges[0]).toMatchObject({ status: "applied", migrated: 1, failed: 0 });
    expect(sendPriceChangeNotice).not.toHaveBeenCalled();
  });

  it("only moves people who pay for themselves (not school instructors)", async () => {
    await pricing.updatePlan("adi", { amount: 800 }, "raj");
    expect(Instructor.find).toHaveBeenCalledWith(expect.objectContaining({
      plan: "adi", schoolRole: { $nin: ["member", "manager"] }, subscriptionStatus: { $in: ["active", "trialing", "past_due"] },
    }));
  });

  it("a second change before the first applies replaces it, and both old prices are moved", async () => {
    Plan.findOne.mockResolvedValue(adi({ stripePriceId: "price_adi_12", pastPriceIds: ["price_adi_10"] }));
    const { priceChanges } = await pricing.updatePlan("adi", { amount: 1300 }, "raj");
    expect(PriceChange.updateMany).toHaveBeenCalledWith({ plan: "adi", kind: "base", status: "scheduled" }, { $set: { status: "cancelled" } });
    expect(priceChanges[0].fromPriceIds).toEqual(["price_adi_10", "price_adi_12"]);
  });

  it("one failed subscription doesn't stop the rest", async () => {
    Instructor.find.mockReturnValue(lean([{ email: "a@x.com", subscriptionId: "sub_a" }, { email: "b@x.com", subscriptionId: "sub_b" }]));
    mockStripe.subscriptions.retrieve
      .mockRejectedValueOnce(new Error("No such subscription"))
      .mockResolvedValueOnce({ id: "sub_b", items: { data: [{ id: "si_b", price: { id: "price_adi_10" }, quantity: 1 }] } });
    const { priceChanges } = await pricing.updatePlan("adi", { amount: 900 }, "raj");
    expect(priceChanges[0]).toMatchObject({ migrated: 1, failed: 1 });
  });

  it("the seat price changes the extra-seat line on school owners' subscriptions", async () => {
    Plan.findOne.mockResolvedValue(school());
    Instructor.find.mockReturnValue(lean([{ email: "o@x.com", subscriptionId: "sub_o" }]));
    mockStripe.subscriptions.retrieve.mockResolvedValue({ id: "sub_o", items: { data: [
      { id: "si_base", price: { id: "price_school_20" }, quantity: 1 },
      { id: "si_seat", price: { id: "price_seat_10" }, quantity: 2 },
    ] } });
    await pricing.updatePlan("driving-school", { extraSeatAmount: 800 }, "raj");
    expect(Instructor.find).toHaveBeenCalledWith(expect.objectContaining({ schoolRole: "owner" }));
    expect(mockStripe.subscriptions.update).toHaveBeenCalledWith("sub_o", {
      items: [{ id: "si_seat", price: "price_new", quantity: 2 }], proration_behavior: "none",
    });
  });

  it("changing included seats updates every school's limit", async () => {
    Plan.findOne.mockResolvedValue(school());
    await pricing.updatePlan("driving-school", { includedSeats: 4 }, "raj");
    expect(School.updateMany).toHaveBeenCalledWith({}, [{ $set: { seatLimit: { $add: [4, { $ifNull: ["$extraSeats", 0] }] } } }]);
  });

  it.each([
    [{ amount: 50 }, "at least £1"],
    [{ amount: 12.5 }, "at least £1"],
    [{ trialDays: 120 }, "0 to 90"],
    [{ name: " " }, "can't be empty"],
    [{ includedSeats: 4 }, "Only the Driving School plan has seats"],
  ])("rejects %p", async (changes, message) => {
    await expect(pricing.updatePlan("adi", changes, "raj")).rejects.toThrow(message);
  });

  it("the free plan can't be priced", async () => {
    Plan.findOne.mockResolvedValue(pdi());
    await expect(pricing.updatePlan("pdi", { amount: 500 }, "raj")).rejects.toThrow("free");
  });

  it("the hourly job applies rises whose notice has ended", async () => {
    const change = { _id: "pc-9", plan: "adi", kind: "base", fromPriceIds: ["price_adi_10"], toPriceId: "price_adi_12", save: jest.fn() };
    PriceChange.find.mockResolvedValue([change]);
    expect(await pricing.applyDuePriceChanges()).toBe(1);
    expect(change.status).toBe("applied");
    expect(PriceChange.find).toHaveBeenCalledWith({ status: "scheduled", effectiveAt: { $lte: expect.any(Date) } });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("sales", () => {
  const now = Date.now();
  const xmas = (extra = {}) => ({
    name: "Christmas", bannerText: "🎄 30% off for 3 months", percentOff: 30, amountOff: null, duration: "repeating", durationMonths: 3,
    plans: ["adi"], startsAt: new Date(now - DAY), endsAt: new Date(now + 10 * DAY), stripeCouponId: "coupon_x", active: true, ...extra,
  });

  it("the pricing page shows the sale price and a banner", async () => {
    sales([xmas()]);
    const { plans: list, sale } = await pricing.publicPricing();
    const a = list.find((p) => p.slug === "adi");
    expect(a.amount).toBe(1000);
    expect(a.sale).toMatchObject({ amount: 700, label: "30% off for 3 months" });
    expect(list.find((p) => p.slug === "driving-school").sale).toBeNull();
    expect(sale).toMatchObject({ bannerText: "🎄 30% off for 3 months" });
  });

  it("a sale that hasn't started isn't shown", async () => {
    sales([xmas({ startsAt: new Date(now + DAY) })]);
    const { plans: list, sale } = await pricing.publicPricing();
    expect(list.find((p) => p.slug === "adi").sale).toBeNull();
    expect(sale).toBeNull();
  });

  it("a sale with no plans chosen covers every paid plan", async () => {
    sales([xmas({ plans: [], percentOff: null, amountOff: 500, duration: "once" })]);
    const { plans: list } = await pricing.publicPricing();
    expect(list.find((p) => p.slug === "driving-school").sale).toMatchObject({ amount: 1500, label: "£5 off for your first month" });
    expect(list.find((p) => p.slug === "pdi").sale).toBeNull();
  });

  it("checkout applies the sale's coupon; with no sale, customers can type a code", async () => {
    sales([xmas()]);
    expect(await pricing.checkoutDiscount("adi")).toEqual({ discounts: [{ coupon: "coupon_x" }] });
    expect(await pricing.checkoutDiscount("driving-school")).toEqual({ allow_promotion_codes: true });
  });

  it("creating a sale makes a Stripe coupon limited to the chosen plans' products", async () => {
    Plan.find.mockImplementation((q) => (q && q.amount ? Promise.resolve([]) : { sort: () => ({ lean: async () => [pdi(), adi(), school()] }) }));
    Sale.create.mockImplementation(async (d) => ({ _id: "sale-1", ...d }));
    await pricing.createSale({
      name: "Christmas", percentOff: 30, duration: "repeating", durationMonths: 3, plans: ["driving-school"],
      startsAt: new Date(now).toISOString(), endsAt: new Date(now + 20 * DAY).toISOString(),
    }, "raj");
    expect(mockStripe.coupons.create).toHaveBeenCalledWith({
      name: "Christmas", percent_off: 30, duration: "repeating", duration_in_months: 3,
      applies_to: { products: ["prod_school", "prod_seat"] },
    });
    expect(Sale.create).toHaveBeenCalledWith(expect.objectContaining({ stripeCouponId: "coupon_1", plans: ["driving-school"] }));
  });

  it.each([
    [{ name: "X", endsAt: new Date(now + DAY) }, "either a percentage or an amount"],
    [{ name: "X", percentOff: 30, amountOff: 500, endsAt: new Date(now + DAY) }, "either a percentage or an amount"],
    [{ name: "X", percentOff: 130, endsAt: new Date(now + DAY) }, "1 to 100"],
    [{ name: "X", percentOff: 30, duration: "repeating", endsAt: new Date(now + DAY) }, "Months must be 1 to 36"],
    [{ name: "X", percentOff: 30, duration: "once", endsAt: new Date(now - DAY) }, "end date must be"],
    [{ percentOff: 30, duration: "once", endsAt: new Date(now + DAY) }, "name"],
  ])("rejects %p", async (input, message) => {
    await expect(pricing.createSale(input, "raj")).rejects.toThrow(message);
    expect(mockStripe.coupons.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("promo codes", () => {
  beforeEach(() => {
    Plan.find.mockImplementation((q) => (q && q.amount ? Promise.resolve([]) : { sort: () => ({ lean: async () => [pdi(), adi(), school()] }) }));
    PromoCode.findOne.mockResolvedValue(null);
    PromoCode.create.mockImplementation(async (d) => ({ _id: "code-1", ...d }));
  });

  it("creates a Stripe promotion code with limits", async () => {
    const expires = new Date(Date.now() + 5 * DAY);
    await pricing.createPromoCode({ code: "diwali25", percentOff: 25, maxRedemptions: 50, expiresAt: expires.toISOString() }, "raj");
    expect(mockStripe.coupons.create).toHaveBeenCalledWith(expect.objectContaining({ percent_off: 25, duration: "once" }));
    expect(mockStripe.promotionCodes.create).toHaveBeenCalledWith({
      promotion: { type: "coupon", coupon: "coupon_1" }, code: "DIWALI25", max_redemptions: 50, expires_at: Math.floor(expires.getTime() / 1000),
    });
    expect(PromoCode.create).toHaveBeenCalledWith(expect.objectContaining({ code: "DIWALI25", stripePromotionCodeId: "promo_1" }));
  });

  it("rejects bad or duplicate codes", async () => {
    await expect(pricing.createPromoCode({ code: "a b", percentOff: 10 }, "raj")).rejects.toThrow("3–30 letters");
    PromoCode.findOne.mockResolvedValue({ code: "SAVE" });
    await expect(pricing.createPromoCode({ code: "save", percentOff: 10 }, "raj")).rejects.toMatchObject({ status: 409 });
  });

  it("deactivating turns it off in Stripe too", async () => {
    const promo = { code: "SAVE", stripePromotionCodeId: "promo_1", save: jest.fn() };
    PromoCode.findById.mockResolvedValue(promo);
    await pricing.deactivatePromoCode("code-1", "raj");
    expect(mockStripe.promotionCodes.update).toHaveBeenCalledWith("promo_1", { active: false });
    expect(promo.active).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
describe("extra seat price", () => {
  beforeEach(() => { process.env.STRIPE_SECRET_KEY = "sk_test"; });
  afterEach(() => { delete process.env.STRIPE_SECRET_KEY; });

  it("uses the plan's seat price when it has one", async () => {
    expect(await pricing.ensureExtraSeatPrice()).toBe("price_seat_10");
    expect(mockStripe.prices.create).not.toHaveBeenCalled();
  });

  it("creates the seat price in Stripe the first time, and saves it on the plan", async () => {
    plans([pdi(), adi(), school({ extraSeatPriceId: null, extraSeatProductId: null })]);
    mockStripe.products.create.mockResolvedValue({ id: "prod_seat_new" });
    Plan.updateOne.mockResolvedValue({});
    expect(await pricing.ensureExtraSeatPrice()).toBe("price_new");
    expect(mockStripe.prices.create).toHaveBeenCalledWith(expect.objectContaining({ product: "prod_seat_new", unit_amount: 1000, currency: "gbp", recurring: { interval: "month" } }));
    expect(Plan.updateOne).toHaveBeenCalledWith({ _id: "p-school" }, { $set: { extraSeatProductId: "prod_seat_new", extraSeatPriceId: "price_new" } });
  });
});
