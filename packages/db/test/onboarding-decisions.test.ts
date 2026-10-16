import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Onboarding decisions in the database (PLAT-018; platform-completions.md rules 26 and 27;
 * migration 0064; hazard HZ-011): append-only records with who and when, read with the
 * onboarding permissions, written only by a holder of platform.onboarding.manage in their own
 * name, never changed or removed, and never seen or written across organisations. The staff file
 * option on `tenant` changes only with the same permission.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_ONBOARDER = "0199f000-0000-7000-8000-000000000801";
const TABLES = ["tenant_setting_decision", "retention_decision", "dcb0160_record"] as const;
const app = () => db.pool("harbour_app");
const asMember =
  (userId: string, tenant = TENANT_A) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const asManager = asMember(a.manager);
const asCarer = asMember(a.carer);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

/** One decision of each kind, as the member in the session. */
const INSERTS: Record<(typeof TABLES)[number], string> = {
  tenant_setting_decision:
    "INSERT INTO tenant_setting_decision (rate_key, kind) VALUES ('handover.shift_hours', 'accepted')",
  retention_decision:
    "INSERT INTO retention_decision (record_class, kind) VALUES ('care_record', 'accepted')",
  dcb0160_record: "INSERT INTO dcb0160_record (safety_case_version) VALUES ('v0.0')",
};

/** The same decisions, naming this organisation from another one. */
const CROSS: Record<(typeof TABLES)[number], string> = {
  tenant_setting_decision:
    "INSERT INTO tenant_setting_decision (tenant_id, rate_key, kind) VALUES ($1, 'handover.shift_hours', 'accepted')",
  retention_decision:
    "INSERT INTO retention_decision (tenant_id, record_class, kind) VALUES ($1, 'care_record', 'accepted')",
  dcb0160_record: "INSERT INTO dcb0160_record (tenant_id, safety_case_version) VALUES ($1, 'v0.0')",
};

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'onboarder', 'Onboarder', 'tenant', '{platform.onboarding.manage}')`,
      [ROLE_ONBOARDER],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_ONBOARDER,
    ]);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 onboarding decisions (migration 0064)", () => {
  it.each(TABLES)("records %s in the holder's own name, and never changes it", async (table) => {
    await asManager((c) => c.query(INSERTS[table]));
    const actor = table === "dcb0160_record" ? "recorded_by" : "decided_by";
    const rows = await ownerDb((c) => c.query(`SELECT ${actor} AS actor FROM ${table}`));
    expect(rows.rows).toEqual([{ actor: a.manager }]);
    await expect(
      asManager((c) => c.query(`UPDATE ${table} SET created_at = now()`)),
    ).rejects.toThrow(/permission denied/);
    await expect(asManager((c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(
      /permission denied/,
    );
    // Not even the owner role changes a decision: a later one is a new row.
    await expect(ownerDb((c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(/append-only/);
  });

  it.each(TABLES)(
    "refuses %s from anyone without platform.onboarding.manage, or for someone else",
    async (table) => {
      await expect(asCarer((c) => c.query(INSERTS[table]))).rejects.toThrow(/row-level security/);
      const actor = table === "dcb0160_record" ? "recorded_by" : "decided_by";
      await expect(
        asManager((c) =>
          c.query(
            INSERTS[table].replace(") VALUES (", `, ${actor}) VALUES (`).replace(/\)$/, ", $1)"),
            [a.carer],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    },
  );

  it.each(TABLES)(
    "shows %s to no one without an onboarding permission, and to no other organisation",
    async (table) => {
      expect((await asCarer((c) => c.query(`SELECT id FROM ${table}`))).rowCount).toBe(0);
      expect(
        (await asMember(ids.b.manager, TENANT_B)((c) => c.query(`SELECT id FROM ${table}`)))
          .rowCount,
      ).toBe(0);
      // Another organisation's member, writing into this one, is refused.
      await expect(
        asMember(ids.b.manager, TENANT_B)((c) => c.query(CROSS[table], [TENANT_A])),
      ).rejects.toThrow(/row-level security|violates/);
    },
  );

  it("changes the staff file option only with platform.onboarding.manage", async () => {
    const set = (option: string) => (c: pg.PoolClient) =>
      c.query("UPDATE tenant SET staff_file_option = $1 WHERE id = $2", [option, TENANT_A]);
    await expect(asCarer(set("staff_file.after_leaving"))).rejects.toThrow(
      /platform.onboarding.manage/,
    );
    await asManager(set("staff_file.to_75th_birthday"));
    await expect(asManager(set("staff_file.forever"))).rejects.toThrow(/tenant_staff_file_option/);
  });
});
