const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const Instructor = require("../models/instructorSchema");
const { signToken } = require("../utils/jwtSign");
const jwtAuth = require("../middleware/jwtAuth");

const router = express.Router();

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /api/auth/google-signup
 * Public — receives Google ID token from frontend, upserts instructor, returns JWT + API key.
 */
router.post("/google-signup", async (req, res) => {
  try {
    const { credential, plan } = req.body;

    if (!credential) {
      return res.status(400).json({ success: false, error: "Missing Google credential" });
    }

    const VALID_PLANS = ["pdi", "adi", "driving-school"];
    const validatedPlan = VALID_PLANS.includes(plan) ? plan : "pdi";

    // Support both ID tokens (from GoogleLogin button) and access tokens (from useGoogleLogin)
    let googleId, email, name, picture;

    try {
      // Try as ID token first
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      const payload = ticket.getPayload();
      ({ sub: googleId, email, name, picture } = payload);
    } catch {
      // Fall back to access token — fetch user info from Google
      const userInfoRes = await fetch(
        "https://www.googleapis.com/oauth2/v3/userinfo",
        { headers: { Authorization: `Bearer ${credential}` } }
      );
      if (!userInfoRes.ok) {
        return res.status(401).json({ success: false, error: "Invalid Google credential" });
      }
      const userInfo = await userInfoRes.json();
      googleId = userInfo.sub;
      email = userInfo.email;
      name = userInfo.name;
      picture = userInfo.picture;
    }

    if (!email) {
      return res.status(400).json({ success: false, error: "Google account has no email" });
    }

    // Upsert instructor by googleId or email
    let instructor = await Instructor.findOne({
      $or: [{ googleId }, { email }],
    });

    let isNew = false;
    let plaintextApiKey = null;

    if (!instructor) {
      // New instructor — generate API key and placeholder phoneNumberId
      isNew = true;
      const apiKey = `ddp_${crypto.randomBytes(24).toString("hex")}`;
      plaintextApiKey = apiKey;
      const hashedKey = crypto.createHash("sha256").update(apiKey).digest("hex");

      instructor = await Instructor.create({
        googleId,
        email,
        name: name || email.split("@")[0],
        phoneNumberId: `signup_${new mongoose.Types.ObjectId()}`,
        plan: validatedPlan,
        apiKey: hashedKey,
        active: true,
      });
    } else {
      // Existing instructor — update googleId if missing
      if (!instructor.googleId) {
        instructor.googleId = googleId;
      }

      if (instructor.suspended) {
        return res.status(403).json({ success: false, error: "This account has been suspended. Contact support@donnadrive.co.uk." });
      }

      // Reactivate if previously soft-deleted
      if (!instructor.active) {
        instructor.active = true;
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

    const { oauth2Client } = require("../config/google");
    const url = oauth2Client.generateAuthUrl({
      access_type: "offline",
      scope: ["https://www.googleapis.com/auth/calendar"],
      prompt: "consent",
      state: `email:${instructor.email}`,
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

    instructor.googleRefreshToken = null;
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
  return { role, name: school.name };
}

// Donna Drive staff role and every permission, for the dashboard to show/hide things
function accessInfo(instructor) {
  const { staffRoleOf, permissionsOf, isSuperAdmin } = require("../services/permissions");
  return { staffRole: staffRoleOf(instructor), superAdmin: isSuperAdmin(instructor), permissions: permissionsOf(instructor) };
}

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
      if (!name || !name.trim()) {
        return res.status(400).json({ success: false, error: "Name cannot be empty" });
      }
      instructor.name = name.trim();
    }
    if (timezone !== undefined) {
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

    // Cancel Stripe subscription if active
    if (instructor.subscriptionId && instructor.stripeCustomerId) {
      try {
        const Stripe = require("stripe");
        const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
        await stripe.subscriptions.cancel(instructor.subscriptionId);
      } catch (stripeErr) {
        console.error("[authGoogle] Stripe cancel error during account deletion:", stripeErr.message);
      }
    }

    // Release phone number back to pool
    const phoneNumberService = require("../services/phoneNumberService");
    if (phoneNumberService.isFullyProvisioned(instructor)) {
      const PhoneNumber = require("../models/phoneNumberModel");
      const pn = await PhoneNumber.findOne({ assignedTo: instructor._id, status: "assigned" });
      if (pn) {
        await phoneNumberService.revokeNumber(pn._id);
      }
    }

    // Soft-delete
    instructor.active = false;
    instructor.apiKey = null;
    await instructor.save();

    res.json({ success: true });
  } catch (err) {
    console.error("[authGoogle] delete-account error:", err);
    res.status(500).json({ success: false, error: "Failed to delete account" });
  }
});

/**
 * POST /api/auth/exchange-code
 * Public — exchanges a one-time auth code for JWT + API key.
 * Used after Stripe checkout redirect.
 */
router.post("/exchange-code", async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) {
      return res.status(400).json({ success: false, error: "Missing auth code" });
    }

    const AuthCode = require("../models/authCodeModel");
    const authCode = await AuthCode.findOne({ code, used: false });

    if (!authCode) {
      return res.status(401).json({ success: false, error: "Invalid or expired auth code" });
    }

    if (authCode.expiresAt < new Date()) {
      return res.status(401).json({ success: false, error: "Auth code expired" });
    }

    authCode.used = true;
    await authCode.save();

    const instructor = await Instructor.findById(authCode.instructorId);

    res.json({
      success: true,
      token: authCode.token,
      apiKey: authCode.apiKey,
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
