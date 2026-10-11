import { beforeAll, describe, expect, it } from "vitest";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * Sync stream isolation (master prompt 5.3): logical replication bypasses row-level security, so
 * these tests prove on their own that a device only receives its tenant's in-scope rows
 * (hazard HZ-011). Invented people and test-range NHS numbers only.
 */

const A = "tenant-a";
const B = "tenant-b";

const source: SourceRows = {
  location: [
    {
      id: "loc-a-north",
      tenant_id: A,
      name: "North House",
      regulator_location_id: "1-01",
      nation: "england",
    },
    {
      id: "loc-a-south",
      tenant_id: A,
      name: "South House",
      regulator_location_id: "1-02",
      nation: "england",
    },
    {
      id: "loc-b-river",
      tenant_id: B,
      name: "Riverside",
      regulator_location_id: "1-03",
      nation: "wales",
    },
  ],
  person: [
    person("ada", A, "loc-a-north", "9990000018"),
    person("ben", A, "loc-a-north", "9990000026"),
    person("cara", A, "loc-a-south", "9990000034"),
    person("dev", B, "loc-b-river", "9990000042"),
  ],
  allergy: [
    {
      id: "allergy-ada",
      tenant_id: A,
      person_id: "ada",
      substance: "Penicillin",
      reaction: null,
      severity: "severe",
      status: "active",
      recorded_at: "2026-10-01T09:00:00Z",
    },
    {
      id: "allergy-cara",
      tenant_id: A,
      person_id: "cara",
      substance: "Peanut",
      reaction: null,
      severity: "severe",
      status: "active",
      recorded_at: "2026-10-01T09:00:00Z",
    },
    {
      id: "allergy-dev",
      tenant_id: B,
      person_id: "dev",
      substance: "Latex",
      reaction: null,
      severity: "moderate",
      status: "active",
      recorded_at: "2026-10-01T09:00:00Z",
    },
  ],
  person_assignment: [
    { id: "pa-1", tenant_id: A, tenant_user_id: "carer-a", person_id: "ada", deleted_at: null },
    {
      id: "pa-2",
      tenant_id: A,
      tenant_user_id: "carer-a",
      person_id: "ben",
      deleted_at: "2026-10-10T00:00:00Z",
    },
    { id: "pa-3", tenant_id: B, tenant_user_id: "agency-in-b", person_id: "dev", deleted_at: null },
    {
      id: "pa-4",
      tenant_id: A,
      tenant_user_id: "agency-in-a",
      person_id: "cara",
      deleted_at: null,
    },
  ],
};

function person(id: string, tenant: string, location: string, nhs: string) {
  return {
    id,
    tenant_id: tenant,
    location_id: location,
    status: "active",
    given_name: id,
    family_name: "Example",
    preferred_name: null,
    date_of_birth: "1940-01-01",
    nhs_number: nhs,
    room_label: null,
    photo_document_id: null,
    communication_needs: "[]",
    allergy_status: "has_allergies",
    updated_at: "2026-10-01T09:00:00Z",
    version: 1,
    // Columns that must never reach a device.
    address_line1: "1 Example Street",
    postcode: "ZZ99 9ZZ",
    religion: "fixture",
  };
}

const claims = (overrides: Partial<SyncTokenClaims>): Partial<SyncTokenClaims> => ({
  location_ids: [],
  people_location_ids: [],
  ...overrides,
});

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

describe("sync streams definition", () => {
  it("pins every stream query to the token's tenant", () => {
    const yaml = readSyncConfig();
    const queries = yaml.split(/\n {2}[a-z_]+:\n/).slice(1);
    expect(queries.length).toBeGreaterThanOrEqual(5);
    for (const q of queries) expect(q).toContain("auth.parameter('tenant_id')");
  });
});

describe("hazard HZ-011 care worker (assigned scope)", () => {
  it("receives only assigned people and their allergies", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, location_ids: ["loc-a-north"] }),
    );
    expect(ids(device, "person")).toEqual(["ada"]);
    expect(ids(device, "allergy")).toEqual(["allergy-ada"]);
    expect(ids(device, "location")).toEqual(["loc-a-north"]);
  });

  it("stops receiving a person once the assignment has ended", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    expect(ids(device, "person")).not.toContain("ben");
  });

  it("never receives address or other columns the device does not need", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    const ada = device.tables.person?.get("ada");
    expect(ada).toBeDefined();
    expect(Object.keys(ada ?? {})).not.toEqual(expect.arrayContaining(["address_line1"]));
    expect(ada).not.toHaveProperty("postcode");
    expect(ada).not.toHaveProperty("religion");
  });
});

describe("hazard HZ-011 location manager (locations scope)", () => {
  it("receives everyone at their locations and nobody elsewhere", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({
        sub: "manager-a",
        tenant_id: A,
        location_ids: ["loc-a-north"],
        people_location_ids: ["loc-a-north"],
      }),
    );
    expect(ids(device, "person")).toEqual(["ada", "ben"]);
    expect(ids(device, "allergy")).toEqual(["allergy-ada"]);
  });
});

describe("hazard HZ-011 cross-tenant isolation", () => {
  it("gives a token for one tenant nothing from another, even with the other's location ids", async () => {
    const device = await syncFor(
      hydrated,
      source,
      claims({
        sub: "manager-a",
        tenant_id: A,
        location_ids: ["loc-b-river"],
        people_location_ids: ["loc-b-river"],
      }),
    );
    expect(ids(device, "person")).toEqual([]);
    expect(ids(device, "location")).toEqual([]);
    expect(ids(device, "allergy")).toEqual([]);
  });

  it("ignores an assignment that belongs to another tenant", async () => {
    // agency-in-b is assigned to Dev in tenant B; a tenant A token for the same id gets nothing.
    const device = await syncFor(hydrated, source, claims({ sub: "agency-in-b", tenant_id: A }));
    expect(ids(device, "person")).toEqual([]);
  });

  it("keeps an agency worker's two tenants apart", async () => {
    const inB = await syncFor(hydrated, source, claims({ sub: "agency-in-b", tenant_id: B }));
    expect(ids(inB, "person")).toEqual(["dev"]);
    expect(ids(inB, "allergy")).toEqual(["allergy-dev"]);
    const inA = await syncFor(hydrated, source, claims({ sub: "agency-in-a", tenant_id: A }));
    expect(ids(inA, "person")).toEqual(["cara"]);
  });

  it("gives a token without a tenant nothing at all", async () => {
    const device = await syncFor(hydrated, source, { sub: "carer-a" });
    expect(device.buckets.flatMap((b) => ids(device, b))).toEqual([]);
    expect(Object.values(device.tables).every((t) => t.size === 0)).toBe(true);
  });
});
