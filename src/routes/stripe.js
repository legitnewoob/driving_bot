const express = require("express");
const crypto = require("crypto");
const Stripe = require("stripe");
const Instructor = require("../models/instructorSchema");
const AuthCode = require("../models/authCodeModel");
const { signToken } = require("../utils/jwtSign");
const pricing = require("../services/pricingService");

const router = express.Router();

function getStripe() {
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

const PAID_PLANS = ["adi", "driving-school"];

/**
 * POST /api/stripe/create-checkout-session
 * JWT protected — creates a Stripe Checkout session for a paid plan.
 */
router.post("/create-checkout-session", async (req, res) => {
  try {
    // embedded: true → Stripe's checkout shown in a modal on the dashboard
    const { plan, embedded } = req.body;

    if (!plan || !PAID_PLANS.includes(plan)) {
      return res.status(400).json({ success: false, error: "Invalid plan. Must be 'adi' or 'driving-school'" });
    }

    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const stripe = getStripe();
    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    if (["member", "manager"].includes(instructor.schoolRole)) {
      return res.status(400).json({ success: false, error: "Your driving school covers your subscription, so there's nothing to pay." });
    }

    if (instructor.comp?.plan && (!instructor.comp.until || instructor.comp.until > new Date())) {
      return res.status(400).json({ success: false, error: "You have free access from Donna Drive, so there's nothing to pay." });
    }

    const planConfig = await pricing.getPlan(plan);
    if (!planConfig?.stripePriceId) {
      return res.status(503).json({ success: false, error: "This plan isn't available to buy right now" });
    }

    if (instructor.subscriptionId && ["active", "trialing"].includes(instructor.subscriptionStatus)) {
      return res.status(400).json({ success: false, error: "You already have an active subscription" });
    }

    // Create or retrieve Stripe Customer
    let customerId = instructor.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: instructor.email,
        name: instructor.name,
        metadata: { instructorId: instructor._id.toString() },
      });
      customerId = customer.id;
      instructor.stripeCustomerId = customerId;
      await instructor.save();
    } else {
      // Ask Stripe, not just our DB: the DB only learns about a subscription when
      // the webhook arrives, so a second checkout before then would double-subscribe.
      const existing = await stripe.subscriptions.list({ customer: customerId, status: "all", limit: 20 });
      const live = existing.data.find((sub) => ["active", "trialing", "past_due", "unpaid", "incomplete"].includes(sub.status));
      if (live) {
        if (instructor.subscriptionId !== live.id || instructor.subscriptionStatus !== live.status) {
          instructor.subscriptionId = live.id;
          instructor.subscriptionStatus = live.status;
          await instructor.save();
        }
        return res.status(400).json({
          success: false,
          error: "You already have a subscription. Manage it from Account → Manage Subscription.",
        });
      }
    }

    // Generate fresh JWT and API key
    const token = signToken(
      { email: instructor.email, instructorId: instructor._id.toString() },
      process.env.JWT_SECRET
    );

    const apiKey = `ddp_${crypto.randomBytes(24).toString("hex")}`;
    instructor.apiKey = crypto.createHash("sha256").update(apiKey).digest("hex");
    await instructor.save();

    // Store credentials in a short-lived one-time auth code (not in the URL)
    const authCode = crypto.randomBytes(32).toString("hex");
    await AuthCode.create({
      code: authCode,
      instructorId: instructor._id,
      token,
      apiKey,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000),
    });

    const portalUrl = process.env.PORTAL_URL || "http://localhost:5174";
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";

    // session_id lets the sign-in step check with Stripe that checkout really finished
    const successUrl = `${frontendUrl}/get-onboard?auth_code=${authCode}&session_id={CHECKOUT_SESSION_ID}`;

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId,
      line_items: [
        {
          price: planConfig.stripePriceId,
          quantity: 1,
        },
      ],
      // An active sale's coupon, or a box for promo codes (Stripe allows one or the other)
      ...(await pricing.checkoutDiscount(plan)),
      subscription_data: planConfig.trialDays > 0 ? { trial_period_days: planConfig.trialDays } : {},
      ...(embedded
        ? { ui_mode: "embedded_page", return_url: successUrl }
        : {
            success_url: successUrl,
            // Backing out returns to the dashboard, which stays locked behind the plan picker until they pay
            cancel_url: `${frontendUrl}/get-onboard`,
          }),
      client_reference_id: instructor._id.toString(),
      metadata: {
        plan,
        instructorEmail: instructor.email,
      },
    });

    // Update the plan on the instructor (will be confirmed by webhook)
    instructor.plan = plan;
    await instructor.save();

    res.json({ success: true, url: session.url || null, clientSecret: session.client_secret || null });
  } catch (err) {
    console.error("[stripe] create-checkout-session error:", err);
    res.status(500).json({ success: false, error: "Failed to create checkout session" });
  }
});

/**
 * GET /api/stripe/subscription-status
 * JWT protected — returns current subscription info.
 */
router.get("/subscription-status", async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true }).lean();
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    res.json({
      success: true,
      plan: instructor.plan || "pdi",
      subscriptionStatus: instructor.subscriptionStatus,
      subscriptionId: instructor.subscriptionId,
    });
  } catch (err) {
    console.error("[stripe] subscription-status error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch subscription status" });
  }
});

router.post("/create-portal-session", async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true }).lean();
    if (!instructor || !instructor.stripeCustomerId) {
      return res.status(400).json({ success: false, error: "No billing account found. Please subscribe first." });
    }

    const stripe = getStripe();
    const portalUrl = process.env.PORTAL_URL || "http://localhost:5173";

    const session = await stripe.billingPortal.sessions.create({
      customer: instructor.stripeCustomerId,
      return_url: portalUrl,
    });

    res.json({ success: true, url: session.url || null, clientSecret: session.client_secret || null });
  } catch (err) {
    console.error("[stripe] create-portal-session error:", err);
    res.status(500).json({ success: false, error: "Failed to create portal session" });
  }
});

router.get("/invoices", async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true }).lean();
    if (!instructor?.stripeCustomerId) {
      return res.json({ success: true, invoices: [] });
    }

    const stripe = getStripe();
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    const invoices = await stripe.invoices.list({
      customer: instructor.stripeCustomerId,
      limit,
    });

    const data = invoices.data.map(inv => ({
      id: inv.id,
      amount: inv.amount_paid / 100,
      currency: inv.currency,
      status: inv.status,
      date: new Date(inv.created * 1000).toISOString(),
      pdfUrl: inv.invoice_pdf,
      hostedUrl: inv.hosted_invoice_url,
      description: inv.lines?.data?.[0]?.description || "",
    }));

    res.json({ success: true, invoices: data });
  } catch (err) {
    console.error("[stripe] invoices error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch invoices" });
  }
});

module.exports = router;
