import {
  ALL_CASE_OUTCOMES,
  APPEAL_OUTCOMES as DOMAIN_APPEAL,
  CASE_CLOSING_REASONS as DOMAIN_CLOSING,
  HEARING_KINDS as DOMAIN_KINDS,
  REFERRAL_NOT_REQUIRED_REASONS as DOMAIN_NOT_REQUIRED,
  CASE_MEMBER_ROLES as DOMAIN_ROLES,
  CASE_STAGES as DOMAIN_STAGES,
  HEARING_STATES as DOMAIN_STATES,
  CASE_TYPES as DOMAIN_TYPES,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPEAL_OUTCOMES,
  CASE_CLOSING_REASONS,
  CASE_MEMBER_ROLES,
  CASE_OUTCOMES,
  CASE_STAGES,
  CASE_TYPES,
  HEARING_KINDS,
  HEARING_STATES,
  REFERRAL_NOT_REQUIRED_REASONS,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Employee relations casework in the database (workforce.md section 2c, rules 15 to 18;
 * WORK-010; migration 0101; ADR-0089): a case and everything on it is read only by the members
 * named on it. The owner, the Registered Manager, the member of staff it is about, a caseworker
 * not named on it and another organisation read nothing. Only a holder of the silo permission
 * opens one; nobody names themselves; the silo permission stays in a role of its own, never in a
 * grant and never with user or role management.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwnerRole = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);

const U = {
  caseworker: "0199f300-0000-7000-8000-000000000301",
  otherCaseworker: "0199f300-0000-7000-8000-000000000302",
  investigator: "0199f300-0000-7000-8000-000000000303",
  chair: "0199f300-0000-7000-8000-000000000304",
  appealChair: "0199f300-0000-7000-8000-000000000305",
};
const ROLE = {
  owner: "0199f300-0000-7000-8000-000000000501",
  manager: "0199f300-0000-7000-8000-000000000502",
  caseworker: "0199f300-0000-7000-8000-000000000503",
  colleague: "0199f300-0000-7000-8000-000000000504",
};
let CASE = "";
const INCIDENT = "0199f300-0000-7000-8000-000000000601";

/** The owner: every wide permission, user and role management included; organisation-wide. */
const asOwner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** The Registered Manager of North House. */
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The member of staff the case is about. */
const asSubject = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const as = <T>(user: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, user, "none"), fn);

const visible = async (c: pg.PoolClient) => {
  const counts: Record<string, number> = {};
  for (const t of [
    "employee_case",
    "employee_case_member",
    "employee_case_hearing",
    "employee_case_event",
  ]) {
    counts[t] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n);
  }
  return counts;
};
const NONE = {
  employee_case: 0,
  employee_case_member: 0,
  employee_case_hearing: 0,
  employee_case_event: 0,
};

/** Whether the member sees the main case, or anything on it. */
const seesCase = (user: string) =>
  as(user, async (c) => {
    let n = 0;
    for (const t of ["employee_case", "employee_case_event"]) {
      const col = t === "employee_case" ? "id" : "case_id";
      n += (await c.query(`SELECT 1 FROM ${t} WHERE ${col} = $1`, [CASE])).rowCount ?? 0;
    }
    return n > 0;
  });

/** Opens a case through the definer, which names the opener its first case manager. */
async function openCase(c: pg.PoolClient, type: string, subject: string): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    "SELECT app.open_employee_case($1, $2, 'Alleged conduct on a night shift', '2026-11-02') AS id",
    [type, subject],
  );
  return rows[0]?.id ?? "";
}

async function addMember(
  c: pg.PoolClient,
  user: string,
  role: string,
  exception: string | null = null,
) {
  await c.query(
    `INSERT INTO employee_case_member (case_id, tenant_user_id, member_role, independence_exception, added_by)
     VALUES ($1, $2, $3, $4, app.current_user_id())`,
    [CASE, user, role, exception],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwnerRole(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-cw', 'Cas Worker', 'cas.worker@example.invalid', 'active'),
         ($2, 'auth-cw2', 'Col Worker', 'col.worker@example.invalid', 'active'),
         ($3, 'auth-inv', 'Ivy Investigator', 'ivy.inv@example.invalid', 'active'),
         ($4, 'auth-chair', 'Cy Chair', 'cy.chair@example.invalid', 'active'),
         ($5, 'auth-appeal', 'Al Appeal', 'al.appeal@example.invalid', 'active')`,
      [U.caseworker, U.otherCaseworker, U.investigator, U.chair, U.appealChair],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'owner', 'Owner', 'tenant',
          '{platform.user.manage,platform.role.manage,platform.grant.manage,workforce.staff_file.read,workforce.staff_file.manage,safety.safeguarding.manage,safety.incident.read,people.person.read}'),
         ($2, 'registered_manager', 'Registered Manager', 'location',
          '{workforce.staff_file.read,safety.incident.read,people.person.read}'),
         ($3, 'employee_relations_lead', 'Caseworker', 'none', '{workforce.casework.manage}'),
         ($4, 'colleague', 'Colleague', 'none', '{workforce.self.read}')`,
      [ROLE.owner, ROLE.manager, ROLE.caseworker, ROLE.colleague],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $5, NULL), ($2, $6, $10), ($3, $7, NULL), ($4, $7, NULL),
         ($8, $9, NULL), ($11, $9, NULL), ($12, $9, NULL)`,
      [
        a.manager,
        a.northManager,
        U.caseworker,
        U.otherCaseworker,
        ROLE.owner,
        ROLE.manager,
        ROLE.caseworker,
        U.investigator,
        ROLE.colleague,
        a.locationNorth,
        U.chair,
        U.appealChair,
      ],
    );
    await c.query(
      `INSERT INTO staff_profile (tenant_user_id, job_title, registration_body, starts_on)
       VALUES ($1, 'Nurse', 'nmc', '2025-01-06')`,
      [a.carer],
    );
  });
  // The caseworker opens a case about the carer and names themselves its case manager.
  CASE = await as(U.caseworker, (c) => openCase(c, "disciplinary", a.carer));
  await as(U.caseworker, (c) => addMember(c, U.investigator, "investigator"));
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("casework codes", () => {
  it("match the domain's", () => {
    expect([...CASE_TYPES]).toEqual([...DOMAIN_TYPES]);
    expect([...CASE_STAGES]).toEqual([...DOMAIN_STAGES]);
    expect([...CASE_MEMBER_ROLES]).toEqual([...DOMAIN_ROLES]);
    expect([...CASE_OUTCOMES].sort()).toEqual([...ALL_CASE_OUTCOMES].sort());
    expect([...APPEAL_OUTCOMES]).toEqual([...DOMAIN_APPEAL]);
    expect([...CASE_CLOSING_REASONS]).toEqual([...DOMAIN_CLOSING]);
    expect([...HEARING_KINDS]).toEqual([...DOMAIN_KINDS]);
    expect([...HEARING_STATES]).toEqual([...DOMAIN_STATES]);
    expect([...REFERRAL_NOT_REQUIRED_REASONS]).toEqual([...DOMAIN_NOT_REQUIRED]);
  });
});

describe("only the case's members read it (ADR-0089)", () => {
  it("lets the case manager and the investigator read the case, its members and timeline", async () => {
    for (const user of [U.caseworker, U.investigator]) {
      expect(await as(user, visible)).toEqual({
        employee_case: 1,
        employee_case_member: 2,
        employee_case_hearing: 0,
        employee_case_event: 1,
      });
    }
    const row = await as(U.caseworker, (c) =>
      c.query("SELECT subject_registered FROM employee_case WHERE id = $1", [CASE]),
    );
    expect(row.rows[0]?.subject_registered).toBe(true);
  });

  it("shows nothing to the owner, though they hold every other permission", async () => {
    expect(await asOwner(visible)).toEqual(NONE);
  });

  it("shows nothing to the Registered Manager", async () => {
    expect(await asManager(visible)).toEqual(NONE);
  });

  it("shows nothing to the member of staff it is about, or to a caseworker not named on it", async () => {
    expect(await asSubject(visible)).toEqual(NONE);
    expect(await as(U.otherCaseworker, visible)).toEqual(NONE);
    expect(await as(U.chair, visible)).toEqual(NONE);
  });

  it("shows nothing to another organisation, even its owner", async () => {
    expect(await inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), visible)).toEqual(NONE);
  });

  it("shows nothing to break-glass", async () => {
    const breakGlass = ctx(TENANT_A, a.manager, "tenant", [], { includesBreakGlass: true });
    expect(await inContext(app(), breakGlass, visible)).toEqual(NONE);
  });

  it("refuses the owner's changes to a case they cannot see", async () => {
    const changed = await asOwner((c) =>
      c.query("UPDATE employee_case SET summary = 'Changed' WHERE id = $1", [CASE]),
    );
    expect(changed.rowCount).toBe(0);
  });
});

describe("opening a case and naming its members", () => {
  it("lets only a holder of the silo permission open one", async () => {
    await expect(asOwner((c) => openCase(c, "grievance", a.carer))).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("never lets a caseworker open a case about themselves", async () => {
    await expect(
      as(U.caseworker, (c) => openCase(c, "grievance", U.caseworker)),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("never lets the application insert a case, or its opening, directly", async () => {
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          `INSERT INTO employee_case (case_type, subject_tenant_user_id, summary, opened_on, stage_since)
           VALUES ('grievance', $1, 'A grievance', '2026-11-02', '2026-11-02')`,
          [a.carer],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          `INSERT INTO employee_case_event (case_id, kind, to_stage, occurred_on)
           VALUES ($1, 'opened', 'open', '2026-11-03')`,
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("counts a part someone was removed from: a removed investigator never chairs unexcepted", async () => {
    const other = await as(U.otherCaseworker, (c) => openCase(c, "capability", a.carer));
    await as(U.otherCaseworker, (c) =>
      c.query(
        `INSERT INTO employee_case_member (case_id, tenant_user_id, member_role, added_by)
         VALUES ($1, $2, 'investigator', app.current_user_id())`,
        [other, U.appealChair],
      ),
    );
    await as(U.otherCaseworker, (c) =>
      c.query(
        `UPDATE employee_case_member SET removed_at = now(), removed_by = app.current_user_id()
          WHERE case_id = $1 AND tenant_user_id = $2`,
        [other, U.appealChair],
      ),
    );
    await expect(
      as(U.otherCaseworker, (c) =>
        c.query(
          `INSERT INTO employee_case_member (case_id, tenant_user_id, member_role, added_by)
           VALUES ($1, $2, 'hearing_chair', app.current_user_id())`,
          [other, U.appealChair],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("never names the member of staff the case is about", async () => {
    await expect(
      as(U.caseworker, (c) => addMember(c, a.carer, "note_taker")),
    ).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("never lets a member name themselves, nor anyone but a case manager name others", async () => {
    await expect(
      as(U.investigator, (c) => addMember(c, U.investigator, "note_taker")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(U.investigator, (c) => addMember(c, U.chair, "hearing_chair")),
    ).rejects.toMatchObject({
      code: "42501",
    });
    await expect(
      as(U.otherCaseworker, (c) => addMember(c, U.otherCaseworker, "case_manager")),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("keeps the investigator from chairing the hearing unless the exception is recorded", async () => {
    await expect(
      as(U.caseworker, (c) => addMember(c, U.investigator, "hearing_chair")),
    ).rejects.toMatchObject({
      code: "23514",
    });
    await as(U.caseworker, (c) => addMember(c, U.chair, "hearing_chair"));
    await as(U.caseworker, (c) => addMember(c, U.appealChair, "appeal_chair"));
    expect((await as(U.chair, visible)).employee_case).toBe(1);
  });

  it("removes a member, who then reads nothing, and keeps the last case manager", async () => {
    await as(U.caseworker, (c) => addMember(c, U.otherCaseworker, "note_taker"));
    expect(await seesCase(U.otherCaseworker)).toBe(true);
    await as(U.caseworker, (c) =>
      c.query(
        `UPDATE employee_case_member SET removed_at = now(), removed_by = app.current_user_id()
          WHERE case_id = $1 AND tenant_user_id = $2`,
        [CASE, U.otherCaseworker],
      ),
    );
    expect(await seesCase(U.otherCaseworker)).toBe(false);
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          `UPDATE employee_case_member SET removed_at = now(), removed_by = app.current_user_id()
            WHERE case_id = $1 AND member_role = 'case_manager'`,
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("the case's rules in the database", () => {
  it("arranges a hearing only led by the member in the matching role", async () => {
    await as(U.caseworker, (c) =>
      c.query(
        "UPDATE employee_case SET stage = 'hearing', stage_since = '2026-11-03' WHERE id = $1",
        [CASE],
      ),
    );
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          `INSERT INTO employee_case_hearing (case_id, kind, led_by, invited_on, scheduled_at, issue_set_out, evidence_shared, companion_right_given)
           VALUES ($1, 'hearing', $2, '2026-11-03', '2026-11-10T10:00:00Z', true, true, true)`,
          [CASE, U.investigator],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await as(U.caseworker, (c) =>
      c.query(
        `INSERT INTO employee_case_hearing (case_id, kind, led_by, invited_on, scheduled_at, issue_set_out, evidence_shared, companion_right_given)
         VALUES ($1, 'hearing', $2, '2026-11-03', '2026-11-10T10:00:00Z', true, true, true)`,
        [CASE, U.chair],
      ),
    );
    await as(U.chair, (c) =>
      c.query(
        "UPDATE employee_case_hearing SET state = 'held', held_on = '2026-11-10', accompanied = true WHERE case_id = $1",
        [CASE],
      ),
    );
    await expect(
      as(U.chair, (c) =>
        c.query(
          "UPDATE employee_case_hearing SET state = 'cancelled', held_on = NULL, accompanied = NULL WHERE case_id = $1",
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("moves only forward, and keeps a decided outcome", async () => {
    await expect(
      as(U.caseworker, (c) =>
        c.query("UPDATE employee_case SET stage = 'investigation' WHERE id = $1", [CASE]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await as(U.chair, (c) =>
      c.query(
        `UPDATE employee_case SET stage = 'outcome', stage_since = '2026-11-11', outcome = 'final_written_warning',
            outcome_decided_on = '2026-11-11', warning_expires_on = '2027-11-11' WHERE id = $1`,
        [CASE],
      ),
    );
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          "UPDATE employee_case SET outcome = 'no_action', warning_expires_on = NULL WHERE id = $1",
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("lets a chair record only their own decision", async () => {
    await expect(
      as(U.chair, (c) =>
        c.query(
          "UPDATE employee_case SET dbs_referral = 'not_required', dbs_referral_reason = 'harm_test_not_met' WHERE id = $1",
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("links only a safeguarding concern the member can see, refusing an unknown one alike", async () => {
    await expect(
      as(U.caseworker, (c) =>
        c.query("UPDATE employee_case SET safeguarding_incident_id = $2 WHERE id = $1", [
          CASE,
          INCIDENT,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("closes once, and never changes after; the timeline is never changed or deleted", async () => {
    await as(U.caseworker, async (c) => {
      await c.query(
        `UPDATE employee_case SET stage = 'closed', closed_on = '2026-11-20', closed_reason = 'outcome_accepted',
            regulator_referral = 'not_required', regulator_referral_reason = 'harm_test_not_met' WHERE id = $1`,
        [CASE],
      );
      await c.query(
        `INSERT INTO employee_case_event (case_id, kind, from_stage, to_stage, occurred_on)
         VALUES ($1, 'stage_changed', 'outcome', 'closed', '2026-11-20')`,
        [CASE],
      );
    });
    await expect(
      as(U.caseworker, (c) =>
        c.query("UPDATE employee_case SET summary = 'Again' WHERE id = $1", [CASE]),
      ),
    ).rejects.toMatchObject({ code: "23000" });
    await expect(
      as(U.caseworker, (c) =>
        c.query(
          `INSERT INTO employee_case_event (case_id, kind, occurred_on, body) VALUES ($1, 'note', '2026-11-21', 'Late')`,
          [CASE],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(U.caseworker, (c) => c.query("UPDATE employee_case_event SET occurred_on = '2026-11-01'")),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      as(U.caseworker, (c) => c.query("DELETE FROM employee_case")),
    ).rejects.toMatchObject({
      code: "42501",
    });
  });
});

describe("the silo guards (ADR-0089)", () => {
  it("refuses a role mixing the silo permission with any other", async () => {
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query(
          `INSERT INTO role (key, name, scope_kind, permissions)
           VALUES ('hr_plus', 'HR plus', 'none', '{workforce.casework.manage,workforce.staff_file.read}')`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query(
          "UPDATE role SET permissions = permissions || '{workforce.casework.manage}' WHERE id = $1",
          [ROLE.owner],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("never turns a role already held into a silo role, nor gives a caseworker's role user management", async () => {
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query("UPDATE role SET permissions = '{workforce.casework.manage}' WHERE id = $1", [
          ROLE.colleague,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // The colleague role is held by the investigator; a caseworker also holding it would gain user
    // management by an edit of it.
    await asOwnerRole(TENANT_A, (c) =>
      c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
        U.otherCaseworker,
        ROLE.colleague,
      ]),
    );
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query(
          "UPDATE role SET permissions = '{workforce.self.read,platform.user.manage}' WHERE id = $1",
          [ROLE.colleague],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses an access grant carrying it", async () => {
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query(
          `INSERT INTO access_grant (tenant_user_id, permissions, valid_to, reason, granted_by)
           VALUES ($1, '{workforce.casework.manage}', now() + interval '1 day', 'Cover', $2)`,
          [a.northManager, a.manager],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses self-appointment, and holding it with user or role management", async () => {
    await expect(
      inContext(db.pool("harbour_owner"), ctx(TENANT_A, a.northManager, "tenant"), (c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          a.northManager,
          ROLE.caseworker,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // The owner manages users: never also a caseworker.
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          a.manager,
          ROLE.caseworker,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // And a caseworker never also manages users.
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
          U.caseworker,
          ROLE.owner,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
