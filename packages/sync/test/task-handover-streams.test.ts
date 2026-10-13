import { beforeAll, describe, expect, it } from "vitest";
import { ROUND_AND_HANDOVER_TABLES } from "../src/client/schema";
import { offlineWindowDays } from "../src/client/window";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, type DeviceDataset, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * The round and the shift handover on the phone (care.md rule 8 and section 6). Logical
 * replication bypasses row-level security, so these tests alone prove that a device receives the
 * open tasks the round view shows (care.plan.read, `app.task_visible`) and the handovers, items,
 * notes and acknowledgements the handover views show (care.handover.manage, the handover
 * policies): only the token's tenant, only in the token's scope, only in the token's window, and
 * nothing the device sends widens it (hazard HZ-011). Invented people and values only.
 */

const A = "tenant-a";
const B = "tenant-b";
const NORTH = "loc-a-north";
const SOUTH = "loc-a-south";
const RIVER = "loc-b-river";
const TODAY = "2026-10-11";
const WINDOW = offlineWindowDays(new Date(`${TODAY}T10:00:00Z`), 3);
const NOW = `${TODAY}T09:00:00.000000Z`;
const OLD = "2026-09-01T09:00:00.000000Z";

const people = [
  { id: "ada", tenant_id: A, location_id: NORTH, status: "active" },
  { id: "ben", tenant_id: A, location_id: NORTH, status: "active" },
  { id: "cara", tenant_id: A, location_id: SOUTH, status: "active" },
  { id: "dev", tenant_id: B, location_id: RIVER, status: "active" },
  // Died in the shift: their record leaves managers' devices, the handover item about it does not.
  { id: "eve", tenant_id: A, location_id: NORTH, status: "deceased" },
];

const assignment = (id: string, tenant: string, user: string, person: string, ended = false) => ({
  id,
  tenant_id: tenant,
  tenant_user_id: user,
  person_id: person,
  deleted_at: ended ? "2026-10-10T00:00:00Z" : null,
});

function task(id: string, tenant: string, fields: Record<string, unknown>) {
  return {
    id,
    tenant_id: tenant,
    series_id: null,
    location_id: NORTH,
    person_id: null,
    kind: "care.reposition",
    title: "Reposition",
    required_permission: "care.note.write",
    assignee_tenant_user_id: null,
    due_at: NOW,
    status: "open",
    escalation_level: 0,
    deleted_at: null,
    details: '{"entries":[]}',
    status_reason: null,
    version: 1,
    ...fields,
  };
}

const handover = (id: string, tenant: string, location: string, shiftEnd: string) => ({
  id,
  tenant_id: tenant,
  location_id: location,
  shift_name: "day",
  shift_start: shiftEnd,
  shift_end: shiftEnd,
  compiled_at: shiftEnd,
  refreshed_at: shiftEnd,
  locked_at: null,
  deleted_at: null,
  updated_at: shiftEnd,
  version: 3,
});

/** The item's key as the compiler makes it: `kind:sourceType:sourceId:personId`. */
const key = (id: string, person: string | null) => `fall:observation:obs-${id}:${person ?? "-"}`;

const item = (id: string, tenant: string, handoverId: string, person: string | null) => ({
  id,
  tenant_id: tenant,
  handover_id: handoverId,
  key: key(id, person),
  position: 0,
  kind: "fall",
  person_id: person,
  source_type: "observation",
  source_id: `obs-${id}`,
  at: NOW,
  late_addition: 0,
  added_at: NOW,
});

const note = (id: string, handoverId: string, itemKey: string | null, person: string | null) => ({
  id,
  tenant_id: A,
  handover_id: handoverId,
  item_key: itemKey,
  person_id: person,
  body: "Invented note",
  device_id: "device-fixture",
  created_at: NOW,
  created_by: "nurse-a",
});

const ack = (id: string, handoverId: string, user: string, keys: string[], tenant = A) => ({
  id,
  tenant_id: tenant,
  handover_id: handoverId,
  tenant_user_id: user,
  item_keys: JSON.stringify(keys),
  acknowledged_at: NOW,
  device_id: "device-fixture",
});

const source: SourceRows = {
  person: people,
  person_assignment: [
    assignment("pa-1", A, "carer-a", "ada"),
    assignment("pa-2", A, "carer-a", "ben", true),
    assignment("pa-3", A, "agency", "cara"),
    assignment("pa-4", B, "agency", "dev"),
  ],
  task: [
    task("t-ada", A, { person_id: "ada", assignee_tenant_user_id: "nurse-a" }),
    task("t-ada-started", A, { person_id: "ada", status: "in_progress" }),
    task("t-ada-done", A, { person_id: "ada", status: "done" }),
    task("t-ada-skipped", A, { person_id: "ada", status: "skipped" }),
    task("t-ada-deleted", A, { person_id: "ada", deleted_at: NOW }),
    task("t-ada-old", A, { person_id: "ada", due_at: OLD }),
    task("t-ben", A, { person_id: "ben" }),
    task("t-cara", A, { person_id: "cara", location_id: SOUTH }),
    task("t-eve", A, { person_id: "eve" }),
    task("t-dev", B, { person_id: "dev", location_id: RIVER }),
    task("t-north-fridge", A, { kind: "platform.manual", title: "Fridge check" }),
    task("t-north-carer", A, { kind: "platform.manual", assignee_tenant_user_id: "carer-a" }),
    task("t-south-carer", A, {
      kind: "platform.manual",
      location_id: SOUTH,
      assignee_tenant_user_id: "carer-a",
    }),
    task("t-south-other", A, { kind: "platform.manual", location_id: SOUTH }),
    task("t-river-agency", B, {
      kind: "platform.manual",
      location_id: RIVER,
      assignee_tenant_user_id: "agency",
    }),
  ],
  handover: [
    handover("h-north-day", A, NORTH, `${TODAY}T19:00:00.000000Z`),
    handover("h-north-night", A, NORTH, `${TODAY}T07:00:00.000000Z`),
    handover("h-north-old", A, NORTH, OLD),
    handover("h-south-day", A, SOUTH, `${TODAY}T19:00:00.000000Z`),
    handover("h-river-day", B, RIVER, `${TODAY}T19:00:00.000000Z`),
  ],
  handover_item: [
    item("i-ada", A, "h-north-day", "ada"),
    item("i-ben", A, "h-north-day", "ben"),
    item("i-eve", A, "h-north-day", "eve"),
    item("i-nobody", A, "h-north-day", null),
    // Recorded at North before Cara moved South.
    item("i-cara-at-north", A, "h-north-day", "cara"),
    item("i-ada-old", A, "h-north-old", "ada"),
    item("i-cara", A, "h-south-day", "cara"),
    item("i-south-nobody", A, "h-south-day", null),
    item("i-dev", B, "h-river-day", "dev"),
  ],
  handover_note: [
    note("n-whole", "h-north-day", null, null),
    note("n-ada", "h-north-day", key("i-ada", "ada"), "ada"),
    note("n-ben", "h-north-day", key("i-ben", "ben"), "ben"),
    note("n-nobody", "h-north-day", key("i-nobody", null), null),
    // Written at North about Cara before she moved South.
    note("n-cara-at-north", "h-north-day", key("i-cara-at-north", "cara"), "cara"),
    note("n-south-whole", "h-south-day", null, null),
    note("n-old-whole", "h-north-old", null, null),
  ],
  handover_acknowledgement: [
    ack("k-carer", "h-north-day", "carer-a", [key("i-ada", "ada")]),
    // A nurse who acknowledged before Cara moved: their keys name her and her fall.
    ack("k-nurse", "h-north-day", "nurse-a", [key("i-ada", "ada"), key("i-cara-at-north", "cara")]),
    ack("k-carer-old", "h-north-old", "carer-a", [key("i-ada-old", "ada")]),
    ack("k-south-nurse", "h-south-day", "nurse-s", [key("i-cara", "cara")]),
    ack("k-agency-b", "h-river-day", "agency", [key("i-dev", "dev")], B),
  ],
};

/** A care worker's token by default: no location in full, assigned people for every family. */
const claims = (overrides: Partial<SyncTokenClaims>): Partial<SyncTokenClaims> => ({
  location_ids: [],
  people_location_ids: [],
  care_location_ids: [],
  entries_location_ids: [],
  handover_location_ids: [],
  people_assigned: true,
  care_assigned: true,
  entries_assigned: true,
  handover_assigned: true,
  offline_days: WINDOW,
  ...overrides,
});

/** A nurse or manager who sees North whole for the round and the handover. */
const manager = (overrides: Partial<SyncTokenClaims> = {}) =>
  claims({
    sub: "manager-a",
    tenant_id: A,
    care_location_ids: [NORTH],
    handover_location_ids: [NORTH],
    people_assigned: false,
    care_assigned: false,
    entries_assigned: false,
    handover_assigned: false,
    ...overrides,
  });

function everything(device: DeviceDataset): string[] {
  return ROUND_AND_HANDOVER_TABLES.flatMap((t) => ids(device, t));
}

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

describe("hazard HZ-011 the round's open tasks follow the round view (care.plan.read)", () => {
  it("gives a care worker the open tasks about assigned people and the tasks about nobody given to them", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    // Whoever the task is given to; never a person not assigned, or an ended assignment.
    expect(ids(device, "task")).toEqual([
      "t-ada",
      "t-ada-started",
      "t-north-carer",
      "t-south-carer",
    ]);
  });

  it("gives a manager every open task about the people at their locations, and about nobody there", async () => {
    const device = await syncFor(hydrated, source, manager());
    expect(ids(device, "task")).toEqual([
      "t-ada",
      "t-ada-started",
      "t-ben",
      "t-north-carer",
      "t-north-fridge",
    ]);
  });

  it("hazard HZ-028 takes a task off the device once it is done, skipped, deleted or due before the window", async () => {
    const device = await syncFor(hydrated, source, manager());
    for (const gone of ["t-ada-done", "t-ada-skipped", "t-ada-deleted", "t-ada-old", "t-eve"]) {
      expect(ids(device, "task")).not.toContain(gone);
    }
  });

  it("sends no task without the care claims, whatever the handover claims say", async () => {
    const device = await syncFor(
      hydrated,
      source,
      manager({ care_location_ids: [], handover_location_ids: [NORTH, SOUTH] }),
    );
    expect(ids(device, "task")).toEqual([]);
    const carer = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, care_assigned: false }),
    );
    expect(ids(carer, "task")).toEqual([]);
  });

  it("never sends the details or reasons the round does not need", async () => {
    const device = await syncFor(hydrated, source, manager());
    const row = device.tables.task?.get("t-ada");
    expect(row).toMatchObject({ person_id: "ada", assignee_tenant_user_id: "nurse-a", version: 1 });
    expect(row).not.toHaveProperty("details");
    expect(row).not.toHaveProperty("status_reason");
  });
});

describe("hazard HZ-011 hazard HZ-018 the handover follows the handover views (care.handover.manage)", () => {
  it("gives a whole reader the location's handovers in the window with every item, note and who acknowledged", async () => {
    const device = await syncFor(hydrated, source, manager({ sub: "nurse-a" }));
    expect(ids(device, "handover")).toEqual(["h-north-day", "h-north-night"]);
    expect(ids(device, "handover_item")).toEqual(["i-ada", "i-ben", "i-eve", "i-nobody"]);
    expect(ids(device, "handover_note")).toEqual(["n-ada", "n-ben", "n-nobody", "n-whole"]);
    // Their own acknowledgement with its keys; everyone's as who and when only.
    expect(ids(device, "handover_acknowledgement")).toEqual(["k-nurse"]);
    expect(ids(device, "handover_staff_acknowledgement")).toEqual(["k-carer", "k-nurse"]);
  });

  it("never sends another member's item keys, which name the people and what happened (review round 1, M1)", async () => {
    const device = await syncFor(hydrated, source, manager());
    expect(ids(device, "handover_acknowledgement")).toEqual([]);
    expect(device.tables.handover_staff_acknowledgement?.get("k-nurse")).toEqual({
      id: "k-nurse",
      tenant_id: A,
      handover_id: "h-north-day",
      tenant_user_id: "nurse-a",
      acknowledged_at: NOW,
    });
    // Cara has moved South, out of this manager's sight: nothing on the device names her.
    const everyValue = Object.values(device.tables).flatMap((t) =>
      [...t.values()].flatMap((row) => Object.values(row).map(String)),
    );
    expect(everyValue.some((v) => v.includes("cara"))).toBe(false);
  });

  it("hazard HZ-018 keeps an item about someone who died in the shift, though their record leaves", async () => {
    const device = await syncFor(
      hydrated,
      source,
      manager({ people_location_ids: [NORTH], people_assigned: false }),
    );
    expect(ids(device, "handover_item")).toContain("i-eve");
    expect(ids(device, "person")).not.toContain("eve");
  });

  it("leaves out an item about someone who now lives where the whole reader cannot see", async () => {
    const device = await syncFor(hydrated, source, manager());
    expect(ids(device, "handover_item")).not.toContain("i-cara-at-north");
  });

  it("gives a reader limited to their people only those people's items and notes, the handover's own notes and their own acknowledgement", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "carer-a", tenant_id: A }));
    // Where Ada lives; not South, not the old shift, not Ben (the assignment ended).
    expect(ids(device, "handover")).toEqual(["h-north-day", "h-north-night"]);
    expect(ids(device, "handover_item")).toEqual(["i-ada"]);
    // Never an item about nobody, or a note on one (slice 5 review round 3).
    expect(ids(device, "handover_note")).toEqual(["n-ada", "n-whole"]);
    expect(ids(device, "handover_acknowledgement")).toEqual(["k-carer"]);
    expect(ids(device, "handover_staff_acknowledgement")).toEqual([]);
  });

  it("gives a limited reader items and notes only from handovers they may open (review round 1, L1)", async () => {
    // Cara lives South now: North's handover, and what North's staff wrote about her there, is
    // not the agency carer's to open, as the API refuses it.
    const device = await syncFor(hydrated, source, claims({ sub: "agency", tenant_id: A }));
    expect(ids(device, "handover")).toEqual(["h-south-day"]);
    expect(ids(device, "handover_item")).toEqual(["i-cara"]);
    expect(ids(device, "handover_note")).toEqual(["n-south-whole"]);
    expect(ids(device, "handover_staff_acknowledgement")).toEqual([]);
  });

  it("keeps a whole reader's other homes limited to their own people (mixed scope, review round 1, L3)", async () => {
    // Whole at North; assigned to Cara at South (a carer who is also a nurse at North).
    const device = await syncFor(
      hydrated,
      source,
      manager({ sub: "agency", handover_assigned: true }),
    );
    expect(ids(device, "handover")).toEqual(["h-north-day", "h-north-night", "h-south-day"]);
    // North whole, with the item and note about Cara from before she moved, as the API shows them;
    // South only what is about Cara.
    expect(ids(device, "handover_item")).toEqual([
      "i-ada",
      "i-ben",
      "i-cara",
      "i-cara-at-north",
      "i-eve",
      "i-nobody",
    ]);
    expect(ids(device, "handover_note")).toEqual([
      "n-ada",
      "n-ben",
      "n-cara-at-north",
      "n-nobody",
      "n-south-whole",
      "n-whole",
    ]);
    // South's item about nobody and the South nurse's acknowledgement stay off the phone.
    expect(ids(device, "handover_item")).not.toContain("i-south-nobody");
    expect(ids(device, "handover_staff_acknowledgement")).toEqual(["k-carer", "k-nurse"]);
  });

  it("sends no handover without the handover claims, whatever the care claims say", async () => {
    const device = await syncFor(
      hydrated,
      source,
      manager({ handover_location_ids: [], care_location_ids: [NORTH, SOUTH] }),
    );
    const carer = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A, handover_assigned: false }),
    );
    for (const table of ROUND_AND_HANDOVER_TABLES.filter((t) => t !== "task")) {
      expect(ids(device, table), table).toEqual([]);
      expect(ids(carer, table), table).toEqual([]);
    }
  });

  it("never sends the refresh time, the version or device ids", async () => {
    const device = await syncFor(hydrated, source, manager());
    const columns = (table: string) =>
      new Set([...(device.tables[table]?.values() ?? [])].flatMap((row) => Object.keys(row)));
    for (const hidden of ["refreshed_at", "version", "updated_at", "deleted_at"]) {
      expect(columns("handover").has(hidden), hidden).toBe(false);
    }
    expect(columns("handover_note").has("device_id")).toBe(false);
    expect(columns("handover_acknowledgement").has("device_id")).toBe(false);
    // `key` is a keyword on the device.
    expect(device.tables.handover_item?.get("i-ada")?.item_key).toBe(key("i-ada", "ada"));
  });
});

describe("hazard HZ-011 the round and the handover across tenants and from the device", () => {
  it("gives a token for one tenant nothing from another, even with the other's location ids", async () => {
    const device = await syncFor(
      hydrated,
      source,
      manager({ care_location_ids: [RIVER], handover_location_ids: [RIVER] }),
    );
    expect(everything(device)).toEqual([]);
  });

  it("keeps an agency worker's two tenants apart", async () => {
    const inA = await syncFor(hydrated, source, claims({ sub: "agency", tenant_id: A }));
    expect(ids(inA, "task")).toEqual(["t-cara"]);
    expect(everything(inA).some((id) => id.includes("dev") || id.includes("river"))).toBe(false);
    const inB = await syncFor(hydrated, source, claims({ sub: "agency", tenant_id: B }));
    expect(ids(inB, "task")).toEqual(["t-dev", "t-river-agency"]);
    expect(ids(inB, "handover")).toEqual(["h-river-day"]);
    expect(ids(inB, "handover_item")).toEqual(["i-dev"]);
    expect(ids(inB, "handover_acknowledgement")).toEqual(["k-agency-b"]);
  });

  it("hazard HZ-028 ignores connection parameters that try to widen the scope or the window", async () => {
    const hostile = {
      tenant_id: B,
      sub: "manager-a",
      care_location_ids: [NORTH, SOUTH, RIVER],
      handover_location_ids: [NORTH, SOUTH, RIVER],
      offline_days: [OLD.slice(0, 10), TODAY],
    };
    const device = await syncFor(
      hydrated,
      source,
      claims({ sub: "carer-a", tenant_id: A }),
      hostile,
    );
    expect(ids(device, "task")).toEqual([
      "t-ada",
      "t-ada-started",
      "t-north-carer",
      "t-south-carer",
    ]);
    expect(ids(device, "handover")).toEqual(["h-north-day", "h-north-night"]);
    expect(ids(device, "handover_item")).toEqual(["i-ada"]);
    expect(ids(device, "handover_note")).toEqual(["n-ada", "n-whole"]);
    expect(ids(device, "handover_acknowledgement")).toEqual(["k-carer"]);
    expect(ids(device, "handover_staff_acknowledgement")).toEqual([]);
  });

  it("sends no task or handover when the token has no window or no tenant (fails closed)", async () => {
    const noWindow = await syncFor(hydrated, source, { ...manager(), offline_days: undefined });
    expect(everything(noWindow)).toEqual([]);
    const noTenant = await syncFor(hydrated, source, { ...manager(), tenant_id: undefined });
    expect(everything(noTenant)).toEqual([]);
  });
});
