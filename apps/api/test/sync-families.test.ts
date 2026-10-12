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
  /** Where the phone may record (care.note.write; review round 2, C2-M3). */
  readonly write: Reach;
}> = [
  {
    name: "carer",
    roles: ["care_worker"],
    people: assigned,
    care: assigned,
    entries: assigned,
    write: assigned,
  },
  {
    name: "agency worker",
    roles: ["agency_worker"],
    people: assigned,
    care: assigned,
    entries: assigned,
    write: assigned,
  },
  {
    name: "senior carer or team leader",
    roles: ["team_leader"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
    write: at(NORTH),
  },
  {
    name: "nurse",
    roles: ["clinical_lead"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
    write: at(NORTH),
  },
  {
    // The coordinator holds no care.note.read: the person and the care reference sync at their
    // home, recent entries nowhere (before this change, nothing synced at all).
    name: "care coordinator",
    roles: ["care_coordinator"],
    people: at(NORTH),
    care: at(NORTH),
    entries: nothing,
    write: nothing,
  },
  {
    name: "Registered Manager",
    roles: ["registered_manager"],
    people: at(NORTH),
    care: at(NORTH),
    entries: at(NORTH),
    write: at(NORTH),
  },
  {
    name: "carer who is also a nurse at the home",
    roles: ["care_worker", "clinical_lead"],
    people: { locationIds: [NORTH], assigned: true },
    care: { locationIds: [NORTH], assigned: true },
    entries: { locationIds: [NORTH], assigned: true },
    write: { locationIds: [NORTH], assigned: true },
  },
  {
    // Reads everyone at the home as a coordinator; records about the clients assigned to them as a
    // carer, which the token names (`entries_write_person_ids`), so the phone offers recording for
    // them although their home syncs in full for reading (review round 3, C3-M2).
    name: "coordinator who also works as a carer",
    roles: ["care_coordinator", "care_worker"],
    people: { locationIds: [NORTH], assigned: true },
    care: { locationIds: [NORTH], assigned: true },
    entries: assigned,
    write: assigned,
  },
];

describe("hazard HZ-011 sync stream families per built-in Care mode role (ADR-0071 review round 1, C-M1)", () => {
  it("serves each family's own permissions", () => {
    expect(SYNCED_READS).toEqual({
      // A person syncs only where their care reference does too (review round 2).
      people: ["people.person.read", "care.plan.read"],
      care: ["care.plan.read"],
      entries: ["care.note.read"],
      entries_write: ["care.note.write"],
    });
  });

  it.each(cases)("$name", ({ roles, people, care, entries, write }) => {
    const effective = resolveAccess(
      roles.map((key) => roleAt(key, NORTH)),
      [],
      NOW,
    );
    const all = [NORTH, SOUTH];
    expect(familyReach(effective, "people", all)).toEqual(people);
    expect(familyReach(effective, "care", all)).toEqual(care);
    expect(familyReach(effective, "entries", all)).toEqual(entries);
    expect(familyReach(effective, "entries_write", all)).toEqual(write);
  });

  it("syncs no person where people.person.read reaches but care.plan.read does not (review round 2)", () => {
    const granted = resolveAccess(
      [roleAt("care_coordinator", NORTH)],
      [
        {
          permissions: ["people.person.read"],
          locationId: SOUTH,
          organisationWide: false,
          validFrom: new Date("2026-01-01T00:00:00Z"),
          validTo: new Date("2027-01-01T00:00:00Z"),
          revokedAt: null,
        },
      ],
      NOW,
    );
    expect(familyReach(granted, "people", [NORTH, SOUTH])).toEqual(at(NORTH));
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
