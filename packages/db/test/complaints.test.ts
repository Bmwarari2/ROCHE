import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Complaints and compliments in the database (Phase 2 slice 18; SAFE-011; migration 0080; hazard
 * HZ-011): forced RLS; read, recorded and changed only by a holder of safety.complaint.manage where
 * the record is, recorded in the holder's own name; a record keeps its identity, home, receipt time
 * and recorder; nothing is deleted by the application; never seen or written across organisations.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE = "0199f000-0000-7000-8000-000000000811";
const TABLES = ["complaint", "compliment"] as const;
type Table = (typeof TABLES)[number];
const app = () => db.pool("harbour_app");
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "tenant"), fn);
const asTenantB = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), fn);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

/** One record of each kind at a home, in the recorder's name. */
function insert(table: Table, locationId: string, recordedBy: string, tenantId?: string) {
  const tenant = tenantId ? "tenant_id, " : "";
  const value = tenantId ? `'${tenantId}', ` : "";
  return table === "complaint"
    ? `INSERT INTO complaint (${tenant}location_id, complainant_name, complainant_relationship,
         channel, received_at, knew_of_matter_on, summary, recorded_by)
       VALUES (${value}'${locationId}', 'Pat Example', 'family_or_friend', 'email', now(),
         current_date, 'Meals arrive cold at lunchtime.', '${recordedBy}') RETURNING id`
    : `INSERT INTO compliment (${tenant}location_id, from_name, from_relationship, received_at,
         summary, recorded_by)
       VALUES (${value}'${locationId}', 'Sam Example', 'family_or_friend', now(),
         'Thank you for the birthday tea.', '${recordedBy}') RETURNING id`;
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'complaints_lead', 'Complaints lead', 'location', '{safety.complaint.manage}')`,
      [ROLE],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE, a.locationNorth],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 complaints and compliments (migration 0080)", () => {
  it.each(TABLES)("records a %s at the holder's own home, in their own name", async (table) => {
    const { rows } = await asNorthManager((c) =>
      c.query<{ id: string }>(insert(table, a.locationNorth, a.northManager)),
    );
    expect(rows).toHaveLength(1);
    const read = await asNorthManager((c) => c.query(`SELECT id FROM ${table}`));
    expect(read.rows.map((r) => r.id)).toContain(rows[0]?.id);
  });

  it.each(TABLES)("refuses a %s at another home or in someone else's name", async (table) => {
    await expect(
      asNorthManager((c) => c.query(insert(table, a.locationSouth, a.northManager))),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorthManager((c) => c.query(insert(table, a.locationNorth, a.manager))),
    ).rejects.toThrow(/row-level security/);
  });

  it.each(TABLES)("hides every %s from a member without the permission", async (table) => {
    await asNorthManager((c) => c.query(insert(table, a.locationNorth, a.northManager)));
    const { rows } = await asCarer((c) => c.query(`SELECT id FROM ${table}`));
    expect(rows).toEqual([]);
    await expect(asCarer((c) => c.query(insert(table, a.locationNorth, a.carer)))).rejects.toThrow(
      /row-level security/,
    );
  });

  it.each(TABLES)("never shows or writes a %s across organisations", async (table) => {
    await asNorthManager((c) => c.query(insert(table, a.locationNorth, a.northManager)));
    const { rows } = await asTenantB((c) => c.query(`SELECT id FROM ${table}`));
    expect(rows).toEqual([]);
    await expect(
      asTenantB((c) => c.query(insert(table, a.locationNorth, ids.b.manager, TENANT_A))),
    ).rejects.toThrow(/row-level security|violates foreign key/);
  });

  it.each(TABLES)(
    "keeps a %s's identity and home, versions it, and never deletes it",
    async (table) => {
      const { rows } = await asNorthManager((c) =>
        c.query<{ id: string }>(insert(table, a.locationNorth, a.northManager)),
      );
      const id = rows[0]?.id;
      await expect(
        ownerDb((c) =>
          c.query(`UPDATE ${table} SET location_id = $1 WHERE id = $2`, [a.locationSouth, id]),
        ),
      ).rejects.toThrow(/keeps its identity/);
      await asNorthManager((c) =>
        c.query(`UPDATE ${table} SET summary = 'Updated after a call.' WHERE id = $1`, [id]),
      );
      const versions = await ownerDb((c) =>
        c.query("SELECT 1 FROM record_version WHERE record_id = $1", [id]),
      );
      expect(versions.rows.length).toBeGreaterThanOrEqual(1);
      await expect(
        asNorthManager((c) =>
          c.query(`UPDATE ${table} SET deleted_at = now() WHERE id = $1`, [id]),
        ),
      ).rejects.toThrow(/retention schedule/);
      await expect(
        asNorthManager((c) => c.query(`DELETE FROM ${table} WHERE id = $1`, [id])),
      ).rejects.toThrow(/permission denied/);
    },
  );
});
