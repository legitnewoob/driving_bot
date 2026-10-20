const launch = require("../services/launchService");
const settings = require("../services/settings");
const logger = require("../utils/logger-advanced");

const HOUR = 60 * 60 * 1000;
const DIGEST_HOUR = 8; // UK time
let _timer = null;

const ukNow = () => {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date())
    .reduce((o, p) => ({ ...o, [p.type]: p.value }), {});
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
};

/** Hourly: remind unused invites; once a day at 8am UK, email the team a summary. */
function startWaitlistJob() {
  if (_timer) return;
  const run = async () => {
    try {
      const n = await launch.sendDueReminders();
      if (n) logger.info(`Waitlist job: sent ${n} invite reminder(s)`);
      const { day, hour } = ukNow();
      if (hour >= DIGEST_HOUR && (await settings.get("waitlist.digestDay")) !== day) {
        await settings.setMany({ "waitlist.digestDay": day }, "system");
        await launch.sendDigest();
      }
    } catch (err) {
      logger.error(`Waitlist job failed: ${err.message}`);
    }
  };
  setTimeout(run, 30 * 1000).unref?.();
  _timer = setInterval(run, HOUR);
  _timer.unref?.();
}

module.exports = { startWaitlistJob };
