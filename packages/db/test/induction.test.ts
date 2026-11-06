import {
  EXIT_INTERVIEW_STATES as DOMAIN_EXIT,
  PROBATION_OUTCOMES as DOMAIN_PROBATION,
  LEAVING_REASONS as DOMAIN_REASONS,
  CARE_CERTIFICATE_STANDARD_IDS as DOMAIN_STANDARDS,
  TICKED_INDUCTION_ITEMS,
  TICKED_LEAVER_ITEMS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CARE_CERTIFICATE_STANDARD_IDS,
  EXIT_INTERVIEW_STATES,
  INDUCTION_TICKED_ITEMS,
  LEAVER_TICKED_ITEMS,
  LEAVING_REASONS,
  PROBATION_OUTCOMES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Induction, the Care Certificate and leavers in the database (workforce.md section 2e, rules 19
 * to 23; WORK-004, WORK-013; migration 0091): another organisation reads and writes nothing;
 * rows follow the staff file (HR reads and writes, the worker reads their own and writes
 * nothing); an assessor with workforce.competence.observe reads and signs the Care Certificate,
 * never their own, and nothing else; everything in the actor's own name; ended access stays
 * ended; read-and-sign counted for HR without reading anyone's signatures.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwnerRole = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR: the staff file permissions, organisation-wide. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** An assessor at North House: workforce.competence.observe only. */
const asAssessor = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The new starter. */
const asWorker = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);

const PROFILE = "0199f400-0000-7000-8000-000000000001";
const HR_PROFILE = "0199f400-0000-7000-8000-000000000002";
const POLICY = "0199f400-0000-7000-8000-0000000000a1";
const POLICY_V1 = "0199f400-0000-7000-8000-0000000000b1";
const TABLES = [
  "induction_plan",
  "staff_checklist_item",
  "shadow_shift",
  "probation_review",
  "care_certificate_progress",
  "leaver_record",
  "reference_request",
];

const counts = async (c: pg.PoolClient) => {
  const out: Record<string, number> = {};
  for (const t of TABLES) {
    out[t] = Number((await c.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]?.n);
  }
  return out;
};

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwnerRole(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f400-0000-7000-8000-000000000501', 'hr', 'HR', 'tenant',
          '{workforce.staff_file.read,workforce.staff_file.manage,quality.policy.manage}'),
         ('0199f400-0000-7000-8000-000000000502', 'team_leader', 'Team leader', 'location',
          '{workforce.competence.observe}'),
         ('0199f400-0000-7000-8000-000000000503', 'self', 'Staff', 'tenant', '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f400-0000-7000-8000-000000000501', NULL),
         ($2, '0199f400-0000-7000-8000-000000000502', $3),
         ($4, $5, $3),
         ($4, '0199f400-0000-7000-8000-000000000503', NULL)`,
      [a.manager, a.northManager, a.locationNorth, a.carer, a.roleCarer],
    );
    await c.query(
      `INSERT INTO staff_profile (id, tenant_user_id, job_title, starts_on, date_of_birth) VALUES
         ($1, $2, 'Care worker', '2026-11-02', '1990-05-01'),
         ($3, $4, 'HR lead', '2020-01-06', NULL)`,
      [PROFILE, a.carer, HR_PROFILE, a.manager],
    );
  });
  // A published policy every care worker must read and sign.
  await asHr(async (c) => {
    await c.query(
      `INSERT INTO policy (id, policy_key, title) VALUES ($1, 'fire_safety', 'Fire safety')`,
      [POLICY],
    );
    await c.query(
      `INSERT INTO policy_version (id, policy_id, change, change_summary, body, roles, review_due_on)
       VALUES ($1, $2, 'major', 'First issue', 'Evacuate by the nearest safe exit.', '{care_worker}', DATE '2099-01-01')`,
      [POLICY_V1, POLICY],
    );
    await c.query(
      "UPDATE policy_version SET state = 'published', published_by = $2 WHERE id = $1",
      [POLICY_V1, a.manager],
    );
    await c.query(
      `INSERT INTO induction_plan (staff_profile_id, probation_ends_on) VALUES ($1, '2027-05-02')`,
      [PROFILE],
    );
    await c.query(
      `INSERT INTO staff_checklist_item (staff_profile_id, checklist, kind, done_on)
       VALUES ($1, 'induction', 'contract_issued', '2026-10-20')`,
      [PROFILE],
    );
    await c.query(
      `INSERT INTO shadow_shift (staff_profile_id, shift_on, shadowed_id) VALUES ($1, '2026-11-03', $2)`,
      [PROFILE, a.northManager],
    );
    await c.query(
      `INSERT INTO probation_review (staff_profile_id, review_on, outcome) VALUES ($1, '2026-12-01', 'on_track')`,
      [PROFILE],
    );
    await c.query(
      `INSERT INTO reference_request (staff_profile_id, requested_on, requester, kind)
       VALUES ($1, '2026-12-01', 'Example Care Homes Ltd', 'conduct')`,
      [PROFILE],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("codes", () => {
  it("match the domain's", () => {
    expect([...CARE_CERTIFICATE_STANDARD_IDS]).toEqual([...DOMAIN_STANDARDS]);
    expect([...INDUCTION_TICKED_ITEMS]).toEqual([...TICKED_INDUCTION_ITEMS]);
    expect([...LEAVER_TICKED_ITEMS]).toEqual([...TICKED_LEAVER_ITEMS]);
    expect([...LEAVING_REASONS]).toEqual([...DOMAIN_REASONS]);
    expect([...EXIT_INTERVIEW_STATES]).toEqual([...DOMAIN_EXIT]);
    expect([...PROBATION_OUTCOMES]).toEqual([...DOMAIN_PROBATION]);
  });
});

describe("who reads and writes (the staff file's rules)", () => {
  it("lets HR read everything, and the worker their own", async () => {
    const hr = await asHr(counts);
    expect(hr).toMatchObject({
      induction_plan: 1,
      staff_checklist_item: 1,
      shadow_shift: 1,
      probation_review: 1,
    });
    expect(await asWorker(counts)).toEqual(hr);
  });

  it("shows another organisation nothing", async () => {
    const other = await inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), counts);
    expect(Object.values(other).every((n) => n === 0)).toBe(true);
  });

  it("shows an assessor only the Care Certificate", async () => {
    const seen = await asAssessor(counts);
    expect(seen.induction_plan).toBe(0);
    expect(seen.leaver_record).toBe(0);
    expect(seen.reference_request).toBe(0);
  });

  it("never lets the worker write their own file", async () => {
    await expect(
      asWorker((c) =>
        c.query(
          `INSERT INTO staff_checklist_item (staff_profile_id, checklist, kind, done_on)
           VALUES ($1, 'induction', 'uniform_and_badge', '2026-10-21')`,
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("never lets HR write on HR's own file", async () => {
    await expect(
      asHr((c) =>
        c.query(`INSERT INTO induction_plan (staff_profile_id) VALUES ($1)`, [HR_PROFILE]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("records everything in the actor's own name, never shadowing the worker themselves", async () => {
    await expect(
      asHr((c) =>
        c.query(
          `INSERT INTO staff_checklist_item (staff_profile_id, checklist, kind, done_on, done_by)
           VALUES ($1, 'induction', 'uniform_and_badge', '2026-10-21', $2)`,
          [PROFILE, a.northManager],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asHr((c) =>
        c.query(
          `INSERT INTO shadow_shift (staff_profile_id, shift_on, shadowed_id) VALUES ($1, '2026-11-04', $2)`,
          [PROFILE, a.carer],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("never changes or deletes the checklist, shadow shifts or reviews", async () => {
    for (const t of ["staff_checklist_item", "shadow_shift", "probation_review"]) {
      await expect(
        asHr((c) => c.query(`UPDATE ${t} SET created_at = now()`)),
        t,
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

describe("the Care Certificate (rule 20)", () => {
  const assess = (c: pg.PoolClient, standard: string, by: string) =>
    c.query(
      `INSERT INTO care_certificate_progress (staff_profile_id, standard_id, knowledge_assessed_on, knowledge_assessed_by)
       VALUES ($1, $2, '2026-11-05', $3)`,
      [PROFILE, standard, by],
    );

  it("is assessed and observed by an assessor, in their own name", async () => {
    await asAssessor((c) => assess(c, "cc01", a.northManager));
    await asAssessor((c) =>
      c.query(
        `UPDATE care_certificate_progress SET observed_on = '2026-11-12', observed_by = $2
          WHERE staff_profile_id = $1 AND standard_id = 'cc01'`,
        [PROFILE, a.northManager],
      ),
    );
    expect((await asAssessor(counts)).care_certificate_progress).toBe(1);
    expect((await asHr(counts)).care_certificate_progress).toBe(1);
    expect((await asWorker(counts)).care_certificate_progress).toBe(1);
  });

  it("is never assessed by the worker, or in someone else's name", async () => {
    await expect(asWorker((c) => assess(c, "cc02", a.carer))).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asAssessor((c) => assess(c, "cc02", a.manager))).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("is observed only by a holder of workforce.competence.observe", async () => {
    await asHr((c) => assess(c, "cc03", a.manager));
    await expect(
      asHr((c) =>
        c.query(
          `UPDATE care_certificate_progress SET observed_on = '2026-11-12', observed_by = $2
            WHERE staff_profile_id = $1 AND standard_id = 'cc03'`,
          [PROFILE, a.manager],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps an observation once signed", async () => {
    await expect(
      asAssessor((c) =>
        c.query(
          `UPDATE care_certificate_progress SET observed_on = '2026-11-13'
            WHERE staff_profile_id = $1 AND standard_id = 'cc01'`,
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });
});

describe("probation and read-and-sign (rules 19 and 21)", () => {
  it("keeps a probation once passed", async () => {
    await asHr((c) =>
      c.query(
        `UPDATE induction_plan SET probation_outcome = 'passed', probation_decided_on = '2027-05-01',
            probation_decided_by = $2 WHERE staff_profile_id = $1`,
        [PROFILE, a.manager],
      ),
    );
    await expect(
      asHr((c) =>
        c.query(
          "UPDATE induction_plan SET probation_outcome = 'not_passed' WHERE staff_profile_id = $1",
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });

  it("counts read-and-sign for HR and the worker, never for anyone else", async () => {
    const signing = (c: pg.PoolClient) =>
      c.query<{ required: number; signed: number }>(
        "SELECT * FROM app.induction_policy_signing($1)",
        [PROFILE],
      );
    expect((await asHr(signing)).rows[0]).toEqual({ required: 1, signed: 0 });
    await asWorker((c) =>
      c.query("INSERT INTO policy_signature (policy_version_id) VALUES ($1)", [POLICY_V1]),
    );
    expect((await asWorker(signing)).rows[0]).toEqual({ required: 1, signed: 1 });
    await expect(asAssessor(signing)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("the review's guards (security review of slice 29)", () => {
  it("starts every record undecided, whoever inserts it", async () => {
    await expect(
      asHr((c) =>
        c.query(
          `INSERT INTO reference_request (staff_profile_id, requested_on, requester, kind, state, sent_on, sent_by)
           VALUES ($1, '2026-12-02', 'Example Agency Ltd', 'factual', 'sent', '2026-12-02', $2)`,
          [PROFILE, a.northManager],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("tells the profile's member only to the file's readers, assessors and the member", async () => {
    const worker = (c: pg.PoolClient) =>
      c.query<{ id: string | null }>("SELECT app.staff_profile_worker($1) AS id", [PROFILE]);
    expect((await asAssessor(worker)).rows[0]?.id).toBe(a.carer);
    expect((await asWorker(worker)).rows[0]?.id).toBe(a.carer);
    await asOwnerRole(TENANT_A, (c) =>
      c.query(
        `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status)
         VALUES ('0199f400-0000-7000-8000-000000000304', 'auth-nobody', 'No Body', 'no.body@example.invalid', 'active')`,
      ),
    );
    const stranger = await inContext(
      app(),
      ctx(TENANT_A, "0199f400-0000-7000-8000-000000000304", "none"),
      worker,
    );
    expect(stranger.rows[0]?.id).toBeNull();
  });

  it("never lets the staff file alone end the access of someone who manages users", async () => {
    // The North manager also manages users: HR's staff file permission alone cannot end it.
    await asOwnerRole(TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ('0199f400-0000-7000-8000-000000000504', 'admin', 'Admin', 'tenant', '{platform.user.manage}')`,
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199f400-0000-7000-8000-000000000504')`,
        [a.northManager],
      );
      await c.query(
        `INSERT INTO staff_profile (id, tenant_user_id, job_title, starts_on)
         VALUES ('0199f400-0000-7000-8000-000000000003', $1, 'Manager', '2020-01-06')`,
        [a.northManager],
      );
    });
    await asHr((c) =>
      c.query(
        `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason)
         VALUES ('0199f400-0000-7000-8000-000000000003', '2027-03-31', 'resignation')`,
      ),
    );
    await expect(
      asHr((c) => c.query("SELECT app.end_leaver_access('0199f400-0000-7000-8000-000000000003')")),
    ).rejects.toMatchObject({ code: "42501" });
    // Nor mark it ended without ending it.
    await expect(
      asHr((c) =>
        c.query(
          `UPDATE leaver_record SET access_removed_at = now() WHERE staff_profile_id = '0199f400-0000-7000-8000-000000000003'`,
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("never records a leaving with access already ended", async () => {
    await expect(
      asHr((c) =>
        c.query(
          `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason, access_removed_at)
           VALUES ($1, '2027-03-31', 'resignation', now())`,
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("leaving (rule 22)", () => {
  it("ends access once, only by HR or the system, never the leaver", async () => {
    await asHr((c) =>
      c.query(
        `INSERT INTO leaver_record (staff_profile_id, leaving_on, reason) VALUES ($1, '2027-03-31', 'resignation')`,
        [PROFILE],
      ),
    );
    const end = (c: pg.PoolClient) =>
      c.query<{ ended: boolean }>("SELECT app.end_leaver_access($1) AS ended", [PROFILE]);
    await expect(asWorker(end)).rejects.toMatchObject({ code: "42501" });
    await expect(asAssessor(end)).rejects.toMatchObject({ code: "42501" });
    expect((await asHr(end)).rows[0]?.ended).toBe(true);
    expect((await asHr(end)).rows[0]?.ended).toBe(false);
    const member = await asOwnerRole(TENANT_A, (c) =>
      c.query<{ status: string; open: string }>(
        `SELECT u.status,
                (SELECT count(*) FROM role_assignment ra WHERE ra.tenant_user_id = u.id
                   AND (ra.valid_to IS NULL OR ra.valid_to > now())) AS open
           FROM tenant_user u WHERE u.id = $1`,
        [a.carer],
      ),
    );
    expect(member.rows[0]).toEqual({ status: "left", open: "0" });
    await expect(
      asHr((c) =>
        c.query("UPDATE leaver_record SET access_removed_at = NULL WHERE staff_profile_id = $1", [
          PROFILE,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("moves the exit interview only forward, and answers a reference once in the sender's name", async () => {
    await asHr((c) =>
      c.query(
        `UPDATE leaver_record SET exit_interview = 'held', exit_interview_on = '2027-03-30',
            exit_interview_summary = 'Moving closer to family.' WHERE staff_profile_id = $1`,
        [PROFILE],
      ),
    );
    await expect(
      asHr((c) =>
        c.query(
          "UPDATE leaver_record SET exit_interview = 'offered', exit_interview_on = NULL, exit_interview_summary = NULL WHERE staff_profile_id = $1",
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asHr((c) =>
        c.query(
          "UPDATE reference_request SET state = 'sent', sent_on = '2027-04-02', sent_by = $2 WHERE staff_profile_id = $1",
          [PROFILE, a.northManager],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await asHr((c) =>
      c.query(
        "UPDATE reference_request SET state = 'sent', sent_on = '2027-04-02', sent_by = $2 WHERE staff_profile_id = $1",
        [PROFILE, a.manager],
      ),
    );
    await expect(
      asHr((c) =>
        c.query(
          "UPDATE reference_request SET state = 'declined', sent_on = NULL, sent_by = NULL, declined_reason = 'duplicate_request' WHERE staff_profile_id = $1",
          [PROFILE],
        ),
      ),
    ).rejects.toMatchObject({ code: "23000" });
  });
});
