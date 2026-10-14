/**
 * Roles and what they can do. Two independent scopes:
 *  - staff:  Donna Drive's own team (admin panel)
 *  - school: inside one driving school (owner / manager / instructor)
 * Everything that checks a permission goes through `can()` so the rules live here.
 */

const STAFF_PERMISSIONS = {
  admin: [
    "admin.view", "admin.trials", "admin.numbers",
    "admin.customers", "admin.pricing", "admin.sales", "admin.roles",
  ],
  support: ["admin.view", "admin.trials", "admin.numbers"],
};

// schoolRole "member" is an instructor
const SCHOOL_PERMISSIONS = {
  owner: [
    "school.view", "school.invite", "school.remove", "school.viewAll",
    "school.billing", "school.roles", "school.rename",
  ],
  manager: ["school.view", "school.invite", "school.remove", "school.viewAll"],
  member: ["school.view"],
};

const SCHOOL_ROLE_LABELS = { owner: "Owner", manager: "Manager", member: "Instructor" };

function superAdminEmails() {
  return (process.env.SUPER_ADMIN_EMAILS || "agrawalraj918@gmail.com")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function isSuperAdmin(person) {
  return !!person?.email && superAdminEmails().includes(String(person.email).toLowerCase());
}

/** The staff role that applies: super admins are always admins. */
function staffRoleOf(person) {
  if (!person) return null;
  if (isSuperAdmin(person)) return "admin";
  return STAFF_PERMISSIONS[person.staffRole] ? person.staffRole : null;
}

/** Signed up but hasn't picked a plan yet (staff never need one). */
function needsPlan(person) {
  return !!person && person.planSelected === false && !staffRoleOf(person);
}

function permissionsOf(person) {
  const staff = STAFF_PERMISSIONS[staffRoleOf(person)] || [];
  const school = (person?.schoolId && SCHOOL_PERMISSIONS[person.schoolRole]) || [];
  return [...staff, ...school];
}

function can(person, permission) {
  return permissionsOf(person).includes(permission);
}

module.exports = {
  STAFF_PERMISSIONS,
  SCHOOL_PERMISSIONS,
  SCHOOL_ROLE_LABELS,
  superAdminEmails,
  isSuperAdmin,
  staffRoleOf,
  permissionsOf,
  needsPlan,
  can,
};
