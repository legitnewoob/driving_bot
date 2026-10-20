const express = require("express");
const router = express.Router();
const PhoneNumber = require("../models/phoneNumberModel");
const PriceChange = require("../models/priceChangeModel");
const phoneNumberService = require("../services/phoneNumberService");
const adminService = require("../services/adminService");
const pricing = require("../services/pricingService");
const launch = require("../services/launchService");
const { requirePermission } = require("../middleware/adminAuth");
const { audit } = require("../services/auditLog");
const logger = require("../utils/logger-advanced");

// Mounted behind adminAuth, so req.staff is always set
const actor = (req) => req.staff?.email || "admin-key";

function fail(res, err, what) {
  if (err.userFacing) return res.status(err.status || 400).json({ success: false, error: err.message, ...(err.code && { code: err.code }) });
  if (err.type?.startsWith?.("Stripe")) {
    logger.error(`Admin ${what} Stripe error: ${err.message}`);
    return res.status(502).json({ success: false, error: `Stripe: ${err.message}` });
  }
  logger.error(`Admin ${what} error: ${err.message}`);
  return res.status(500).json({ success: false, error: `Failed to ${what}` });
}

const wrap = (what, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    fail(res, err, what);
  }
};

// ── Who am I ────────────────────────────────────────────────────────────
router.get("/me", (req, res) => res.json({ success: true, data: req.staff }));

// ── Overview ────────────────────────────────────────────────────────────
router.get("/overview", requirePermission("admin.view"), wrap("load the overview", async (req, res) => {
  res.json({ success: true, data: await adminService.overview() });
}));

// ── Customers ───────────────────────────────────────────────────────────
router.get("/customers", requirePermission("admin.view"), wrap("list customers", async (req, res) => {
  res.json({ success: true, ...(await adminService.listCustomers(req.query)) });
}));

router.get("/customers/:id", requirePermission("admin.view"), wrap("load the customer", async (req, res) => {
  res.json({ success: true, data: await adminService.customerDetail(req.params.id) });
}));

router.post("/customers/:id/extend-trial", requirePermission("admin.trials"), wrap("extend the trial", async (req, res) => {
  res.json({ success: true, data: await adminService.extendTrial(req.params.id, req.body?.days, actor(req)) });
}));

router.put("/customers/:id/comp", requirePermission("admin.customers"), wrap("comp the plan", async (req, res) => {
  res.json({ success: true, data: await adminService.setComp(req.params.id, req.body || {}, actor(req)) });
}));

router.delete("/customers/:id/comp", requirePermission("admin.customers"), wrap("remove the comp", async (req, res) => {
  res.json({ success: true, data: await adminService.removeComp(req.params.id, actor(req)) });
}));

router.post("/customers/:id/suspend", requirePermission("admin.customers"), wrap("suspend the account", async (req, res) => {
  res.json({ success: true, data: await adminService.setSuspended(req.params.id, true, actor(req), req.staff?.email) });
}));

router.post("/customers/:id/reactivate", requirePermission("admin.customers"), wrap("reactivate the account", async (req, res) => {
  res.json({ success: true, data: await adminService.setSuspended(req.params.id, false, actor(req), req.staff?.email) });
}));

// Permanent: the body must say { confirmation: "DELETE" }
router.post("/customers/:id/delete", requirePermission("admin.customers"), wrap("delete the account", async (req, res) => {
  if (req.body?.confirmation !== "DELETE") return res.status(400).json({ success: false, error: 'Type DELETE to confirm' });
  res.json({ success: true, data: await adminService.deleteCustomer(req.params.id, actor(req), req.staff?.email) });
}));

// ── Staff roles ─────────────────────────────────────────────────────────
router.get("/staff", requirePermission("admin.roles"), wrap("list staff", async (req, res) => {
  res.json({ success: true, data: await adminService.listStaff() });
}));

router.put("/staff", requirePermission("admin.roles"), wrap("change the role", async (req, res) => {
  res.json({ success: true, data: await adminService.setStaffRole(req.body?.email, req.body?.role, actor(req), req.staff?.email) });
}));

// ── Plans and prices ────────────────────────────────────────────────────
router.get("/plans", requirePermission("admin.pricing"), wrap("load plans", async (req, res) => {
  await pricing.ensurePlans();
  res.json({ success: true, data: await pricing.getPlans(), noticeDays: pricing.noticeDays() });
}));

router.patch("/plans/:slug", requirePermission("admin.pricing"), wrap("update the plan", async (req, res) => {
  const result = await pricing.updatePlan(req.params.slug, req.body || {}, actor(req));
  res.json({ success: true, data: result });
}));

router.get("/price-changes", requirePermission("admin.pricing"), wrap("load price changes", async (req, res) => {
  res.json({ success: true, data: await PriceChange.find({}).sort({ createdAt: -1 }).limit(50).lean() });
}));

router.delete("/price-changes/:id", requirePermission("admin.pricing"), wrap("cancel the price change", async (req, res) => {
  res.json({ success: true, data: await pricing.cancelPriceChange(req.params.id, actor(req)) });
}));

// ── Sales and promo codes ───────────────────────────────────────────────
router.get("/sales", requirePermission("admin.sales"), wrap("load sales", async (req, res) => {
  res.json({ success: true, data: await pricing.listSales() });
}));

router.post("/sales", requirePermission("admin.sales"), wrap("create the sale", async (req, res) => {
  res.status(201).json({ success: true, data: await pricing.createSale(req.body || {}, actor(req)) });
}));

router.patch("/sales/:id", requirePermission("admin.sales"), wrap("update the sale", async (req, res) => {
  res.json({ success: true, data: await pricing.updateSale(req.params.id, req.body || {}, actor(req)) });
}));

router.delete("/sales/:id", requirePermission("admin.sales"), wrap("end the sale", async (req, res) => {
  res.json({ success: true, data: await pricing.endSale(req.params.id, actor(req)) });
}));

router.get("/promo-codes", requirePermission("admin.sales"), wrap("load promo codes", async (req, res) => {
  res.json({ success: true, data: await pricing.listPromoCodes() });
}));

router.post("/promo-codes", requirePermission("admin.sales"), wrap("create the code", async (req, res) => {
  res.status(201).json({ success: true, data: await pricing.createPromoCode(req.body || {}, actor(req)) });
}));

router.delete("/promo-codes/:id", requirePermission("admin.sales"), wrap("deactivate the code", async (req, res) => {
  res.json({ success: true, data: await pricing.deactivatePromoCode(req.params.id, actor(req)) });
}));

// ── Launch waitlist ─────────────────────────────────────────────────────
router.get("/waitlist", requirePermission("admin.waitlist"), wrap("load the waitlist", async (req, res) => {
  res.json({ success: true, ...(await launch.adminList(req.query)) });
}));

router.get("/waitlist.csv", requirePermission("admin.waitlist"), wrap("export the waitlist", async (req, res) => {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(await launch.csv());
}));

router.post("/waitlist/invite", requirePermission("admin.waitlist"), wrap("send the invites", async (req, res) => {
  res.json({ success: true, data: await launch.invite(req.body || {}, actor(req)) });
}));

router.post("/waitlist/:id/remove", requirePermission("admin.waitlist"), wrap("remove them", async (req, res) => {
  res.json({ success: true, data: await launch.remove(req.params.id, actor(req)) });
}));

router.get("/launch", requirePermission("admin.waitlist"), wrap("load the launch settings", async (req, res) => {
  res.json({ success: true, data: await launch.launchSettings() });
}));

router.put("/launch", requirePermission("admin.launch"), wrap("save the launch settings", async (req, res) => {
  res.json({ success: true, data: await launch.updateLaunchSettings(req.body || {}, actor(req)) });
}));

router.post("/launch/announce", requirePermission("admin.launch"), wrap("send the announcement", async (req, res) => {
  res.json({ success: true, data: await launch.announceLaunch(actor(req)) });
}));

// ── Audit log ───────────────────────────────────────────────────────────
router.get("/audit", requirePermission("admin.view"), wrap("load the audit log", async (req, res) => {
  res.json({ success: true, ...(await adminService.auditLog(req.query)) });
}));

// ── Phone-number pool ───────────────────────────────────────────────────
router.use("/phone-numbers", requirePermission("admin.numbers"));

router.get("/phone-numbers", async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      PhoneNumber.find(filter).select("-whatsappToken").sort({ createdAt: -1 }).skip(skip).limit(limit).populate("assignedTo", "name email").lean(),
      PhoneNumber.countDocuments(filter),
    ]);

    res.json({ success: true, data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error("[admin] list phone-numbers error:", err);
    res.status(500).json({ success: false, error: "Failed to list numbers" });
  }
});

router.post("/phone-numbers", async (req, res) => {
  try {
    const input = req.body.numbers || [req.body];
    if (!input.length || !input[0].phoneNumber || !input[0].phoneNumberId) {
      return res.status(400).json({ success: false, error: "Each number needs phoneNumber and phoneNumberId" });
    }

    const result = await phoneNumberService.addToPool(input);
    await audit(actor(req), "numbers.add", null, { numbers: input.map((n) => n.phoneNumber) });
    res.json({ success: true, added: result.length });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, error: "Duplicate number(s) in pool" });
    }
    console.error("[admin] add phone-numbers error:", err);
    res.status(500).json({ success: false, error: "Failed to add numbers" });
  }
});

router.delete("/phone-numbers/:id", async (req, res) => {
  try {
    const doc = await PhoneNumber.findById(req.params.id);
    if (!doc) return res.status(404).json({ success: false, error: "Not found" });
    if (doc.status === "assigned") {
      return res.status(400).json({ success: false, error: "Cannot delete assigned number. Revoke first." });
    }
    await doc.deleteOne();
    await audit(actor(req), "numbers.delete", doc.phoneNumber);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] delete phone-number error:", err);
    res.status(500).json({ success: false, error: "Failed to delete number" });
  }
});

router.post("/phone-numbers/:id/revoke", async (req, res) => {
  try {
    const result = await phoneNumberService.revokeNumber(req.params.id);
    if (!result) {
      return res.status(404).json({ success: false, error: "Number not found or not assigned" });
    }
    await audit(actor(req), "numbers.revoke", req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] revoke phone-number error:", err);
    res.status(500).json({ success: false, error: "Failed to revoke number" });
  }
});

module.exports = router;
