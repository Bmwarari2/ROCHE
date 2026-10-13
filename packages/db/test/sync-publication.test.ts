import { readSyncConfig } from "@harbour/sync/streams";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { inContext } from "./support/fixtures";

/**
 * Every table a sync stream reads (packages/sync/src/streams/sync-config.yaml) must be in the
 * powersync publication, with SELECT and the replication policy for the sync role; otherwise the
 * PowerSync service skips it and a stream delivers nothing, so the phone shows less than the
 * person's record without saying so (HZ-006, HZ-018, HZ-028). Migration 0052 publishes the round
 * and handover tables.
 */

let db: TestDatabase;

beforeAll(async () => {
  db = await createTestDatabase();
});

afterAll(async () => {
  await db?.drop();
});

/** The source tables of every stream query: each name in a FROM list, aliases and quotes dropped. */
function streamSourceTables(config: string): string[] {
  const tables = new Set<string>();
  const query = config.split(/\s+/).join(" ");
  for (const match of query.matchAll(/ FROM (.+?) WHERE /g)) {
    for (const source of (match[1] ?? "").split(",")) {
      const name = source.trim().split(" ")[0]?.replaceAll('"', "");
      if (name) tables.add(name);
    }
  }
  return [...tables].sort();
}

describe("hazard HZ-018 hazard HZ-028 the sync publication", () => {
  it("reads the source tables of the stream queries, renamed outputs included", () => {
    const tables = streamSourceTables(readSyncConfig());
    for (const table of ["person", "person_assignment", "task", "handover_acknowledgement"]) {
      expect(tables).toContain(table);
    }
    expect(tables).not.toContain("handover_staff_acknowledgement");
    expect(tables).not.toContain("opener");
  });

  it("publishes every table a sync stream reads, readable by the sync role", async () => {
    const { rows } = await db
      .pool("harbour_owner")
      .query<{ table: string }>(
        "SELECT tablename AS table FROM pg_publication_tables WHERE pubname = 'powersync' AND schemaname = 'public'",
      );
    const published = new Set(rows.map((r) => r.table));
    for (const table of streamSourceTables(readSyncConfig())) {
      expect(published.has(table), `${table} is in the powersync publication`).toBe(true);
      // The replication snapshot is a plain SELECT by the sync role, outside any tenant context.
      await expect(
        inContext(db.pool("harbour_sync"), null, (c) => c.query(`SELECT 1 FROM ${table} LIMIT 1`)),
        `${table} is readable by harbour_sync`,
      ).resolves.toBeDefined();
    }
  });

  it("gives the sync role nothing but SELECT on the round and handover tables (migration 0052)", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ table: string; privilege: string }>(
      `SELECT table_name AS table, privilege_type AS privilege
       FROM information_schema.role_table_grants
       WHERE grantee = 'harbour_sync' AND table_schema = 'public'
         AND table_name IN ('task', 'handover', 'handover_item', 'handover_note',
           'handover_acknowledgement')`,
    );
    expect(rows.map((r) => `${r.table}:${r.privilege}`).sort()).toEqual([
      "handover:SELECT",
      "handover_acknowledgement:SELECT",
      "handover_item:SELECT",
      "handover_note:SELECT",
      "task:SELECT",
    ]);
    await expect(
      inContext(db.pool("harbour_sync"), null, (c) =>
        c.query("UPDATE task SET title = 'x' WHERE false"),
      ),
    ).rejects.toThrow(/permission denied/);
  });
});
