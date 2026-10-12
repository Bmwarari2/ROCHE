import { describe, expect, it } from "vitest";
import {
  type AccessGrantInput,
  checkGrantPermissions,
  checkRoleDefinition,
  NO_SCOPE,
  type RoleAssignmentInput,
  resolveAccess,
  rolePermissionMix,
  scopeFor,
} from "./access";
import { BUILTIN_ROLES, builtinRole, PORTAL_ONLY_PERMISSIONS } from "./roles";

/**
 * Staff and portal sessions never mix (comms.md section 3; ADR-0061; hazard HZ-022): portal-only
 * permissions reach only portal sessions, from portal roles, and never through grants.
 */

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const NORTH = "0193a000-0000-7000-8000-000000000101";

function assignment(roleKey: string, locationId: string | null = null): RoleAssignmentInput {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  return {
    roleKey,
    scopeKind: role.scopeKind,
    permissions: role.permissions,
    locationId,
    validFrom: PAST,
    validTo: null,
  };
}

const mixed: RoleAssignmentInput = {
  roleKey: "tenant_custom_mixed",
  scopeKind: "location",
  permissions: ["care.note.read", "comms.feed.read"],
  locationId: NORTH,
  validFrom: PAST,
  validTo: null,
};

const grant = (permissions: string[]): AccessGrantInput => ({
  permissions,
  locationId: null,
  validFrom: PAST,
  validTo: new Date("2027-01-01T00:00:00Z"),
  revokedAt: null,
});

describe("hazard HZ-022 portal and staff permissions never mix", () => {
  it("keeps every built-in role either a portal role or a staff role", () => {
    for (const role of BUILTIN_ROLES) {
      expect(rolePermissionMix(role.permissions)).not.toBe("mixed");
      expect(checkRoleDefinition(role.permissions)).toEqual([]);
    }
    expect(rolePermissionMix(builtinRole("family_representative")?.permissions ?? [])).toBe(
      "portal",
    );
    expect(rolePermissionMix(builtinRole("registered_manager")?.permissions ?? [])).toBe("staff");
    expect(rolePermissionMix([])).toBe("empty");
  });

  it.each<[string, readonly string[], readonly string[]]>([
    ["a staff role", ["care.note.read", "care.note.write"], []],
    ["a portal role", ["comms.portal.family", "comms.feed.read"], []],
    [
      "a role mixing both",
      ["care.note.read", "comms.feed.read"],
      ["portal_and_staff_permissions_mixed"],
    ],
    [
      "a role with an unknown permission",
      ["care.note.read", "care.note.delete"],
      ["unknown_permission"],
    ],
  ])("checks %s", (_label, permissions, problems) => {
    expect(checkRoleDefinition(permissions)).toEqual(problems);
  });

  it.each<[string, readonly string[], readonly string[]]>([
    ["an acting-up grant", ["safety.notification.submit"], []],
    ["a grant of family access", ["comms.feed.read"], ["portal_permission_in_grant"]],
    ["a grant of an unknown permission", ["care.everything"], ["unknown_permission"]],
  ])("checks %s", (_label, permissions, problems) => {
    expect(checkGrantPermissions(permissions)).toEqual(problems);
  });

  it("gives a staff session no portal permission and no scope from a portal role", () => {
    const access = resolveAccess(
      [assignment("care_worker"), assignment("family_representative")],
      [grant(["comms.feed.read", "safety.notification.submit"])],
      NOW,
    );
    expect(access.session).toBe("staff");
    for (const p of PORTAL_ONLY_PERMISSIONS) expect(access.permissions.has(p)).toBe(false);
    expect(access.permissions.has("care.note.write")).toBe(true);
    expect(access.permissions.has("safety.notification.submit")).toBe(true);
    expect(access.roleKeys).toEqual(["care_worker"]);
    expect(scopeFor(access, "care.note.write")).toEqual({ scope: "assigned", locationIds: [] });
    // The grant reaches the whole organisation for the one permission it carries (ADR-0071).
    expect(scopeFor(access, "safety.notification.submit")).toEqual({
      scope: "tenant",
      locationIds: [],
    });
    expect(scopeFor(access, "comms.feed.read")).toEqual(NO_SCOPE);
  });

  it("resolves a portal session from portal roles only, with no person scope and no grants", () => {
    const access = resolveAccess(
      [assignment("family_representative"), assignment("registered_manager", NORTH)],
      [grant(["safety.notification.submit"])],
      NOW,
      "portal",
    );
    const permissions = [
      "comms.portal.family",
      "comms.feed.read",
      "comms.notification.subscribe",
      "comms.visit_booking.request",
    ] as const;
    expect(access).toEqual({
      permissions: new Set(permissions),
      scopes: new Map(permissions.map((p) => [p, NO_SCOPE])),
      roleKeys: ["family_representative"],
      session: "portal",
    });
  });

  it("ignores a stored role that mixes both, in either kind of session", () => {
    for (const session of ["staff", "portal"] as const) {
      const access = resolveAccess([mixed], [], NOW, session);
      expect(access.permissions.size).toBe(0);
      expect(scopeFor(access, "care.note.read")).toEqual(NO_SCOPE);
    }
  });
});
