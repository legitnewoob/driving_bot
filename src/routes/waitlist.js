const express = require("express");
const rateLimit = require("express-rate-limit");
const launch = require("../services/launchService");
const logger = require("../utils/logger-advanced");

const router = express.Router();

// Joining and answering questions: generous for real people, tight for scripts
const joinLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: process.env.NODE_ENV === "test" ? 1000 : 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many attempts. Please try again later." },
});

function fail(res, err, what) {
  if (err.userFacing) return res.status(err.status || 400).json({ success: false, error: err.message, ...(err.code && { code: err.code }) });
  logger.error(`Waitlist ${what} error: ${err.message}`);
  return res.status(500).json({ success: false, error: `Couldn't ${what}. Please try again.` });
}

/**
 * GET /api/launch
 * Public: the site's mode (waitlist / invite / open), launch date, banner and how many are waiting.
 */
router.get("/launch", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=30");
    res.json({ success: true, data: await launch.publicLaunch() });
  } catch (err) {
    fail(res, err, "load the launch details");
  }
});

/** POST /api/waitlist — join. Hidden `website` field is a honeypot. */
router.post("/waitlist", joinLimiter, async (req, res) => {
  try {
    const { website, ...input } = req.body || {};
    if (website) return res.status(201).json({ success: true, data: { created: true, entry: { place: 1 } } });
    const result = await launch.join(input);
    res.status(result.created ? 201 : 200).json({ success: true, data: result });
  } catch (err) {
    fail(res, err, "add you to the waitlist");
  }
});

/** GET /api/waitlist/me?t=… — their place, referrals and share link. */
router.get("/waitlist/me", async (req, res) => {
  try {
    res.json({ success: true, data: await launch.status(String(req.query.t || "")) });
  } catch (err) {
    fail(res, err, "load your place");
  }
});

/** PATCH /api/waitlist/me?t=… — the optional "help us get you in sooner" answers. */
router.patch("/waitlist/me", joinLimiter, async (req, res) => {
  try {
    res.json({ success: true, data: await launch.updateProfile(String(req.query.t || ""), req.body || {}) });
  } catch (err) {
    fail(res, err, "save your answers");
  }
});

/** GET /api/waitlist/invite/:token — the /join page checks its invite. */
router.get("/waitlist/invite/:token", async (req, res) => {
  try {
    res.json({ success: true, data: await launch.inviteInfo(req.params.token) });
  } catch (err) {
    fail(res, err, "check the invite");
  }
});

const unsubscribedPage = (ok) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Donna Drive</title></head>
<body style="font-family:-apple-system,Segoe UI,Arial,sans-serif;display:flex;min-height:90vh;align-items:center;justify-content:center;color:#1f2937;padding:16px;">
<div style="max-width:420px;text-align:center;"><h1 style="font-size:22px;">${ok ? "You're unsubscribed" : "Link not recognised"}</h1>
<p style="color:#6b7280;">${ok ? "We won't send you any more reminders or news. You keep your place on the waitlist, and we'll still email you your invite when it's your turn." : "This unsubscribe link isn't valid any more. Reply to any of our emails and we'll sort it out."}</p></div></body></html>`;

/**
 * GET and POST /api/waitlist/unsubscribe/:token — the link in emails, and the
 * one-click List-Unsubscribe POST that mail apps send.
 */
router.get("/waitlist/unsubscribe/:token", async (req, res) => {
  const ok = await launch.unsubscribe(req.params.token).catch(() => false);
  res.status(ok ? 200 : 404).type("html").send(unsubscribedPage(ok));
});
router.post("/waitlist/unsubscribe/:token", async (req, res) => {
  const ok = await launch.unsubscribe(req.params.token).catch(() => false);
  res.status(ok ? 200 : 404).json({ success: ok });
});

module.exports = router;
