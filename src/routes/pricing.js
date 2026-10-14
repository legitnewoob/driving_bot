const express = require("express");
const pricing = require("../services/pricingService");
const logger = require("../utils/logger-advanced");

const router = express.Router();

/** GET /api/pricing — public: plans, prices and any running sale. */
router.get("/", async (req, res) => {
  try {
    res.set("Cache-Control", "public, max-age=60");
    res.json({ success: true, data: await pricing.publicPricing() });
  } catch (err) {
    logger.error(`Pricing load error: ${err.message}`);
    res.status(500).json({ success: false, error: "Failed to load pricing" });
  }
});

module.exports = router;
