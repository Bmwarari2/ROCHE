import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Pay through Thapsus-HR in the database (integrations.md section 11.5 rules 11 and 12; slice 89;
 * migration 0151; HZ-133, HZ-140): pay periods and hourly rates written by the link's sync alone;
 * rates read by pay holders only; units written once, by the system, for a locked pay run, then
 * never changed; nothing crosses organisations. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const PAYA = "0199f610-0000-7000-8000-000000000601";
const SET = "0199f610-0000-7000-8000-0000000000a1";
const RUN = "0199f610-0000-7000-8000-0000000000b1";
const DRAFT = "0199f610-0000-7000-8000-0000000000b2";
const app = () => db.pool("harbour_app");
const asOwner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** Finance: pay manage and approve across the organisation. */
const asFinance = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
const asApprover = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, PAYA, "tenant"), fn);
/** The HR link's reader, with no pay permission. */
const asHrReader = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "locations", [b.location]), fn);
const count = async (c: pg.PoolClient, text: string) =>
  Number((await c.query<{ n: string }>(text)).rows[0]?.n);

let period = "";
let profile = "";

const unit = (c: pg.PoolClient, run: string, kind = "hours") =>
  c.query(
    `INSERT INTO hr_pay_unit (run_id, hr_pay_period_id, member_id, unit_kind, quantity, pay_code)
     VALUES ($1, $2, $3, $4, 37.5, 'BASIC')`,
    [run, period, a.carer, kind],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, 'auth-a-paya-hr', 'Pat Approver', 'pat.approver.hr@example.invalid', 'active')`,
      [PAYA],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f610-0000-7000-8000-000000000701', 'payroll', 'Payroll', 'none',
          '{scheduling.pay.manage,scheduling.pay.approve}'),
         ('0199f610-0000-7000-8000-000000000702', 'pay_approver', 'Pay approver', 'tenant',
          '{scheduling.pay.approve}'),
         ('0199f610-0000-7000-8000-000000000703', 'hr_reader', 'HR link reader', 'tenant',
          '{integrations.hr_link.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES
         ($1, '0199f610-0000-7000-8000-000000000701'),
         ($2, '0199f610-0000-7000-8000-000000000702'),
         ($3, '0199f610-0000-7000-8000-000000000703')`,
      [a.manager, PAYA, a.northManager],
    );
    profile = (
      await c.query<{ id: string }>(
        "INSERT INTO staff_profile (tenant_user_id, job_title) VALUES ($1, 'Care worker') RETURNING id",
        [a.carer],
      )
    ).rows[0]?.id as string;
  });
  // A locked weekly run and a draft, by the usual two people.
  await asFinance((c) =>
    c.query(
      `INSERT INTO pay_rule_set (id, name, version_number, effective_from, role_rates)
       VALUES ($1, 'Standard', 1, '2026-04-06', '{"care_worker": 1300}')`,
      [SET],
    ),
  );
  await asApprover((c) =>
    c.query(
      "UPDATE pay_rule_set SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1",
      [SET, PAYA],
    ),
  );
  await asFinance(async (c) => {
    for (const [id, start, end] of [
      [RUN, "2026-11-02", "2026-11-08"],
      [DRAFT, "2026-11-09", "2026-11-15"],
    ] as const) {
      await c.query(
        `INSERT INTO pay_run (id, frequency, period_start, period_end, rule_set_id, nation)
         VALUES ($1, 'weekly', $2, $3, $4, 'england')`,
        [id, start, end, SET],
      );
    }
    await c.query(
      "UPDATE pay_run SET calculation = calculation + 1, calculated_by = $2, calculated_at = now() WHERE id = $1",
      [RUN, a.manager],
    );
  });
  await asApprover((c) =>
    c.query(
      "UPDATE pay_run SET status = 'locked', locked_by = $2, locked_at = now() WHERE id = $1",
      [RUN, PAYA],
    ),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-140 Thapsus-HR's pay periods and rates are the sync's copies (rule 11)", () => {
  it("lets the sync write them, and refuses a person", async () => {
    period = (
      await asSystem((c) =>
        c.query<{ id: string }>(
          `INSERT INTO hr_pay_period (hr_id, frequency, starts_on, ends_on, last_seen_at)
           VALUES ('pp_1', 'weekly', '2026-11-02', '2026-11-08', now()) RETURNING id`,
        ),
      )
    ).rows[0]?.id as string;
    await asSystem((c) =>
      c.query(
        `INSERT INTO hr_pay_rate (staff_profile_id, hourly_pence, effective_from, last_seen_at)
         VALUES ($1, 1271, '2026-04-01', now())`,
        [profile],
      ),
    );
    await expect(
      asFinance((c) =>
        c.query(
          `INSERT INTO hr_pay_rate (staff_profile_id, hourly_pence, effective_from, last_seen_at)
           VALUES ($1, 9999, '2026-10-01', now())`,
          [profile],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(
      (await asFinance((c) => c.query("UPDATE hr_pay_rate SET hourly_pence = 1"))).rowCount,
    ).toBe(0);
    expect(
      (await asFinance((c) => c.query("UPDATE hr_pay_period SET ends_on = '2026-11-07'"))).rowCount,
    ).toBe(0);
  });

  it("refuses a period longer than a pay run may be, and a rate that is not real", async () => {
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO hr_pay_period (hr_id, frequency, starts_on, ends_on, last_seen_at)
           VALUES ('pp_2', 'monthly', '2026-11-01', '2026-12-05', now())`,
        ),
      ),
    ).rejects.toThrow(/hr_pay_period_values/);
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO hr_pay_rate (staff_profile_id, hourly_pence, effective_from, last_seen_at)
           VALUES ($1, 0, '2026-10-01', now())`,
          [profile],
        ),
      ),
    ).rejects.toThrow(/hr_pay_rate_values/);
  });

  it("shows rates to pay holders only; periods also to the link's readers; nothing to another organisation", async () => {
    expect(await asFinance((c) => count(c, "SELECT count(*) AS n FROM hr_pay_rate"))).toBe(1);
    expect(await asHrReader((c) => count(c, "SELECT count(*) AS n FROM hr_pay_rate"))).toBe(0);
    expect(await asHrReader((c) => count(c, "SELECT count(*) AS n FROM hr_pay_period"))).toBe(1);
    for (const t of ["hr_pay_period", "hr_pay_rate", "hr_pay_unit"]) {
      expect(await asOtherTenant((c) => count(c, `SELECT count(*) AS n FROM ${t}`))).toBe(0);
    }
  });
});

describe("hazard HZ-140 a pay run's route to payroll is fixed, and a correction takes its original's (rule 12)", () => {
  it("refuses changing a run's route, and a correction with another route", async () => {
    await expect(
      asOwner((c) => c.query("UPDATE pay_run SET pay_route = 'thapsus_hr' WHERE id = $1", [DRAFT])),
    ).rejects.toThrow(/pay_run_route_fixed/);
    await expect(
      asFinance((c) =>
        c.query(
          `INSERT INTO pay_run (frequency, period_start, period_end, rule_set_id, nation, kind, corrects_run_id, pay_route)
           VALUES ('weekly', '2026-11-02', '2026-11-08', $1, 'england', 'correction', $2, 'thapsus_hr')`,
          [SET, RUN],
        ),
      ),
    ).rejects.toThrow(/pay_run_route_of_original/);
  });
});

describe("hazard HZ-140 units are kept once, for a locked pay run only, and never change (rules 11 and 12)", () => {
  it("refuses units for a draft run, and a person writing them", async () => {
    await expect(asSystem((c) => unit(c, DRAFT))).rejects.toThrow(/row-level security/);
    await expect(asFinance((c) => unit(c, RUN))).rejects.toThrow(/row-level security/);
  });

  it("keeps the system's units for a locked run, read by pay holders only", async () => {
    await asSystem((c) => unit(c, RUN));
    expect(await asFinance((c) => count(c, "SELECT count(*) AS n FROM hr_pay_unit"))).toBe(1);
    expect(await asHrReader((c) => count(c, "SELECT count(*) AS n FROM hr_pay_unit"))).toBe(0);
  });

  it("refuses a unit kind it does not know, and any change or deletion", async () => {
    await expect(asSystem((c) => unit(c, RUN, "bonus"))).rejects.toThrow(/hr_pay_unit_values/);
    await expect(asOwner((c) => c.query("UPDATE hr_pay_unit SET quantity = 1"))).rejects.toThrow();
    await expect(asOwner((c) => c.query("DELETE FROM hr_pay_unit"))).rejects.toThrow();
  });
});
