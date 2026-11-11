import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The retention report (retention sweeps plan slice 4; ADR-0135): counts only, written by the
 * system in each organisation's context, read only in tenant-wide scope, never by another
 * organisation, and append-only (each run is a new row).
 */

let db: TestDatabase;
const app = () => db.pool("harbour_app");
const LINES = JSON.stringify([
  { table: "care_note", recordClass: "care_record", reason: null, counts: { due: 0, held: 0 } },
]);

const write = (tenantId: string, mode = "report") =>
  inContext(app(), ctx(tenantId, null, "tenant"), (c) =>
    c.query(
      `INSERT INTO retention_report (mode, as_of, duration_ms, tables_read, tables_skipped, lines, totals)
       VALUES ($1, now(), 12, 1, 0, $2::jsonb, '{}'::jsonb) RETURNING id`,
      [mode, LINES],
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await write(TENANT_A);
  await write(TENANT_B);
});

afterAll(async () => {
  await db?.drop();
});

const count = (context: ReturnType<typeof ctx>) =>
  inContext(app(), context, async (c) => {
    const { rows } = await c.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM retention_report",
    );
    return rows[0]?.n;
  });

describe("retention_report", () => {
  it("shows each organisation only its own reports, in tenant-wide scope only", async () => {
    expect(await count(ctx(TENANT_A, ids.a.manager, "tenant"))).toBe(1);
    expect(await count(ctx(TENANT_B, ids.b.manager, "tenant"))).toBe(1);
    expect(await count(ctx(TENANT_A, ids.a.northManager, "locations", [ids.a.locationNorth]))).toBe(
      0,
    );
    // The owner too is held to tenant-wide scope (ADR-0002; migration 0162).
    const asOwner = await inContext(
      db.pool("harbour_owner"),
      ctx(TENANT_A, ids.a.northManager, "locations", [ids.a.locationNorth]),
      (c) => c.query<{ n: number }>("SELECT count(*)::int AS n FROM retention_report"),
    );
    expect(asOwner.rows[0]?.n).toBe(0);
  });

  it("refuses a report written for another organisation", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query(
          `INSERT INTO retention_report (tenant_id, mode, as_of, duration_ms, tables_read, tables_skipped, lines, totals)
           VALUES ($1, 'report', now(), 1, 0, 0, '[]', '{}')`,
          [TENANT_B],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses a mode the slice does not support", async () => {
    await expect(write(TENANT_A, "destroy")).rejects.toThrow(/retention_report_mode/);
  });

  it("is append-only: never updated or deleted, by the application or the owner", async () => {
    for (const statement of [
      "UPDATE retention_report SET duration_ms = 0",
      "DELETE FROM retention_report",
    ]) {
      await expect(
        inContext(app(), ctx(TENANT_A, null, "tenant"), (c) => c.query(statement)),
      ).rejects.toThrow();
      await expect(
        inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), (c) =>
          c.query(statement),
        ),
      ).rejects.toThrow();
    }
    expect(await count(ctx(TENANT_A, ids.a.manager, "tenant"))).toBe(1);
  });
});
