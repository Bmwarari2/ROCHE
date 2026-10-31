import {
  VETTING_CHECK_KINDS as DOMAIN_KINDS,
  VETTING_CONSENT_PURPOSES as DOMAIN_PURPOSES,
  EVIDENCE_SOURCES as DOMAIN_SOURCES,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EVIDENCE_SOURCES, VETTING_CHECK_KINDS, VETTING_CONSENT_PURPOSES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Identity and vetting adapters in the database (workforce.md section 2e and rule 24; ADR-0094;
 * migration 0120): another organisation's consents and checks never seen or written; the worker
 * reads their own and writes none; consents and checks in the writer's own name; one consent in
 * force per purpose, withdrawn once; a DBS check only with its consent in force; a check moves
 * forward only and is applied once; a compliance item names a check as its source only once that
 * check is applied by its writer; nothing deleted.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR (a role with no person scope): read and manage. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** A second HR member. */
const HR2 = "0199f500-0000-7000-8000-000000000310";
const asHr2 = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, HR2, "none"), fn);
/** The care worker, with workforce.self.read only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const CARER_FILE = "0199f500-0000-7000-8000-0000000000a1";
const HR2_FILE = "0199f500-0000-7000-8000-0000000000a2";

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? "error";
  }
};
const count = async (c: pg.PoolClient, sql: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]?.n);

const recordConsent = (
  c: pg.PoolClient,
  purpose: string,
  by: string,
  profile = CARER_FILE,
  givenOn = "2026-10-01",
) =>
  c
    .query<{ id: string }>(
      `INSERT INTO vetting_consent (staff_profile_id, purpose, given_on, recorded_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [profile, purpose, givenOn, by],
    )
    .then((r) => r.rows[0]?.id ?? "");

const startCheck = (
  c: pg.PoolClient,
  kind: string,
  by: string,
  consent: string | null = null,
  checked: object = {},
  profile = CARER_FILE,
) =>
  c
    .query<{ id: string }>(
      `INSERT INTO vetting_check (staff_profile_id, kind, provider, consent_id, requested_by, checked)
       VALUES ($1, $2, 'mock', $3, $4, $5::jsonb) RETURNING id`,
      [profile, kind, consent, by, JSON.stringify(checked)],
    )
    .then((r) => r.rows[0]?.id ?? "");

const complete = (c: pg.PoolClient, id: string, result: object) =>
  c.query(
    `UPDATE vetting_check SET state = 'completed', result = $2::jsonb, completed_at = now(),
       external_reference = 'mock-ref' WHERE id = $1`,
    [id, JSON.stringify(result)],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
       VALUES ($1, 'auth-vet-hr2', 'Hari Example', 'hari.vet@example.invalid', 'active')`,
      [HR2],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f500-0000-7000-8000-000000000501', 'hr', 'HR', 'none',
          '{workforce.staff_file.read,workforce.staff_file.manage}'),
         ('0199f500-0000-7000-8000-000000000503', 'self', 'Self', 'assigned', '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES
         ($1, '0199f500-0000-7000-8000-000000000501'),
         ($2, '0199f500-0000-7000-8000-000000000501'),
         ($3, '0199f500-0000-7000-8000-000000000503')`,
      [a.manager, HR2, a.carer],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f500-0000-7000-8000-000000000504', 'hr', 'HR', 'none',
          '{workforce.staff_file.read,workforce.staff_file.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199f500-0000-7000-8000-000000000504')`,
      [b.manager],
    );
  });
  await asHr(async (c) => {
    await c.query(
      `INSERT INTO staff_profile (id, tenant_user_id, job_title, date_of_birth) VALUES
         ($1, $2, 'Care worker', '1990-04-01'), ($3, $4, 'HR adviser', '1985-02-01')`,
      [CARER_FILE, a.carer, HR2_FILE, HR2],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("the database's lists match the domain's", () => {
  it("kinds, sources and purposes", () => {
    expect([...VETTING_CHECK_KINDS]).toEqual([...DOMAIN_KINDS]);
    expect([...EVIDENCE_SOURCES]).toEqual([...DOMAIN_SOURCES]);
    expect([...VETTING_CONSENT_PURPOSES]).toEqual([...DOMAIN_PURPOSES]);
  });
});

describe("consents", () => {
  it("are recorded by HR in their own name, never by the worker or in another's name", async () => {
    expect(await code(() => asHr((c) => recordConsent(c, "dbs_update_service", HR2)))).toBe(
      "42501",
    );
    expect(await code(() => asCarer((c) => recordConsent(c, "dbs_update_service", a.carer)))).toBe(
      "42501",
    );
    // HR never records consents on their own file.
    expect(
      await code(() => asHr2((c) => recordConsent(c, "dbs_update_service", HR2, HR2_FILE))),
    ).toBe("42501");
    expect(await code(() => asHr((c) => recordConsent(c, "dbs_update_service", a.manager)))).toBe(
      "ok",
    );
  });

  it("one in force per purpose; withdrawn once, in the withdrawer's name; never deleted", async () => {
    expect(await code(() => asHr((c) => recordConsent(c, "dbs_update_service", a.manager)))).toBe(
      "23505",
    );
    const id = await asHr(
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM vetting_consent WHERE purpose = 'dbs_update_service' AND withdrawn_on IS NULL",
          )
        ).rows[0]?.id,
    );
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            "UPDATE vetting_consent SET withdrawn_on = '2026-10-20', withdrawn_by = $2 WHERE id = $1",
            [id, HR2],
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      await code(() =>
        asHr((c) =>
          c.query("UPDATE vetting_consent SET given_on = '2026-09-01' WHERE id = $1", [id]),
        ),
      ),
    ).toBe("23000");
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            "UPDATE vetting_consent SET withdrawn_on = '2026-10-20', withdrawn_by = $2 WHERE id = $1",
            [id, a.manager],
          ),
        ),
      ),
    ).toBe("ok");
    expect(
      await code(() =>
        asHr2((c) =>
          c.query(
            "UPDATE vetting_consent SET withdrawn_on = '2026-10-21', withdrawn_by = $2 WHERE id = $1",
            [id, HR2],
          ),
        ),
      ),
    ).toBe("23000");
    expect(
      await code(() => asHr((c) => c.query("DELETE FROM vetting_consent WHERE id = $1", [id]))),
    ).not.toBe("ok");
    // A new consent after the withdrawal is a new row.
    expect(await code(() => asHr((c) => recordConsent(c, "dbs_update_service", a.manager)))).toBe(
      "ok",
    );
  });
});

describe("checks", () => {
  it("a DBS check needs its consent in force, for its purpose and file", async () => {
    const appConsent = await asHr((c) => recordConsent(c, "dbs_application", a.manager));
    // A consent dated after today is not in force.
    const future = await asHr((c) =>
      recordConsent(c, "dbs_application", a.manager, HR2_FILE, "2099-01-01"),
    );
    expect(
      await code(() =>
        asHr((c) => startCheck(c, "dbs_application", a.manager, future, {}, HR2_FILE)),
      ),
    ).toBe("23514");
    // Without a consent, the CHECK refuses.
    expect(await code(() => asHr((c) => startCheck(c, "dbs_application", a.manager)))).toBe(
      "23514",
    );
    // The consent for status checks is not consent to an application.
    const statusConsent = await asHr(
      async (c) =>
        (
          await c.query<{ id: string }>(
            "SELECT id FROM vetting_consent WHERE purpose = 'dbs_update_service' AND withdrawn_on IS NULL",
          )
        ).rows[0]?.id ?? "",
    );
    expect(
      await code(() => asHr((c) => startCheck(c, "dbs_application", a.manager, statusConsent))),
    ).toBe("23514");
    expect(
      await code(() => asHr((c) => startCheck(c, "dbs_application", a.manager, appConsent))),
    ).toBe("ok");
  });

  it("are requested in the requester's own name, never by the worker or another organisation", async () => {
    expect(await code(() => asHr((c) => startCheck(c, "nmc_register_check", HR2)))).toBe("42501");
    expect(await code(() => asCarer((c) => startCheck(c, "nmc_register_check", a.carer)))).toBe(
      "42501",
    );
    expect(
      await code(() => asOtherTenant((c) => startCheck(c, "nmc_register_check", b.manager))),
    ).not.toBe("ok");
    expect(
      await code(() =>
        asHr((c) => startCheck(c, "nmc_register_check", a.manager, null, { pin: "99A9999E" })),
      ),
    ).toBe("ok");
    // One pending check of a kind per file.
    expect(
      await code(() =>
        asHr((c) => startCheck(c, "nmc_register_check", a.manager, null, { pin: "99A9999E" })),
      ),
    ).toBe("23505");
  });

  it("move forward only, keep what they checked, and are applied once in the applier's name", async () => {
    const id = await asHr(async (c) => {
      const check = await startCheck(c, "idsp_right_to_work", a.manager, null, {
        document: "british_passport",
      });
      await complete(c, check, {
        outcome: "identity_verified",
        checkedOn: "2026-10-30",
        document: "british_passport",
      });
      return check;
    });
    expect(
      await code(() =>
        asHr((c) => c.query("UPDATE vetting_check SET checked = '{}'::jsonb WHERE id = $1", [id])),
      ),
    ).toBe("23000");
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            "UPDATE vetting_check SET state = 'pending', result = NULL, completed_at = NULL WHERE id = $1",
            [id],
          ),
        ),
      ),
    ).toBe("23000");
    expect(
      await code(() =>
        asHr((c) =>
          c.query("UPDATE vetting_check SET applied_at = now(), applied_by = $2 WHERE id = $1", [
            id,
            HR2,
          ]),
        ),
      ),
    ).toBe("42501");
    expect(
      await code(() =>
        asCarer((c) =>
          c.query("UPDATE vetting_check SET applied_at = now(), applied_by = $2 WHERE id = $1", [
            id,
            a.carer,
          ]),
        ),
      ),
    ).toBe("ok"); // the worker's update matches no row it may write
    expect(
      await asOwner(TENANT_A, async (c) =>
        count(
          c,
          "SELECT count(*) AS n FROM vetting_check WHERE id = $1 AND applied_at IS NOT NULL",
          [id],
        ),
      ),
    ).toBe(0);
    // Not applied: the item cannot name it as its source.
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            `INSERT INTO compliance_item (staff_profile_id, kind, detail, verified_on, verified_by,
               evidence_source, vetting_check_id)
             VALUES ($1, 'right_to_work', $2::jsonb, '2026-10-30', $3, 'idsp_right_to_work', $4)`,
            [CARER_FILE, JSON.stringify({ kind: "right_to_work", checks: [] }), a.manager, id],
          ),
        ),
      ),
    ).toBe("42501");
    expect(
      await code(() =>
        asHr(async (c) => {
          await c.query(
            "UPDATE vetting_check SET applied_at = now(), applied_by = $2 WHERE id = $1",
            [id, a.manager],
          );
          // A source of the wrong kind for the item is refused (in a savepoint, so the
          // application above is kept).
          await c.query("SAVEPOINT wrong_kind");
          const wrong = await code(() =>
            c.query(
              `INSERT INTO compliance_item (staff_profile_id, kind, detail, evidence_source, vetting_check_id)
               VALUES ($1, 'dbs_certificate', $2::jsonb, 'idsp_right_to_work', $3)`,
              [
                CARER_FILE,
                JSON.stringify({
                  kind: "dbs_certificate",
                  certificate: null,
                  updateService: null,
                  barredListClearOn: null,
                }),
                id,
              ],
            ),
          );
          await c.query("ROLLBACK TO SAVEPOINT wrong_kind");
          if (wrong !== "42501") throw new Error(`wrong kind: ${wrong}`);
        }),
      ),
    ).toBe("ok");
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            `INSERT INTO compliance_item (staff_profile_id, kind, detail, verified_on, verified_by,
               evidence_source, vetting_check_id)
             VALUES ($1, 'right_to_work', $2::jsonb, '2026-10-30', $3, 'idsp_right_to_work', $4)`,
            [
              CARER_FILE,
              JSON.stringify({
                kind: "right_to_work",
                checks: [
                  {
                    method: "idsp",
                    checkedOn: "2026-10-30",
                    permission: "unlimited",
                    expiresOn: null,
                  },
                ],
              }),
              a.manager,
              id,
            ],
          ),
        ),
      ),
    ).toBe("ok");
    // Applied once.
    expect(
      await code(() =>
        asHr2((c) =>
          c.query("UPDATE vetting_check SET applied_at = now(), applied_by = $2 WHERE id = $1", [
            id,
            HR2,
          ]),
        ),
      ),
    ).toBe("23000");
    // A source and its check go together.
    expect(
      await code(() =>
        asHr((c) =>
          c.query(
            "UPDATE compliance_item SET evidence_source = 'idsp_right_to_work', vetting_check_id = NULL WHERE kind = 'right_to_work'",
          ),
        ),
      ),
    ).toBe("23514");
    expect(
      await code(() => asHr((c) => c.query("DELETE FROM vetting_check WHERE id = $1", [id]))),
    ).not.toBe("ok");
  });
});

describe("reading", () => {
  it("HR read every file's; the worker reads their own; another organisation reads none", async () => {
    const all = await asHr((c) => count(c, "SELECT count(*) AS n FROM vetting_check"));
    expect(all).toBeGreaterThan(0);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM vetting_check"))).toBe(all);
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM vetting_consent"))).toBe(
      await asHr((c) =>
        count(c, "SELECT count(*) AS n FROM vetting_consent WHERE staff_profile_id = $1", [
          CARER_FILE,
        ]),
      ),
    );
    expect(await asOtherTenant((c) => count(c, "SELECT count(*) AS n FROM vetting_check"))).toBe(0);
    expect(await asOtherTenant((c) => count(c, "SELECT count(*) AS n FROM vetting_consent"))).toBe(
      0,
    );
  });
});
