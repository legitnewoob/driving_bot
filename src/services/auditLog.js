const AuditLog = require("../models/auditLogModel");
const { isDbReady } = require("../utils/db");
const logger = require("../utils/logger-advanced");

/** Record an action. Never throws: an audit write must not break the action itself. */
async function audit(actor, action, target = null, details = {}) {
  if (!isDbReady()) return;
  try {
    await AuditLog.create({ actor: actor || "system", action, target: target == null ? null : String(target), details });
  } catch (err) {
    logger.warn(`Audit log write failed (${action}): ${err.message}`);
  }
}

module.exports = { audit };
