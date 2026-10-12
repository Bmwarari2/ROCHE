import { describe, expect, it } from "vitest";
import {
  mayRecordFor,
  parseStoredWriteScope,
  serialiseWriteScope,
  type WriteScope,
  writeScopeFromToken,
} from "./write-scope";

/**
 * Hazard HZ-073 (ADR-0071 review rounds 2 and 3, C2-M3 and C3-M2): the phone offers recording
 * only where the user's care.note.write reaches, as the sync token says, so a coordinator who may
 * read people at their home is never offered to record what the server would refuse with no copy
 * kept, and a coordinator who is also a care worker records about the clients assigned to them.
 */

const NORTH = "loc-north";
const SOUTH = "loc-south";
const ADA = "person-ada";
const BEN = "person-ben";
const CARA = "person-cara";

const token = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "u1", tenant_id: "t1", ...claims })).toString("base64url"),
    "signature",
  ].join(".");

describe("hazard HZ-073 where the phone may record (review rounds 2 to 4, C2-M3 and C3-M2)", () => {
  it("reads the write claims from the sync token, with the assigned people", () => {
    expect(
      writeScopeFromToken(
        token({
          people_location_ids: [NORTH],
          entries_write_location_ids: [NORTH],
          entries_write_assigned: true,
          entries_write_person_ids: [ADA],
        }),
      ),
    ).toEqual({
      locationIds: [NORTH],
      assigned: true,
      personIds: [ADA],
      peopleLocationIds: [NORTH],
    });
    // A token that does not name the people (more than it carries).
    expect(
      writeScopeFromToken(
        token({
          people_location_ids: [NORTH],
          entries_write_location_ids: [],
          entries_write_assigned: true,
        }),
      ),
    ).toEqual({ locationIds: [], assigned: true, personIds: null, peopleLocationIds: [NORTH] });
  });

  it("reads nothing from a token without write claims or one it cannot read", () => {
    expect(writeScopeFromToken(token({ people_location_ids: [NORTH] }))).toBeNull();
    expect(writeScopeFromToken("not-a-token")).toBeNull();
    expect(writeScopeFromToken("a.%%%.b")).toBeNull();
  });

  const coordinator: WriteScope = {
    locationIds: [],
    assigned: false,
    personIds: null,
    peopleLocationIds: [NORTH],
  };
  const carer: WriteScope = {
    locationIds: [],
    assigned: true,
    personIds: [ADA],
    peopleLocationIds: [],
  };
  const nurse: WriteScope = {
    locationIds: [NORTH],
    assigned: false,
    personIds: null,
    peopleLocationIds: [NORTH],
  };
  // Reads everyone at North as a coordinator; records about Ada, assigned to them, as a carer.
  const coordinatorAndCarer: WriteScope = {
    locationIds: [],
    assigned: true,
    personIds: [ADA],
    peopleLocationIds: [NORTH],
  };
  // More than 100 assigned people: the token names none (review round 4).
  const unnamedCarer: WriteScope = {
    locationIds: [],
    assigned: true,
    personIds: null,
    peopleLocationIds: [],
  };
  const unnamedCoordinatorAndCarer: WriteScope = {
    locationIds: [],
    assigned: true,
    personIds: null,
    peopleLocationIds: [NORTH],
  };
  const ada = { id: ADA, locationId: NORTH };
  const ben = { id: BEN, locationId: NORTH };
  const cara = { id: CARA, locationId: SOUTH };

  it.each([
    ["a coordinator, at their home", coordinator, ben, false],
    ["a care worker, about someone they are assigned to", carer, ada, true],
    ["a care worker, about someone they are not assigned to", carer, ben, false],
    ["a nurse, at their home", nurse, ben, true],
    ["a nurse, about someone elsewhere", nurse, cara, false],
    // The server takes it: the care worker role reaches the people assigned to them (C3-M2).
    [
      "a coordinator who is also a carer, about an assigned client at the home they read",
      coordinatorAndCarer,
      ada,
      true,
    ],
    [
      "a coordinator who is also a carer, about someone else at the home they read",
      coordinatorAndCarer,
      ben,
      false,
    ],
    // Over 100 assigned people, the token names none: the location rule (review round 4).
    [
      "a carer with over 100 clients, about someone at a home synced only for them",
      unnamedCarer,
      ben,
      true,
    ],
    [
      "a coordinator who is also a carer with over 100 clients, at the home they read",
      unnamedCoordinatorAndCarer,
      ada,
      false,
    ],
    [
      "a coordinator who is also a carer with over 100 clients, about someone elsewhere",
      unnamedCoordinatorAndCarer,
      cara,
      true,
    ],
  ] as const)("%s", (_name, scope, person, expected) => {
    expect(mayRecordFor(person, scope)).toBe(expected);
  });

  it("records about no one while no scope is known, whatever the permissions (review round 5)", () => {
    // Before any token, or once a token's scope could not be kept or read: never a guess.
    expect(mayRecordFor(ada, null)).toBe(false);
    expect(mayRecordFor(cara, null)).toBe(false);
  });

  it("keeps the scope across a restart, and reads one stored before the people were named", () => {
    expect(parseStoredWriteScope(serialiseWriteScope(carer))).toEqual(carer);
    expect(parseStoredWriteScope(serialiseWriteScope(nurse))).toEqual(nurse);
    expect(
      parseStoredWriteScope(
        JSON.stringify({ locationIds: [NORTH], assigned: true, peopleLocationIds: [NORTH] }),
      ),
    ).toEqual({
      locationIds: [NORTH],
      assigned: true,
      personIds: null,
      peopleLocationIds: [NORTH],
    });
    expect(parseStoredWriteScope("{}")).toBeNull();
    expect(parseStoredWriteScope("not json")).toBeNull();
    expect(parseStoredWriteScope(null)).toBeNull();
  });
});
