const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const Instructor = require("../models/instructorSchema");
const { signToken } = require("../utils/jwtSign");
const jwtAuth = require("../middleware/jwtAuth");

const router = express.Router();

// Donna Drive staff role and every permission, for the dashboard to show/hide things
function accessInfo(instructor) {
  const { staffRoleOf, permissionsOf, isSuperAdmin } = require("../services/permissions");
  return { staffRole: staffRoleOf(instructor), superAdmin: isSuperAdmin(instructor), permissions: permissionsOf(instructor) };
}

const { needsPlan } = require("../services/permissions");

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Google apps whose sign-in tokens we accept: the backend's own client, the
// website and Portal sign-in client, and any extra in GOOGLE_SIGNIN_CLIENT_IDS
// (comma-separated). A token issued to any other app is refused, so a token
// from some other site someone signed into with Google can't be replayed here.
const WEB_SIGNIN_CLIENT_ID = "985782225462-p15d627102gkh8fcuafed3mt77k9cufr.apps.googleusercontent.com";
function signInAudiences() {
  return [
    ...new Set(
      [process.env.GOOGLE_CLIENT_ID, WEB_SIGNIN_CLIENT_ID, ...(process.env.GOOGLE_SIGNIN_CLIENT_IDS || "").split(",")]
        .map((id) => (id || "").trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * Who a Google credential belongs to: an ID token (verified, audience checked)
 * or an access token (checked with Google that it was issued to one of our
 * apps). Null if it isn't valid for us. Only verified email addresses count.
 */
async function googleIdentity(credential) {
  const audiences = signInAudiences();
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: audiences });
    const p = ticket.getPayload();
    if (!p?.email || p.email_verified === false) return null;
    return { googleId: p.sub, email: p.email, name: p.name, picture: p.picture };
  } catch {
    // Not an ID token: treat it as an access token
  }

  const info = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(credential)}`, {
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  if (!info?.ok) return null;
  const token = await info.json();
  if (!audiences.includes(token.aud) && !audiences.includes(token.azp)) {
    console.warn(`[authGoogle] Sign-in token issued to another app (${token.aud || token.azp}) was refused`);
    return null;
  }
  if (!token.email || String(token.email_verified) !== "true") return null;

  const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(10000),
  }).catch(() => null);
  const user = userInfoRes?.ok ? await userInfoRes.json() : {};
  // The identity comes from tokeninfo (checked); userinfo only adds a display name
  if (user.sub && user.sub !== token.sub) return null;
  return { googleId: token.sub, email: token.email, name: user.name, picture: user.picture };
}

/**
 * POST /api/auth/google-signup
 * Public — receives Google ID token from frontend, upserts instructor, returns JWT + API key.
 */
router.post("/google-signup", async (req, res) => {
  try {
    // signInOnly: the Portal's sign-in, which must never create an account
    // invite: a launch-waitlist invite token; ref: a referral code from a ?ref= link
    const { credential, plan, signInOnly, invite, ref } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, error: "Missing Google credential" });
    }

    const VALID_PLANS = ["pdi", "adi", "driving-school"];
    const validatedPlan = VALID_PLANS.includes(plan) ? plan : "pdi";

    // Support both ID tokens (from GoogleLogin button) and access tokens (from useGoogleLogin)
    const identity = await googleIdentity(credential);
    if (!identity) {
      return res.status(401).json({ success: false, error: "Invalid Google credential" });
    }
    const { googleId, name, picture } = identity;
    const { email } = identity;

    if (!email) {
      return res.status(400).json({ success: false, error: "Google account has no email" });
    }

    // Upsert instructor by googleId or email
    let instructor = await Instructor.findOne({
      $or: [{ googleId }, { email }],
    });

    let isNew = false;
    let plaintextApiKey = null;

    // The Portal is for instructors who've already signed up on the website
    if (signInOnly && (!instructor || !instructor.active)) {
      return res.status(404).json({
        success: false,
        code: "NOT_REGISTERED",
        error: "There's no Donna Drive instructor account for this Google account yet.",
      });
    }

    if (instructor?.suspended) {
      return res.status(403).json({ success: false, error: "This account has been suspended. Contact support@donnadrive.co.uk." });
    }

    // A deleted account (older deletions only switched it off): finish deleting it
    // so this sign-in starts a fresh account instead of bringing the old one back
    if (instructor && !instructor.active) {
      await require("../services/accountDeletion").deleteAccount(instructor);
      instructor = null;
    }

    // While the launch waitlist is on, new accounts need an invite. Nothing is
    // created; the website turns this into "join the waitlist" (or "you're #142").
    let waitlistEntry = null;
    if (!instructor) {
      const launch = require("../services/launchService");
      const gate = await launch.signupAllowed({ email, inviteToken: invite });
      if (!gate.allowed) {
        return res.status(403).json({
          success: false,
          code: "WAITLIST",
          error: gate.onList
            ? "You're on the waitlist. We'll email you as soon as it's your turn."
            : "We're not open yet. Join the waitlist and we'll email you.",
          onList: gate.onList,
          place: gate.place,
          status: gate.status,
          name: name || "",
          email,
        });
      }
      waitlistEntry = gate.entry;
    }

    if (!instructor) {
      // New instructor — generate API key and placeholder phoneNumberId
      isNew = true;
      const apiKey = `ddp_${crypto.randomBytes(24).toString("hex")}`;
      plaintextApiKey = apiKey;
      const hashedKey = crypto.createHash("sha256").update(apiKey).digest("hex");

      // Signing up again after deleting: a fresh account for them, linked to the
      // old one(s) so admins can see they've come back
      const { previousAccounts } = require("../services/accountDeletion");
      const previous = await previousAccounts({ email, googleId });

      instructor = await Instructor.create({
        googleId,
        email,
        name: name || email.split("@")[0],
        phoneNumberId: `signup_${new mongoose.Types.ObjectId()}`,
        plan: validatedPlan,
        planSelected: false,
        apiKey: hashedKey,
        active: true,
        // New instructors start with Donna packing their day
        botSettings: { scheduleMode: "packed" },
        ...(previous.length && { previousAccountIds: previous }),
      });
      await require("../services/lessonTypes").ensureDefaultLessonTypes(instructor.phoneNumberId);
      if (previous.length) {
        await require("../services/auditLog").audit(email, "account.rejoined", email, { previousAccountIds: previous.map(String) });
      }
      // Their waitlist place is used up; their referral code and referrer carry over
      await require("../services/launchService").onSignup(instructor, { entry: waitlistEntry, ref });
    } else {
      // Existing instructor — update googleId if missing
      if (!instructor.googleId) {
        instructor.googleId = googleId;
      }

      // Always generate a fresh API key on login so the portal has a working key
      const apiKey = `ddp_${crypto.randomBytes(24).toString("hex")}`;
      plaintextApiKey = apiKey;
      instructor.apiKey = crypto.createHash("sha256").update(apiKey).digest("hex");
      await instructor.save();
    }

    // Sign JWT
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      return res.status(500).json({ success: false, error: "JWT_SECRET not configured" });
    }

    const token = signToken(
      { email: instructor.email, instructorId: instructor._id.toString(), googleId },
      jwtSecret
    );

    res.json({
      success: true,
      token,
      apiKey: plaintextApiKey, // only non-null for new signups or first key generation
      instructor: {
        name: instructor.name,
        email: instructor.email,
        plan: instructor.plan || "pdi",
        subscriptionStatus: instructor.subscriptionStatus,
      },
      // Staff land on the admin panel instead of the instructor dashboard
      access: accessInfo(instructor),
      needsPlan: needsPlan(instructor),
      // Their driving school, so the website opens the right home straight away
      school: isNew ? null : await schoolInfo(instructor).catch(() => null),
      isNew,
    });
  } catch (err) {
    console.error("[authGoogle] google-signup error:", err);
    if (err.message?.includes("Token used too late") || err.message?.includes("Invalid token")) {
      return res.status(401).json({ success: false, error: "Invalid or expired Google token" });
    }
    res.status(500).json({ success: false, error: "Authentication failed" });
  }
});

/**
 * GET /api/auth/calendar/connect
 * JWT protected — returns a Google OAuth URL the frontend can redirect to.
 * State encodes the instructor's email so the callback can look them up.
 */
router.get("/calendar/connect", jwtAuth, async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    const { newClient } = require("../config/google");
    const url = newClient().generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/calendar"],
      prompt: "consent",
      // Signed and short-lived: the callback trusts it to say whose calendar this is
      state: require("../utils/oauthState").createState(instructor._id),
    });

    res.json({ success: true, url });
  } catch (err) {
    console.error("[authGoogle] calendar/connect error:", err);
    res.status(500).json({ success: false, error: "Failed to generate auth URL" });
  }
});

/**
 * POST /api/auth/calendar/disconnect
 * JWT protected — removes the stored Google refresh token for this instructor.
 */
router.post("/calendar/disconnect", jwtAuth, async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    // Without a calendar Donna can't see the diary or book, so she goes off too
    // (turning her back on needs a calendar again)
    instructor.googleRefreshToken = null;
    instructor.calendarTokenExpired = false;
    if (instructor.botSettings) instructor.botSettings.donnaEnabled = false;
    else instructor.botSettings = { donnaEnabled: false };
    await instructor.save();

    const { invalidateInstructorCache } = require("../models/instructorModel");
    invalidateInstructorCache(instructor.phoneNumberId);

    res.json({ success: true });
  } catch (err) {
    console.error("[authGoogle] calendar/disconnect error:", err);
    res.status(500).json({ success: false, error: "Failed to disconnect calendar" });
  }
});

/**
 * POST /api/auth/verify
 * JWT protected — verifies token is still valid.
 */
router.post("/verify", jwtAuth, (req, res) => {
  if (!req.user) {
    return res.status(401).json({ success: false, error: "Invalid token" });
  }
  res.json({ success: true, user: req.user });
});

/**
 * GET /api/auth/me
 * JWT protected — returns current instructor profile.
 */
// Which school (if any) this instructor owns or belongs to, for the dashboard nav
async function schoolInfo(instructor) {
  const { SEAT_ROLES, schoolFor } = require("../services/schoolService");
  const school = await schoolFor(instructor, { create: false });
  if (!school) return instructor.plan === "driving-school" && !SEAT_ROLES.includes(instructor.schoolRole) ? { role: "owner", name: null } : null;
  const role = String(school.ownerId) === String(instructor._id) ? "owner" : instructor.schoolRole === "manager" ? "manager" : "member";
  if (role === "owner") return { role, name: school.name };
  // Instructors see who runs their school, and whether the school has Donna on
  const owner = await Instructor.findById(school.ownerId).select("name email").lean().catch(() => null);
  return { role, name: school.name, ownerName: owner?.name || null, ownerEmail: owner?.email || null, donnaEnabled: school.donnaEnabled !== false };
}



/**
 * POST /api/auth/choose-plan
 * JWT protected — picks a free plan (one priced at £0). Paid plans are chosen by finishing Stripe checkout.
 */
router.post("/choose-plan", jwtAuth, async (req, res) => {
  try {
    // Only a free plan (priced £0) can be picked here; anything with a price goes through checkout
    const plan = await require("../services/pricingService").getPlan(String(req.body?.plan || ""));
    if (!plan || plan.amount > 0) {
      return res.status(400).json({ success: false, error: "Paid plans are chosen at checkout", code: "PAID_PLAN" });
    }
    const instructor = await Instructor.findOne({ email: req.user?.email, active: true });
    if (!instructor) return res.status(404).json({ success: false, error: "Instructor not found" });
    // A paying or school account keeps its plan; this only completes a new sign-up
    if (instructor.planSelected === false) {
      instructor.plan = plan.slug;
      instructor.planSelected = true;
      await instructor.save();
    }
    res.json({ success: true, plan: instructor.plan });
  } catch (err) {
    console.error("[authGoogle] choose-plan error:", err);
    res.status(500).json({ success: false, error: "Failed to choose plan" });
  }
});

router.get("/me", jwtAuth, async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    res.json({
      success: true,
      instructor: {
        name: instructor.name,
        email: instructor.email,
        plan: instructor.plan || "pdi",
        subscriptionStatus: instructor.subscriptionStatus,
        calendarConnected: !!instructor.googleRefreshToken,
        whatsappConnected: !!instructor.whatsappToken,
        phoneNumber: instructor.phoneNumberId && !instructor.phoneNumberId.startsWith("signup_") ? instructor.phone : null,
        phoneNumberId: instructor.phoneNumberId,
        timezone: instructor.timezone,
        onboardingComplete: instructor.onboardingComplete,
        onboardingStatus: instructor.onboardingStatus,
        createdAt: instructor.createdAt,
        school: await schoolInfo(instructor),
        access: accessInfo(instructor),
        needsPlan: needsPlan(instructor),
        // Picked a paid plan but didn't finish paying: offer to resume it
        pendingPlan: needsPlan(instructor) && instructor.pendingPlan ? instructor.pendingPlan : null,
        comp: instructor.comp?.plan ? { plan: instructor.comp.plan, until: instructor.comp.until } : null,
      },
    });
  } catch (err) {
    console.error("[authGoogle] /me error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch profile" });
  }
});

router.put("/profile", jwtAuth, async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    const { name, timezone } = req.body;
    if (name !== undefined) {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 100) {
        return res.status(400).json({ success: false, error: "Name must be 1–100 characters" });
      }
      instructor.name = name.trim();
    }
    if (timezone !== undefined) {
      // Only real time zones: anything else would break their diary
      if (typeof timezone !== "string" || !require("moment-timezone").tz.zone(timezone)) {
        return res.status(400).json({ success: false, error: "Unknown time zone" });
      }
      instructor.timezone = timezone;
    }

    await instructor.save();

    res.json({
      success: true,
      instructor: {
        name: instructor.name,
        email: instructor.email,
        timezone: instructor.timezone,
        plan: instructor.plan || "pdi",
        subscriptionStatus: instructor.subscriptionStatus,
      },
    });
  } catch (err) {
    console.error("[authGoogle] profile update error:", err);
    res.status(500).json({ success: false, error: "Failed to update profile" });
  }
});

router.post("/delete-account", jwtAuth, async (req, res) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, error: "Invalid token" });
    }

    const { confirmation } = req.body;
    if (confirmation !== "DELETE") {
      return res.status(400).json({ success: false, error: "Please send { confirmation: \"DELETE\" } to confirm" });
    }

    const instructor = await Instructor.findOne({ email: req.user.email, active: true });
    if (!instructor) {
      return res.status(404).json({ success: false, error: "Instructor not found" });
    }

    if (require("../services/permissions").isSuperAdmin(instructor)) {
      return res.status(403).json({ success: false, error: "A super admin account can't be deleted" });
    }
    if (instructor.schoolRole === "owner") {
      const others = await Instructor.countDocuments({ schoolId: instructor.schoolId, schoolRole: { $in: ["member", "manager"] }, active: true });
      if (others > 0) {
        return res.status(409).json({ success: false, error: "Remove your school's instructors first, then delete your account." });
      }
    }

    // Cancels billing, releases the number and removes their identity, so signing
    // in again with the same Google account starts a new account
    await require("../services/accountDeletion").deleteAccount(instructor);

    res.json({ success: true });
  } catch (err) {
    console.error("[authGoogle] delete-account error:", err);
    res.status(500).json({ success: false, error: "Failed to delete account" });
  }
});

/**
 * POST /api/auth/handoff
 * JWT protected — a one-time code that signs the same instructor in on another
 * Donna Drive site (the Portal's "dashboard" button opens the website, which has
 * its own storage, and an installed Portal app opens it in a separate browser).
 */
router.post("/handoff", jwtAuth, async (req, res) => {
  try {
    const instructor = await Instructor.findOne({ email: req.user?.email, active: true });
    if (!instructor) return res.status(404).json({ success: false, error: "Instructor not found" });

    const AuthCode = require("../models/authCodeModel");
    const code = crypto.randomBytes(32).toString("hex");
    await AuthCode.create({
      code,
      instructorId: instructor._id,
      token: req.headers.authorization.slice("Bearer ".length).trim(),
      expiresAt: new Date(Date.now() + 2 * 60 * 1000),
    });
    res.json({ success: true, code });
  } catch (err) {
    console.error("[authGoogle] handoff error:", err);
    res.status(500).json({ success: false, error: "Couldn't create a sign-in link" });
  }
});

/**
 * POST /api/auth/exchange-code
 * Public — exchanges a one-time auth code for JWT + API key.
 * Used after Stripe checkout redirect.
 */
router.post("/exchange-code", async (req, res) => {
  try {
    const { code, sessionId } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: "Missing auth code" });
    }

    const AuthCode = require("../models/authCodeModel");
    // Claim it in one step, so the same code can never be used twice
    const authCode = await AuthCode.findOneAndUpdate(
      { code: String(code), used: false, expiresAt: { $gt: new Date() } },
      { used: true },
      { new: true }
    );

    if (!authCode) {
      return res.status(401).json({ success: false, error: "Invalid or expired auth code" });
    }

    const instructor = await Instructor.findById(authCode.instructorId);
    // Back from checkout: unlock straight away if Stripe says it finished (the
    // webhook does the same, but may land after they're back on the dashboard)
    if (instructor && instructor.planSelected === false && sessionId) {
      try {
        const stripe = new (require("stripe"))(process.env.STRIPE_SECRET_KEY);
        const session = await stripe.checkout.sessions.retrieve(String(sessionId));
        if (session.status === "complete" && session.client_reference_id === String(instructor._id)) {
          instructor.planSelected = true;
          await instructor.save();
        }
      } catch (err) {
        console.warn("[authGoogle] exchange-code: couldn't check the checkout session:", err.message);
      }
    }

    res.json({
      success: true,
      token: authCode.token,
      apiKey: authCode.apiKey || null,
      instructor: instructor ? {
        name: instructor.name,
        email: instructor.email,
        plan: instructor.plan || "pdi",
        subscriptionStatus: instructor.subscriptionStatus,
      } : null,
    });
  } catch (err) {
    console.error("[authGoogle] exchange-code error:", err);
    res.status(500).json({ success: false, error: "Code exchange failed" });
  }
});

module.exports = router;
