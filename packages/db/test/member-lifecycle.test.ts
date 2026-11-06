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

  it("reinstates only a suspended membership, keeping its roles", async () => {
    await expect(change(TENANT_A, a.manager, a.carer, "active")).resolves.toBe("active");
    expect(await change(TENANT_A, a.manager, a.carer, "suspended")).toBe("active");
    expect(await change(TENANT_A, a.manager, a.carer, "active")).toBe("suspended");
    expect((await statusOf(TENANT_A, a.carer))?.status).toBe("active");
    const roles = await owner(TENANT_A, (c) =>
      c.query("SELECT 1 FROM person_assignment WHERE tenant_user_id = $1", [a.carer]),
    );
    expect(roles.rowCount).toBeGreaterThan(0);
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

  it("never reinstates an ended membership", async () => {
    await expect(change(TENANT_A, a.manager, SOLO, "active")).rejects.toThrow(
      /reinstated or ended/,
    );
  });

  it("keeps an ended membership ended, whoever writes, and lets the application write no state", async () => {
    await expect(
      owner(TENANT_A, (c) =>
        c.query("UPDATE tenant_user SET status = 'active' WHERE id = $1", [SOLO]),
      ),
    ).rejects.toThrow(/stays ended/);
    for (const column of [
      "status = 'suspended'",
      "auth_user_id = NULL",
      "sign_in_erasure_requested_at = now()",
      "sign_in_erased_at = now()",
      "status_changed_at = now()",
    ]) {
      await expect(
        as(
          TENANT_A,
          a.manager,
        )((c) => c.query(`UPDATE tenant_user SET ${column} WHERE id = $1`, [a.carer])),
        column,
      ).rejects.toThrow(/permission denied/);
    }
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

const dueOne = (id: string) =>
  app()
    .query<{ due: boolean }>("SELECT app.sign_in_due_for_erasure($1) AS due", [id])
    .then((r) => r.rows[0]?.due);

describe("sign-ins due for erasure (migration 0144)", () => {
  it("records only the member's own request", async () => {
    await as(TENANT_A, SOLO)((c) => c.query("SELECT app.request_sign_in_erasure()"));
    const [row] = (
      await owner(TENANT_A, (c) =>
        c.query<{ asked: Date | null }>(
          "SELECT sign_in_erasure_requested_at AS asked FROM tenant_user WHERE id = $1",
          [SOLO],
        ),
      )
    ).rows;
    expect(row?.asked).not.toBeNull();
  });

  it("lists a sign-in that asked once that membership has ended and none is held elsewhere", async () => {
    expect(await due()).toContain("auth-a-solo");
    expect(await dueOne("auth-a-solo")).toBe(true);
  });

  it("never lists a member who asked but is only suspended (security review H1)", async () => {
    await owner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO tenant_user (auth_user_id, display_name, email, status, sign_in_erasure_requested_at)
         VALUES ('auth-a-paused', 'Pip Example', 'pip@example.invalid', 'suspended', now())`,
      ),
    );
    expect(await due()).not.toContain("auth-a-paused");
  });

  it("keeps a sign-in still active, or suspended, in another organisation", async () => {
    await owner(TENANT_A, (c) =>
      c.query(
        "UPDATE tenant_user SET status = 'left', sign_in_erasure_requested_at = now() WHERE id = $1",
        [a.carer],
      ),
    );
    expect(await dueOne(AUTH_USER_SHARED)).toBe(false);
    const states = await app().query<{ s: string }>(
      "SELECT s FROM app.other_membership_states($1, $2) AS s",
      [AUTH_USER_SHARED, TENANT_A],
    );
    expect(states.rows.map((r) => r.s)).toEqual(["active"]);
    // Not listed for erasure, so the memberships are not given out either.
    const listed = await app().query("SELECT * FROM app.memberships_of_sign_in($1)", [
      AUTH_USER_SHARED,
    ]);
    expect(listed.rowCount).toBe(0);
    await owner(TENANT_B, (c) =>
      c.query("UPDATE tenant_user SET status = 'suspended' WHERE auth_user_id = $1", [
        AUTH_USER_SHARED,
      ]),
    );
    expect(await dueOne(AUTH_USER_SHARED)).toBe(false);
    await owner(TENANT_B, (c) =>
      c.query("UPDATE tenant_user SET status = 'left' WHERE auth_user_id = $1", [AUTH_USER_SHARED]),
    );
    expect(await dueOne(AUTH_USER_SHARED)).toBe(true);
  });

  it("marks, then unlinks, only as the system, and finishes an erasure begun", async () => {
    await expect(
      as(
        TENANT_A,
        a.manager,
      )((c) => c.query("SELECT app.mark_sign_in_erased($1, 'auth-a-solo', false)", [SOLO])),
    ).rejects.toThrow(/Only the system/);
    const system = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
    await system((c) =>
      c.query("SELECT app.mark_sign_in_erased($1, 'auth-a-solo', false)", [SOLO]),
    );
    // A run stopped here is still due, though the request is no longer what makes it so.
    expect(await dueOne("auth-a-solo")).toBe(true);
    await system((c) => c.query("SELECT app.mark_sign_in_erased($1, 'auth-a-solo', true)", [SOLO]));
    expect(await due()).not.toContain("auth-a-solo");
    const [row] = (
      await owner(TENANT_A, (c) =>
        c.query<{ email: string; display_name: string }>(
          "SELECT email, display_name FROM tenant_user WHERE id = $1",
          [SOLO],
        ),
      )
    ).rows;
    expect(row).toEqual({ email: `${SOLO}@erased.invalid`, display_name: "Sol Example" });
  });

  it("never marks a sign-in not due, and lets a new membership overtake an erasure begun (security review N1)", async () => {
    const system = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
    await expect(
      system((c) =>
        c.query("SELECT app.mark_sign_in_erased($1, 'auth-a-manager', false)", [a.manager]),
      ),
    ).rejects.toThrow(/not due/);
    // Unlinking a row never marked changes nothing.
    const unlinked = await system((c) =>
      c.query<{ changed: boolean }>(
        "SELECT app.mark_sign_in_erased($1, 'auth-a-manager', true) AS changed",
        [a.manager],
      ),
    );
    expect(unlinked.rows[0]?.changed).toBe(false);
    // An erasure begun, then the person joins an organisation again: it waits.
    await owner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO tenant_user (auth_user_id, display_name, email, status, sign_in_erasure_requested_at, sign_in_erased_at)
         VALUES ('auth-a-begun', 'Bo Example', 'bo@example.invalid', 'left', now(), now())`,
      ),
    );
    expect(await dueOne("auth-a-begun")).toBe(true);
    await owner(TENANT_B, (c) =>
      c.query(
        `INSERT INTO tenant_user (auth_user_id, display_name, email, status)
         VALUES ('auth-a-begun', 'Bo Example', 'bo@example.invalid', 'active')`,
      ),
    );
    expect(await dueOne("auth-a-begun")).toBe(false);
  });

  it("takes no sign-in again once erased, and keeps the record of it", async () => {
    await expect(
      owner(TENANT_A, (c) =>
        c.query("UPDATE tenant_user SET auth_user_id = 'auth-again' WHERE id = $1", [SOLO]),
      ),
    ).rejects.toThrow(/takes no sign-in again/);
    await expect(
      owner(TENANT_A, (c) =>
        c.query("UPDATE tenant_user SET sign_in_erased_at = NULL WHERE id = $1", [SOLO]),
      ),
    ).rejects.toThrow(/record of an erased sign-in/);
  });
});
