const crypto = require("crypto");
const { verifyToken } = require("./jwtAuth");
const Instructor = require("../models/instructorSchema");
const { staffRoleOf, permissionsOf, isSuperAdmin, STAFF_PERMISSIONS } = require("../services/permissions");

function validAdminKey(key) {
  const expected = process.env.ADMIN_API_KEY;
  if (!key || !expected || key.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(key), Buffer.from(expected));
}

/**
 * Donna Drive staff only. Accepts either the server's ADMIN_API_KEY (scripts,
 * curl; treated as a full admin) or a signed-in staff member's JWT. Sets
 * `req.staff = { email, role, permissions }`.
 */
async function adminAuth(req, res, next) {
  if (validAdminKey(req.headers["x-admin-key"])) {
    req.staff = { email: "admin-key", role: "admin", superAdmin: false, permissions: STAFF_PERMISSIONS.admin };
    return next();
  }

  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ") && process.env.JWT_SECRET) {
    try {
      const payload = verifyToken(header.slice(7).trim(), process.env.JWT_SECRET);
      const person = payload?.email ? await Instructor.findOne({ email: payload.email, active: true }).lean() : null;
      const role = staffRoleOf(person);
      if (role) {
        req.user = payload;
        req.staff = { email: person.email, id: String(person._id), role, superAdmin: isSuperAdmin(person), permissions: permissionsOf(person).filter((p) => p.startsWith("admin.")) };
        return next();
      }
    } catch {
      // fall through to 403
    }
  }

  return res.status(403).json({ success: false, error: "Forbidden" });
}

/** After adminAuth: the staff member must hold this permission. */
function requirePermission(permission) {
  return (req, res, next) => {
    if (req.staff?.permissions?.includes(permission)) return next();
    return res.status(403).json({ success: false, error: "Your role doesn't allow this", code: "FORBIDDEN_ROLE" });
  };
}

module.exports = adminAuth;
module.exports.requirePermission = requirePermission;
module.exports.validAdminKey = validAdminKey;
