import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Time and attendance in the database (scheduling.md section 16; hazards HZ-010, HZ-011, HZ-124;
 * migration 0109): cross-tenant denial; a member's own clock events and timesheets; others' only
 * for those who build or approve the rota there; clock events never changed; a timesheet approved
 * only by an approver in their own name, never the worker, fixed once approved and corrected by a
 * superseding entry, one at a time; opt-outs never recorded by the worker.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** North's rota lead: builds and approves. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A rota builder at North without approve. */
const asPlanner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "locations", [a.locationNorth]), fn);
/** The care worker, with scheduling.timesheet.self. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "locations", [b.location]), fn);

const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);
const EVENT = "0199f500-0000-7000-8000-0000000000e1";
const ENTRY = "0199f500-0000-7000-8000-0000000000f1";

const clock = (c: pg.PoolClient, worker: string, id: string | null = null) =>
  c.query(
    `INSERT INTO clock_event (id, worker_id, kind, location_id, device_time)
     VALUES (COALESCE($1::uuid, app.uuid_v7()), $2, 'in', $3, now())`,
    [id, worker, a.locationNorth],
  );
const draft = (
  c: pg.PoolClient,
  v: { id?: string; worker?: string; supersedes?: string; kind?: string } = {},
) =>
  c.query(
    `INSERT INTO timesheet_entry (id, worker_id, location_id, kind, started_at, ended_at, source,
       supersedes_id, correction_reason)
     VALUES (COALESCE($1::uuid, app.uuid_v7()), $2, $3, $4, '2026-11-02T08:00:00Z', '2026-11-02T20:00:00Z',
       'manual', $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE 'Clocked out late in error' END)`,
    [v.id ?? null, v.worker ?? a.carer, a.locationNorth, v.kind ?? "work", v.supersedes ?? null],
  );
const approve = (c: pg.PoolClient, id: string, by: string) =>
  c.query(
    "UPDATE timesheet_entry SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
    [id, by],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f500-0000-7000-8000-000000000501', 'rota_lead', 'Rota lead', 'location',
          '{scheduling.rota.manage,scheduling.rota.approve}'),
         ('0199f500-0000-7000-8000-000000000502', 'planner', 'Planner', 'location',
          '{scheduling.rota.manage}'),
         ('0199f500-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{scheduling.timesheet.self}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f500-0000-7000-8000-000000000501', $4),
         ($2, '0199f500-0000-7000-8000-000000000502', $4),
         ($3, '0199f500-0000-7000-8000-000000000503', $4)`,
      [a.northManager, a.manager, a.carer, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 time records stay in their organisation", () => {
  it("hazard HZ-011 never shows another organisation's rows", async () => {
    await asCarer((c) => clock(c, a.carer, EVENT));
    await asPlanner((c) => draft(c, { id: ENTRY }));
    await asNorth((c) =>
      c.query("INSERT INTO clock_setting (location_id, evidence) VALUES ($1, 'none')", [
        a.locationNorth,
      ]),
    );
    const tables = [
      "clock_setting",
      "clock_event",
      "timesheet_entry",
      "sleep_in_awake_period",
      "working_time_opt_out",
      "working_time_result",
    ];
    const seen = await asOtherTenant(async (c) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = await count(c, `SELECT count(*) AS n FROM ${t}`);
      return out;
    });
    expect(Object.values(seen).every((n) => n === 0)).toBe(true);
  });
});

describe("clock events (rule 1 and 2)", () => {
  it("lets a member clock for themselves only, and never changes an event", async () => {
    await expect(asCarer((c) => clock(c, a.manager))).rejects.toThrow(/row-level security/);
    await expect(
      asCarer((c) => c.query("UPDATE clock_event SET kind = 'out' WHERE id = $1", [EVENT])),
    ).rejects.toThrow();
  });

  it("refuses a second event with the same client id", async () => {
    await expect(asCarer((c) => clock(c, a.carer, EVENT))).rejects.toThrow(/duplicate key/);
  });

  it("shows a member their own events and managers those at their location", async () => {
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM clock_event"))).toBe(1);
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM clock_event"))).toBe(1);
  });
});

describe("timesheets: approval never by the worker, fixed once approved (rules 5 and 6)", () => {
  it("refuses a worker making or changing their own entry", async () => {
    await expect(asCarer((c) => draft(c))).rejects.toThrow(/row-level security/);
    await expect(
      asCarer((c) =>
        c.query(
          "UPDATE timesheet_entry SET ended_at = ended_at + interval '1 hour' WHERE id = $1",
          [ENTRY],
        ),
      ),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it("refuses approval without the approve permission, or in someone else's name", async () => {
    await expect(asPlanner((c) => approve(c, ENTRY, a.manager))).rejects.toThrow(
      /approver's own name/,
    );
    await expect(asNorth((c) => approve(c, ENTRY, a.manager))).rejects.toThrow(
      /approver's own name/,
    );
  });

  it("never approves an entry the approver entered by hand", async () => {
    const mine = "0199f500-0000-7000-8000-0000000000f8";
    await asNorth((c) => draft(c, { id: mine }));
    await expect(asNorth((c) => approve(c, mine, a.northManager))).rejects.toThrow(
      /whoever entered or changed/,
    );
  });

  it("approves an entry entered by someone else, then never changes it", async () => {
    await asNorth((c) => approve(c, ENTRY, a.northManager));
    await expect(
      asNorth((c) =>
        c.query(
          "UPDATE timesheet_entry SET ended_at = ended_at + interval '1 hour' WHERE id = $1",
          [ENTRY],
        ),
      ),
    ).rejects.toThrow(/never changed/);
  });

  it("never approves the approver's own entry (row-level security finds no row to change)", async () => {
    const own = "0199f500-0000-7000-8000-0000000000f9";
    await asOwner(TENANT_A, (o) => draft(o, { id: own, worker: a.northManager }));
    const result = await asNorth((c) => approve(c, own, a.northManager));
    expect(result.rowCount).toBe(0);
    const [row] = (
      await asOwner(TENANT_A, (o) =>
        o.query<{ status: string }>("SELECT status FROM timesheet_entry WHERE id = $1", [own]),
      )
    ).rows;
    expect(row?.status).toBe("draft");
  });

  it("corrects an approved entry by a superseding draft, one at a time, never a draft", async () => {
    await asNorth((c) =>
      draft(c, { id: "0199f500-0000-7000-8000-0000000000f2", supersedes: ENTRY }),
    );
    await expect(asNorth((c) => draft(c, { supersedes: ENTRY }))).rejects.toThrow(/one_correction/);
    await expect(
      asNorth((c) => draft(c, { supersedes: "0199f500-0000-7000-8000-0000000000f2" })),
    ).rejects.toThrow(/approved entry/);
  });

  it("adds awake periods to a sleep-in draft only", async () => {
    await asNorth((c) =>
      draft(c, { id: "0199f500-0000-7000-8000-0000000000f3", kind: "sleep_in" }),
    );
    await asNorth((c) =>
      c.query(
        `INSERT INTO sleep_in_awake_period (timesheet_entry_id, started_at, ended_at)
         VALUES ($1, '2026-11-02T02:00:00Z', '2026-11-02T02:20:00Z')`,
        ["0199f500-0000-7000-8000-0000000000f3"],
      ),
    );
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO sleep_in_awake_period (timesheet_entry_id, started_at, ended_at)
           VALUES ($1, '2026-11-02T02:00:00Z', '2026-11-02T02:20:00Z')`,
          [ENTRY],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows a worker their own entries", async () => {
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM timesheet_entry"))).toBe(4);
  });
});

describe("opt-outs on file (rule 8)", () => {
  const optOut = (c: pg.PoolClient, worker: string, by: string) =>
    c.query(
      `INSERT INTO working_time_opt_out (worker_id, signed_on, recorded_by) VALUES ($1, '2026-01-05', $2)`,
      [worker, by],
    );
  it("records an opt-out from the signed agreement, never by the worker or in another's name", async () => {
    await asNorth((c) => optOut(c, a.carer, a.northManager));
    await expect(asNorth((c) => optOut(c, a.carer, a.manager))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asCarer((c) => optOut(c, a.carer, a.carer))).rejects.toThrow();
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM working_time_opt_out"))).toBe(
      1,
    );
  });
});

describe("hazard HZ-011 every time table is closed to another organisation", () => {
  it("hazard HZ-011 working time results are written only by the system", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO working_time_result (worker_id, location_id, evaluate_from, evaluate_to, findings,
             breaches, conditionals, input_hash, trigger)
           VALUES ($1, $2, '2026-11-02', '2026-11-02', '[]', 0, 0, 'x', 'requested')`,
          [a.carer, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await asOwner(TENANT_A, (o) =>
      o.query(
        `INSERT INTO working_time_result (worker_id, location_id, evaluate_from, evaluate_to, findings,
           breaches, conditionals, input_hash, trigger)
         VALUES ($1, $2, '2026-11-02', '2026-11-02', '[]', 0, 0, 'x', 'requested')`,
        [a.carer, a.locationNorth],
      ),
    );
  });

  it("hazard HZ-011 denies every table, once each has rows", async () => {
    const tables = [
      "clock_setting",
      "clock_event",
      "timesheet_entry",
      "sleep_in_awake_period",
      "working_time_opt_out",
      "working_time_result",
    ];
    const own = await asOwner(TENANT_A, async (o) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = await count(o, `SELECT count(*) AS n FROM ${t}`);
      return out;
    });
    expect(Object.values(own).every((n) => n > 0)).toBe(true);
    const seen = await asOtherTenant(async (c) => {
      const out: Record<string, number> = {};
      for (const t of tables) out[t] = await count(c, `SELECT count(*) AS n FROM ${t}`);
      return out;
    });
    expect(seen).toEqual(Object.fromEntries(tables.map((t) => [t, 0])));
  });
});
