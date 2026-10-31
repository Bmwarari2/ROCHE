import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * Recommended answers applied 31/10/2026 (migration 0116; review at testing):
 * - H-802: the removal-from-regulated-activity flag is decided with the outcome, and only with an
 *   action short of dismissal.
 * - H-806: a case's retention class is set by the database as it closes, never by a client.
 * - H-804: Thapsus support appoints a case manager to a case whose case managers have all left, on
 *   a ticket raised by a user manager and approved by the data protection lead, without reading
 *   the case.
 * - H-876: "requester not verified" is a decline reason.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwnerRole = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);
const as = <T>(user: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, user, "none"), fn);
/** Thapsus support, in the ticket's organisation, with no member in the session. */
const asOperator = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_operator"), ctx(TENANT_A, null, "none"), fn);

const U = {
  caseworker: "0199f400-0000-7000-8000-000000000301",
  caseworker2: "0199f400-0000-7000-8000-000000000302",
  dpl: "0199f400-0000-7000-8000-000000000303",
  newManager: "0199f400-0000-7000-8000-000000000304",
};
const OPERATOR = "0199f400-0000-7000-8000-000000000901";
const userManager = () => a.manager;

async function openCase(c: pg.PoolClient, type: string, subject: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    "SELECT app.open_employee_case($1, $2, 'A case for the recommended answers', '2026-11-02') AS id",
    [type, subject],
  );
  return rows[0]?.id ?? "";
}
const caseRow = (id: string) =>
  asOwnerRole(async (c) => {
    const { rows } = await c.query<{
      retention_class: string;
      removes_from_regulated_activity: boolean;
    }>("SELECT retention_class, removes_from_regulated_activity FROM employee_case WHERE id = $1", [
      id,
    ]);
    return rows[0];
  });
const raise = (caseId: string, newManager = U.newManager) =>
  as(userManager(), async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO casework_support_ticket (case_id, new_manager_id, reason)
       VALUES ($1, $2, 'The case manager has left the organisation') RETURNING id`,
      [caseId, newManager],
    );
    return rows[0]?.id ?? "";
  });
const approve = (ticket: string, by = U.dpl) =>
  as(
    by,
    async (c) =>
      (
        await c.query(
          "UPDATE casework_support_ticket SET approved_by = $2, approved_at = now() WHERE id = $1",
          [ticket, by],
        )
      ).rowCount,
  );
const appoint = (ticket: string) =>
  asOperator(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "SELECT app.operator_appoint_case_manager($1, $2) AS id",
      [ticket, OPERATOR],
    );
    return rows[0]?.id;
  });

let ORPHAN = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwnerRole(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-ra-cw', 'Cas Example', 'cas.ra@example.invalid', 'active'),
         ($2, 'auth-ra-cw2', 'Col Example', 'col.ra@example.invalid', 'active'),
         ($3, 'auth-ra-dpl', 'Dee Example', 'dee.ra@example.invalid', 'active'),
         ($4, 'auth-ra-new', 'Nia Example', 'nia.ra@example.invalid', 'active')`,
      [U.caseworker, U.caseworker2, U.dpl, U.newManager],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f400-0000-7000-8000-000000000501', 'owner', 'Owner', 'tenant', '{platform.user.manage}'),
         ('0199f400-0000-7000-8000-000000000502', 'employee_relations_lead', 'Caseworker', 'none', '{workforce.casework.manage}'),
         ('0199f400-0000-7000-8000-000000000503', 'dpl', 'Data protection lead', 'tenant', '{platform.dpia.sign}'),
         ('0199f400-0000-7000-8000-000000000504', 'colleague', 'Colleague', 'none', '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES
         ($1, '0199f400-0000-7000-8000-000000000501'),
         ($2, '0199f400-0000-7000-8000-000000000502'),
         ($3, '0199f400-0000-7000-8000-000000000502'),
         ($4, '0199f400-0000-7000-8000-000000000503'),
         ($5, '0199f400-0000-7000-8000-000000000504')`,
      [a.manager, U.caseworker, U.caseworker2, U.dpl, U.newManager],
    );
  });
  ORPHAN = await as(U.caseworker, (c) => openCase(c, "disciplinary", a.carer));
  // The only case manager leaves the organisation.
  await asOwnerRole((c) =>
    c.query("UPDATE tenant_user SET status = 'left' WHERE id = $1", [U.caseworker]),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("H-806 the retention class is set as the case closes", () => {
  it("gives a grievance closed informally the shorter class", async () => {
    const id = await as(U.caseworker2, (c) => openCase(c, "grievance", a.carer));
    await as(U.caseworker2, (c) =>
      c.query(
        `UPDATE employee_case SET stage = 'closed', closed_on = '2026-11-03',
           closed_reason = 'resolved_informally' WHERE id = $1`,
        [id],
      ),
    );
    expect((await caseRow(id))?.retention_class).toBe("casework_no_sanction");
  });

  it("keeps a warning with the staff file, and no client sets the class", async () => {
    const id = await as(U.caseworker2, (c) => openCase(c, "disciplinary", a.carer));
    // A client asking for the shorter class on an open case changes nothing.
    await as(U.caseworker2, (c) =>
      c.query("UPDATE employee_case SET retention_class = 'casework_no_sanction' WHERE id = $1", [
        id,
      ]),
    );
    expect((await caseRow(id))?.retention_class).toBe("staff_file");
    await as(U.caseworker2, async (c) => {
      await c.query(
        "UPDATE employee_case SET stage = 'hearing', stage_since = '2026-11-04' WHERE id = $1",
        [id],
      );
      await c.query(
        `UPDATE employee_case SET stage = 'outcome', outcome = 'first_written_warning',
           outcome_decided_on = '2026-11-05', warning_expires_on = '2027-05-05' WHERE id = $1`,
        [id],
      );
      await c.query(
        `UPDATE employee_case SET stage = 'closed', closed_on = '2026-11-06',
           closed_reason = 'outcome_accepted' WHERE id = $1`,
        [id],
      );
    });
    expect((await caseRow(id))?.retention_class).toBe("staff_file");
  });
});

describe("H-802 removal from regulated activity is decided with the outcome", () => {
  it("is set only with an action short of dismissal, and never changed after", async () => {
    const id = await as(U.caseworker2, (c) => openCase(c, "disciplinary", a.carer));
    await as(U.caseworker2, (c) =>
      c.query(
        "UPDATE employee_case SET stage = 'hearing', stage_since = '2026-11-04' WHERE id = $1",
        [id],
      ),
    );
    await expect(
      as(U.caseworker2, (c) =>
        c.query(
          `UPDATE employee_case SET stage = 'outcome', outcome = 'first_written_warning',
             outcome_decided_on = '2026-11-05', warning_expires_on = '2027-05-05',
             removes_from_regulated_activity = true WHERE id = $1`,
          [id],
        ),
      ),
    ).rejects.toThrow(/employee_case_regulated_activity/);
    await as(U.caseworker2, (c) =>
      c.query(
        `UPDATE employee_case SET stage = 'outcome', outcome = 'action_short_of_dismissal',
           outcome_decided_on = '2026-11-05', removes_from_regulated_activity = true WHERE id = $1`,
        [id],
      ),
    );
    expect((await caseRow(id))?.removes_from_regulated_activity).toBe(true);
    await expect(
      as(U.caseworker2, (c) =>
        c.query("UPDATE employee_case SET removes_from_regulated_activity = false WHERE id = $1", [
          id,
        ]),
      ),
    ).rejects.toThrow(/decided with the outcome/);
  });
});

describe("H-804 Thapsus support appoints a case manager on an approved ticket", () => {
  let ticket = "";

  it("is raised by a user manager, never naming themselves", async () => {
    await expect(raise(ORPHAN, userManager())).rejects.toThrow(/casework_support_ticket_people/);
    await expect(
      as(U.newManager, (c) =>
        c.query(
          `INSERT INTO casework_support_ticket (case_id, new_manager_id, reason)
           VALUES ($1, $2, 'The case manager has left the organisation')`,
          [ORPHAN, U.dpl],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    ticket = await raise(ORPHAN);
    expect(ticket).not.toBe("");
  });

  it("is refused by support until approved", async () => {
    await expect(appoint(ticket)).rejects.toThrow(/ticket_not_approved/);
  });

  it("is approved only by the data protection lead, never the requester", async () => {
    expect(await approve(ticket, userManager())).toBe(0);
    expect(await approve(ticket)).toBe(1);
    // Approved once.
    await expect(approve(ticket)).rejects.toThrow(/approved once/);
  });

  it("appoints the named member, who then reads the case; used once", async () => {
    expect(
      await as(U.newManager, (c) => c.query("SELECT 1 FROM employee_case WHERE id = $1", [ORPHAN])),
    ).toMatchObject({ rowCount: 0 });
    expect(await appoint(ticket)).toBe(ORPHAN);
    expect(
      await as(U.newManager, (c) => c.query("SELECT 1 FROM employee_case WHERE id = $1", [ORPHAN])),
    ).toMatchObject({ rowCount: 1 });
    await expect(appoint(ticket)).rejects.toThrow(/ticket_used/);
  });

  it("refuses a case that still has a case manager employed", async () => {
    const id = await as(U.caseworker2, (c) => openCase(c, "disciplinary", a.carer));
    const second = await raise(id);
    await approve(second);
    await expect(appoint(second)).rejects.toThrow(/case_has_manager/);
  });

  it("is never usable by the application role, and never by a member in the session", async () => {
    await expect(
      as(U.dpl, (c) =>
        c.query("SELECT app.operator_appoint_case_manager($1, $2)", [ticket, OPERATOR]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(U.dpl, (c) =>
        c.query(
          "UPDATE casework_support_ticket SET used_by_operator = $2, used_at = now() WHERE id = $1",
          [ticket, OPERATOR],
        ),
      ),
    ).rejects.toThrow(/used once, only by Thapsus support/);
  });

  it("is read by the requester and the data protection lead, never by a colleague", async () => {
    const count = (user: string) =>
      as(user, async (c) =>
        Number(
          (await c.query<{ n: string }>("SELECT count(*) AS n FROM casework_support_ticket"))
            .rows[0]?.n,
        ),
      );
    expect(await count(userManager())).toBeGreaterThan(0);
    expect(await count(U.dpl)).toBeGreaterThan(0);
    expect(await count(U.newManager)).toBe(0);
  });
});

describe("H-876 decline reasons", () => {
  it("accepts 'requester not verified', and keeps the old reason valid for past requests", async () => {
    const def = await asOwnerRole(async (c) => {
      const { rows } = await c.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
          WHERE conname = 'reference_request_state'`,
      );
      return rows[0]?.def ?? "";
    });
    expect(def).toContain("requester_not_verified");
    expect(def).toContain("no_consent_to_share");
  });
});

describe("H-805 casework for a staff subject access request", () => {
  const dsarLead = "0199f400-0000-7000-8000-000000000305";
  const forRequest = (user: string, requester: string) =>
    as(user, async (c) => {
      const { rows } = await c.query<{ case_id: string; case_manager_id: string | null }>(
        "SELECT case_id, case_manager_id FROM app.casework_for_subject_access($1)",
        [requester],
      );
      return rows;
    });

  beforeAll(async () => {
    await asOwnerRole(async (c) => {
      await c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ($1, 'auth-ra-dsar', 'Dara Example', 'dara.ra@example.invalid', 'active')`,
        [dsarLead],
      );
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ('0199f400-0000-7000-8000-000000000505', 'dsar_lead', 'DSAR lead', 'tenant', '{quality.dsar.manage}')`,
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id)
         VALUES ($1, '0199f400-0000-7000-8000-000000000505')`,
        [dsarLead],
      );
    });
  });

  it("lists the cases about the requester with their case managers still employed, by id", async () => {
    const rows = await forRequest(dsarLead, a.carer);
    expect(rows.length).toBeGreaterThan(0);
    // The orphaned case now has the manager support appointed; others have the second caseworker.
    for (const row of rows) expect([U.newManager, U.caseworker2]).toContain(row.case_manager_id);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(["case_id", "case_manager_id"]);
  });

  it("names nothing for someone with no case", async () => {
    expect(await forRequest(dsarLead, U.dpl)).toEqual([]);
  });

  it("is refused to anyone without the DSAR permission", async () => {
    await expect(forRequest(U.caseworker2, a.carer)).rejects.toThrow(/quality.dsar.manage/);
  });
});
