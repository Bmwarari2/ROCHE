import { beforeAll, describe, expect, it } from "vitest";
import { shiftWindowDays } from "../src/client/window";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * The member's own shifts and clock events on the phone (scheduling.md section 18; Phase 2 slice
 * 71). Logical replication bypasses row-level security, so these tests alone prove that a phone
 * receives only its own member's published, uncancelled shifts and their own clock events, in the
 * token's tenant and shift days, never a colleague's, and that nothing the device sends widens it
 * (hazard HZ-011). Invented ids only.
 */

const A = "tenant-a";
const B = "tenant-b";
const NORTH = "loc-a-north";
const DAYS = shiftWindowDays(new Date("2026-10-11T10:00:00Z"));
const PUBLISHED = "2026-10-01 09:00:00+00";

const shift = (
  id: string,
  tenant: string,
  startsAt: string,
  extra: { published?: boolean; cancelled?: boolean } = {},
) => ({
  id,
  tenant_id: tenant,
  location_id: NORTH,
  label: "Early",
  kind: "work",
  starts_at: startsAt,
  ends_at: startsAt.replace(" 07:", " 15:"),
  break_minutes: 30,
  changed_after_publish_at: null,
  published_at: extra.published === false ? null : PUBLISHED,
  deleted_at: extra.cancelled ? "2026-10-05 09:00:00+00" : null,
  cancel_reason: extra.cancelled ? "No longer needed" : null,
});

const assignment = (
  id: string,
  tenant: string,
  shiftId: string,
  worker: string,
  extra: { published?: boolean; removed?: boolean } = {},
) => ({
  id,
  tenant_id: tenant,
  shift_id: shiftId,
  location_id: NORTH,
  worker_id: worker,
  published_at: extra.published === false ? null : PUBLISHED,
  deleted_at: extra.removed ? "2026-10-05 09:00:00+00" : null,
});

const clock = (id: string, tenant: string, worker: string, deviceTime: string) => ({
  id,
  tenant_id: tenant,
  worker_id: worker,
  kind: "in",
  shift_id: null,
  location_id: NORTH,
  device_time: deviceTime,
  recorded_at: deviceTime,
  flags: "[]",
});

const source: SourceRows = {
  shift: [
    shift("s-mine-today", A, "2026-10-11 07:00:00+00"),
    shift("s-mine-next-week", A, "2026-10-18 07:00:00+00"),
    shift("s-mine-yesterday-night", A, "2026-10-10 07:00:00+00"),
    shift("s-mine-old", A, "2026-10-01 07:00:00+00"),
    shift("s-mine-far", A, "2026-10-25 07:00:00+00"),
    shift("s-colleague", A, "2026-10-11 07:00:00+00"),
    shift("s-unpublished", A, "2026-10-12 07:00:00+00", { published: false }),
    shift("s-cancelled", A, "2026-10-12 07:00:00+00", { cancelled: true }),
    shift("s-assignment-draft", A, "2026-10-13 07:00:00+00"),
    shift("s-assignment-removed", A, "2026-10-13 07:00:00+00"),
    shift("s-other-tenant", B, "2026-10-11 07:00:00+00"),
  ],
  shift_assignment: [
    assignment("a1", A, "s-mine-today", "me"),
    assignment("a2", A, "s-mine-next-week", "me"),
    assignment("a3", A, "s-mine-yesterday-night", "me"),
    assignment("a4", A, "s-mine-old", "me"),
    assignment("a5", A, "s-mine-far", "me"),
    assignment("a6", A, "s-colleague", "colleague"),
    assignment("a7", A, "s-unpublished", "me"),
    assignment("a8", A, "s-cancelled", "me"),
    assignment("a9", A, "s-assignment-draft", "me", { published: false }),
    assignment("a10", A, "s-assignment-removed", "me", { removed: true }),
    // The same member id in another tenant: never crosses.
    assignment("a11", B, "s-other-tenant", "me"),
  ],
  clock_event: [
    clock("c-mine", A, "me", "2026-10-11 07:02:00+00"),
    clock("c-mine-old", A, "me", "2026-10-01 07:02:00+00"),
    clock("c-colleague", A, "colleague", "2026-10-11 07:01:00+00"),
    clock("c-other-tenant", B, "me", "2026-10-11 07:03:00+00"),
  ],
};

const claims = (overrides: Partial<SyncTokenClaims> = {}): Partial<SyncTokenClaims> => ({
  sub: "me",
  tenant_id: A,
  location_ids: [NORTH],
  people_location_ids: [],
  care_location_ids: [],
  entries_location_ids: [],
  handover_location_ids: [],
  people_assigned: false,
  care_assigned: false,
  entries_assigned: false,
  handover_assigned: false,
  offline_days: [],
  shift_days: DAYS,
  ...overrides,
});

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

describe("hazard HZ-011 only the member's own shifts and clock events reach their phone", () => {
  it("gives the member their own published, uncancelled shifts in the shift days, nothing else", async () => {
    const device = await syncFor(hydrated, source, claims());
    expect(ids(device, "shift")).toEqual([
      "s-mine-next-week",
      "s-mine-today",
      "s-mine-yesterday-night",
    ]);
  });

  it("gives the member their own clock events in the shift days, never a colleague's", async () => {
    const device = await syncFor(hydrated, source, claims());
    expect(ids(device, "clock_event")).toEqual(["c-mine"]);
  });

  it("gives a colleague theirs, and never the member's", async () => {
    const device = await syncFor(hydrated, source, claims({ sub: "colleague" }));
    expect(ids(device, "shift")).toEqual(["s-colleague"]);
    expect(ids(device, "clock_event")).toEqual(["c-colleague"]);
  });

  it("keeps each tenant's rows to its own token, for the same member id", async () => {
    const device = await syncFor(hydrated, source, claims({ tenant_id: B }));
    expect(ids(device, "shift")).toEqual(["s-other-tenant"]);
    expect(ids(device, "clock_event")).toEqual(["c-other-tenant"]);
  });

  it("syncs no shift and no clock event without the shift days claim (no timesheet.self: fails closed)", async () => {
    for (const shiftDays of [[], undefined]) {
      const device = await syncFor(hydrated, source, claims({ shift_days: shiftDays }));
      expect(ids(device, "shift"), String(shiftDays)).toEqual([]);
      expect(ids(device, "clock_event"), String(shiftDays)).toEqual([]);
    }
  });

  it("ignores whatever the device sends to widen the member, the tenant or the days", async () => {
    const device = await syncFor(hydrated, source, claims(), {
      sub: "colleague",
      worker_id: "colleague",
      tenant_id: B,
      shift_days: ["2026-10-01", "2026-10-25"],
    });
    expect(ids(device, "shift")).toEqual([
      "s-mine-next-week",
      "s-mine-today",
      "s-mine-yesterday-night",
    ]);
    expect(ids(device, "clock_event")).toEqual(["c-mine"]);
  });

  it("syncs no lone-worker table at all (a duress press must never reach the phone as one)", async () => {
    const device = await syncFor(
      hydrated,
      {
        ...source,
        lone_worker_session: [{ id: "lw1", tenant_id: A, worker_id: "me" }],
        lone_worker_event: [{ id: "e1", tenant_id: A, worker_id: "me", kind: "duress" }],
      },
      claims(),
    );
    expect(Object.keys(device.tables).filter((t) => t.startsWith("lone_worker"))).toEqual([]);
  });
});
