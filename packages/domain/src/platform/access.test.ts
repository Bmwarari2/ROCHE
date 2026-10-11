import { describe, expect, it } from "vitest";
import {
  type AccessGrantInput,
  authorise,
  can,
  type RoleAssignmentInput,
  resolveAccess,
} from "./access";
import {
  ALL_PERMISSIONS,
  isPermission,
  PERMISSIONS,
  permissionContext,
  requiresStepUp,
  touchesCareRecords,
} from "./permissions";
import { BUILTIN_ROLES, builtinRole } from "./roles";

const NOW = new Date("2026-10-11T10:00:00Z");
const PAST = new Date("2026-01-01T00:00:00Z");
const FUTURE = new Date("2027-01-01T00:00:00Z");
const NORTH = "0193a000-0000-7000-8000-000000000101";
const SOUTH = "0193a000-0000-7000-8000-000000000102";

function assignment(
  roleKey: string,
  locationId: string | null = null,
  validTo: Date | null = null,
  validFrom: Date = PAST,
): RoleAssignmentInput {
  const role = builtinRole(roleKey);
  if (!role) throw new Error(`unknown role ${roleKey}`);
  return {
    roleKey,
    scopeKind: role.scopeKind,
    permissions: role.permissions,
    locationId,
    validFrom,
    validTo,
  };
}

describe("resolveAccess scope", () => {
  it.each([
    ["no assignments", [], "none", []],
    ["owner, tenant-wide", [assignment("owner")], "tenant", []],
    [
      "registered manager at one location",
      [assignment("registered_manager", NORTH)],
      "locations",
      [NORTH],
    ],
    [
      "managers at two locations",
      [assignment("registered_manager", NORTH), assignment("deputy_manager", SOUTH)],
      "locations",
      [NORTH, SOUTH].sort(),
    ],
    [
      "location role with no location means every location",
      [assignment("registered_manager")],
      "tenant",
      [],
    ],
    ["care worker", [assignment("care_worker")], "assigned", []],
    ["person receiving care (self)", [assignment("person_receiving_care")], "assigned", []],
    ["catering has no person scope", [assignment("catering")], "none", []],
    [
      "widest scope wins",
      [assignment("care_worker"), assignment("registered_manager", NORTH)],
      "locations",
      [NORTH],
    ],
    ["expired assignment is ignored", [assignment("owner", null, PAST)], "none", []],
    ["future assignment is ignored", [assignment("owner", null, null, FUTURE)], "none", []],
  ] as const)("%s", (_name, assignments, scope, locationIds) => {
    const access = resolveAccess(assignments, [], NOW);
    expect(access.scope).toBe(scope);
    expect(access.locationIds).toEqual(locationIds);
  });
});

describe("resolveAccess permissions", () => {
  it("unions role permissions and ignores unknown keys", () => {
    const access = resolveAccess(
      [{ ...assignment("care_worker"), permissions: ["care.note.write", "not.a.permission"] }],
      [],
      NOW,
    );
    expect([...access.permissions]).toEqual(["care.note.write"]);
  });

  it("adds active grants, ignoring revoked and expired ones", () => {
    const grants: AccessGrantInput[] = [
      {
        permissions: ["safety.notification.submit"],
        locationId: NORTH,
        validFrom: PAST,
        validTo: FUTURE,
        revokedAt: null,
      },
      {
        permissions: ["finance.ledger.approve"],
        locationId: null,
        validFrom: PAST,
        validTo: FUTURE,
        revokedAt: PAST,
      },
      {
        permissions: ["platform.data.export"],
        locationId: null,
        validFrom: PAST,
        validTo: PAST,
        revokedAt: null,
      },
    ];
    const access = resolveAccess([assignment("care_worker")], grants, NOW);
    expect(can(access, "safety.notification.submit")).toBe(true);
    expect(can(access, "finance.ledger.approve")).toBe(false);
    expect(can(access, "platform.data.export")).toBe(false);
  });

  it("records the active role keys for the audit log", () => {
    const access = resolveAccess(
      [assignment("team_leader", NORTH), assignment("care_worker")],
      [],
      NOW,
    );
    expect(access.roleKeys).toEqual(["care_worker", "team_leader"]);
  });
});

describe("built-in roles follow section 4", () => {
  it.each([
    ["registered_manager", "safety.notification.submit", true],
    ["owner", "safety.notification.submit", true],
    ["deputy_manager", "safety.notification.submit", false],
    ["quality_lead", "safety.notification.submit", false],
    ["care_worker", "safety.incident.read", true],
    ["care_worker", "safety.incident.manage", false],
    ["team_leader", "safety.incident.manage", false],
    ["clinical_lead", "safety.incident.manage", true],
    ["quality_lead", "safety.incident.read", true],
    ["catering", "safety.incident.report", true],
    ["catering", "safety.incident.read", false],
    ["care_worker", "care.note.write", true],
    ["care_worker", "platform.user.manage", false],
    ["catering", "care.note.read", false],
    ["finance", "care.note.read", false],
    ["hr", "care.note.read", false],
    ["clinical_lead", "medicines.cd.administer", true],
    ["family_representative", "comms.portal.family", true],
    ["family_representative", "people.person.read", false],
    ["group_executive", "care.plan.write", false],
    ["inspector", "quality.evidence.read", true],
    ["owner", "comms.portal.family", false],
  ] as const)("%s has %s: %s", (roleKey, permission, expected) => {
    const role = builtinRole(roleKey);
    expect(role?.permissions.includes(permission)).toBe(expected);
  });

  it("uses only catalogued permissions", () => {
    for (const role of BUILTIN_ROLES) {
      for (const p of role.permissions) expect(isPermission(p)).toBe(true);
    }
  });

  it("has unique keys", () => {
    const keys = BUILTIN_ROLES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("requires an expiry on agency, external and inspector roles", () => {
    const expiring = BUILTIN_ROLES.filter((r) => r.requiresExpiry)
      .map((r) => r.key)
      .sort();
    expect(expiring).toEqual(["agency_worker", "external_professional", "inspector"]);
  });

  it("returns undefined for an unknown role", () => {
    expect(builtinRole("nobody")).toBeUndefined();
  });
});

describe("permission catalogue", () => {
  it("names every permission module.resource.action with a known module", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(p).toMatch(/^[a-z]+\.[a-z_]+\.[a-z_]+$/);
      expect(permissionContext(p)).toBe(p.split(".")[0]);
    }
  });

  it.each([
    ["medicines.cd.administer", true],
    ["finance.ledger.approve", true],
    ["platform.data.export", true],
    ["people.person.break_glass", true],
    ["safety.notification.submit", true],
    ["care.note.write", false],
  ] as const)("step-up for %s is %s", (permission, expected) => {
    expect(requiresStepUp(permission)).toBe(expected);
  });

  it.each([
    ["care.note.read", true],
    ["safety.incident.read", true],
    ["safety.notification.submit", true],
    ["safety.incident.report", false],
    ["operations.catering.manage", false],
  ] as const)("%s touches care records: %s", (permission, expected) => {
    expect(touchesCareRecords(permission)).toBe(expected);
  });

  it("has a description for every permission", () => {
    for (const definition of Object.values(PERMISSIONS)) {
      expect(definition.description.length).toBeGreaterThan(5);
    }
  });
});

describe("authorise", () => {
  const manager = resolveAccess([assignment("registered_manager", NORTH)], [], NOW);
  const fiveMinutesAgo = new Date(NOW.getTime() - 5 * 60_000);
  const anHourAgo = new Date(NOW.getTime() - 60 * 60_000);

  it.each([
    ["allowed without step-up", "care.note.read", null, { allowed: true }],
    [
      "missing permission",
      "platform.tenant.manage",
      fiveMinutesAgo,
      { allowed: false, reason: "missing_permission" },
    ],
    ["step-up fresh", "safety.notification.submit", fiveMinutesAgo, { allowed: true }],
    [
      "step-up stale",
      "safety.notification.submit",
      anHourAgo,
      { allowed: false, reason: "step_up_required" },
    ],
    [
      "step-up never done",
      "safety.notification.submit",
      null,
      { allowed: false, reason: "step_up_required" },
    ],
  ] as const)("%s", (_name, permission, lastStrongAuthAt, expected) => {
    expect(authorise(manager, permission, lastStrongAuthAt, NOW, 600)).toEqual(expected);
  });
});
