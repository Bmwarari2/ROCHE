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
 * - exports append-only, with the database deciding whether one is a re-export;
 * - one connected row per provider, holding a secret's name and never a token;
 * - payroll references unique in the organisation.
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
const HASH = "c".repeat(64);

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { message?: string }) => e.message ?? "error",
  );
const exportRow = (c: pg.PoolClient, run: string, over: Record<string, unknown> = {}) =>
  c.query<{ id: string; reexport: boolean }>(
    `INSERT INTO payroll_export (run_id, calculation, format, format_version, line_count,
       content_sha256, outcome, external_ref, exported_by)
     VALUES ($1, $2, $3, 1, 2, $4, $5, $6, app.current_user_id()) RETURNING id, reexport`,
    [
      run,
      over.calculation ?? 1,
      over.format ?? "brightpay_csv",
      HASH,
      over.outcome ?? "generated",
      over.externalRef ?? null,
    ],
  );
const connect = (c: pg.PoolClient, secret = "xero-payroll-tenant-a") =>
  c.query<{ id: string }>(
    `INSERT INTO payroll_connection (provider, external_organisation_id, secret_ref, connected_by)
     VALUES ('xero_payroll_uk', 'xero-org-1', $1, app.current_user_id()) RETURNING id`,
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
              ($2, $3, 'monthly', '2026-11-01', '2026-11-30', $4, 'england', 1, 'draft', NULL, NULL)`,
      [LOCKED, DRAFT, TENANT_A, SET, a.manager],
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
           content_sha256, outcome, reexport, exported_by)
         VALUES ($1, 1, 'sage_csv', 1, 2, $2, 'generated', false, app.current_user_id())
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
               content_sha256, outcome, exported_by)
             VALUES ($1, 1, 'sage_csv', 1, 2, $2, 'generated', $3)`,
            [LOCKED, HASH, a.northManager],
          ),
        ),
      ),
    ).toMatch(/row-level security/);
    expect(await code(asFinance((c) => exportRow(c, LOCKED, { outcome: "sent" })))).toBe(
      "payroll_export_file_outcome",
    );
    expect(await code(asNorth((c) => exportRow(c, LOCKED)))).toMatch(/row-level security/);
    const seen = await asNorth((c) => c.query("SELECT 1 FROM payroll_export"));
    expect(seen.rowCount).toBe(0);
  });

  it("sends to Xero only while the organisation is connected, once per provider", async () => {
    expect(
      await code(
        asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk", outcome: "sent" })),
      ),
    ).toBe("payroll_export_not_connected");
    const made = await asFinance((c) => connect(c));
    expect(await code(asFinance((c) => connect(c, "xero-payroll-second")))).toMatch(
      /payroll_connection_live_key/,
    );
    // A token's shape is not a secret's name.
    expect(await code(asFinance((c) => connect(c, "eyJhbGciOiJIUzI1NiJ9.e30.x")))).toMatch(
      /payroll_connection_secret_ref/,
    );
    expect(
      await code(
        asFinance((c) =>
          exportRow(c, LOCKED, {
            format: "xero_payroll_uk",
            outcome: "sent",
            externalRef: "batch-1",
          }),
        ),
      ),
    ).toBe("ok");
    const id = made.rows[0]?.id as string;
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
    expect(
      await code(
        asFinance((c) => exportRow(c, LOCKED, { format: "xero_payroll_uk", outcome: "sent" })),
      ),
    ).toBe("payroll_export_not_connected");
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
  });

  it("keeps exports and connections inside their organisation", async () => {
    const theirs = await asOtherTenant(async (c) => ({
      exports: (await c.query("SELECT 1 FROM payroll_export")).rowCount,
      connections: (await c.query("SELECT 1 FROM payroll_connection")).rowCount,
    }));
    expect(theirs).toEqual({ exports: 0, connections: 0 });
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
