import { readFileSync } from "node:fs";
import type { SqliteRow } from "@powersync/service-sync-rules";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_OFFLINE_WINDOW_DAYS, offlineWindowDays, shiftWindowDays } from "../src/client/window";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * Buckets per connection (ADR-0134; HZ-002). PowerSync refuses a connection whose buckets, or
 * whose parameter query results, pass the limits in infra/powersync/powersync.yaml (PSYNC_S2305),
 * and the phone then gets no fresh data at all: no care record, no round, no handover. Streams
 * keyed by person and day made thousands for one phone at a 60-bed home. These profiles measure
 * the worst cases on the real stream engine, at the longest offline window the rate table allows:
 * the design target is half the configured limit; every profile stays under the limit itself.
 * Invented ids only.
 */

const NOW = new Date("2026-11-06T10:00:00Z");
const DAYS = offlineWindowDays(NOW, MAX_OFFLINE_WINDOW_DAYS);
const TARGET = 500;

function limit(key: string): number {
  const config = readFileSync(
    new URL("../../../infra/powersync/powersync.yaml", import.meta.url),
    "utf8",
  );
  const match = config.match(new RegExp(`^\\s+${key}: (\\d+)$`, "m"));
  if (!match) throw new Error(`${key} is not set in powersync.yaml`);
  return Number(match[1]);
}

/** Homes L (120 beds), M and N (20 each); two handovers a day at each, for the whole window. */
const people = Array.from({ length: 160 }, (_, i) => ({
  id: `p${i}`,
  tenant_id: "A",
  location_id: i < 120 ? "L" : i < 140 ? "M" : "N",
  status: "active",
  deleted_at: null,
}));
const handovers = DAYS.flatMap((d) =>
  ["L", "M", "N"].flatMap((home) =>
    ["day", "night"].map((shift) => ({
      id: `h-${home}-${d}-${shift}`,
      tenant_id: "A",
      location_id: home,
      shift_name: shift,
      shift_end: `${d} 20:00:00+00`,
      deleted_at: null,
    })),
  ),
);
const assign = (who: readonly { id: string }[]): SqliteRow[] =>
  who.map((p, i) => ({
    id: `pa${i}`,
    tenant_id: "A",
    person_id: p.id,
    tenant_user_id: "member",
    deleted_at: null,
  }));

const base: Partial<SyncTokenClaims> = {
  sub: "member",
  tenant_id: "A",
  location_ids: ["L"],
  offline_days: DAYS,
  shift_days: shiftWindowDays(NOW),
};
const wholeHome = {
  people_location_ids: ["L"],
  care_location_ids: ["L"],
  entries_location_ids: ["L"],
  handover_location_ids: ["L"],
  entries_write_location_ids: ["L"],
};
const noHome = {
  people_location_ids: [],
  care_location_ids: [],
  entries_location_ids: [],
  handover_location_ids: [],
};
const assigned = (on: boolean) => ({
  people_assigned: on,
  care_assigned: on,
  entries_assigned: on,
  handover_assigned: on,
  entries_write_assigned: on,
});

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

const measure = (claims: Partial<SyncTokenClaims>, assignments: SqliteRow[]) =>
  syncFor(
    hydrated,
    { person: people, person_assignment: assignments, handover: handovers } as SourceRows,
    claims,
  );

describe("hazard HZ-002 a phone stays under PowerSync's buckets per connection (ADR-0134)", () => {
  it("sets both limits explicitly in the PowerSync config", () => {
    expect(limit("max_buckets_per_connection")).toBeGreaterThanOrEqual(2 * TARGET);
    expect(limit("max_parameter_query_results")).toBeGreaterThanOrEqual(2 * TARGET);
  });

  it.each([
    // A nurse or manager reaching a 120-bed home whole (the API leaves their assigned streams off
    // when the home already carries everyone they are assigned to).
    ["the whole of a 120-bed home", { ...base, ...wholeHome, ...assigned(false) }, []],
    // A care worker with 20 people across two homes.
    [
      "20 assigned people at two homes",
      { ...base, ...noHome, ...assigned(true) },
      assign([...people.slice(0, 10), ...people.slice(120, 130)]),
    ],
  ] as const)("keeps %s at or under the design target", async (_case, claims, assignments) => {
    const device = await measure(claims, [...assignments]);
    expect(device.buckets.length).toBeLessThanOrEqual(TARGET);
    expect(device.parameterResults).toBeLessThanOrEqual(TARGET);
  });

  it.each([
    [
      "the whole of a 120-bed home and 20 people at two other homes",
      { ...base, ...wholeHome, ...assigned(true) },
      assign([...people.slice(120, 130), ...people.slice(140, 150)]),
    ],
    [
      "40 assigned people at two homes",
      { ...base, ...noHome, ...assigned(true) },
      assign([...people.slice(0, 20), ...people.slice(120, 140)]),
    ],
  ] as const)("keeps %s under the configured limits", async (_case, claims, assignments) => {
    const device = await measure(claims, [...assignments]);
    expect(device.buckets.length).toBeLessThan(limit("max_buckets_per_connection"));
    expect(device.parameterResults).toBeLessThan(limit("max_parameter_query_results"));
  });

  it("keys a whole home's rows by home and day, never by person", async () => {
    const device = await measure({ ...base, ...wholeHome, ...assigned(false) }, []);
    const dayStreams = device.buckets.filter((b) =>
      /^location_(recent_entries|open_tasks|handovers)\|/.test(b),
    );
    expect(dayStreams.some((b) => /"p\d+"/.test(b))).toBe(false);
  });

  it("syncs no assigned entry, task or handover item without the token's ten-day blocks (fails closed)", async () => {
    const source = {
      person: people,
      person_assignment: assign(people.slice(0, 1)),
      care_note: [
        {
          id: "note",
          tenant_id: "A",
          person_id: "p0",
          location_id: "L",
          occurred_at: `${DAYS.at(-2)} 08:00:00+00`,
          category: "personal_care",
          body: "Invented",
        },
      ],
    } as SourceRows;
    const claims = { ...base, ...noHome, ...assigned(true) };
    expect(ids(await syncFor(hydrated, source, claims), "care_note")).toEqual(["note"]);
    const without = await syncFor(hydrated, source, { ...claims, offline_blocks: [] });
    expect(ids(without, "care_note")).toEqual([]);
  });
});
