import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Data security evidence in the database (QUAL-012; quality.md section 18; migration 0094; hazard
 * HZ-011): read and written only with quality.dsar.manage held across the organisation, never by a
 * manager for one home or across organisations; read by the system for renewal tasks; evidence
 * links append-only; checks on years, references, statuses and dates; one submission per year.
 */

let db: TestDatabase;
const a = ids.a;
const ROLE_DPO = "0199f000-0000-7000-8000-000000000b01";
const ROLE_HOME = "0199f000-0000-7000-8000-000000000b02";
const HASH = "a".repeat(64);
let orgDocument = "";
const app = () => db.pool("harbour_app");
const asMember =
  (userId: string | null, tenant = TENANT_A, scope: "tenant" | "locations" = "tenant") =>
  <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(
      app(),
      ctx(tenant, userId, scope, scope === "locations" ? [a.locationNorth] : []),
      fn,
    );
const asDpo = asMember(a.manager);
const asHomeManager = asMember(a.northManager, TENANT_A, "locations");
const asSystem = asMember(null);
const asOther = asMember(ids.b.manager, TENANT_B);
const ownerDb = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const ASSERTION =
  "INSERT INTO dspt_assertion (financial_year, assertion_ref, title) VALUES ('2025/26', '1.1.1', 'Staff know their responsibilities') RETURNING id";
const CERTIFICATE =
  "INSERT INTO security_certificate (kind, reference, issued_on) VALUES ('cyber_essentials', 'CE-1234', '2026-01-10') RETURNING id";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await ownerDb(async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'dpo', 'Data protection lead', 'tenant', '{quality.dsar.manage}'),
         ($2, 'home_manager', 'Home manager', 'location', '{quality.dsar.manage}')`,
      [ROLE_DPO, ROLE_HOME],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      a.manager,
      ROLE_DPO,
    ]);
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.northManager, ROLE_HOME, a.locationNorth],
    );
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes, sha256)
       VALUES ('organisation_document', 'Information security policy', 'organisation_document', 'ds1', 'application/pdf', 10, $1)
       RETURNING id`,
      [HASH],
    );
    orgDocument = rows[0]?.id ?? "";
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 data security evidence (migration 0094)", () => {
  it("is recorded and read with quality.dsar.manage across the organisation, and versioned", async () => {
    const { rows } = await asDpo((c) => c.query<{ id: string }>(ASSERTION));
    const id = rows[0]?.id;
    await asDpo((c) =>
      c.query("UPDATE dspt_assertion SET status = 'in_progress' WHERE id = $1", [id]),
    );
    const after = await asDpo((c) =>
      c.query("SELECT version, created_by FROM dspt_assertion WHERE id = $1", [id]),
    );
    expect(after.rows).toEqual([{ version: 2, created_by: a.manager }]);
    await asDpo((c) => c.query(CERTIFICATE));
    await expect(asDpo((c) => c.query("DELETE FROM security_certificate"))).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asDpo((c) => c.query("UPDATE dspt_assertion SET deleted_at = now() WHERE id = $1", [id])),
    ).rejects.toThrow(/data_security_fixed_fields/);
  });

  it("shows a manager for one home, another organisation and a member without it nothing, and lets the system read for renewals", async () => {
    for (const table of [
      "dspt_assertion",
      "dspt_evidence",
      "dspt_submission",
      "security_certificate",
    ]) {
      expect((await asHomeManager((c) => c.query(`SELECT id FROM ${table}`))).rowCount).toBe(0);
      expect((await asOther((c) => c.query(`SELECT id FROM ${table}`))).rowCount).toBe(0);
      // The owner role is bound too (ADR-0002): acting for a member without the permission.
      expect(
        (
          await inContext(db.pool("harbour_owner"), ctx(TENANT_A, a.carer, "tenant"), (c) =>
            c.query(`SELECT id FROM ${table}`),
          )
        ).rowCount,
      ).toBe(0);
    }
    expect(
      (await asSystem((c) => c.query("SELECT id FROM security_certificate"))).rowCount,
    ).toBeGreaterThan(0);
    // The system reads; it never writes the evidence.
    await expect(asSystem((c) => c.query(CERTIFICATE))).rejects.toThrow(/row-level security/);
    await expect(asHomeManager((c) => c.query(CERTIFICATE))).rejects.toThrow(/row-level security/);
    await expect(
      asOther((c) =>
        c.query(
          "INSERT INTO security_certificate (tenant_id, kind, reference, issued_on) VALUES ($1, 'ico_registration', 'Z1', '2026-01-01')",
          [TENANT_A],
        ),
      ),
    ).rejects.toThrow(/row-level security|violates/);
  });

  it("keeps evidence links append-only, in one's own name, to this organisation's documents", async () => {
    const { rows } = await asDpo((c) =>
      c.query<{ id: string }>(
        "INSERT INTO dspt_assertion (financial_year, assertion_ref, title) VALUES ('2025/26', '1.2.1', 'Data security training') RETURNING id",
      ),
    );
    const assertion = rows[0]?.id;
    await asDpo((c) =>
      c.query(
        "INSERT INTO dspt_evidence (assertion_id, document_id, kind) VALUES ($1, $2, 'linked')",
        [assertion, orgDocument],
      ),
    );
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO dspt_evidence (assertion_id, document_id, kind, recorded_by) VALUES ($1, $2, 'linked', $3)",
          [assertion, orgDocument, a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asDpo((c) => c.query("UPDATE dspt_evidence SET kind = 'unlinked'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      inContext(db.pool("harbour_owner"), ctx(TENANT_A, a.manager, "tenant"), (c) =>
        c.query("DELETE FROM dspt_evidence"),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("checks years, references, statuses, dates and one submission per year", async () => {
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO dspt_assertion (financial_year, assertion_ref, title) VALUES ('2025', '1.1.9', 'Bad year')",
        ),
      ),
    ).rejects.toThrow(/dspt_assertion_year/);
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO dspt_assertion (financial_year, assertion_ref, title, status) VALUES ('2025/26', '1.3.1', 'Not met without notes', 'not_met')",
        ),
      ),
    ).rejects.toThrow(/dspt_assertion_text/);
    await expect(
      asDpo((c) =>
        c.query(
          "INSERT INTO security_certificate (kind, reference, issued_on, expires_on) VALUES ('cyber_essentials_plus', 'CEP-1', '2026-02-01', '2026-01-01')",
        ),
      ),
    ).rejects.toThrow(/security_certificate_dates/);
    const submit =
      "INSERT INTO dspt_submission (financial_year, submitted_on, outcome) VALUES ('2025/26', '2026-06-20', 'standards_met')";
    await asDpo((c) => c.query(submit));
    await expect(asDpo((c) => c.query(submit))).rejects.toThrow(/dspt_submission_year_key/);
  });
});
