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
 * Membership changes held by the database (migration 0129; H-566 security review; hazard
 * HZ-011): the application role never changes a member's status or sign-in link itself;
 * app.change_membership suspends, reinstates, ends and unlinks, only for a holder of
 * platform.user.manage acting on someone else while active themselves, one change at a time, and
 * never removes the organisation's last member who manages users through a role; the guard
 * trigger allows only the transitions a membership can make and never relinks a sign-in.
 */

let db: TestDatabase;
const a = ids.a;
const MANAGER_ROLE = "0199f000-0000-7000-8000-000000000729";
const XAVI = "0199f000-0000-7000-8000-000000000731";
const PIA = "0199f000-0000-7000-8000-000000000732";
const QUIN = "0199f000-0000-7000-8000-000000000733";

const app = () => db.pool("harbour_app");
const as =
  (userId: string | null, tenant: string = TENANT_A) =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(tenant, userId, "tenant"), fn);
const owner = <T>(fn: (c: pg.PoolClient) => Promise<T>, tenant: string = TENANT_A) =>
  inContext(db.pool("harbour_owner"), ctx(tenant, null, "tenant"), fn);
const change = (member: string, action: string) => (c: pg.PoolClient) =>
  c
    .query<{ before: string }>("SELECT app.change_membership($1, $2) AS before", [member, action])
    .then((r) => r.rows[0]?.before);
const stateOf = (member: string) =>
  owner((c) =>
    c
      .query<{ status: string; auth_user_id: string | null }>(
        "SELECT status, auth_user_id FROM tenant_user WHERE id = $1",
        [member],
      )
      .then((r) => r.rows[0]),
  );
const setState = (member: string, status: string, tenant: string = TENANT_A) =>
  owner(
    (c) => c.query("UPDATE tenant_user SET status = $2 WHERE id = $1", [member, status]),
    tenant,
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'user_manager', 'User manager', 'tenant', '{platform.user.manage}')`,
      [MANAGER_ROLE],
    );
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-xavi', 'Xavi Example', 'xavi@example.invalid', 'active'),
         ($2, 'auth-pia', 'Pia Example', 'pia@example.invalid', 'active'),
         ($3, 'auth-quin', 'Quin Example', 'quin@example.invalid', 'active')`,
      [XAVI, PIA, QUIN],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       SELECT m, $1 FROM unnest($2::uuid[]) AS m`,
      [MANAGER_ROLE, [a.manager, PIA, QUIN]],
    );
    // The carer acts up with a grant of platform.user.manage, never a role.
    await c.query(
      `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_to, reason, granted_by)
       VALUES ($1, '{platform.user.manage}', $2, now() + interval '1 day', 'Acting up', $3)`,
      [a.carer, a.locationNorth, a.manager],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 the application role never changes a membership itself (migration 0129)", () => {
  it.each([
    ["undo a suspension", "UPDATE tenant_user SET status = 'active' WHERE id = $1", "suspended"],
    ["suspend", "UPDATE tenant_user SET status = 'suspended' WHERE id = $1", "active"],
    ["end", "UPDATE tenant_user SET status = 'left' WHERE id = $1", "active"],
    [
      "relink to another sign-in",
      "UPDATE tenant_user SET auth_user_id = 'auth-someone-else' WHERE id = $1",
      "active",
    ],
    ["unlink", "UPDATE tenant_user SET auth_user_id = NULL WHERE id = $1", "active"],
  ])("refuses a direct update to %s, from a manager or a job", async (_label, statement, from) => {
    await setState(XAVI, from);
    for (const actor of [a.manager, null]) {
      await expect(as(actor)((c) => c.query(statement, [XAVI]))).rejects.toThrow(
        /change_membership|row-level security/,
      );
    }
    expect(await stateOf(XAVI)).toEqual({ status: from, auth_user_id: "auth-xavi" });
    await setState(XAVI, "active");
  });

  it("still lets the application role change the member's other details", async () => {
    await as(a.manager)((c) =>
      c.query("UPDATE tenant_user SET job_title = 'Care worker' WHERE id = $1", [XAVI]),
    );
  });
});

describe("H-566 app.change_membership", () => {
  it("suspends, reinstates, ends and unlinks, each change once", async () => {
    const asManager = as(a.manager);
    expect(await asManager(change(XAVI, "suspend"))).toBe("active");
    expect(await asManager(change(XAVI, "suspend"))).toBe("unchanged");
    expect(await asManager(change(XAVI, "reinstate"))).toBe("suspended");
    expect((await stateOf(XAVI))?.status).toBe("active");
    await expect(asManager(change(XAVI, "end"))).rejects.toThrow(/suspend_first/);
    await expect(asManager(change(XAVI, "unlink_sign_in"))).rejects.toThrow(/membership_not_ended/);
    await asManager(change(XAVI, "suspend"));
    expect(await asManager(change(XAVI, "end"))).toBe("suspended");
    expect(await asManager(change(XAVI, "end"))).toBe("unchanged");
    await expect(asManager(change(XAVI, "suspend"))).rejects.toThrow(/membership_ended/);
    expect(await asManager(change(XAVI, "unlink_sign_in"))).toBe("left");
    expect(await stateOf(XAVI)).toEqual({ status: "left", auth_user_id: null });
    expect(await asManager(change(XAVI, "unlink_sign_in"))).toBe("unchanged");
    // Once the sign-in is gone, an ended membership never comes back (migration 0149, H-1469).
    await expect(asManager(change(XAVI, "reinstate"))).rejects.toThrow(/membership_ended/);
  });

  it("refuses someone without platform.user.manage, oneself, a job, an unknown action and another organisation", async () => {
    await expect(as(a.northManager)(change(PIA, "suspend"))).rejects.toThrow(/not_permitted/);
    await expect(as(a.manager)(change(a.manager, "suspend"))).rejects.toThrow(/own_membership/);
    await expect(as(null)(change(PIA, "suspend"))).rejects.toThrow(/not_permitted/);
    await expect(as(a.manager)(change(PIA, "promote"))).rejects.toThrow(/unknown_action/);
    // A NULL action or member is refused, never taken as unlinking (security re-check, Low 1).
    await expect(
      as(a.manager)((c) => c.query("SELECT app.change_membership($1, NULL)", [PIA])),
    ).rejects.toThrow(/unknown_action/);
    await expect(
      as(a.manager)((c) => c.query("SELECT app.change_membership(NULL, 'unlink_sign_in')")),
    ).rejects.toThrow(/member_not_found/);
    // Another organisation's member is not found from here, and its manager holds nothing here.
    await expect(as(a.manager)(change(ids.b.manager, "suspend"))).rejects.toThrow(
      /member_not_found/,
    );
    await expect(as(ids.b.manager, TENANT_B)(change(PIA, "suspend"))).rejects.toThrow(
      /not_permitted/,
    );
    expect((await stateOf(PIA))?.status).toBe("active");
  });

  it("keeps the organisation's last member who manages users through a role", async () => {
    // Pia and Quin step away: the manager is left as the only role holder.
    await setState(PIA, "suspended");
    await setState(QUIN, "suspended");
    try {
      // An acting-up grant never counts as a holder, so the carer cannot remove the last one.
      await expect(as(a.carer)(change(a.manager, "suspend"))).rejects.toThrow(/last_user_manager/);
      expect((await stateOf(a.manager))?.status).toBe("active");
      // With another active role holder, the manager may be suspended, and while suspended can
      // change no one.
      await setState(PIA, "active");
      expect(await as(a.carer)(change(a.manager, "suspend"))).toBe("active");
      await expect(as(a.manager)(change(QUIN, "reinstate"))).rejects.toThrow(/not_permitted/);
    } finally {
      await setState(a.manager, "active");
      await setState(PIA, "active");
      await setState(QUIN, "active");
    }
  });

  it("lets only one of two managers suspending each other at once succeed", async () => {
    const results = await Promise.allSettled([
      as(PIA)(change(QUIN, "suspend")),
      as(QUIN)(change(PIA, "suspend")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/not_permitted/);
    const states = [(await stateOf(PIA))?.status, (await stateOf(QUIN))?.status].sort();
    expect(states).toEqual(["active", "suspended"]);
    await setState(PIA, "active");
    await setState(QUIN, "active");
  });
});

describe("H-566 the guard trigger for any role but the owner", () => {
  /** As the function's own role, which may make only the changes a membership can make. */
  const asMemberOwner = (statement: string, params: unknown[]) =>
    owner(async (c) => {
      await c.query("SET LOCAL ROLE harbour_member_owner");
      await c.query(statement, params);
    });

  it.each([
    [
      "relinks a member to another sign-in",
      "UPDATE tenant_user SET auth_user_id = 'auth-other' WHERE id = $1",
    ],
    ["unlinks an active member", "UPDATE tenant_user SET auth_user_id = NULL WHERE id = $1"],
    [
      "moves an active member straight back to invited",
      "UPDATE tenant_user SET status = 'invited' WHERE id = $1",
    ],
  ])("refuses a change that %s", async (_label, statement) => {
    await expect(asMemberOwner(statement, [PIA])).rejects.toThrow(/linked once|cannot change from/);
    expect(await stateOf(PIA)).toEqual({ status: "active", auth_user_id: "auth-pia" });
  });

  it("brings an ended membership back only as active or invited, never to another state", async () => {
    await setState(QUIN, "left");
    try {
      // Migration 0149 (H-1469): back to active with its sign-in, through app.change_membership.
      await expect(
        asMemberOwner("UPDATE tenant_user SET status = 'suspended' WHERE id = $1", [QUIN]),
      ).rejects.toThrow(/cannot change from left to suspended/);
      await expect(
        asMemberOwner("UPDATE tenant_user SET status = 'invited' WHERE id = $1", [QUIN]),
      ).rejects.toThrow(/cannot change from left to invited/);
    } finally {
      await setState(QUIN, "active");
    }
  });
});

describe("H-566 a sign-in's memberships elsewhere that have not ended", () => {
  const count = (member: string) => (c: pg.PoolClient) =>
    c
      .query<{ n: number }>("SELECT app.sign_in_memberships_elsewhere($1) AS n", [member])
      .then((r) => r.rows[0]?.n);
  const otherCat = () =>
    owner(
      (c) =>
        c
          .query<{ id: string }>(
            "SELECT id FROM tenant_user WHERE auth_user_id = $1 AND tenant_id = $2",
            [AUTH_USER_SHARED, TENANT_B],
          )
          .then((r) => r.rows[0]?.id ?? ""),
      TENANT_B,
    );

  it("counts the other organisation's membership while it is active or suspended, not once ended", async () => {
    const other = await otherCat();
    expect(await as(a.manager)(count(a.carer))).toBe(1);
    await setState(other, "suspended", TENANT_B);
    expect(await as(a.manager)(count(a.carer))).toBe(1);
    await setState(other, "left", TENANT_B);
    expect(await as(a.manager)(count(a.carer))).toBe(0);
    await setState(other, "active", TENANT_B);
    expect(await as(a.manager)(count(PIA))).toBe(0);
  });

  it("answers only a holder of platform.user.manage", async () => {
    await expect(as(a.northManager)(count(a.carer))).rejects.toThrow(/not_permitted/);
    await expect(as(null)(count(a.carer))).rejects.toThrow(/not_permitted/);
  });
});

describe("H-566 a leaver's access and a suspension never race past the last user manager", () => {
  it("ends a manager's access or lets them suspend the last other manager, never both", async () => {
    const PROFILE = "0199f000-0000-7000-8000-000000000741";
    // Only Pia and Quin manage users through a role; Pia is leaving, and suspends Quin as the
    // leavers sweep (no member) ends Pia's access.
    await setState(a.manager, "suspended");
    await owner(async (c) => {
      await c.query(
        `INSERT INTO staff_profile (id, tenant_user_id, job_title) VALUES ($1, $2, 'Deputy manager')`,
        [PROFILE, PIA],
      );
      await c.query(
        `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason)
         VALUES ($1, current_date - 1, 'resignation')`,
        [PROFILE],
      );
    });
    const results = await Promise.allSettled([
      as(PIA)(change(QUIN, "suspend")),
      as(null)((c) => c.query("SELECT app.end_leaver_access($1) AS ended", [PROFILE])),
    ]);
    // One of the two goes through; the organisation keeps an active user manager either way.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const managers = await owner((c) =>
      c
        .query<{ id: string }>(
          `SELECT DISTINCT u.id FROM tenant_user u
             JOIN role_assignment ra ON ra.tenant_user_id = u.id AND ra.deleted_at IS NULL
              AND (ra.valid_to IS NULL OR ra.valid_to > now())
             JOIN role r ON r.id = ra.role_id
            WHERE u.status = 'active' AND 'platform.user.manage' = ANY (r.permissions)`,
        )
        .then((r) => r.rows.map((m) => m.id)),
    );
    expect(managers).toHaveLength(1);
    expect([PIA, QUIN]).toContain(managers[0]);
  });
});

describe("H-566 the lifecycle times and the erasure sweep (migration 0149)", () => {
  const ROSA = "0199f000-0000-7000-8000-000000000741";
  const times = (member: string, tenant: string = TENANT_A) =>
    owner(
      (c) =>
        c
          .query<{ changed: Date | null; erased: Date | null; auth: string | null }>(
            `SELECT status_changed_at AS changed, sign_in_erased_at AS erased, auth_user_id AS auth
               FROM tenant_user WHERE id = $1`,
            [member],
          )
          .then((r) => r.rows[0]),
      tenant,
    );
  const due = () =>
    db
      .pool("harbour_worker")
      .query<{ tenant_user_id: string; auth_user_id: string }>(
        "SELECT tenant_user_id, auth_user_id FROM app.sign_ins_due_for_erasure()",
      )
      .then((r) => r.rows);
  const system = (tenant: string = TENANT_A) => as(null, tenant);

  beforeAll(async () => {
    await owner((c) =>
      c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ($1, 'auth-rosa', 'Rosa Example', 'rosa@example.invalid', 'active')`,
        [ROSA],
      ),
    );
    // The manager acts again, whatever the tests above left them as (the owner is not held).
    await setState(a.manager, "active");
  });

  it("records when the status changed, through app.change_membership only", async () => {
    expect((await times(ROSA))?.changed).toBeNull();
    await as(a.manager)(change(ROSA, "suspend"));
    const first = (await times(ROSA))?.changed;
    expect(first).not.toBeNull();
    await as(a.manager)(change(ROSA, "reinstate"));
    expect((await times(ROSA))?.changed?.getTime()).toBeGreaterThanOrEqual(first?.getTime() ?? 0);
    for (const column of [
      "status_changed_at",
      "sign_in_erased_at",
      "sign_in_erasure_requested_at",
    ]) {
      await expect(
        as(a.manager)((c) =>
          c.query(`UPDATE tenant_user SET ${column} = now() WHERE id = $1`, [ROSA]),
        ),
        column,
      ).rejects.toThrow(/permission denied/);
    }
  });

  it("records only the member's own request", async () => {
    await as(ROSA)((c) => c.query("SELECT app.request_sign_in_erasure()"));
    const [row] = (
      await owner((c) =>
        c.query<{ asked: Date | null }>(
          "SELECT sign_in_erasure_requested_at AS asked FROM tenant_user WHERE id = $1",
          [ROSA],
        ),
      )
    ).rows;
    expect(row?.asked).not.toBeNull();
    await expect(system()((c) => c.query("SELECT app.request_sign_in_erasure()"))).rejects.toThrow(
      /not_permitted/,
    );
  });

  it("is due only once the membership that asked has ended and none is held elsewhere", async () => {
    expect((await due()).map((r) => r.auth_user_id)).not.toContain("auth-rosa");
    // Not while it is only suspended.
    await as(a.manager)(change(ROSA, "suspend"));
    expect((await due()).map((r) => r.auth_user_id)).not.toContain("auth-rosa");
    await as(a.manager)(change(ROSA, "end"));
    expect(await due()).toContainEqual({ tenant_user_id: ROSA, auth_user_id: "auth-rosa" });
  });

  it("keeps a sign-in active or suspended in another organisation", async () => {
    await setState(a.carer, "left");
    await owner((c) =>
      c.query("UPDATE tenant_user SET sign_in_erasure_requested_at = now() WHERE id = $1", [
        a.carer,
      ]),
    );
    expect((await due()).map((r) => r.auth_user_id)).not.toContain(AUTH_USER_SHARED);
    await owner(
      (c) =>
        c.query("UPDATE tenant_user SET status = 'suspended' WHERE auth_user_id = $1", [
          AUTH_USER_SHARED,
        ]),
      TENANT_B,
    );
    expect((await due()).map((r) => r.auth_user_id)).not.toContain(AUTH_USER_SHARED);
  });

  it("lets the worker, and only the worker, unlink an ended membership whose sign-in is due, recording when", async () => {
    const worker = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(db.pool("harbour_worker"), ctx(TENANT_A, null, "tenant"), fn);
    // The application role acting as the system cannot (security review M1).
    await expect(system()(change(ROSA, "unlink_sign_in"))).rejects.toThrow(/not_permitted/);
    await expect(worker(change(a.carer, "unlink_sign_in"))).rejects.toThrow(/sign_in_in_use/);
    // The worker does nothing else.
    await expect(worker(change(XAVI, "suspend"))).rejects.toThrow(/not_permitted/);
    expect(await worker(change(ROSA, "unlink_sign_in"))).toBe("left");
    const after = await times(ROSA);
    expect(after?.auth).toBeNull();
    expect(after?.erased).not.toBeNull();
    expect(await worker(change(ROSA, "unlink_sign_in"))).toBe("unchanged");
    expect((await due()).map((r) => r.auth_user_id)).not.toContain("auth-rosa");
  });
});

describe("H-1469 reinstating an ended membership (a wrong leaving date withdrawn, HZ-133)", () => {
  const SAM = "0199f000-0000-7000-8000-000000000751";
  const NORTH_ROLE = "0199f000-0000-7000-8000-000000000752";
  beforeAll(async () => {
    await owner(async (c) => {
      await c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ($1, 'auth-sam', 'Sam Example', 'sam@example.invalid', 'left')`,
        [SAM],
      );
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ($1, 'north_user_manager', 'North user manager', 'location', '{platform.user.manage}')`,
        [NORTH_ROLE],
      );
      await c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
        [a.northManager, NORTH_ROLE, a.locationNorth],
      );
    });
    await setState(a.manager, "active");
    await setState(a.northManager, "active");
    // The sign-ins the members below keep (only an existing one is brought back).
    await db.pool("harbour_auth").query(
      `INSERT INTO auth."user" (id, name, email) VALUES
           ('auth-sam', 'Sam Example', 'sam@example.invalid'),
           ('auth-tom', 'Tom Example', 'tom@example.invalid')`,
    );
  });

  it("never once the sign-in has been deleted from another organisation (security re-check N1)", async () => {
    const UNA = "0199f000-0000-7000-8000-000000000754";
    await owner((c) =>
      c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ($1, 'auth-gone', 'Una Example', 'una@example.invalid', 'left')`,
        [UNA],
      ),
    );
    await expect(as(a.manager)(change(UNA, "reinstate"))).rejects.toThrow(/membership_ended/);
    expect((await stateOf(UNA))?.status).toBe("left");
  });

  it("refuses a manager whose permission is only at a home", async () => {
    await expect(as(a.northManager)(change(SAM, "reinstate"))).rejects.toThrow(/membership_ended/);
    expect((await stateOf(SAM))?.status).toBe("left");
  });

  it("brings it back for a manager across the organisation, through the guard, recording when", async () => {
    expect(await as(a.manager)(change(SAM, "reinstate"))).toBe("left");
    expect(await stateOf(SAM)).toMatchObject({ status: "active", auth_user_id: "auth-sam" });
    // The application role still cannot do it itself.
    await setState(SAM, "left");
    await expect(
      as(a.manager)((c) =>
        c.query("UPDATE tenant_user SET status = 'active' WHERE id = $1", [SAM]),
      ),
    ).rejects.toThrow(/only through app.change_membership/);
  });

  it("never while a leaving is still recorded: it is withdrawn first (HZ-133, the leavers sweep)", async () => {
    const TOM = "0199f000-0000-7000-8000-000000000753";
    const [leaver] = await owner(async (c) => {
      await c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ($1, 'auth-tom', 'Tom Example', 'tom@example.invalid', 'left')`,
        [TOM],
      );
      const profile = await c.query<{ id: string }>(
        "INSERT INTO staff_profile (tenant_user_id, job_title) VALUES ($1, 'Care worker') RETURNING id",
        [TOM],
      );
      return (
        await c.query<{ id: string }>(
          `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason, access_removed_at)
           VALUES ($1, current_date - 1, 'resignation', now()) RETURNING id`,
          [profile.rows[0]?.id],
        )
      ).rows;
    });
    await expect(as(a.manager)(change(TOM, "reinstate"))).rejects.toThrow(/leaving_still_recorded/);
    expect((await stateOf(TOM))?.status).toBe("left");
    // Withdrawn in the staff file (soft-deleted), the membership comes back.
    await owner((c) =>
      c.query("UPDATE leaver_record SET deleted_at = now() WHERE id = $1", [leaver?.id]),
    );
    expect(await as(a.manager)(change(TOM, "reinstate"))).toBe("left");
    expect((await stateOf(TOM))?.status).toBe("active");
  });

  it("never once the sign-in has been erased", async () => {
    await owner((c) =>
      c.query(
        "UPDATE tenant_user SET auth_user_id = NULL, sign_in_erased_at = now() WHERE id = $1",
        [SAM],
      ),
    );
    await expect(as(a.manager)(change(SAM, "reinstate"))).rejects.toThrow(/membership_ended/);
    expect((await stateOf(SAM))?.status).toBe("left");
  });
});
