const express = require("express");
const jwtAuth = require("../middleware/jwtAuth");
const Instructor = require("../models/instructorSchema");
const School = require("../models/schoolModel");
const schoolService = require("../services/schoolService");
const { sendSchoolInvite } = require("../utils/emailNotifier");
const logger = require("../utils/logger-advanced");

const router = express.Router();

async function me(req) {
  if (!req.user?.email) return null;
  return Instructor.findOne({ email: req.user.email, active: true }).lean();
}

function fail(res, err, what) {
  if (err.userFacing) return res.status(err.status || 400).json({ success: false, error: err.message, ...(err.code && { code: err.code }) });
  logger.error(`School ${what} error: ${err.message}`);
  return res.status(500).json({ success: false, error: `Failed to ${what}` });
}

// ── Public: the join page reads an invite before the instructor signs in ─────
router.get("/invites/:token", async (req, res) => {
  try {
    const info = await schoolService.inviteInfo(req.params.token);
    if (!info) return res.status(404).json({ success: false, error: "This invite has expired or been cancelled." });
    res.json({ success: true, data: info });
  } catch (err) {
    fail(res, err, "load the invite");
  }
});

router.use(jwtAuth);

router.get("/", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    const data = await schoolService.overview(instructor);
    if (!data) return res.status(404).json({ success: false, error: "You're not part of a driving school" });
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "load your school");
  }
});

router.patch("/", async (req, res) => {
  try {
    const instructor = await me(req);
    const school = instructor && (await schoolService.schoolFor(instructor));
    if (!school || String(school.ownerId) !== String(instructor._id)) {
      return res.status(403).json({ success: false, error: "Only the school owner can do that" });
    }
    const name = String(req.body?.name || "").trim();
    if (!name || name.length > 80) return res.status(400).json({ success: false, error: "School name must be 1–80 characters" });
    await School.findByIdAndUpdate(school._id, { name });
    res.json({ success: true, data: await schoolService.overview(instructor) });
  } catch (err) {
    fail(res, err, "rename the school");
  }
});

router.post("/invites", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    const { invite, link, school, alreadySent } = await schoolService.invite(instructor, req.body?.email);
    let emailed = false;
    if (!alreadySent) {
      emailed = await sendSchoolInvite({ to: invite.email, schoolName: school.name, ownerName: instructor.name, link }).catch(() => false);
    }
    res.status(alreadySent ? 200 : 201).json({ success: true, data: { email: invite.email, link, emailed: !!emailed, alreadySent: !!alreadySent } });
  } catch (err) {
    fail(res, err, "send the invite");
  }
});

router.delete("/invites/:id", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    await schoolService.cancelInvite(instructor, req.params.id);
    res.json({ success: true });
  } catch (err) {
    fail(res, err, "cancel the invite");
  }
});

router.post("/invites/:token/accept", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Sign in first" });
    const data = await schoolService.acceptInvite(instructor, req.params.token);
    res.json({ success: true, data });
  } catch (err) {
    fail(res, err, "join the school");
  }
});

// Extra instructor seats beyond the 3 included, £10/month each
router.put("/seats", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    await schoolService.setExtraSeats(instructor, req.body?.extraSeats);
    res.json({ success: true, data: await schoolService.overview(instructor) });
  } catch (err) {
    fail(res, err, "change seats");
  }
});

router.delete("/members/:id", async (req, res) => {
  try {
    const instructor = await me(req);
    if (!instructor) return res.status(401).json({ success: false, error: "Instructor not found" });
    const removed = await schoolService.removeMember(instructor, req.params.id);
    res.json({ success: true, data: removed });
  } catch (err) {
    fail(res, err, "remove the instructor");
  }
});

module.exports = router;
