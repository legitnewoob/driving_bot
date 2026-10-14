const Instructor = require("../models/instructorSchema");
const { needsPlan } = require("../services/permissions");

/**
 * After jwtAuth / apiKeyAuth: refuse instructors who signed up but haven't
 * picked a plan yet, so closing the plan picker doesn't get them in.
 */
async function requirePlan(req, res, next) {
  try {
    let person = req.instructor;
    if (!person && req.user?.email) {
      person = await Instructor.findOne({ email: req.user.email, active: true }, { email: 1, planSelected: 1, staffRole: 1 }).lean();
    }
    if (needsPlan(person)) {
      return res.status(403).json({ success: false, error: "Choose a plan to start using Donna Drive.", code: "PLAN_REQUIRED" });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requirePlan;
