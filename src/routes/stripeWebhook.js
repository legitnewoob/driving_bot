const { syncMembersSubscription, syncSeatsFromSubscription } = require("../services/schoolService");
const Stripe = require("stripe");
const Instructor = require("../models/instructorSchema");
const ProcessedEvent = require("../models/processedEventModel");

/**
 * POST /api/stripe/webhook
 * Stripe webhook handler — must receive raw body (mounted before express.json()).
 */
async function stripeWebhookHandler(req, res) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers["stripe-signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error("[stripeWebhook] Signature verification failed:", err.message);
    return res.status(400).json({ error: "Webhook signature verification failed" });
  }

  // Idempotency check — skip already-processed events
  try {
    await ProcessedEvent.create({ eventId: event.id });
  } catch (err) {
    if (err.code === 11000) {
      return res.json({ received: true });
    }
    throw err;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const instructorId = session.client_reference_id;
        const plan = session.metadata?.plan;

        if (instructorId) {
          let subStatus = "active";
          let trialEnd = null;
          if (session.subscription) {
            const sub = await stripe.subscriptions.retrieve(session.subscription);
            subStatus = sub.status;
            trialEnd = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
          }
          const instructor = await Instructor.findById(instructorId);
          if (instructor) {
            instructor.subscriptionId = session.subscription;
            instructor.subscriptionStatus = subStatus;
            instructor.trialEndsAt = trialEnd;
            instructor.canceledAt = null;
            instructor.stripeCustomerId = session.customer;
            if (plan) instructor.plan = plan;
            instructor.planSelected = true;
            await instructor.save();
            await syncMembersSubscription(instructor);
            console.log(`[stripeWebhook] Subscription ${subStatus} for instructor ${instructorId}, plan: ${plan}`);
          }
        }
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const instructor = await Instructor.findOne({ stripeCustomerId: customerId });
        if (instructor) {
          instructor.subscriptionStatus = subscription.status;
          instructor.subscriptionId = subscription.id;
          instructor.trialEndsAt = subscription.trial_end ? new Date(subscription.trial_end * 1000) : null;
          await instructor.save();
          await syncMembersSubscription(instructor);
          await syncSeatsFromSubscription(instructor, subscription);
          console.log(`[stripeWebhook] Subscription updated for ${instructor.email}: ${subscription.status}`);
        }
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;
        const customerId = subscription.customer;

        const instructor = await Instructor.findOne({ stripeCustomerId: customerId });
        if (instructor) {
          instructor.subscriptionStatus = "canceled";
          instructor.canceledAt = new Date();
          await instructor.save();
          await syncMembersSubscription(instructor);
          console.log(`[stripeWebhook] Subscription canceled for ${instructor.email}`);
        }
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object;
        const customerId = invoice.customer;
        // A declined one-off charge for trial seats isn't a failed subscription
        // payment: the seat just isn't added, and the school keeps working
        if (invoice.metadata?.kind === "trial-seats") break;

        const instructor = await Instructor.findOne({ stripeCustomerId: customerId });
        if (instructor) {
          instructor.subscriptionStatus = "past_due";
          await instructor.save();
          await syncMembersSubscription(instructor);
          console.log(`[stripeWebhook] Payment failed for ${instructor.email}`);
        }
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object;
        const customerId = invoice.customer;

        const instructor = await Instructor.findOne({ stripeCustomerId: customerId });
        if (instructor && instructor.subscriptionStatus === "past_due") {
          instructor.subscriptionStatus = "active";
          await instructor.save();
          await syncMembersSubscription(instructor);
          console.log(`[stripeWebhook] Payment recovered for ${instructor.email}`);
        }
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object;
        const instructorId = session.client_reference_id;

        if (instructorId) {
          const instructor = await Instructor.findById(instructorId);
          if (instructor && !instructor.subscriptionId) {
            instructor.plan = "pdi";
            await instructor.save();
            await syncMembersSubscription(instructor);
            console.log(`[stripeWebhook] Checkout expired, reverted plan for instructor ${instructorId}`);
          }
        }
        break;
      }

      default:
        // Unhandled event type — ignore silently
        break;
    }
  } catch (err) {
    console.error(`[stripeWebhook] Error handling ${event.type}:`, err);
    return res.status(500).json({ error: "Webhook handler failed" });
  }

  res.json({ received: true });
}

module.exports = stripeWebhookHandler;
