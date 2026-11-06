import { PAYROLL_FORMATS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PAYROLL_FORMAT_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase, withAdminClient } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Payroll and pension exports in the database (scheduling.md section 19; migration 0127;
 * SCHED-008):
 * - cross-tenant denial;
 * - an export only of a locked run's current calculation, and a Xero export only when connected;
 * - only holders of finance.payroll.export across the organisation who also read pay;
 * - exports append-only, with the database deciding whether one is a re-export, one at a time;
 * - an API export's result once, and a known failure not counting as exported;
 * - one connected row per provider, naming the organisation's own secret, never a token;
 * - payroll references unique in the organisation, never shaped like an NI number.
 * All the people here are invented.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asAdmin = <T>(fn: (c: pg.Client) => Promise<T>) => withAdminClient(fn, db.name);
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** Finance (no location scope): pay and payroll export. */
const asFinance = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** A location's manager holding every permission only at North. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "locations", [ids.b.location]), fn);

const SET = "0199f676-0000-7000-8000-0000000000a1";
const LOCKED = "0199f676-0000-7000-8000-0000000000b1";
const DRAFT = "0199f676-0000-7000-8000-0000000000b2";
const RACED = "0199f676-0000-7000-8000-0000000000b3";
const HASH = "c".repeat(64);

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { message?: string }) => e.message ?? "error",
  );
const exportRow = (c: pg.PoolClient, run: string, over: Record<string, unknown> = {}) => {
  const format = (over.format as string | undefined) ?? "brightpay_csv";
  return c.query<{ id: string; reexport: boolean }>(
    `INSERT INTO payroll_export (run_id, calculation, format, format_version, line_count,
       content_sha256, outcome, payroll_references, exported_by)
     VALUES ($1, $2, $3, 1, 2, $4, $5, '{}', app.current_user_id()) RETURNING id, reexport`,
    [
      run,
      over.calculation ?? 1,
      format,
      HASH,
      over.outcome ?? (format === "xero_payroll_uk" ? "pending" : "generated"),
    ],
  );
};
const result = (c: pg.PoolClient, exportId: string, outcome = "sent", ref: string | null = null) =>
  c.query(
    `INSERT INTO payroll_export_result (export_id, outcome, external_ref, recorded_by)
     VALUES ($1, $2, $3, app.current_user_id())`,
    [exportId, outcome, ref],
  );
const connect = (c: pg.PoolClient, secret = "payroll/someone-elses/xero_payroll_uk/x") =>
  c.query<{ id: string; secret_ref: string; tenant_id: string }>(
    `INSERT INTO payroll_connection (provider, external_organisation_id, secret_ref, connected_by)
     VALUES ('xero_payroll_uk', 'xero-org-1', $1, app.current_user_id())
     RETURNING id, secret_ref, tenant_id`,
    [secret],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f676-0000-7000-8000-000000000701', 'payroll', 'Payroll', 'none',
          '{scheduling.pay.manage,scheduling.pay.approve,finance.payroll.export}'),
         ('0199f676-0000-7000-8000-000000000703', 'local_pay', 'Local pay', 'location',
          '{scheduling.pay.manage,scheduling.pay.approve,finance.payroll.export}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f676-0000-7000-8000-000000000701', NULL),
         ($2, '0199f676-0000-7000-8000-000000000703', $3)`,
      [a.manager, a.northManager, a.locationNorth],
    );
  });
  // Test setup only: a locked run and a draft one, written past the pay guards.
  await asAdmin(async (c) => {
    await c.query("SET session_replication_role = replica");
    await c.query(
      `INSERT INTO pay_rule_set (id, tenant_id, name, version_number, effective_from, role_rates, status,
         approved_by, approved_at)
       VALUES ($1, $2, 'Standard', 1, '2026-04-06', '{"care_worker": 1300}', 'approved', $3, now())`,
      [SET, TENANT_A, a.northManager],
    );
    await c.query(
      `INSERT INTO pay_run (id, tenant_id, frequency, period_start, period_end, rule_set_id, nation,
         calculation, status, locked_by, locked_at)
       VALUES ($1, $3, 'monthly', '2026-10-01', '2026-10-31', $4, 'england', 1, 'locked', $5, now()),
              ($2, $3, 'monthly', '2026-11-01', '2026-11-30', $4, 'england', 1, 'draft', NULL, NULL),
              ($6, $3, 'weekly', '2026-10-05', '2026-10-11', $4, 'england', 1, 'locked', $5, now())`,
      [LOCKED, DRAFT, TENANT_A, SET, a.manager, RACED],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("SCHED-008 payroll exports", () => {
  it("keeps the format lists in step", () => {
    expect([...PAYROLL_FORMAT_CODES]).toEqual([...PAYROLL_FORMATS]);
  });

  it("records an export only of a locked run's current calculation", async () => {
    expect(await code(asFinance((c) => exportRow(c, DRAFT)))).toBe("payroll_export_not_locked");
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { calculation: 2 })))).toBe(
      "payroll_export_not_locked",
    );
    const first = await asFinance((c) => exportRow(c, LOCKED));
    expect(first.rows[0]?.reexport).toBe(false);
    // The database says whether it is a re-export, whatever the caller says.
    const second = await asFinance((c) =>
      c.query<{ reexport: boolean }>(
        `INSERT INTO payroll_export (run_id, calculation, format, format_version, line_count,
           content_sha256, outcome, payroll_references, reexport, exported_by)
         VALUES ($1, 1, 'sage_csv', 1, 2, $2, 'generated', '{}', false, app.current_user_id())
         RETURNING reexport`,
        [LOCKED, HASH],
      ),
    );
    expect(second.rows[0]?.reexport).toBe(true);
    expect(
      await code(
        asFinance((c) =>
          c.query("UPDATE payroll_export SET line_count = 9 WHERE run_id = $1", [LOCKED]),
        ),
      ),
    ).toMatch(/permission denied/);
  });

  it("refuses an export in someone else's name, a file with a provider's outcome, and a location's manager", async () => {
    expect(
      await code(
        asFinance((c) =>
          c.query(
            `INSERT INTO payroll_export (run_id, calculation, format, format_version, line_count,
               content_sha256, outcome, payroll_references, exported_by)
             VALUES ($1, 1, 'sage_csv', 1, 2, $2, 'generated', '{}', $3)`,
            [LOCKED, HASH, a.northManager],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { outcome: "pending" })))).toBe(
      "payroll_export_outcome",
    );
    expect(await code(asNorth((c) => exportRow(c, LOCKED)))).toMatch(/row-level security/);
    const seen = await asNorth((c) => c.query("SELECT 1 FROM payroll_export"));
    expect(seen.rowCount).toBe(0);
  });

  it("sends to Xero only while the organisation is connected, once per provider", async () => {
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk" })))).toBe(
      "payroll_export_not_connected",
    );
    // Whatever secret the caller names, the connection holds its own organisation's.
    const made = await asFinance((c) => connect(c));
    const conn = made.rows[0];
    expect(conn?.secret_ref).toBe(`payroll/${conn?.tenant_id}/xero_payroll_uk/${conn?.id}`);
    expect(await code(asFinance((c) => connect(c)))).toMatch(/payroll_connection_live_key/);
    expect(
      await code(
        asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk", outcome: "generated" })),
      ),
    ).toBe("payroll_export_outcome");
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk" })))).toBe(
      "ok",
    );
    const id = conn?.id as string;
    expect(
      await code(
        asFinance((c) =>
          c.query("UPDATE payroll_connection SET secret_ref = 'other-secret' WHERE id = $1", [id]),
        ),
      ),
    ).toBe("payroll_connection_fixed");
    await asFinance((c) =>
      c.query("UPDATE payroll_connection SET status = 'disconnected' WHERE id = $1", [id]),
    );
    expect(
      await code(
        asFinance((c) =>
          c.query("UPDATE payroll_connection SET status = 'connected' WHERE id = $1", [id]),
        ),
      ),
    ).toBe("payroll_connection_disconnected");
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk" })))).toBe(
      "payroll_export_not_connected",
    );
  });

  it("records an API export's result once, and only a known failure stops it counting", async () => {
    await asFinance((c) => connect(c));
    const first = await asFinance(
      async (c) => (await exportRow(c, RACED, { format: "xero_payroll_uk" })).rows[0],
    );
    expect(first?.reexport).toBe(false);
    const file = await asFinance(async (c) => (await exportRow(c, LOCKED)).rows[0]);
    expect(await code(asFinance((c) => result(c, file?.id as string)))).toBe(
      "payroll_export_result_not_pending",
    );
    expect(
      await code(asFinance((c) => result(c, first?.id as string, "failed", "batch-1"))),
    ).toMatch(/payroll_export_result_external_ref/);
    await asFinance((c) => result(c, first?.id as string, "failed"));
    expect(await code(asFinance((c) => result(c, first?.id as string, "sent")))).toMatch(
      /payroll_export_result_export_key/,
    );
    expect(
      await code(asFinance((c) => c.query("UPDATE payroll_export_result SET outcome = 'sent'"))),
    ).toMatch(/permission denied/);
    // The send that failed does not count: the next is not a re-export. One left pending does.
    const second = await asFinance(
      async (c) => (await exportRow(c, RACED, { format: "xero_payroll_uk" })).rows[0],
    );
    expect(second?.reexport).toBe(false);
    const third = await asFinance(
      async (c) => (await exportRow(c, RACED, { format: "xero_payroll_uk" })).rows[0],
    );
    expect(third?.reexport).toBe(true);
    expect((await asNorth((c) => c.query("SELECT 1 FROM payroll_export_result"))).rowCount).toBe(0);
  });

  it("lets only one of two exports at once be the first", async () => {
    await asAdmin(async (c) => {
      await c.query("SET session_replication_role = replica");
      await c.query("UPDATE pay_run SET calculation = 2 WHERE id = $1", [RACED]);
    });
    let firstInserted!: () => void;
    const inserted = new Promise<void>((resolve) => {
      firstInserted = resolve;
    });
    const one = asFinance(async (c) => {
      const row = (await exportRow(c, RACED, { calculation: 2 })).rows[0];
      firstInserted();
      // Hold the transaction open while the other export tries.
      await new Promise((r) => setTimeout(r, 300));
      return row?.reexport;
    });
    await inserted;
    const two = asFinance(
      async (c) => (await exportRow(c, RACED, { calculation: 2 })).rows[0]?.reexport,
    );
    expect(await Promise.all([one, two])).toEqual([false, true]);
  });

  it("keeps a payroll reference unique in the organisation", async () => {
    await asAdmin(async (c) => {
      await c.query("SET session_replication_role = replica");
      await c.query(
        `INSERT INTO pay_profile (tenant_id, member_id, frequency, payroll_reference)
         VALUES ($1, $2, 'monthly', 'W001')`,
        [TENANT_A, a.carer],
      );
    });
    expect(
      await code(
        asAdmin((c) =>
          c.query(
            `INSERT INTO pay_profile (tenant_id, member_id, frequency, payroll_reference)
             VALUES ($1, $2, 'monthly', 'W001')`,
            [TENANT_A, a.northManager],
          ),
        ),
      ),
    ).toMatch(/pay_profile_payroll_reference_key/);
    expect(
      await code(
        asAdmin((c) =>
          c.query("UPDATE pay_profile SET payroll_reference = '=CMD()' WHERE member_id = $1", [
            a.carer,
          ]),
        ),
      ),
    ).toMatch(/pay_profile_payroll_reference/);
    // Never an NI number, never a name: a works number has a digit.
    for (const bad of ["QQ123456C", "ada.example"]) {
      expect(
        await code(
          asAdmin((c) =>
            c.query("UPDATE pay_profile SET payroll_reference = $2 WHERE member_id = $1", [
              a.carer,
              bad,
            ]),
          ),
        ),
      ).toMatch(/pay_profile_payroll_reference/);
    }
  });

  it("keeps exports and connections inside their organisation", async () => {
    const theirs = await asOtherTenant(async (c) => ({
      exports: (await c.query("SELECT 1 FROM payroll_export")).rowCount,
      connections: (await c.query("SELECT 1 FROM payroll_connection")).rowCount,
      results: (await c.query("SELECT 1 FROM payroll_export_result")).rowCount,
    }));
    expect(theirs).toEqual({ exports: 0, connections: 0, results: 0 });
    const columns = await asAdmin((c) =>
      c.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'payroll_connection'",
      ),
    );
    expect(columns.rows.map((r) => r.column_name)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/token/)]),
    );
  });
});
