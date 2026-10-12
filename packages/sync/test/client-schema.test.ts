import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  AppSchema,
  DEVICE_WRITABLE_TABLES,
  NEVER_EVICT_TABLES,
  OFFLINE_WINDOW_TABLES,
  ROUND_AND_HANDOVER_TABLES,
} from "../src/client/schema";
import { readSyncConfig } from "../src/streams/index";
import { compile, ids, syncFor } from "./support/simulator";

interface StreamDefinition {
  readonly query?: string;
  readonly queries?: readonly string[];
}

/** The output table and column names of a stream query, read with plain string operations. */
function outputColumns(raw: string): { table: string; columns: string[] } {
  // Folded YAML keeps the line breaks of more-indented lines, so normalise all whitespace first.
  const query = raw.split(/\s+/).join(" ");
  const upper = query.toUpperCase();
  const select = upper.indexOf("SELECT ") + "SELECT ".length;
  const from = upper.indexOf(" FROM ");
  // The output table is the first source table, or its alias when it is renamed (`AS "name"`).
  const source = (
    query
      .slice(from + " FROM ".length)
      .trim()
      .split(",")[0] ?? ""
  ).split(/\s+/);
  const table = (source[1]?.toUpperCase() === "AS" ? source[2] : source[0])?.replaceAll('"', "");
  const columns = query
    .slice(select, from)
    .split(",")
    .map((item) => {
      const words = item.trim().split(/\s+/);
      const last = words[words.length - 1] ?? "";
      const name = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1) : last;
      return name.replaceAll('"', "");
    });
  return { table: table ?? "", columns };
}

describe("client schema covers every stream", () => {
  it("declares every column every stream query selects", () => {
    const parsed = parse(readSyncConfig()) as { streams: Record<string, StreamDefinition> };
    const queries = Object.values(parsed.streams).flatMap((s) => [
      ...(s.query ? [s.query] : []),
      ...(s.queries ?? []),
    ]);
    const tablesSeen = new Set<string>();
    for (const query of queries) {
      const { table, columns } = outputColumns(query);
      tablesSeen.add(table);
      const declared = new Set(
        AppSchema.tables.find((t) => t.name === table)?.columns.map((c) => c.name) ?? [],
      );
      expect(declared.size, `${table} is declared`).toBeGreaterThan(0);
      for (const column of columns) {
        if (column === "id") continue;
        expect(declared.has(column), `${table}.${column}`).toBe(true);
      }
    }
    // Every synced table on the device has a stream; only local-only tables have none.
    for (const table of AppSchema.tables) {
      expect(tablesSeen.has(table.name) || table.localOnly, table.name).toBe(true);
    }
  });

  it("splits the care tables into reference data, windowed entries and the round and handover, and only entries are written", () => {
    const synced = AppSchema.tables.filter((t) => !t.localOnly).map((t) => t.name);
    expect(
      [...NEVER_EVICT_TABLES, ...OFFLINE_WINDOW_TABLES, ...ROUND_AND_HANDOVER_TABLES].sort(),
    ).toEqual(synced.sort());
    expect(DEVICE_WRITABLE_TABLES).toEqual(OFFLINE_WINDOW_TABLES);
  });

  it("keeps upload problems and bookkeeping on the device only", () => {
    const localOnly = AppSchema.tables.filter((t) => t.localOnly).map((t) => t.name);
    expect(localOnly.sort()).toEqual(["held_entry", "sync_meta", "upload_issue"]);
  });
});

/** The device schema and the stream outputs must agree, or synced columns are silently dropped. */
describe("client schema matches stream output", () => {
  it("declares every column the streams send", async () => {
    const { hydrated } = compile(readSyncConfig());
    const row = {
      id: "p1",
      tenant_id: "t1",
      location_id: "l1",
      status: "active",
      given_name: "Ada",
      family_name: "Example",
      preferred_name: null,
      date_of_birth: "1938-02-01",
      nhs_number: "9990000018",
      room_label: "12",
      photo_document_id: null,
      communication_needs: "[]",
      allergy_status: "unknown",
      updated_at: "2026-10-01T09:00:00Z",
      version: 1,
    };
    const device = await syncFor(
      hydrated,
      {
        person: [row],
        location: [
          {
            id: "l1",
            tenant_id: "t1",
            name: "North",
            regulator_location_id: "1-1",
            nation: "england",
          },
        ],
        allergy: [
          {
            id: "a1",
            tenant_id: "t1",
            person_id: "p1",
            substance: "Latex",
            reaction: null,
            severity: "mild",
            status: "active",
            recorded_at: "2026-10-01T09:00:00Z",
          },
        ],
      },
      { sub: "u1", tenant_id: "t1", location_ids: ["l1"], people_location_ids: ["l1"] },
    );
    expect(ids(device, "person")).toEqual(["p1"]);
    for (const tableName of ["person", "location", "allergy"]) {
      const declared = new Set(
        AppSchema.tables.find((t) => t.name === tableName)?.columns.map((c) => c.name) ?? [],
      );
      const sent = [...(device.tables[tableName]?.values() ?? [])].flatMap((r) => Object.keys(r));
      for (const column of sent) {
        if (column === "id") continue;
        expect(declared.has(column), `${tableName}.${column}`).toBe(true);
      }
    }
  });
});
