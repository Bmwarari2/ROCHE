import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUILTIN_ROLES,
  LONE_WORKER_ALARM_REASONS,
  LONE_WORKER_ALARM_STATES,
  LONE_WORKER_EVENT_KINDS,
  LONE_WORKER_OUTCOMES,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LONE_WORKER_ALARM_REASON_CODES,
  LONE_WORKER_ALARM_STATE_CODES,
  LONE_WORKER_EVENT_KIND_CODES,
  LONE_WORKER_OUTCOME_CODES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Lone-worker safety in the database (SCHED-012; migration 0113; HZ-125): cross-tenant denial;
 * a worker reads and writes only their own sessions; monitors read at the locations where they
 * hold scheduling.lone_worker.monitor; events are append-only and written only by the session's
 * worker; alarms are acknowledged by a monitor who is not the worker, and a help or duress alarm
 * is never resolved by a check-in; location evidence is erased by the sweep only, and only at its
 * date.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** The worker sweep: no user, tenant scope (`app.is_system()`). */
const asSweep = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** The care worker (check-in only). */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
/** The North House manager: monitor at North House only. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A tenant-wide manager with no lone-worker permission. */
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const NORTH_SESSION = "0199f200-0000-7000-8000-0000000000a1";
const SOUTH_SESSION = "0199f200-0000-7000-8000-0000000000a2";
const CHECK_IN = "0199f200-0000-7000-8000-0000000000e1";
const DURESS = "0199f200-0000-7000-8000-0000000000e2";
const SOUTH_CHECK_IN = "0199f200-0000-7000-8000-0000000000e3";
const OVERDUE_ALARM = "0199f200-0000-7000-8000-0000000000f1";
const DURESS_ALARM = "0199f200-0000-7000-8000-0000000000f2";
const POINT = "0199f200-0000-7000-8000-0000000000d1";
const OLD_POINT = "0199f200-0000-7000-8000-0000000000d2";
const OLD_EVENT = "0199f200-0000-7000-8000-0000000000e4";

const count = async (c: pg.PoolClient, sql: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]?.n);
const startSession = (c: pg.PoolClient, id: string, locationId: string, worker: string = a.carer) =>
  c.query(
    `INSERT INTO lone_worker_session (id, location_id, worker_tenant_user_id, work_kind,
       started_at, planned_end_at, interval_minutes)
     VALUES ($1, $2, $3, 'night_shift', now() - interval '2 hours', now() + interval '6 hours', 60)`,
    [id, locationId, worker],
  );
const addEvent = (c: pg.PoolClient, id: string, session: string, kind: string) =>
  c.query(
    `INSERT INTO lone_worker_event (id, session_id, kind, device_at, effective_at, late)
     VALUES ($1, $2, $3, now() - interval '1 hour', now() - interval '1 hour', false)
     ON CONFLICT (id) DO NOTHING`,
    [id, session, kind],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f200-0000-7000-8000-000000000501', 'lone', 'Lone worker', 'assigned',
          '{scheduling.lone_worker.check_in}'),
         ('0199f200-0000-7000-8000-000000000502', 'monitor', 'Monitor', 'location',
          '{scheduling.lone_worker.monitor}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f200-0000-7000-8000-000000000501', $3),
         ($2, '0199f200-0000-7000-8000-000000000502', $3)`,
      [a.carer, a.northManager, a.locationNorth],
    );
  });
  await asCarer(async (c) => {
    await startSession(c, NORTH_SESSION, a.locationNorth);
    await addEvent(c, CHECK_IN, NORTH_SESSION, "check_in");
    await addEvent(c, DURESS, NORTH_SESSION, "duress");
    await addEvent(c, OLD_EVENT, NORTH_SESSION, "check_in");
    await c.query(
      `INSERT INTO lone_worker_location (id, event_id, session_id, latitude, longitude, delete_after)
       VALUES ($1, $2, $3, 51.50000, -0.12000, now() + interval '30 days'),
              ($4, $5, $3, 51.50000, -0.12000, now() - interval '1 minute')`,
      [POINT, DURESS, NORTH_SESSION, OLD_POINT, OLD_EVENT],
    );
  });
  await asSweep(async (c) => {
    await c.query(
      `INSERT INTO lone_worker_alarm (id, session_id, location_id, worker_tenant_user_id, reason,
         trigger_event_id, raised_at, last_alerted_at)
       VALUES ($1, $2, $3, $4, 'duress', $5, now(), now())`,
      [DURESS_ALARM, NORTH_SESSION, a.locationNorth, a.carer, DURESS],
    );
    await c.query(
      `INSERT INTO lone_worker_alarm (id, session_id, location_id, worker_tenant_user_id, reason,
         due_at, raised_at, last_alerted_at)
       VALUES ($1, $2, $3, $4, 'overdue', now() - interval '20 minutes', now(), now())`,
      [OVERDUE_ALARM, NORTH_SESSION, a.locationNorth, a.carer],
    );
  });
  // A second worker's session at South House, by the North House manager as a worker.
  await asOwner(TENANT_A, (c) =>
    c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       VALUES ($1, '0199f200-0000-7000-8000-000000000501', $2)`,
      [a.northManager, a.locationSouth],
    ),
  );
  await asNorth(async (c) => {
    await startSession(c, SOUTH_SESSION, a.locationSouth, a.northManager);
    await addEvent(c, SOUTH_CHECK_IN, SOUTH_SESSION, "check_in");
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("code lists", () => {
  it("keep the database and domain lists in step", () => {
    expect([...LONE_WORKER_EVENT_KIND_CODES]).toEqual([...LONE_WORKER_EVENT_KINDS]);
    expect([...LONE_WORKER_ALARM_REASON_CODES]).toEqual([...LONE_WORKER_ALARM_REASONS]);
    expect([...LONE_WORKER_ALARM_STATE_CODES]).toEqual([...LONE_WORKER_ALARM_STATES]);
    expect([...LONE_WORKER_OUTCOME_CODES]).toEqual([...LONE_WORKER_OUTCOMES]);
  });
});

describe("tenant isolation", () => {
  it.each([
    "lone_worker_session",
    "lone_worker_event",
    "lone_worker_alarm",
    "lone_worker_location",
  ])("another organisation sees no %s rows", async (table) => {
    await asOtherTenant(async (c) => {
      expect(await count(c, `SELECT count(*) AS n FROM ${table}`)).toBe(0);
    });
  });

  it("another organisation cannot add an event to a session", async () => {
    await expect(
      asOtherTenant((c) =>
        addEvent(c, "0199f200-0000-7000-8000-0000000000e9", NORTH_SESSION, "check_in"),
      ),
    ).rejects.toThrow();
  });
});

describe("who sees what", () => {
  it("the worker sees their own session, events and alarms, but never a duress alarm", async () => {
    await asCarer(async (c) => {
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_session")).toBe(1);
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_event")).toBe(3);
      const alarms = await c.query<{ reason: string }>("SELECT reason FROM lone_worker_alarm");
      expect(alarms.rows.map((r) => r.reason)).toEqual(["overdue"]);
    });
  });

  it("a monitor sees sessions at their location, and their own", async () => {
    await asNorth(async (c) => {
      const rows = await c.query<{ id: string }>("SELECT id FROM lone_worker_session ORDER BY id");
      expect(rows.rows.map((r) => r.id)).toEqual([NORTH_SESSION, SOUTH_SESSION]);
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_location")).toBe(2);
    });
  });

  it("a manager without the monitor permission sees nothing", async () => {
    await asManager(async (c) => {
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_session")).toBe(0);
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_alarm")).toBe(0);
      expect(await count(c, "SELECT count(*) AS n FROM lone_worker_location")).toBe(0);
    });
  });

  it("the redacted history keeps no worker or note", async () => {
    await asSweep((c) =>
      c.query("UPDATE lone_worker_session SET reminder_sent_for = now() WHERE id = $1", [
        NORTH_SESSION,
      ]),
    );
    await asOwner(TENANT_A, async (c) => {
      const { rows } = await c.query<{ data: Record<string, unknown> }>(
        "SELECT data FROM record_version WHERE table_name = 'lone_worker_session'",
      );
      expect(rows[0]?.data.worker_tenant_user_id).toBe("[redacted]");
    });
  });
});

describe("writing", () => {
  it("nobody starts a session for someone else", async () => {
    await expect(
      asNorth((c) => startSession(c, "0199f200-0000-7000-8000-0000000000a9", a.locationNorth)),
    ).rejects.toThrow(/row-level security/);
  });

  it("nobody starts a session where they do not hold the check-in permission", async () => {
    // The carer's check-in role is at North House only; the manager has none at all.
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO lone_worker_session (location_id, work_kind, started_at, planned_end_at, interval_minutes)
           VALUES ($1, 'night_shift', now(), now() + interval '1 hour', 30)`,
          [a.locationSouth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO lone_worker_session (location_id, work_kind, started_at, planned_end_at, interval_minutes)
           VALUES ($1, 'night_shift', now(), now() + interval '1 hour', 30)`,
          [a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("the worker can only finish: never remove a session or touch its reminders", async () => {
    await expect(
      asCarer((c) =>
        c.query("UPDATE lone_worker_session SET deleted_at = now() WHERE id = $1", [NORTH_SESSION]),
      ),
    ).rejects.toThrow(/only the system/);
    await expect(
      asCarer((c) =>
        c.query("UPDATE lone_worker_session SET reminder_sent_for = now() WHERE id = $1", [
          NORTH_SESSION,
        ]),
      ),
    ).rejects.toThrow(/only the system/);
  });

  it("an event never counts from after it arrived", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO lone_worker_event (id, session_id, kind, device_at, effective_at, late)
           VALUES (app.uuid_v7(), $1, 'check_in', now(), now() + interval '1 hour', false)`,
          [NORTH_SESSION],
        ),
      ),
    ).rejects.toThrow(/lone_worker_event_effective/);
  });

  it("only a holder of the manage permission writes the on-call route", async () => {
    for (const as of [asCarer, asNorth]) {
      await expect(
        as((c) =>
          c.query(
            `INSERT INTO escalation_chain (key, name, steps)
             VALUES ('scheduling.lone_worker.alarm', 'Route', '[]'::jsonb)`,
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("one open overdue alarm per missed due time, and one open help or duress alarm per kind", async () => {
    await expect(
      asSweep((c) =>
        c.query(
          `INSERT INTO lone_worker_alarm (session_id, location_id, worker_tenant_user_id, reason,
             due_at, raised_at, last_alerted_at)
           SELECT session_id, location_id, worker_tenant_user_id, 'overdue', due_at, now(), now()
             FROM lone_worker_alarm WHERE id = $1`,
          [OVERDUE_ALARM],
        ),
      ),
    ).rejects.toThrow(/lone_worker_alarm_overdue_due_key/);
    await expect(
      asSweep((c) =>
        c.query(
          `INSERT INTO lone_worker_alarm (session_id, location_id, worker_tenant_user_id, reason,
             trigger_event_id, raised_at, last_alerted_at)
           VALUES ($1, $2, $3, 'duress', $4, now(), now())`,
          [NORTH_SESSION, a.locationNorth, a.carer, OLD_EVENT],
        ),
      ),
    ).rejects.toThrow(/lone_worker_alarm_open_worker_raised_key/);
  });

  it("one open session per worker", async () => {
    await expect(
      asCarer((c) => startSession(c, "0199f200-0000-7000-8000-0000000000a8", a.locationNorth)),
    ).rejects.toThrow(/lone_worker_session_open_key/);
  });

  it("a monitor cannot check in on a worker's behalf", async () => {
    await expect(
      asNorth((c) =>
        addEvent(c, "0199f200-0000-7000-8000-0000000000e8", NORTH_SESSION, "check_in"),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("an event is accepted once (client UUID, idempotent)", async () => {
    await asCarer(async (c) => {
      await addEvent(c, CHECK_IN, NORTH_SESSION, "check_in");
      expect(
        await count(c, "SELECT count(*) AS n FROM lone_worker_event WHERE id = $1", [CHECK_IN]),
      ).toBe(1);
    });
  });

  it("events are append-only, for every role", async () => {
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query("UPDATE lone_worker_event SET kind = 'check_in' WHERE id = $1", [DURESS]),
      ),
    ).rejects.toThrow();
    await expect(
      asOwner(TENANT_A, (c) => c.query("DELETE FROM lone_worker_event WHERE id = $1", [DURESS])),
    ).rejects.toThrow();
  });

  it("a session's worker, place and times are fixed", async () => {
    await expect(
      asCarer((c) =>
        c.query("UPDATE lone_worker_session SET interval_minutes = 600 WHERE id = $1", [
          NORTH_SESSION,
        ]),
      ),
    ).rejects.toThrow(/fixed/);
  });

  it("a worker cannot raise an alarm, even for help, only the system", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO lone_worker_alarm (session_id, location_id, worker_tenant_user_id, reason,
             trigger_event_id, raised_at, last_alerted_at)
           VALUES ($1, $2, $3, 'help', $4, now(), now())`,
          [NORTH_SESSION, a.locationNorth, a.carer, CHECK_IN],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("alarms (HZ-125)", () => {
  it("a check-in never resolves a duress alarm", async () => {
    const result = await asCarer((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'resolved_by_check_in', resolved_at = now(),
           resolved_by_event_id = $2 WHERE id = $1`,
        [DURESS_ALARM, CHECK_IN],
      ),
    );
    expect(result.rowCount).toBe(0);
    // Not even the sweep: the table refuses it.
    await expect(
      asSweep((c) =>
        c.query(
          `UPDATE lone_worker_alarm SET state = 'resolved_by_check_in', resolved_at = now(),
             resolved_by_event_id = $2 WHERE id = $1`,
          [DURESS_ALARM, CHECK_IN],
        ),
      ),
    ).rejects.toThrow(/lone_worker_alarm_worker_raised/);
  });

  it("the worker cannot acknowledge their own alarm", async () => {
    const result = await asCarer((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'acknowledged', acknowledged_at = now(),
           acknowledged_by = $2, outcome = 'safe_confirmed', note = 'Fine' WHERE id = $1`,
        [DURESS_ALARM, a.carer],
      ),
    );
    expect(result.rowCount).toBe(0);
  });

  it("a manager without the monitor permission cannot acknowledge", async () => {
    const result = await asManager((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'acknowledged', acknowledged_at = now(),
           acknowledged_by = $2, outcome = 'safe_confirmed', note = 'Phoned' WHERE id = $1`,
        [DURESS_ALARM, a.manager],
      ),
    );
    expect(result.rowCount).toBe(0);
  });

  it("an acknowledgement needs a note", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `UPDATE lone_worker_alarm SET state = 'acknowledged', acknowledged_at = now(),
             acknowledged_by = $2, outcome = 'help_sent', note = ' ' WHERE id = $1`,
          [DURESS_ALARM, a.northManager],
        ),
      ),
    ).rejects.toThrow(/lone_worker_alarm_acknowledged/);
  });

  it("the worker cannot resolve even an overdue alarm; the system does on their check-in", async () => {
    const byWorker = await asCarer((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'resolved_by_check_in', resolved_at = now(),
           resolved_by_event_id = $2 WHERE id = $1`,
        [OVERDUE_ALARM, CHECK_IN],
      ),
    );
    expect(byWorker.rowCount).toBe(0);
    const result = await asSweep((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'resolved_late_check_in', resolved_at = now(),
           resolved_by_event_id = $2 WHERE id = $1`,
        [OVERDUE_ALARM, CHECK_IN],
      ),
    );
    expect(result.rowCount).toBe(1);
  });

  it("a monitor acknowledges a duress alarm in their own name, and it stays closed", async () => {
    const result = await asNorth((c) =>
      c.query(
        `UPDATE lone_worker_alarm SET state = 'acknowledged', acknowledged_at = now(),
           acknowledged_by = $2, outcome = 'help_sent', note = 'Went round' WHERE id = $1`,
        [DURESS_ALARM, a.northManager],
      ),
    );
    expect(result.rowCount).toBe(1);
    await expect(
      asSweep((c) =>
        c.query("UPDATE lone_worker_alarm SET state = 'open' WHERE id = $1", [DURESS_ALARM]),
      ),
    ).rejects.toThrow(/stays closed/);
  });
});

describe("location evidence (H-527)", () => {
  it("only the sweep erases it, and only at its date", async () => {
    const byWorker = await asCarer((c) =>
      c.query(
        `UPDATE lone_worker_location SET latitude = NULL, longitude = NULL, cleared_at = now()
         WHERE id = $1`,
        [OLD_POINT],
      ),
    );
    expect(byWorker.rowCount).toBe(0);
    await expect(
      asSweep((c) =>
        c.query(
          `UPDATE lone_worker_location SET latitude = NULL, longitude = NULL, cleared_at = now()
           WHERE id = $1`,
          [POINT],
        ),
      ),
    ).rejects.toThrow(/not before/);
    const bySweep = await asSweep((c) =>
      c.query(
        `UPDATE lone_worker_location SET latitude = NULL, longitude = NULL, cleared_at = now()
         WHERE delete_after <= now() AND cleared_at IS NULL`,
      ),
    );
    expect(bySweep.rowCount).toBe(1);
  });

  it("the application can never delete it", async () => {
    await expect(
      asSweep((c) => c.query("DELETE FROM lone_worker_location WHERE id = $1", [POINT])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("existing tenants' role copies gain the lone-worker permissions (migration 0113)", () => {
  const FILE = fileURLToPath(new URL("../drizzle/0113_lone_worker_safety.sql", import.meta.url));
  const SECTION = { begin: "-- BEGIN role backfill 0113", end: "-- END role backfill 0113" };
  const PERMISSIONS = [
    "scheduling.lone_worker.check_in",
    "scheduling.lone_worker.monitor",
    "scheduling.lone_worker.manage",
  ];
  const section = () => {
    const sql = readFileSync(FILE, "utf8");
    return sql.slice(sql.indexOf(SECTION.begin), sql.indexOf(SECTION.end));
  };
  const grants = () =>
    new Map(
      [...section().matchAll(/\('([a-z_]+)', ARRAY\[([^\]]*)\]\)/g)].map((m) => [
        m[1] ?? "",
        [...(m[2] ?? "").matchAll(/'([^']+)'/g)].map((p) => p[1] ?? ""),
      ]),
    );

  async function rerun() {
    const client = await db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      for (const statement of section().split("--> statement-breakpoint")) {
        if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  it("lists the same roles and permissions as the built-in definitions", () => {
    const listed = grants();
    for (const permission of PERMISSIONS) {
      const holders = BUILTIN_ROLES.filter((r) =>
        (r.permissions as readonly string[]).includes(permission),
      ).map((r) => r.key);
      const named = [...listed].filter(([, add]) => add.includes(permission)).map(([k]) => k);
      expect(named.sort(), permission).toEqual([...holders].sort());
    }
  });

  it("adds them once to each copy that lacks them, audited as the system", async () => {
    await asOwner(TENANT_B, (c) =>
      c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('team_leader', 'Team leader', 'location', '{people.person.read}', true),
           ('finance', 'Finance', 'none', '{finance.billing.manage}', true)`,
      ),
    );
    await rerun();
    await rerun();
    const roles = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string; permissions: string[] }>(
        "SELECT key, permissions FROM role WHERE key IN ('team_leader', 'finance') ORDER BY key",
      ),
    );
    expect(roles.rows.map((r) => [r.key, r.permissions])).toEqual([
      ["finance", ["finance.billing.manage"]],
      [
        "team_leader",
        ["people.person.read", "scheduling.lone_worker.check_in", "scheduling.lone_worker.monitor"],
      ],
    ]);
    const audit = await asOwner(TENANT_B, (c) =>
      c.query<{ actor: string; key: string }>(
        `SELECT actor_auth_user_id AS actor, scope ->> 'roleKey' AS key FROM audit_event
         WHERE action = 'platform.role.permissions_migrated'
           AND scope ->> 'migration' = '0113_lone_worker_safety' ORDER BY 2`,
      ),
    );
    expect(audit.rows.map((r) => [r.actor, r.key])).toEqual([["system", "team_leader"]]);
  });
});
