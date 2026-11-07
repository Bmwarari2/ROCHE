import { readFileSync } from "node:fs";
import type { SqliteRow } from "@powersync/service-sync-rules";
import { beforeAll, describe, expect, it } from "vitest";
import {
  MAX_OFFLINE_WINDOW_DAYS,
  medsRecentDays,
  offlineWindowBlocks,
  offlineWindowDays,
  shiftWindowDays,
} from "../src/client/window";
import { estimateBuckets, SYNC_BUCKET_LIMIT } from "../src/streams/budget";
import { readSyncConfig, type SyncTokenClaims } from "../src/streams/index";
import { compile, ids, type SourceRows, syncFor } from "./support/simulator";

/**
 * Buckets per connection (ADR-0134; HZ-002, HZ-138). PowerSync refuses a connection whose buckets,
 * or whose parameter query results, pass the limits in infra/powersync/powersync.yaml (PSYNC_S2305),
 * and the phone then gets no fresh data at all. These profiles measure, on the real stream engine,
 * at the longest offline window the rate table allows and on the dates whose windows span the most
 * ten-day blocks (across February), the worst cases: a whole 120-bed home and a care worker with
 * 20 people stay at or under half the limit; groups of homes and large assignment counts are
 * estimated, and the API narrows a token whose estimate passes the limit (`estimateBuckets`, never
 * below what the engine makes). Invented ids only.
 */

const TARGET = SYNC_BUCKET_LIMIT / 2;
const DATES = ["2026-11-06T10:00:00Z", "2027-02-28T10:00:00Z", "2028-02-29T10:00:00Z"];
const HOMES = ["H0", "H1", "H2", "H3", "H4", "H5"];
const BEDS = 60;

function limit(key: string): number {
  const config = readFileSync(
    new URL("../../../infra/powersync/powersync.yaml", import.meta.url),
    "utf8",
  );
  const match = config.match(new RegExp(`^\\s+${key}: (\\d+)$`, "m"));
  if (!match) throw new Error(`${key} is not set in powersync.yaml`);
  return Number(match[1]);
}

/** Six homes of 60 people (home H0 doubled to 120 beds), two handovers a day at each. */
const people = HOMES.flatMap((home) =>
  Array.from({ length: home === "H0" ? 2 * BEDS : BEDS }, (_, i) => ({
    id: `${home}-p${i}`,
    tenant_id: "A",
    location_id: home,
    status: "active",
    deleted_at: null,
  })),
);
const at = (home: string, n: number) => people.filter((p) => p.location_id === home).slice(0, n);

let hydrated: ReturnType<typeof compile>["hydrated"];

beforeAll(() => {
  const compiled = compile(readSyncConfig());
  expect(compiled.errors).toEqual([]);
  hydrated = compiled.hydrated;
});

interface Profile {
  readonly whole: readonly string[];
  /** The medicines family's whole homes, when wider than the others' (defaults to `whole`). */
  readonly medsWhole?: readonly string[];
  readonly assigned: readonly { id: string; location_id: string }[];
}

async function measure(date: string, profile: Profile) {
  const now = new Date(date);
  const days = offlineWindowDays(now, MAX_OFFLINE_WINDOW_DAYS);
  const handovers = days.flatMap((d) =>
    HOMES.flatMap((home) =>
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
  const on = profile.assigned.length > 0;
  const claims: Partial<SyncTokenClaims> = {
    sub: "member",
    tenant_id: "A",
    location_ids: [...profile.whole],
    offline_days: days,
    shift_days: shiftWindowDays(now),
    people_location_ids: [...profile.whole],
    care_location_ids: [...profile.whole],
    entries_location_ids: [...profile.whole],
    handover_location_ids: [...profile.whole],
    people_assigned: on,
    care_assigned: on,
    entries_assigned: on,
    handover_assigned: on,
    // Medicines on the phone (slice 68): the same reach, with the administrations' 35 days.
    meds_location_ids: [...(profile.medsWhole ?? profile.whole)],
    meds_assigned: on,
    meds_recent_days: medsRecentDays(now),
    meds_recent_blocks: offlineWindowBlocks(medsRecentDays(now)),
  };
  const assignments: SqliteRow[] = profile.assigned.map((p, i) => ({
    id: `pa${i}`,
    tenant_id: "A",
    person_id: p.id,
    tenant_user_id: "member",
    deleted_at: null,
  }));
  const device = await syncFor(
    hydrated,
    { person: people, person_assignment: assignments, handover: handovers } as SourceRows,
    claims,
  );
  const estimate = estimateBuckets({
    days: days.length,
    blocks: offlineWindowBlocks(days).length,
    shiftDays: shiftWindowDays(now).length,
    entriesHomes: profile.whole.length,
    careHomes: profile.whole.length,
    handoverHomes: profile.whole.length,
    wholePeople: people.filter((p) => profile.whole.includes(p.location_id)).length,
    assignedPeople: profile.assigned.length,
    assignedHomes: new Set(profile.assigned.map((p) => p.location_id)).size,
    medsHomes: (profile.medsWhole ?? profile.whole).length,
    medsPeople: people.filter((p) => (profile.medsWhole ?? profile.whole).includes(p.location_id))
      .length,
    medsDays: medsRecentDays(now).length,
    medsBlocks: offlineWindowBlocks(medsRecentDays(now)).length,
    medsAssignedPeople: profile.assigned.length,
  });
  return { device, estimate };
}

describe("hazard HZ-002 a phone stays under PowerSync's buckets per connection (ADR-0134)", () => {
  it("sets both limits explicitly in the PowerSync config, as the API's estimate assumes", () => {
    expect(limit("max_buckets_per_connection")).toBe(SYNC_BUCKET_LIMIT);
    expect(limit("max_parameter_query_results")).toBeGreaterThanOrEqual(SYNC_BUCKET_LIMIT);
  });

  it("moves a person's records over more days than any offline window holds (HZ-138)", () => {
    const migration = readFileSync(
      new URL("../../db/drizzle/0146_sync_location.sql", import.meta.url),
      "utf8",
    );
    const moved = migration.match(/- interval '(\d+) days'/);
    expect(moved).not.toBeNull();
    // The window is tomorrow, today and the days before: MAX_OFFLINE_WINDOW_DAYS + 1 days.
    expect(Number(moved?.[1])).toBeGreaterThan(MAX_OFFLINE_WINDOW_DAYS + 1);
  });

  it("spans at most six ten-day blocks in a 32-day window, across February too", () => {
    for (const date of ["2027-02-28T10:00:00Z", "2028-02-29T10:00:00Z", "2027-03-01T10:00:00Z"]) {
      const days = offlineWindowDays(new Date(date), MAX_OFFLINE_WINDOW_DAYS);
      expect(offlineWindowBlocks(days).length, date).toBeLessThanOrEqual(6);
    }
  });

  describe.each(DATES)("on %s", (date) => {
    it.each([
      // A nurse or manager reaching a 120-bed home whole (the API leaves their assigned streams
      // off when the home already carries everyone they are assigned to).
      ["the whole of a 120-bed home", { whole: ["H0"], assigned: [] }],
      // A care worker with 15 people across two homes: with medicines on the phone (slice 68),
      // each assigned person costs about 28 buckets at the 31-day window.
      [
        "15 assigned people at two homes",
        { whole: [], assigned: [...at("H1", 8), ...at("H2", 7)] },
      ],
    ] as const)("keeps %s at or under the design target", async (_case, profile) => {
      const { device, estimate } = await measure(date, profile);
      expect(device.buckets.length).toBeLessThanOrEqual(TARGET);
      expect(device.parameterResults).toBeLessThanOrEqual(TARGET);
      expect(estimate).toBeGreaterThanOrEqual(device.buckets.length);
    });

    it.each([
      ["two homes whole", { whole: ["H1", "H2"], assigned: [] }],
      [
        "one home for the care record and five for medicines (rebuild review, M1)",
        { whole: ["H1"], medsWhole: ["H1", "H2", "H3", "H4", "H5"], assigned: [] },
      ],
      ["five homes whole", { whole: ["H1", "H2", "H3", "H4", "H5"], assigned: [] }],
      [
        "a 120-bed home and 20 people at two other homes",
        { whole: ["H0"], assigned: [...at("H1", 10), ...at("H2", 10)] },
      ],
      [
        "20 assigned people at two homes",
        { whole: [], assigned: [...at("H1", 10), ...at("H2", 10)] },
      ],
      [
        "40 assigned people at two homes",
        { whole: [], assigned: [...at("H1", 20), ...at("H2", 20)] },
      ],
      [
        "100 assigned people at two homes",
        { whole: [], assigned: [...at("H1", 50), ...at("H2", 50)] },
      ],
    ] as const)(
      "estimates %s at or above what the engine makes, and under the limit when the estimate is",
      async (_case, profile) => {
        const { device, estimate } = await measure(date, profile);
        expect(estimate).toBeGreaterThanOrEqual(device.buckets.length);
        if (estimate <= SYNC_BUCKET_LIMIT) {
          expect(device.buckets.length).toBeLessThanOrEqual(SYNC_BUCKET_LIMIT);
          expect(device.parameterResults).toBeLessThanOrEqual(limit("max_parameter_query_results"));
        }
      },
    );
  });

  it("keys a whole home's rows by home and day, never by person", async () => {
    const { device } = await measure(DATES[0] as string, { whole: ["H0"], assigned: [] });
    const dayStreams = device.buckets.filter((b) =>
      /^location_(recent_entries|open_tasks|handovers)\|/.test(b),
    );
    expect(dayStreams.some((b) => /-p\d+"/.test(b))).toBe(false);
  });

  it("syncs no assigned entry without the token's ten-day blocks (fails closed)", async () => {
    const now = new Date(DATES[0] as string);
    const days = offlineWindowDays(now, MAX_OFFLINE_WINDOW_DAYS);
    const source = {
      person: people,
      person_assignment: [
        {
          id: "pa",
          tenant_id: "A",
          person_id: "H1-p0",
          tenant_user_id: "member",
          deleted_at: null,
        },
      ],
      care_note: [
        {
          id: "note",
          tenant_id: "A",
          person_id: "H1-p0",
          location_id: "H1",
          occurred_at: `${days.at(-2)} 08:00:00+00`,
          category: "personal_care",
          body: "Invented",
        },
      ],
    } as SourceRows;
    const claims: Partial<SyncTokenClaims> = {
      sub: "member",
      tenant_id: "A",
      offline_days: days,
      entries_assigned: true,
    };
    expect(ids(await syncFor(hydrated, source, claims), "care_note")).toEqual(["note"]);
    const without = await syncFor(hydrated, source, { ...claims, offline_blocks: [] });
    expect(ids(without, "care_note")).toEqual([]);
  });
});
