import { builtinRole, type RoleAssignmentInput, resolveAccess } from "@harbour/domain";
import { describe, expect, it } from "vitest";
import { familyReach, SYNCED_READS } from "../src/routes/sync";

/**
 * Hazard HZ-011 (ADR-0071 review round 1, C-M1 and S-M1): which locations, and whether the people
 * they are assigned to, sync for each family of streams, for every built-in role used in Care mode.
 * Each family follows its own read permission only, from the roles carrying it.
 */

const NORTH = "0194d000-0000-7000-8000-000000000101";
const SOUTH = "0194d000-0000-7000-8000-000000000102";
const NOW = new Date("2026-10-12T09:00:00Z");

function roleAt(key: string, locationId: string): RoleAssignmentInput {
  const role = builtinRole(key);
  if (!role) throw new Error(`No built-in role ${key}`);
  return {
    roleKey: role.key,
    scopeKind: role.scopeKind,
    permissions: [...role.permissions],
    locationId,
    organisationWide: false,
    validFrom: new Date("2026-01-01T00:00:00Z"),
    validTo: null,
  };
}

type Reach = { readonly locationIds: string[]; readonly assigned: boolean };
const at = (...locationIds: string[]): Reach => ({ locationIds, assigned: false });
const assigned: Reach = { locationIds: [], assigned: true };
const nothing: Reach = { locationIds: [], assigned: false };

const cases: ReadonlyArray<{
  readonly name: string;
  readonly roles: readonly string[];
  readonly people: Reach;
  readonly care: Reach;
  readonly entries: Reach;
}> = [
  { name: "carer", roles: ["care_worker"], people: assigned, care: assigned, entries: assigned },
  {
    name: "agency worker",
    roles: ["agency_worker"],
    people: assigned,
    care: assigned,
    entries: assigned,
  },
  {
    name: "senior carer or team leader",
    roles: ["team_leader"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
  },
  {
    name: "nurse",
    roles: ["clinical_lead"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
  },
  {
    // The coordinator holds no care.note.read: the person and the care reference sync at their
    // home, recent entries nowhere (before this change, nothing synced at all).
    name: "care coordinator",
    roles: ["care_coordinator"],
    people: at(NORTH),
    care: at(NORTH),
    entries: nothing,
  },
  {
    name: "Registered Manager",
    roles: ["registered_manager"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
  },
  {
    name: "carer who is also a nurse at the home",
    roles: ["care_worker", "clinical_lead"],
    people: { locationIds: [NORTH], assigned: true },
    care: { locationIds: [NORTH], assigned: true },
    entries: { locationIds: [NORTH], assigned: true },
  },
  {
    name: "coordinator who also works as a carer",
    roles: ["care_coordinator", "care_worker"],
    people: { locationIds: [NORTH], assigned: true },
    care: { locationIds: [NORTH], assigned: true },
    entries: assigned,
  },
];

describe("hazard HZ-011 sync stream families per built-in Care mode role (ADR-0071 review round 1, C-M1)", () => {
  it("serves one read permission per family", () => {
    expect(SYNCED_READS).toEqual({
      people: "people.person.read",
      care: "care.plan.read",
      entries: "care.note.read",
    });
  });

  it.each(cases)("$name", ({ roles, people, care, entries }) => {
    const effective = resolveAccess(
      roles.map((key) => roleAt(key, NORTH)),
      [],
      NOW,
    );
    const all = [NORTH, SOUTH];
    expect(familyReach(effective, "people", all)).toEqual(people);
    expect(familyReach(effective, "care", all)).toEqual(care);
    expect(familyReach(effective, "entries", all)).toEqual(entries);
  });

  it("syncs the whole organisation for a family only where its permission reaches it", () => {
    const owner = resolveAccess(
      [{ ...roleAt("owner", NORTH), locationId: null, organisationWide: false }],
      [],
      NOW,
    );
    expect(familyReach(owner, "people", [NORTH, SOUTH]).locationIds).toEqual([NORTH, SOUTH]);
  });
});
