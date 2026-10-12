import { describe, expect, it } from "vitest";
import {
  mayRecordFor,
  parseStoredWriteScope,
  serialiseWriteScope,
  type WriteScope,
  writeScopeFromToken,
} from "./write-scope";

/**
 * Hazard HZ-073 (ADR-0071 review round 2, C2-M3): the phone offers recording only where the
 * user's care.note.write reaches, as the sync token says, so a coordinator who may read people at
 * their home is never offered to record what the server would refuse with no copy kept.
 */

const NORTH = "loc-north";
const SOUTH = "loc-south";

const token = (claims: Record<string, unknown>) =>
  [
    Buffer.from(JSON.stringify({ alg: "ES256" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "u1", tenant_id: "t1", ...claims })).toString("base64url"),
    "signature",
  ].join(".");

describe("hazard HZ-073 where the phone may record (review round 2, C2-M3)", () => {
  it("reads the write claims from the sync token", () => {
    expect(
      writeScopeFromToken(
        token({
          people_location_ids: [NORTH],
          entries_write_location_ids: [NORTH],
          entries_write_assigned: false,
        }),
      ),
    ).toEqual({ locationIds: [NORTH], assigned: false, peopleLocationIds: [NORTH] });
  });

  it("reads nothing from a token without write claims or one it cannot read", () => {
    expect(writeScopeFromToken(token({ people_location_ids: [NORTH] }))).toBeNull();
    expect(writeScopeFromToken("not-a-token")).toBeNull();
    expect(writeScopeFromToken("a.%%%.b")).toBeNull();
  });

  const coordinator: WriteScope = { locationIds: [], assigned: false, peopleLocationIds: [NORTH] };
  const carer: WriteScope = { locationIds: [], assigned: true, peopleLocationIds: [] };
  const nurse: WriteScope = { locationIds: [NORTH], assigned: false, peopleLocationIds: [NORTH] };
  const coordinatorAndCarer: WriteScope = {
    locationIds: [],
    assigned: true,
    peopleLocationIds: [NORTH],
  };

  it.each([
    ["a coordinator, at their home", coordinator, NORTH, false],
    ["a care worker, about someone they are assigned to", carer, NORTH, true],
    ["a nurse, at their home", nurse, NORTH, true],
    ["a nurse, about someone elsewhere", nurse, SOUTH, false],
    [
      "a coordinator who is also a carer, about an assigned person elsewhere",
      coordinatorAndCarer,
      SOUTH,
      true,
    ],
    // Synced through their home, where the user may only read: shown read only (fails closed).
    ["a coordinator who is also a carer, at the home they read", coordinatorAndCarer, NORTH, false],
    ["anyone, before any token has been seen", null, NORTH, true],
  ] as const)("%s: %s", (_name, scope, locationId, expected) => {
    expect(mayRecordFor(locationId, scope)).toBe(expected);
  });

  it("keeps the scope across a restart", () => {
    expect(parseStoredWriteScope(serialiseWriteScope(nurse))).toEqual(nurse);
    expect(parseStoredWriteScope("{}")).toBeNull();
    expect(parseStoredWriteScope("not json")).toBeNull();
    expect(parseStoredWriteScope(null)).toBeNull();
  });
});
