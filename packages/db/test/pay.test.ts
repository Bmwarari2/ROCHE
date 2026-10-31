import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Pay calculation runs in the database (scheduling.md section 18; migration 0116; HZ-011):
 * cross-tenant denial for all five tables; pay permissions count only organisation-wide (a
 * location's manager sees no pay); a rule set approved by its author is refused, then fixed; a run
 * is locked by a second person with no open exception and then never changes; lines append-only;
 * one regular run per period; a member reads their own locked line.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const PAYA = "0199f600-0000-7000-8000-000000000601";
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** Finance (no location scope): manage and approve. */
const asFinance = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** A tenant-wide approver. */
const asApprover = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, PAYA, "tenant"), fn);
/** A location's manager holding the pay permissions only at North. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "locations", [b.location]), fn);

const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);
const SET = "0199f600-0000-7000-8000-0000000000a1";
const RUN = "0199f600-0000-7000-8000-0000000000b1";
const TABLES = ["pay_rule_set", "pay_profile", "pay_run", "pay_run_line", "pay_run_exception"];
const HASH = "a".repeat(64);

const line = (c: pg.PoolClient, calculation: number, member: string = a.carer) =>
  c.query(
    `INSERT INTO pay_run_line (run_id, calculation, member_id, paid_minutes, nmw_minutes, basic_pence,
       premium_pence, sleep_in_pence, on_call_pence, mileage_pence, nmw_top_up_pence,
       rolled_up_holiday_pence, ssp_pence, total_pence, working, inputs, input_hash)
     VALUES ($1, $2, $3, 480, 480, 10000, 0, 0, 0, 0, 0, 0, 0, 10000, '[]', '{}', $4)`,
    [RUN, calculation, member, HASH],
  );
const calculate = (c: pg.PoolClient, by: string) =>
  c.query(
    "UPDATE pay_run SET calculation = calculation + 1, calculated_by = $2, calculated_at = now() WHERE id = $1",
    [RUN, by],
  );
const lock = (c: pg.PoolClient, by: string) =>
  c.query("UPDATE pay_run SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1", [
    RUN,
    by,
  ]);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, 'auth-a-paya', 'Pat Approver', 'pat.approver@example.invalid', 'active')`,
      [PAYA],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f600-0000-7000-8000-000000000701', 'payroll', 'Payroll', 'none',
          '{scheduling.pay.manage,scheduling.pay.approve}'),
         ('0199f600-0000-7000-8000-000000000702', 'pay_approver', 'Pay approver', 'tenant',
          '{scheduling.pay.approve}'),
         ('0199f600-0000-7000-8000-000000000703', 'local_pay', 'Local pay', 'location',
          '{scheduling.pay.manage,scheduling.pay.approve}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f600-0000-7000-8000-000000000701', NULL),
         ($2, '0199f600-0000-7000-8000-000000000702', NULL),
         ($3, '0199f600-0000-7000-8000-000000000703', $4)`,
      [a.manager, PAYA, a.northManager, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("rule sets (rule 1)", () => {
  it("lets Finance write a draft, and refuses its author approving it", async () => {
    await asFinance((c) =>
      c.query(
        `INSERT INTO pay_rule_set (id, name, version_number, effective_from, role_rates)
         VALUES ($1, 'Standard', 1, '2026-04-06', '{"care_worker": 1300}')`,
        [SET],
      ),
    );
    await expect(
      asFinance((c) =>
        c.query(
          "UPDATE pay_rule_set SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
          [SET, a.manager],
        ),
      ),
    ).rejects.toThrow(/neither wrote nor changed/);
  });

  it("is approved by someone else, then never changes", async () => {
    await asApprover((c) =>
      c.query(
        "UPDATE pay_rule_set SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
        [SET, PAYA],
      ),
    );
    await expect(
      asFinance((c) =>
        c.query("UPDATE pay_rule_set SET sleep_in_flat_pence = 1 WHERE id = $1", [SET]),
      ),
    ).rejects.toThrow(/never changes/);
  });

  it("shows a location's manager no pay, even holding the pay permissions there", async () => {
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM pay_rule_set"))).toBe(0);
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO pay_rule_set (name, version_number, effective_from, role_rates)
           VALUES ('Local', 2, '2026-04-06', '{}')`,
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("pay profiles", () => {
  it("are written for others only, and the member reads their own", async () => {
    await asFinance((c) =>
      c.query(
        "INSERT INTO pay_profile (member_id, frequency, role_key) VALUES ($1, 'weekly', 'care_worker')",
        [a.carer],
      ),
    );
    await expect(
      asFinance((c) =>
        c.query("INSERT INTO pay_profile (member_id, frequency) VALUES ($1, 'weekly')", [
          a.manager,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM pay_profile"))).toBe(1);
  });
});

describe("runs: drafted, checked by a second person and locked (rules 9, 11 and 12)", () => {
  it("starts a draft with an approved rule set, one regular run per period", async () => {
    await asFinance((c) =>
      c.query(
        `INSERT INTO pay_run (id, frequency, period_start, period_end, rule_set_id, nation)
         VALUES ($1, 'weekly', '2026-11-02', '2026-11-08', $2, 'england')`,
        [RUN, SET],
      ),
    );
    await expect(
      asFinance((c) =>
        c.query(
          `INSERT INTO pay_run (frequency, period_start, period_end, rule_set_id, nation)
           VALUES ('weekly', '2026-11-02', '2026-11-08', $1, 'england')`,
          [SET],
        ),
      ),
    ).rejects.toThrow(/pay_run_one_regular_key/);
  });

  it("writes lines only for the latest calculation, and never changes one", async () => {
    await asFinance(async (c) => {
      await calculate(c, a.manager);
      await line(c, 1);
    });
    await expect(asFinance((c) => line(c, 2, a.northManager))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      asFinance((c) => c.query("UPDATE pay_run_line SET total_pence = 1 WHERE run_id = $1", [RUN])),
    ).rejects.toThrow();
  });

  it("refuses locking with an open exception, then allows it once overridden by someone else", async () => {
    const [exception] = (
      await asFinance((c) =>
        c.query<{ id: string }>(
          `INSERT INTO pay_run_exception (run_id, calculation, member_id, kind, line_input_hash)
           VALUES ($1, 1, $2, 'below_nmw', $3) RETURNING id`,
          [RUN, a.carer, HASH],
        ),
      )
    ).rows;
    await expect(asApprover((c) => lock(c, PAYA))).rejects.toThrow(/open exception/);
    await expect(
      asApprover((c) =>
        c.query(
          `UPDATE pay_run_exception SET status = 'overridden', overridden_by = $2,
             overridden_at = now(), override_reason = 'Top-up checked' WHERE id = $1`,
          [exception?.id, a.manager],
        ),
      ),
    ).rejects.toThrow(/own name/);
    await asApprover((c) =>
      c.query(
        `UPDATE pay_run_exception SET status = 'overridden', overridden_by = $2,
           overridden_at = now(), override_reason = 'Top-up checked' WHERE id = $1`,
        [exception?.id, PAYA],
      ),
    );
  });

  it("refuses the person who created or calculated it locking it", async () => {
    await expect(asFinance((c) => lock(c, a.manager))).rejects.toThrow(/neither created/);
  });

  it("is locked by a second person, then never changes", async () => {
    await asApprover((c) => lock(c, PAYA));
    await expect(asFinance((c) => calculate(c, a.manager))).rejects.toThrow(/never changes/);
  });

  it("lets the member read their own locked line, never the others", async () => {
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM pay_run_line"))).toBe(1);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM pay_run_exception"))).toBe(0);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM pay_run"))).toBe(1);
  });

  it("corrects a locked run only in a correction run of the same period, one open at a time", async () => {
    const correction = (start = "2026-11-02") =>
      asFinance((c) =>
        c.query(
          `INSERT INTO pay_run (frequency, period_start, period_end, kind, corrects_run_id, rule_set_id, nation)
           VALUES ('weekly', $2, '2026-11-08', 'correction', $1, $3, 'england')`,
          [RUN, start, SET],
        ),
      );
    await expect(correction("2026-11-03")).rejects.toThrow(/same period/);
    await correction();
    await expect(correction()).rejects.toThrow(/pay_run_one_open_correction_key/);
  });
});

describe("hazard HZ-011 pay stays in its organisation", () => {
  it("hazard HZ-011 denies every pay table to another organisation, once each has rows", async () => {
    const own = await asOwner(TENANT_A, async (o) => {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = await count(o, `SELECT count(*) AS n FROM ${t}`);
      return out;
    });
    expect(Object.values(own).every((n) => n > 0)).toBe(true);
    const seen = await asOtherTenant(async (c) => {
      const out: Record<string, number> = {};
      for (const t of TABLES) out[t] = await count(c, `SELECT count(*) AS n FROM ${t}`);
      return out;
    });
    expect(seen).toEqual(Object.fromEntries(TABLES.map((t) => [t, 0])));
  });
});
