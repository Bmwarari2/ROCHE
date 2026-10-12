import { describe, expect, it } from "vitest";
import {
  type AccessGrantInput,
  authorise,
  can,
  NO_SCOPE,
  narrowestScope,
  type PermissionScope,
  permissionsAtLocation,
  placesCover,
  placesHoldingPermission,
  type RoleAssignmentInput,
  resolveAccess,
  scopeFor,
  widestScope,
} from "./access";
import {
  ALL_PERMISSIONS,
  isPermission,
  PERMISSIONS,
  type Permission,
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

const grantOf = (
  permissions: string[],
  locationId: string | null,
  overrides: Partial<AccessGrantInput> = {},
): AccessGrantInput => ({
  permissions,
  locationId,
  validFrom: PAST,
  validTo: FUTURE,
  revokedAt: null,
  ...overrides,
});

/** A role an organisation designed: the issue's "Finance viewer" across the organisation. */
const financeViewer: RoleAssignmentInput = {
  roleKey: "tenant_finance_viewer",
  scopeKind: "tenant",
  permissions: ["finance.reporting.read"],
  locationId: null,
  validFrom: PAST,
  validTo: null,
};

const tenantWide: PermissionScope = { scope: "tenant", locationIds: [] };
const assigned: PermissionScope = { scope: "assigned", locationIds: [] };
const at = (...ids: string[]): PermissionScope => ({
  scope: "locations",
  locationIds: [...ids].sort(),
});

describe("hazard HZ-011 scopeFor: data scope is per permission (ADR-0071)", () => {
  it.each<[string, RoleAssignmentInput[], AccessGrantInput[], Permission, PermissionScope]>([
    ["no roles reach no one", [], [], "care.note.read", NO_SCOPE],
    ["the owner, organisation-wide", [assignment("owner")], [], "care.note.read", tenantWide],
    [
      "a Registered Manager at one location",
      [assignment("registered_manager", NORTH)],
      [],
      "care.note.read",
      at(NORTH),
    ],
    [
      "managers at two locations add up",
      [assignment("registered_manager", NORTH), assignment("deputy_manager", SOUTH)],
      [],
      "care.note.read",
      at(NORTH, SOUTH),
    ],
    [
      "a location role with no location reaches every location",
      [assignment("registered_manager")],
      [],
      "care.note.read",
      tenantWide,
    ],
    [
      "a care worker reaches the people assigned to them",
      [assignment("care_worker")],
      [],
      "care.note.write",
      assigned,
    ],
    [
      "two roles: care notes stay at the care role's home (the issue's example)",
      [assignment("team_leader", NORTH), financeViewer],
      [],
      "care.note.write",
      at(NORTH),
    ],
    [
      "two roles: reading people stays at the care role's home",
      [assignment("team_leader", NORTH), financeViewer],
      [],
      "people.person.read",
      at(NORTH),
    ],
    [
      "two roles: the finance permission reaches the whole organisation",
      [assignment("team_leader", NORTH), financeViewer],
      [],
      "finance.reporting.read",
      tenantWide,
    ],
    [
      "a care worker who is also a group executive writes notes for assigned people only",
      [assignment("care_worker"), assignment("group_executive")],
      [],
      "care.note.write",
      assigned,
    ],
    [
      "a care worker who is also a group executive reads notes across the organisation",
      [assignment("care_worker"), assignment("group_executive")],
      [],
      "care.note.read",
      tenantWide,
    ],
    [
      "a role scoped to no one gives its permission and no one to use it on",
      [assignment("catering", NORTH)],
      [],
      "operations.catering.manage",
      NO_SCOPE,
    ],
    [
      "a role mixing portal and staff permissions is ignored",
      [
        {
          roleKey: "tenant_custom_mixed",
          scopeKind: "tenant",
          permissions: ["care.note.read", "comms.feed.read"],
          locationId: null,
          validFrom: PAST,
          validTo: null,
        },
      ],
      [],
      "care.note.read",
      NO_SCOPE,
    ],
    [
      "a portal role gives a staff session nothing",
      [assignment("person_receiving_care")],
      [],
      "comms.portal.self",
      NO_SCOPE,
    ],
    [
      "an ended role is ignored",
      [assignment("owner", null, PAST), assignment("registered_manager", NORTH)],
      [],
      "care.note.read",
      at(NORTH),
    ],
    [
      "a role not yet started is ignored",
      [assignment("owner", null, null, FUTURE)],
      [],
      "care.note.read",
      NO_SCOPE,
    ],
    [
      "a grant at a location reaches that location only",
      [assignment("administrator", NORTH)],
      [grantOf(["care.note.write", "care.note.read"], SOUTH)],
      "care.note.write",
      at(SOUTH),
    ],
    [
      "a grant leaves the role's own permissions where they were",
      [assignment("administrator", NORTH)],
      [grantOf(["care.note.write"], SOUTH)],
      "people.demographics.read",
      at(NORTH),
    ],
    [
      "a grant and a role carrying the same permission add up",
      [assignment("registered_manager", NORTH)],
      [grantOf(["care.note.read"], SOUTH)],
      "care.note.read",
      at(NORTH, SOUTH),
    ],
    [
      "a grant at a location adds that location to a care worker's assigned people",
      [assignment("care_worker")],
      [grantOf(["care.note.write"], SOUTH)],
      "care.note.write",
      at(SOUTH),
    ],
    [
      "a grant with no location reaches the whole organisation",
      [assignment("care_worker")],
      [grantOf(["safety.notification.submit"], null)],
      "safety.notification.submit",
      tenantWide,
    ],
    [
      "a revoked grant gives nothing",
      [],
      [grantOf(["care.note.read"], null, { revokedAt: PAST })],
      "care.note.read",
      NO_SCOPE,
    ],
    [
      "an expired grant gives nothing",
      [],
      [grantOf(["care.note.read"], null, { validTo: PAST })],
      "care.note.read",
      NO_SCOPE,
    ],
    [
      "a grant not yet started gives nothing",
      [],
      [grantOf(["care.note.read"], null, { validFrom: FUTURE })],
      "care.note.read",
      NO_SCOPE,
    ],
    [
      "a permission held nowhere reaches no one",
      [assignment("registered_manager", NORTH)],
      [],
      "platform.tenant.manage",
      NO_SCOPE,
    ],
  ])("%s", (_name, assignments, grants, permission, expected) => {
    expect(scopeFor(resolveAccess(assignments, grants, NOW), permission)).toEqual(expected);
  });

  it("gives a portal session its permissions with no person scope, and no grants (ADR-0061)", () => {
    const access = resolveAccess(
      [assignment("family_representative"), assignment("registered_manager", NORTH)],
      [grantOf(["care.note.read"], null)],
      NOW,
      "portal",
    );
    expect(can(access, "comms.portal.family")).toBe(true);
    expect(scopeFor(access, "comms.portal.family")).toEqual(NO_SCOPE);
    expect(can(access, "care.note.read")).toBe(false);
    expect(scopeFor(access, "care.note.read")).toEqual(NO_SCOPE);
  });

  it("keeps the permission set for the screens and authorise, whatever each one reaches", () => {
    const access = resolveAccess([assignment("team_leader", NORTH), financeViewer], [], NOW);
    expect(can(access, "care.note.write")).toBe(true);
    expect(can(access, "finance.reporting.read")).toBe(true);
    expect([...access.scopes.keys()].sort()).toEqual([...access.permissions].sort());
  });
});

describe("hazard HZ-011 narrowestScope: a request that needs several permissions (ADR-0071)", () => {
  it.each<[string, PermissionScope[], PermissionScope]>([
    ["nothing required reaches no one", [], NO_SCOPE],
    ["one scope is itself", [at(NORTH)], at(NORTH)],
    ["organisation-wide twice", [tenantWide, tenantWide], tenantWide],
    [
      "organisation-wide narrows to the locations",
      [tenantWide, at(NORTH, SOUTH)],
      at(NORTH, SOUTH),
    ],
    ["two location scopes keep the shared locations", [at(NORTH, SOUTH), at(SOUTH)], at(SOUTH)],
    ["two location scopes sharing none keep assigned people", [at(NORTH), at(SOUTH)], assigned],
    ["locations and assigned people is assigned people", [at(NORTH), assigned], assigned],
    ["organisation-wide and assigned people is assigned people", [tenantWide, assigned], assigned],
    ["no one wins over organisation-wide", [tenantWide, NO_SCOPE], NO_SCOPE],
    ["no one wins over assigned people", [assigned, NO_SCOPE], NO_SCOPE],
    ["the order does not matter", [at(SOUTH), tenantWide, at(NORTH, SOUTH)], at(SOUTH)],
  ])("%s", (_name, scopes, expected) => {
    expect(narrowestScope(scopes)).toEqual(expected);
    expect(narrowestScope([...scopes].reverse())).toEqual(expected);
  });

  it("never reaches further than any one of the scopes it narrows", () => {
    const all = [tenantWide, at(NORTH), at(SOUTH), at(NORTH, SOUTH), assigned, NO_SCOPE];
    const rank = { none: 0, assigned: 1, locations: 2, tenant: 3 } as const;
    const within = (a: PermissionScope, b: PermissionScope) =>
      rank[a.scope] < rank[b.scope] ||
      (a.scope === b.scope && a.locationIds.every((id) => b.locationIds.includes(id)));
    for (const a of all) {
      for (const b of all) {
        const n = narrowestScope([a, b]);
        expect(within(n, a) && within(n, b)).toBe(true);
      }
    }
  });
});

describe("widestScope: any one of several permissions, or every source of one", () => {
  it.each<[string, PermissionScope[], PermissionScope]>([
    ["nothing reaches no one", [], NO_SCOPE],
    ["no one adds nothing", [NO_SCOPE, assigned], assigned],
    ["location scopes add up", [at(NORTH), at(SOUTH)], at(NORTH, SOUTH)],
    ["assigned people are inside a location scope", [assigned, at(NORTH)], at(NORTH)],
    ["organisation-wide wins", [at(NORTH), tenantWide, NO_SCOPE], tenantWide],
  ])("%s", (_name, scopes, expected) => {
    expect(widestScope(scopes)).toEqual(expected);
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
        permissions: ["platform.export.create"],
        locationId: null,
        validFrom: PAST,
        validTo: PAST,
        revokedAt: null,
      },
    ];
    const access = resolveAccess([assignment("care_worker")], grants, NOW);
    expect(can(access, "safety.notification.submit")).toBe(true);
    expect(can(access, "finance.ledger.approve")).toBe(false);
    expect(can(access, "platform.export.create")).toBe(false);
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

describe("permissionsAtLocation", () => {
  it("hazards HZ-004 and HZ-005 counts only the roles and grants for that location or the whole tenant", () => {
    const grants: AccessGrantInput[] = [
      {
        permissions: ["medicines.cd.administer"],
        locationId: SOUTH,
        validFrom: PAST,
        validTo: FUTURE,
        revokedAt: null,
      },
    ];
    const assignments = [assignment("clinical_lead", SOUTH), assignment("care_worker", NORTH)];
    const north = permissionsAtLocation(assignments, grants, NORTH, NOW);
    expect(north.has("care.note.write")).toBe(true);
    expect(north.has("care.plan.write")).toBe(false);
    expect(north.has("medicines.cd.administer")).toBe(false);
    const south = permissionsAtLocation(assignments, grants, SOUTH, NOW);
    expect(south.has("care.plan.write")).toBe(true);
    expect(south.has("medicines.cd.administer")).toBe(true);
    const everywhere = permissionsAtLocation([assignment("clinical_lead")], [], NORTH, NOW);
    expect(everywhere.has("care.plan.write")).toBe(true);
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
    // Platform completions (platform-completions.md section 3).
    ["owner", "platform.export.create", true],
    ["registered_manager", "platform.export.create", false],
    ["quality_lead", "platform.export.create", false],
    ["care_worker", "platform.search.use", true],
    ["agency_worker", "platform.search.use", true],
    ["administrator", "platform.search.use", true],
    ["hr", "platform.search.use", true],
    ["external_professional", "platform.search.use", false],
    ["family_representative", "platform.search.use", false],
    ["inspector", "platform.search.use", false],
    ["housekeeping", "platform.search.use", false],
    ["care_worker", "platform.search.archived", false],
    ["registered_manager", "platform.search.archived", true],
    ["quality_lead", "platform.search.archived", true],
    ["owner", "platform.onboarding.manage", true],
    ["registered_manager", "platform.onboarding.manage", false],
    ["registered_manager", "platform.onboarding.read", true],
    ["registered_manager", "platform.dpia.prepare", true],
    ["deputy_manager", "platform.dpia.prepare", false],
    ["deputy_manager", "platform.dpia.read", true],
    ["registered_manager", "platform.dpia.sign", false],
    ["quality_lead", "platform.dpia.sign", true],
    ["owner", "platform.dpia.sign", true],
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
    ["platform.export.create", true],
    ["platform.search.use", false],
    ["platform.dpia.sign", true],
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
    // The full export holds every care record, so asking for it needs MFA (security review).
    ["platform.export.create", true],
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

describe("placesHoldingPermission (#26 review round 2, S1)", () => {
  const grant = (
    permissions: string[],
    locationId: string | null,
    revokedAt: Date | null = null,
  ): AccessGrantInput => ({ permissions, locationId, validFrom: PAST, validTo: FUTURE, revokedAt });

  it.each<[string, RoleAssignmentInput[], AccessGrantInput[], unknown]>([
    [
      "a Registered Manager at one home",
      [assignment("registered_manager", NORTH)],
      [],
      { organisationWide: false, locationIds: [NORTH] },
    ],
    [
      "a Registered Manager at North who is an administrator at South: North only",
      [assignment("registered_manager", NORTH), assignment("administrator", SOUTH)],
      [],
      { organisationWide: false, locationIds: [NORTH] },
    ],
    [
      "a Registered Manager at North who is also a group executive: still North only",
      [assignment("registered_manager", NORTH), assignment("group_executive")],
      [],
      { organisationWide: false, locationIds: [NORTH] },
    ],
    [
      "a quality lead across the organisation",
      [assignment("quality_lead")],
      [],
      { organisationWide: true, locationIds: [] },
    ],
    [
      "an ended assignment gives nothing",
      [assignment("registered_manager", NORTH, new Date("2025-06-01T00:00:00Z"))],
      [],
      { organisationWide: false, locationIds: [] },
    ],
    [
      "a role scoped to assigned people gives no place",
      [{ ...assignment("care_worker", NORTH), permissions: ["quality.policy.manage"] }],
      [],
      { organisationWide: false, locationIds: [] },
    ],
    [
      "a grant at South adds South; a revoked one adds nothing",
      [assignment("registered_manager", NORTH)],
      [
        grant(["quality.policy.manage"], SOUTH),
        grant(["quality.policy.manage"], null, new Date("2026-10-01T00:00:00Z")),
      ],
      { organisationWide: false, locationIds: [NORTH, SOUTH] },
    ],
    [
      "a grant with no location is organisation-wide",
      [],
      [grant(["quality.policy.manage"], null)],
      { organisationWide: true, locationIds: [] },
    ],
  ])("%s", (_name, assignments, grants, expected) => {
    expect(placesHoldingPermission(assignments, grants, "quality.policy.manage", NOW)).toEqual(
      expected,
    );
  });

  it("keeps the organisation's settings to roles that hold them organisation-wide", () => {
    // The owner role assigned at one home is not the organisation's owner.
    const atOneHome = placesHoldingPermission(
      [assignment("owner", NORTH), assignment("group_executive")],
      [],
      "platform.tenant.manage",
      NOW,
    );
    expect(placesCover(atOneHome, null)).toBe(false);
    expect(placesCover(atOneHome, NORTH)).toBe(true);
    expect(placesCover(atOneHome, SOUTH)).toBe(false);
    const owner = placesHoldingPermission([assignment("owner")], [], "platform.tenant.manage", NOW);
    expect(placesCover(owner, null)).toBe(true);
    expect(placesCover(owner, SOUTH)).toBe(true);
  });
});
