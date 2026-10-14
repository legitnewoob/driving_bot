const pricing = require("../services/pricingService");
const logger = require("../utils/logger-advanced");

const HOUR = 60 * 60 * 1000;
let _timer = null;

/** Seed plans once, then hourly move subscribers whose price-rise notice has ended. */
function startBillingJob() {
  if (_timer) return;
  const run = async () => {
    try {
      await pricing.ensurePlans();
      const n = await pricing.applyDuePriceChanges();
      if (n) logger.info(`Billing job: applied ${n} price change(s)`);
    } catch (err) {
      logger.error(`Billing job failed: ${err.message}`);
    }
  };
  setTimeout(run, 15 * 1000).unref?.();
  _timer = setInterval(run, HOUR);
  _timer.unref?.();
}

module.exports = { startBillingJob };
