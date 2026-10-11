import { AppSchema as SharedSchema } from "@harbour/sync/client";
import { describe, expect, it } from "vitest";
import { AppSchema, DemoSchema, toRuntimeSchema } from "./schema";

describe("schema bridge", () => {
  it("serialises exactly like the shared @harbour/sync schema", () => {
    expect(AppSchema.toJSON()).toEqual(SharedSchema.toJSON());
  });

  it("keeps sync_meta local-only and the synced tables synced", () => {
    const tables = Object.fromEntries(AppSchema.tables.map((t) => [t.name, t.localOnly]));
    expect(tables).toEqual({ person: false, allergy: false, location: false, sync_meta: true });
  });

  it("makes every table local-only for the demo database", () => {
    expect(DemoSchema.tables.every((t) => t.localOnly)).toBe(true);
    expect(DemoSchema.tables.map((t) => t.name).sort()).toEqual(
      AppSchema.tables.map((t) => t.name).sort(),
    );
  });

  it("validates as a PowerSync schema", () => {
    expect(() => AppSchema.validate()).not.toThrow();
    expect(() => DemoSchema.validate()).not.toThrow();
  });

  it("round-trips indexes, descending columns and tracking options", () => {
    const source = {
      toJSON: () => ({
        tables: [
          {
            name: "note",
            view_name: "notes_view",
            local_only: false,
            insert_only: false,
            include_old: ["body"],
            include_old_only_when_changed: true,
            include_metadata: true,
            ignore_empty_update: true,
            columns: [
              { name: "body", type: "TEXT" },
              { name: "n", type: "INTEGER" },
              { name: "x", type: "REAL" },
            ],
            indexes: [
              { name: "by_n", columns: [{ name: "n", ascending: false, type: "INTEGER" }] },
            ],
          },
        ],
        raw_tables: [],
      }),
    };
    expect(toRuntimeSchema(source).toJSON()).toEqual(source.toJSON());
  });

  it("refuses raw tables rather than dropping them", () => {
    expect(() =>
      toRuntimeSchema({ toJSON: () => ({ tables: [], raw_tables: [{ name: "r" }] }) }),
    ).toThrow(/Raw tables/);
  });
});
