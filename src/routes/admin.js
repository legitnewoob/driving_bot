const express = require("express");
const router = express.Router();
const PhoneNumber = require("../models/phoneNumberModel");
const phoneNumberService = require("../services/phoneNumberService");

router.get("/phone-numbers", async (req, res) => {
  try {
    const filter = {};
    if (req.query.status) filter.status = req.query.status;

    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      PhoneNumber.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).populate("assignedTo", "name email").lean(),
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
    res.json({ success: true });
  } catch (err) {
    console.error("[admin] revoke phone-number error:", err);
    res.status(500).json({ success: false, error: "Failed to revoke number" });
  }
});

module.exports = router;
