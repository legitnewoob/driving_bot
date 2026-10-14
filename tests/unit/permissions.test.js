const { can, permissionsOf, staffRoleOf, isSuperAdmin } = require("../../src/services/permissions");

describe("roles and permissions", () => {
  afterEach(() => { delete process.env.SUPER_ADMIN_EMAILS; });

  it("agrawalraj918@gmail.com is a super admin by default, whatever the record says", () => {
    const raj = { email: "AgrawalRaj918@gmail.com", staffRole: null };
    expect(isSuperAdmin(raj)).toBe(true);
    expect(staffRoleOf(raj)).toBe("admin");
    expect(can(raj, "admin.pricing")).toBe(true);
  });

  it("super admins come from SUPER_ADMIN_EMAILS", () => {
    process.env.SUPER_ADMIN_EMAILS = "boss@donnadrive.co.uk, other@x.com";
    expect(isSuperAdmin({ email: "other@x.com" })).toBe(true);
    expect(isSuperAdmin({ email: "agrawalraj918@gmail.com" })).toBe(false);
  });

  it("support can view and help, but not change pricing, sales, comps or roles", () => {
    const s = { email: "s@x.com", staffRole: "support" };
    for (const p of ["admin.view", "admin.trials", "admin.numbers"]) expect(can(s, p)).toBe(true);
    for (const p of ["admin.pricing", "admin.sales", "admin.customers", "admin.roles"]) expect(can(s, p)).toBe(false);
  });

  it("customers have no admin permissions", () => {
    expect(permissionsOf({ email: "i@x.com" })).toEqual([]);
    expect(staffRoleOf({ email: "i@x.com", staffRole: "hacker" })).toBeNull();
  });

  it("school permissions need a school", () => {
    expect(can({ email: "o@x.com", schoolRole: "owner", schoolId: null }, "school.billing")).toBe(false);
    expect(can({ email: "o@x.com", schoolRole: "owner", schoolId: "s1" }, "school.billing")).toBe(true);
  });

  it.each([
    ["owner", ["school.billing", "school.roles", "school.rename", "school.invite"], []],
    ["manager", ["school.invite", "school.remove", "school.viewAll"], ["school.billing", "school.roles", "school.rename"]],
    ["member", ["school.view"], ["school.invite", "school.viewAll"]],
  ])("%s", (role, yes, no) => {
    const p = { email: "x@x.com", schoolRole: role, schoolId: "s1" };
    for (const perm of yes) expect(can(p, perm)).toBe(true);
    for (const perm of no) expect(can(p, perm)).toBe(false);
  });

  it("a staff member who owns a school has both sets", () => {
    const p = { email: "x@x.com", staffRole: "support", schoolRole: "owner", schoolId: "s1" };
    expect(can(p, "admin.view")).toBe(true);
    expect(can(p, "school.billing")).toBe(true);
  });
});
