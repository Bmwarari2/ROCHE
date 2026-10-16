import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Adding members in the database (PLAT-004; platform.md, Members; migration 0060; hazard HZ-011;
 * #71 security review M1): the application adds a member only as invited, and gives a role only
 * where the giver holds platform.user.manage and every permission of it through their own roles.
 * An access grant never counts: acting up is a time-boxed grant, never a role edit (section 4).
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_GIVER = "0199f000-0000-7000-8000-000000000601";
const ROLE_READER = "0199f000-0000-7000-8000-000000000602";
const app = () => db.pool("harbour_app");
const owner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const as =
  (tenant: string, userId: string) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
let n = 0;

/** Adds an invited member with the reader role at North, as one statement. */
const addReader = (c: pg.PoolClient) => {
  n += 1;
  return c.query(
    `WITH m AS (INSERT INTO tenant_user (display_name, email) VALUES ($1, $2) RETURNING id)
     INSERT INTO role_assignment (tenant_user_id, role_id, location_id) SELECT id, $3, $4 FROM m`,
    [`Ada Example ${n}`, `added${n}@example.invalid`, ROLE_READER, a.locationNorth],
  );
};
const mayAssign = (c: pg.PoolClient) =>
  c
    .query<{ may: boolean }>("SELECT app.may_assign_role($1, $2) AS may", [
      ROLE_READER,
      a.locationNorth,
    ])
    .then((r) => r.rows[0]?.may);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'giver', 'Giver', 'location', '{platform.user.manage,people.person.read}'),
         ($2, 'reader', 'Reader', 'location', '{people.person.read}')`,
      [ROLE_GIVER, ROLE_READER],
    );
    // The north manager gives roles through a role of their own; the carer acts up on a grant.
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE_GIVER, a.locationNorth],
    );
    await c.query(
      `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_to, reason, granted_by)
       VALUES ($1, '{platform.user.manage,people.person.read}', $2, now() + interval '1 day',
               'Acting up', $3)`,
      [a.carer, a.locationNorth, a.manager],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 adding members (migration 0060)", () => {
  it("lets a manager give a role they hold through their own role", async () => {
    await as(
      TENANT_A,
      a.northManager,
    )(async (c) => {
      expect(await mayAssign(c)).toBe(true);
      await addReader(c);
    });
  });

  it("never counts an acting-up grant (#71 security review M1)", async () => {
    await as(
      TENANT_A,
      a.carer,
    )(async (c) => {
      expect(await mayAssign(c)).toBe(false);
    });
    await expect(as(TENANT_A, a.carer)(addReader)).rejects.toThrow(/row-level security/);
    await expect(
      as(
        TENANT_A,
        a.carer,
      )((c) =>
        c.query(
          "INSERT INTO tenant_user (display_name, email) VALUES ('Bo Example', 'bo@example.invalid')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("adds a member only as invited, with no sign-in and a second factor required", async () => {
    for (const values of [
      "'active', NULL, true",
      "'invited', 'auth-user-x', true",
      "'invited', NULL, false",
    ]) {
      await expect(
        as(
          TENANT_A,
          a.northManager,
        )((c) =>
          c.query(
            `INSERT INTO tenant_user (display_name, email, status, auth_user_id, mfa_required)
             VALUES ('Cy Example', 'cy@example.invalid', ${values})`,
          ),
        ),
        values,
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("never finds another organisation's role", async () => {
    await as(
      TENANT_B,
      ids.b.manager,
    )(async (c) => {
      expect(await mayAssign(c)).toBe(false);
    });
  });
});
