import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Care mode devices in the database (care.md section 6, Device integrity; hazards HZ-011 and
 * HZ-040): which member has used which device, written only in the system's view and read by the
 * member or the organisation's managers; deletion lists; copies of refused entries; one open sync
 * task per source; shared quotas.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;

const DEVICE = "0199d000-0000-4000-8000-0000000000d1";
const DEVICE_2 = "0199d000-0000-4000-8000-0000000000d2";
const DEVICE_B = "0199d000-0000-4000-8000-0000000000d3";

const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const app = () => db.pool("harbour_app");
/** The system's view: the API binds and revokes in the organisation's view. */
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const devicesSeen = (c: pg.PoolClient) =>
  c
    .query<{ device_id: string; tenant_user_id: string }>(
      "SELECT device_id, tenant_user_id FROM device_binding ORDER BY device_id, tenant_user_id",
    )
    .then((r) => r.rows.map((row) => `${row.device_id}:${row.tenant_user_id}`));

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asSystem((c) =>
    c.query(
      `INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2), ($1, $3), ($4, $3)`,
      [DEVICE, a.carer, a.manager, DEVICE_2],
    ),
  );
  await inContext(app(), ctx(TENANT_B, b.manager, "tenant"), (c) =>
    c.query("INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2)", [
      DEVICE_B,
      b.manager,
    ]),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 device bindings (part 1)", () => {
  it("keeps each organisation's bindings to itself", async () => {
    expect(await asOtherTenant(devicesSeen)).toEqual([`${DEVICE_B}:${b.manager}`]);
    expect(await asNorthManager(devicesSeen)).not.toContain(`${DEVICE_B}:${b.manager}`);
  });

  it("shows a member their own devices and a manager the organisation's", async () => {
    expect(await asCarer(devicesSeen)).toEqual([`${DEVICE}:${a.carer}`]);
    expect(await asNorthManager(devicesSeen)).toEqual(
      [`${DEVICE}:${a.carer}`, `${DEVICE}:${a.manager}`, `${DEVICE_2}:${a.manager}`].sort(),
    );
  });

  it("lets only the system's view bind or revoke", async () => {
    await expect(
      asCarer((c) =>
        c.query("INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2)", [
          DEVICE_2,
          a.carer,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asNorthManager((c) =>
      c.query(
        `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'lost_or_stolen'
         WHERE device_id = $2`,
        [a.northManager, DEVICE],
      ),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("never moves a binding, never moves a sighting back, and never undoes a revocation", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE device_binding SET tenant_user_id = $1 WHERE device_id = $2", [
          a.northManager,
          DEVICE_2,
        ]),
      ),
    ).rejects.toThrow(/keeps its device, member and first sighting/);
    const seen = await asSystem(async (c) => {
      await c.query(
        "UPDATE device_binding SET last_seen_at = '2000-01-01T00:00:00Z' WHERE device_id = $1",
        [DEVICE_2],
      );
      return c.query<{ later: boolean }>(
        "SELECT last_seen_at > '2001-01-01' AS later FROM device_binding WHERE device_id = $1",
        [DEVICE_2],
      );
    });
    expect(seen.rows[0]?.later).toBe(true);
    await asSystem((c) =>
      c.query(
        `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'replaced'
         WHERE device_id = $2`,
        [a.manager, DEVICE_2],
      ),
    );
    await expect(
      asSystem((c) =>
        c.query(
          "UPDATE device_binding SET revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL WHERE device_id = $1",
          [DEVICE_2],
        ),
      ),
    ).rejects.toThrow(/stays revoked/);
  });

  it("refuses a revocation without who or why, or with a reason not on the list", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE device_binding SET revoked_at = now() WHERE device_id = $1", [DEVICE]),
      ),
    ).rejects.toThrow(/device_binding_revocation/);
    await expect(
      asSystem((c) =>
        c.query(
          `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'because'
           WHERE device_id = $2`,
          [a.manager, DEVICE],
        ),
      ),
    ).rejects.toThrow(/device_binding_revocation/);
  });

  it("binds every member with an event from a device before migration 0030, first and last seen (backfill)", async () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../drizzle/0030_device_binding_security.sql", import.meta.url)),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf("-- backfill: begin"), sql.indexOf("-- backfill: end"));
    const OLD = "0199d000-0000-4000-8000-0000000000e1";
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, actor_tenant_user_id, device_id, occurred_at)
         VALUES
           ($1, 'sync.token.issue', 'device', $2, $3, $2, '2026-10-01T08:00:00Z'),
           ($1, 'sync.device.report', 'device', upper($2), $3, $2, '2026-10-03T08:00:00Z'),
           ($1, 'sync.token.issue', 'device', 'not-a-device', $3, NULL, '2026-10-02T08:00:00Z'),
           ($1, 'sync.token.issue', 'device', $2, $4, $2, '2026-10-02T08:00:00Z')`,
        [TENANT_A, OLD, a.northManager, "0193a000-0000-7000-8000-000000000999"],
      ),
    );
    const run = async () => {
      const client = await db.pool("harbour_owner").connect();
      try {
        await client.query("BEGIN");
        for (const statement of backfill.split("--> statement-breakpoint")) {
          if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    await run();
    await run();
    const rows = await asOwner(TENANT_A, (c) =>
      c.query<{ tenant_user_id: string; first_seen_at: Date; last_seen_at: Date }>(
        "SELECT tenant_user_id, first_seen_at, last_seen_at FROM device_binding WHERE device_id = $1",
        [OLD],
      ),
    );
    // One row: the member who is staff here, from the first event to the last; an event naming
    // no device, or from someone who is not a member, binds nothing.
    expect(rows.rows).toEqual([
      {
        tenant_user_id: a.northManager,
        first_seen_at: new Date("2026-10-01T08:00:00Z"),
        last_seen_at: new Date("2026-10-03T08:00:00Z"),
      },
    ]);
    // Row-level security is forced on the audit trail again.
    const forced = await db
      .pool("harbour_owner")
      .query<{ relforcerowsecurity: boolean }>(
        "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'audit_event'",
      );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
  });
});
