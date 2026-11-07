import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * Migration 0152 (ADR-0127): stored words people read carry the product name, Thapsus Care. The
 * starter templates from 0081 change; global rate and retention rows change as a re-seed would;
 * a tenant's own rows keep the tenant's words; a second run changes nothing.
 */

const DRIZZLE = fileURLToPath(new URL("../drizzle/", import.meta.url));
const OLD = "Harbour";
const NEW = "Thapsus Care";

let db: TestDatabase;

async function asOwner<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  return inContext(db.pool("harbour_owner"), null, fn);
}

async function rerun(): Promise<void> {
  const sql = readFileSync(`${DRIZZLE}0152_product_name_stored_rows.sql`, "utf8");
  await asOwner(async (c) => {
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.replace(/--.*$/gm, "").trim()) await c.query(statement);
    }
  });
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("the product name in stored rows (migration 0152, ADR-0127)", () => {
  it("names Thapsus Care in every starter template's source", async () => {
    const { rows } = await asOwner((c) =>
      c.query<{ key: string; source: string }>(
        "SELECT key, source FROM audit_starter_template ORDER BY key",
      ),
    );
    expect(rows).toHaveLength(7);
    for (const row of rows) {
      expect(row.source).not.toMatch(/\bHarbour\b/);
      expect(row.source).toContain(NEW);
    }
  });

  it("renames global rate and retention rows, keeps a tenant's own words, and is idempotent", async () => {
    await asOwner(async (c) => {
      await c.query(
        `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
         VALUES ('test.rename_global', '1', 'count', 'uk', '2026-01-01', $1, 'verified')`,
        [`${OLD} policy default, not a statutory figure`],
      );
      await c.query(
        `INSERT INTO retention_class (record_class, period, unit, trigger, source, notes)
         VALUES ('test_rename_global', 1, 'years', 'created', $1, $2),
                ('test_rename_no_notes', 1, 'years', 'created', $1, NULL)`,
        [`${OLD} default for data minimisation`, `${OLD} default for the DPO to confirm.`],
      );
    });
    await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        `INSERT INTO rate_table (tenant_id, key, value, unit, nation, valid_from, source, verification_status)
         VALUES ($1, 'test.rename_tenant', '2', 'count', 'uk', '2026-01-01', $2, 'verified')`,
        [TENANT_A, `Set by ${OLD} Example Care`],
      ),
    );

    await rerun();
    await rerun();

    const global = await asOwner((c) =>
      c.query<{ source: string }>("SELECT source FROM rate_table WHERE key = 'test.rename_global'"),
    );
    expect(global.rows).toEqual([{ source: `${NEW} policy default, not a statutory figure` }]);
    const retention = await asOwner((c) =>
      c.query<{ record_class: string; source: string; notes: string | null }>(
        `SELECT record_class, source, notes FROM retention_class
          WHERE record_class LIKE 'test_rename_%' ORDER BY record_class`,
      ),
    );
    expect(retention.rows).toEqual([
      {
        record_class: "test_rename_global",
        source: `${NEW} default for data minimisation`,
        notes: `${NEW} default for the DPO to confirm.`,
      },
      {
        record_class: "test_rename_no_notes",
        source: `${NEW} default for data minimisation`,
        notes: null,
      },
    ]);
    const tenant = await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query<{ source: string }>("SELECT source FROM rate_table WHERE key = 'test.rename_tenant'"),
    );
    expect(tenant.rows).toEqual([{ source: `Set by ${OLD} Example Care` }]);
  });
});
