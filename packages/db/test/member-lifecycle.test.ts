import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import {
  AUTH_USER_SHARED,
  ctx,
  ids,
  inContext,
  seedTwoTenants,
  TENANT_A,
  TENANT_B,
} from "./support/fixtures";

/**
 * The member lifecycle in the database (H-566; platform.md, Members; migration 0144): a holder of
 * platform.user.manage suspends a membership, then ends it, never their own and never the last
 * active member who manages users; an ended membership stays ended; and a sign-in is due for
 * erasure only once it asked for deletion and no membership anywhere is invited or active.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_ADMIN = "0199f000-0000-7000-8000-000000014401";
const SOLO = "0199f000-0000-7000-8000-000000014402";
const app = () => db.pool("harbour_app");
const owner = <T>(tenant: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);
const as =
  (tenant: string, userId: string) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const change = (tenant: string, by: string, member: string, to: string) =>
  as(
    tenant,
    by,
  )((c) =>
    c
      .query<{ from: string }>('SELECT app.change_member_status($1, $2) AS "from"', [member, to])
      .then((r) => r.rows[0]?.from),
  );
const statusOf = (tenant: string, member: string) =>
  owner(tenant, (c) =>
    c
      .query<{ status: string; changed: Date | null }>(
        "SELECT status, status_changed_at AS changed FROM tenant_user WHERE id = $1",
        [member],
      )
      .then((r) => r.rows[0]),
  );
const due = () =>
  db
    .pool("harbour_worker")
    .query<{ id: string }>("SELECT id FROM app.sign_ins_due_for_erasure() AS id")
    .then((r) => r.rows.map((row) => row.id));

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'admin', 'Admin', 'tenant', '{platform.user.manage}')`,
      [ROLE_ADMIN],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_ADMIN,
    ]);
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, 'auth-a-solo', 'Sol Example', 'sol@example.invalid', 'active')`,
      [SOLO],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      SOLO,
      a.roleCarer,
    ]);
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("suspending and ending a membership (migration 0144)", () => {
  it("needs platform.user.manage", async () => {
    await expect(change(TENANT_A, a.carer, SOLO, "suspended")).rejects.toThrow(
      /platform\.user\.manage/,
    );
  });

  it("never changes the caller's own membership", async () => {
    await expect(change(TENANT_A, a.manager, a.manager, "suspended")).rejects.toThrow(
      /own membership/,
    );
  });

  it("ends only a suspended membership", async () => {
    await expect(change(TENANT_A, a.manager, SOLO, "left")).rejects.toThrow(
      /suspended from active/,
    );
  });

  it("suspends, replays without change, then ends and ends the roles", async () => {
    expect(await change(TENANT_A, a.manager, SOLO, "suspended")).toBe("active");
    const first = await statusOf(TENANT_A, SOLO);
    expect(first?.status).toBe("suspended");
    expect(await change(TENANT_A, a.manager, SOLO, "suspended")).toBe("suspended");
    expect((await statusOf(TENANT_A, SOLO))?.changed).toEqual(first?.changed);
    expect(await change(TENANT_A, a.manager, SOLO, "left")).toBe("suspended");
    expect((await statusOf(TENANT_A, SOLO))?.status).toBe("left");
    const roles = await owner(TENANT_A, (c) =>
      c.query(
        "SELECT 1 FROM role_assignment WHERE tenant_user_id = $1 AND (valid_to IS NULL OR valid_to > now())",
        [SOLO],
      ),
    );
    expect(roles.rowCount).toBe(0);
  });

  it("keeps an ended membership ended, whoever writes", async () => {
    await expect(
      as(
        TENANT_A,
        a.manager,
      )((c) => c.query("UPDATE tenant_user SET status = 'active' WHERE id = $1", [SOLO])),
    ).rejects.toThrow(/stays ended/);
  });

  it("keeps the organisation's last active member who manages users", async () => {
    await owner(TENANT_A, (c) =>
      c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
        a.northManager,
        ROLE_ADMIN,
      ]),
    );
    await change(TENANT_A, a.manager, a.northManager, "suspended");
    // The suspended holder does not count as another one, so the manager stays.
    await expect(change(TENANT_A, a.northManager, a.manager, "suspended")).rejects.toThrow(
      /last member who manages users/,
    );
  });

  it("refuses a member of another organisation (cross-tenant)", async () => {
    await expect(change(TENANT_B, ids.b.manager, SOLO, "suspended")).rejects.toThrow(
      /platform\.user\.manage|No such member/,
    );
    await owner(TENANT_B, async (c) => {
      await c.query(
        `INSERT INTO role (key, name, scope_kind, permissions) VALUES ('admin', 'Admin', 'tenant', '{platform.user.manage}')`,
      );
      await c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id) SELECT $1, id FROM role WHERE key = 'admin'",
        [ids.b.manager],
      );
    });
    await expect(change(TENANT_B, ids.b.manager, a.carer, "suspended")).rejects.toThrow(
      /No such member/,
    );
    expect((await statusOf(TENANT_A, a.carer))?.status).toBe("active");
  });
});

describe("sign-ins due for erasure (migration 0144)", () => {
  it("lists a sign-in that asked, once no membership anywhere is invited or active", async () => {
    expect(await due()).not.toContain("auth-a-solo");
    await owner(TENANT_A, (c) =>
      c.query("UPDATE tenant_user SET sign_in_erasure_requested_at = now() WHERE id = $1", [SOLO]),
    );
    expect(await due()).toContain("auth-a-solo");
  });

  it("keeps a sign-in still active in another organisation", async () => {
    await owner(TENANT_A, (c) =>
      c.query(
        "UPDATE tenant_user SET status = 'left', sign_in_erasure_requested_at = now() WHERE id = $1",
        [a.carer],
      ),
    );
    expect(await due()).not.toContain(AUTH_USER_SHARED);
    const memberships = await app().query<{ tenant_id: string; status: string }>(
      "SELECT tenant_id, status FROM app.memberships_of_sign_in($1)",
      [AUTH_USER_SHARED],
    );
    expect(memberships.rows.map((r) => [r.tenant_id, r.status]).sort()).toEqual(
      [
        [TENANT_A, "left"],
        [TENANT_B, "active"],
      ].sort(),
    );
  });

  it("takes no sign-in again once erased", async () => {
    await owner(TENANT_A, (c) =>
      c.query(
        "UPDATE tenant_user SET auth_user_id = NULL, sign_in_erased_at = now() WHERE id = $1",
        [SOLO],
      ),
    );
    expect(await due()).not.toContain("auth-a-solo");
    await expect(
      owner(TENANT_A, (c) =>
        c.query("UPDATE tenant_user SET auth_user_id = 'auth-again' WHERE id = $1", [SOLO]),
      ),
    ).rejects.toThrow(/takes no sign-in again/);
  });
});
