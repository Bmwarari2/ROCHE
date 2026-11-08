import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Development records follow attribute scope (ADR-0136, migration 0161; WORK-009 follow-up): an
 * organisation-wide holder (HR's role with no person scope, a tenant-scoped role) reads every
 * member's records and reminder tasks; a holder at a home (a role there, or an acting-up access
 * grant there) reads only the members who work there, as app.works_at counts it (a role in force
 * there or across the organisation, or that home on their staff profile); an assigned-scope role
 * reads none; a member reads their own; another organisation reads nothing. Writes follow the same
 * scope in the policies themselves; the HZ-119 sign-off guard still sees every withdrawal; the
 * context definers that read tasks evaluate the task policy without error. There is no team or
 * line-manager scope for staff yet, and agency workers hold location roles (the home case), so
 * neither has a row of its own here.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

const id = (n: number) => `0199f300-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ROLE = {
  hr: id(501),
  org: id(502),
  home: id(503),
  staff: id(504),
  roam: id(505),
  assigned: id(507),
};
const HR = id(601);
const ORG = id(602);
const NORTH_LEAD = id(603);
const ACTING = id(604);
const ASSIGNED = id(605);
const W_NORTH = id(611);
const W_SOUTH = id(612);
const W_ROAM = id(613);
const W_PROFILE = id(614);
const WORKERS: readonly string[] = [W_NORTH, W_SOUTH, W_ROAM, W_PROFILE];
const B_HR = id(701);
const HASH = "a".repeat(64);
const PACKAGE = id(801);
const COURSE = id(802);

const READERS = {
  hr: () => ctx(TENANT_A, HR, "none"),
  org: () => ctx(TENANT_A, ORG, "tenant"),
  north: () => ctx(TENANT_A, NORTH_LEAD, "locations", [a.locationNorth]),
  acting: () => ctx(TENANT_A, ACTING, "locations", [a.locationNorth]),
  assigned: () => ctx(TENANT_A, ASSIGNED, "assigned"),
  self: () => ctx(TENANT_A, W_SOUTH, "locations", [a.locationSouth]),
  other: () => ctx(TENANT_B, B_HR, "none"),
};
type Who = keyof typeof READERS;
const as = <T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), READERS[who](), fn);
const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();

/** The member each table's rows are about, as each reader sees them. */
const TABLES: Record<string, string> = {
  training_record: "SELECT worker_id AS w FROM training_record",
  supervision_record: "SELECT worker_id AS w FROM supervision_record",
  competence_sign_off: "SELECT worker_id AS w FROM competence_sign_off",
  competence_withdrawal:
    "SELECT s.worker_id AS w FROM competence_withdrawal x JOIN competence_sign_off s ON s.id = x.sign_off_id",
  revalidation_evidence: "SELECT worker_id AS w FROM revalidation_evidence",
  elearning_attempt: "SELECT worker_id AS w FROM elearning_attempt",
  record_version:
    "SELECT (data->>'worker_id')::uuid AS w FROM record_version WHERE table_name = 'training_record'",
  training_certificate: `SELECT r.worker_id AS w FROM document d
    JOIN training_record r ON r.id = d.subject_id WHERE d.category = 'training_certificate'`,
};
const seen = (who: Who, query: string) =>
  as(who, async (c) =>
    sorted(
      (await c.query<{ w: string }>(query)).rows.map((r) => r.w).filter((w) => WORKERS.includes(w)),
    ),
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('competence.medicines.refresh_months', 12, 'months', 'all', '2000-01-01', 'rates.md', 'master-prompt'),
              ('competence.default_refresh_months', 12, 'months', 'all', '2000-01-01', 'rates.md', 'to-verify')`,
    ),
  );
  const DEV =
    "{workforce.training.manage,workforce.supervision.manage,workforce.competence.observe}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'hr_scope', 'HR', 'none', $7),
         ($2, 'org_scope', 'Organisation', 'tenant', $7),
         ($3, 'home_scope', 'Home manager', 'location', $7),
         ($4, 'staff_scope', 'Staff', 'location', '{workforce.self.read}'),
         ($5, 'roam_scope', 'Roaming staff', 'tenant', '{workforce.self.read}'),
         ($6, 'assigned_scope', 'Key worker', 'assigned', $7)`,
      [ROLE.hr, ROLE.org, ROLE.home, ROLE.staff, ROLE.roam, ROLE.assigned, DEV],
    );
    const people: [string, string, string][] = [
      [HR, "Hari Scope", "hari.scope"],
      [ORG, "Orla Scope", "orla.scope"],
      [NORTH_LEAD, "Nia Lead", "nia.lead"],
      [ACTING, "Ari Acting", "ari.acting"],
      [ASSIGNED, "Kit Keyworker", "kit.keyworker"],
      [W_NORTH, "Noor North", "noor.north"],
      [W_SOUTH, "Sam South", "sam.south"],
      [W_ROAM, "Rory Roam", "rory.roam"],
      [W_PROFILE, "Pia Profile", "pia.profile"],
    ];
    for (const [member, name, email] of people) {
      await c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, $2, $3, 'active')",
        [member, name, `${email}@example.invalid`],
      );
    }
    const assign = (member: string, role: string, location: string | null) =>
      c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
        [member, role, location],
      );
    await assign(HR, ROLE.hr, null);
    await assign(ORG, ROLE.org, null);
    await assign(NORTH_LEAD, ROLE.home, a.locationNorth);
    await assign(ACTING, ROLE.staff, a.locationNorth);
    await assign(ASSIGNED, ROLE.assigned, a.locationNorth);
    await assign(W_NORTH, ROLE.staff, a.locationNorth);
    await assign(W_SOUTH, ROLE.staff, a.locationSouth);
    await assign(W_ROAM, ROLE.roam, null);
    await assign(W_PROFILE, ROLE.staff, a.locationSouth);
    // Pia's role is at South House, and her staff file names North House as her home.
    await c.query(
      "INSERT INTO staff_profile (tenant_user_id, job_title, location_id) VALUES ($1, 'Care worker', $2)",
      [W_PROFILE, a.locationNorth],
    );
    // Ari acts up at North House for a day: an access grant there, not a role.
    await c.query(
      `INSERT INTO access_grant (tenant_user_id, location_id, permissions, valid_from, valid_to,
                                 reason, granted_by)
       VALUES ($1, $2, $3, now() - interval '1 hour', now() + interval '1 day',
               'Acting up while the manager is away', $4)`,
      [ACTING, a.locationNorth, DEV, HR],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      "INSERT INTO role (id, key, name, scope_kind, permissions) VALUES ($1, 'hr_scope', 'HR', 'none', $2)",
      [id(506), DEV],
    );
    await c.query(
      "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Bea Other', 'bea.other@example.invalid', 'active')",
      [B_HR],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      B_HR,
      id(506),
    ]);
  });
  await asSystem(async (c) => {
    await c.query(
      `INSERT INTO document (id, category, title, retention_class, storage_key, content_type, size_bytes, sha256)
       VALUES ($1, 'elearning_package', 'Fire safety', 'organisation_document', 'k', 'application/zip', 10, $2)`,
      [PACKAGE, HASH],
    );
    await c.query(
      `INSERT INTO elearning_course (id, title, topic, standard, document_id, package_sha256, launch_path,
         file_count, unpacked_bytes, package_index)
       VALUES ($1, 'Fire safety', 'fire_safety', 'scorm_1_2', $2, $3, 'index.html', 1, 100,
         '[{"p":"index.html","o":0,"c":100,"u":100,"k":0,"m":0}]')`,
      [COURSE, PACKAGE, HASH],
    );
    for (const worker of WORKERS) {
      const record = (
        await c.query<{ id: string }>(
          `INSERT INTO training_record (worker_id, topic, completed_on)
           VALUES ($1, 'fire_safety', DATE '2026-09-01') RETURNING id`,
          [worker],
        )
      ).rows[0]?.id;
      await c.query("UPDATE training_record SET provider = 'Thapsus Academy' WHERE id = $1", [
        record,
      ]);
      await c.query(
        `INSERT INTO document (category, title, retention_class, storage_key, content_type, size_bytes,
           sha256, subject_type, subject_id)
         VALUES ('training_certificate', 'Certificate', 'staff_file', 'k/' || app.uuid_v7(),
           'application/pdf', 10, $2, 'training_record', $1)`,
        [record, HASH],
      );
      await c.query(
        `INSERT INTO supervision_record (worker_id, kind, held_on, held_by)
         VALUES ($1, 'supervision', DATE '2026-10-01', $2)`,
        [worker, HR],
      );
      await c.query("INSERT INTO elearning_attempt (course_id, worker_id) VALUES ($1, $2)", [
        COURSE,
        worker,
      ]);
      await c.query(
        `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key,
                           source_type, source_id, details)
         VALUES ('workforce.supervision_due', 'Hold a supervision that is due',
                 'workforce.supervision.manage', now(), 'hr', 'tenant_user', $1::uuid,
                 jsonb_build_object('memberId', $1::uuid))`,
        [worker],
      );
    }
    await c.query(
      `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key)
       VALUES ('workforce.training_expiry', 'Renew training before it expires',
               'workforce.training.manage', now(), 'hr')`,
    );
  });
  // Written by HR in their own name: a sign-off and its withdrawal, and revalidation evidence.
  await as("hr", async (c) => {
    for (const worker of WORKERS) {
      const signOff = (
        await c.query<{ id: string }>(
          `INSERT INTO competence_sign_off (worker_id, competence, observed_on, observer_id, valid_until)
           VALUES ($1, 'moving_and_handling_hoist', DATE '2026-06-01', app.current_user_id(), DATE '2027-05-31')
           RETURNING id`,
          [worker],
        )
      ).rows[0]?.id;
      await c.query(
        `INSERT INTO competence_withdrawal (sign_off_id, reason, withdrawn_by)
         VALUES ($1, 'Observed unsafe practice on a shift', app.current_user_id())`,
        [signOff],
      );
      await c.query(
        "INSERT INTO revalidation_evidence (worker_id, cycle_due_on) VALUES ($1, DATE '2027-03-31')",
        [worker],
      );
    }
  });
});

afterAll(async () => {
  await db?.drop();
});

const EVERYONE = sorted(WORKERS);
// At North House: Noor (a role there), Rory (organisation-wide role), Pia (North on her staff
// file); never Sam, who works only at South House.
const NORTH = sorted([W_NORTH, W_ROAM, W_PROFILE]);
const EXPECTED: Record<Who, readonly string[]> = {
  hr: EVERYONE,
  org: EVERYONE,
  north: NORTH,
  acting: NORTH,
  assigned: [],
  self: [W_SOUTH],
  other: [],
};

describe("hazard HZ-011 development records follow attribute scope (ADR-0136)", () => {
  const cases = (Object.keys(EXPECTED) as Who[]).flatMap((who) =>
    Object.keys(TABLES).map((table) => [who, table] as const),
  );
  it.each(cases)("%s reads %s for the members in scope only", async (who, table) => {
    expect(await seen(who, TABLES[table] as string)).toEqual(EXPECTED[who]);
  });

  it.each([
    ["hr", EVERYONE, true],
    ["org", EVERYONE, true],
    ["north", NORTH, true],
    ["acting", NORTH, true],
    ["assigned", [], false],
    ["self", [], false],
    ["other", [], false],
  ] as const)(
    "%s sees the reminder tasks about members in scope only",
    async (who, expected, seesUnsourced) => {
      const rows = await as(
        who,
        async (c) =>
          (
            await c.query<{ kind: string; source_id: string | null }>(
              "SELECT kind, source_id FROM task WHERE kind LIKE 'workforce.%'",
            )
          ).rows,
      );
      expect(
        sorted(
          rows
            .filter((r) => r.kind === "workforce.supervision_due")
            .map((r) => r.source_id as string),
        ),
      ).toEqual(expected);
      // A workforce task about no member keeps 0079's rule: any holder of its permission.
      expect(rows.some((r) => r.kind === "workforce.training_expiry")).toBe(seesUnsourced);
    },
  );

  it("answers the scope question per member, and never for another organisation's member", async () => {
    const answer = (who: Who, worker: string) =>
      as(
        who,
        async (c) =>
          (
            await c.query<{ ok: boolean }>("SELECT app.reads_development_of($1::uuid) AS ok", [
              worker,
            ])
          ).rows[0]?.ok,
      );
    expect(await answer("north", W_NORTH)).toBe(true);
    expect(await answer("north", W_SOUTH)).toBe(false);
    expect(await answer("hr", W_SOUTH)).toBe(true);
    expect(await answer("other", W_SOUTH)).toBe(false);
    expect(await answer("hr", b.manager)).toBe(false);
  });
});

describe("hazard HZ-011 development writes follow the same scope in the policies (ADR-0136)", () => {
  const attempt = (who: Who, text: string, params: unknown[]) =>
    as(who, (c) => c.query(text, params)).then(
      () => "ok",
      (error: Error) => error.message,
    );

  it.each([
    [
      "training_record",
      "INSERT INTO training_record (worker_id, topic, completed_on) VALUES ($1, 'fire_safety', DATE '2026-09-02')",
    ],
    [
      "supervision_record",
      "INSERT INTO supervision_record (worker_id, kind, held_on, held_by) VALUES ($1, 'supervision', DATE '2026-10-02', app.current_user_id())",
    ],
    [
      "competence_sign_off",
      `INSERT INTO competence_sign_off (worker_id, competence, observed_on, observer_id, valid_until)
       VALUES ($1, 'catheter_care', DATE '2026-06-02', app.current_user_id(), DATE '2027-06-01')`,
    ],
    [
      "revalidation_evidence",
      "INSERT INTO revalidation_evidence (worker_id, cycle_due_on) VALUES ($1, DATE '2030-03-31')",
    ],
  ])("refuses a %s for a member out of scope, without RETURNING", async (_table, text) => {
    expect(await attempt("north", text, [W_SOUTH])).toMatch(/row-level security/);
    expect(await attempt("north", text, [W_NORTH])).toBe("ok");
  });

  it("hazard HZ-119 still refuses a sign-off backdated before a withdrawal, whoever inserts it", async () => {
    // HR withdrew Noor's hoist competence today; a sign-off observed before that day is refused
    // for the home's manager as it is for HR.
    for (const who of ["north", "hr"] as const) {
      expect(
        await attempt(
          who,
          `INSERT INTO competence_sign_off (worker_id, competence, observed_on, observer_id, valid_until)
           VALUES ($1, 'moving_and_handling_hoist', DATE '2026-07-01', app.current_user_id(), DATE '2027-06-30')`,
          [W_NORTH],
        ),
      ).toMatch(/observed on or after the day the competence was withdrawn/);
    }
  });
});

describe("hazard HZ-119 the sign-off guard sees withdrawals the inserter cannot read (ADR-0136)", () => {
  it("hazard HZ-119 refuses a backdated sign-off for a member whose withdrawal the inserter's rules hide", async () => {
    // North House's manager cannot read Sam's withdrawal (Sam works only at South House)...
    expect(
      await as("north", async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              `SELECT count(*) AS n FROM competence_withdrawal x
                 JOIN competence_sign_off s ON s.id = x.sign_off_id WHERE s.worker_id = $1`,
              [W_SOUTH],
            )
          ).rows[0]?.n,
        ),
      ),
    ).toBe(0);
    // ...yet the guard, which runs before the insert policy, still finds it and refuses the
    // backdated sign-off for that reason, not only because Sam is out of scope.
    const message = await as("north", (c) =>
      c.query(
        `INSERT INTO competence_sign_off (worker_id, competence, observed_on, observer_id, valid_until)
         VALUES ($1, 'moving_and_handling_hoist', DATE '2026-07-01', app.current_user_id(), DATE '2027-06-30')`,
        [W_SOUTH],
      ),
    ).then(
      () => "ok",
      (error: Error) => error.message,
    );
    expect(message).toMatch(/observed on or after the day the competence was withdrawn/);
  });

  it("answers no to a direct call outside the guard, so it never reveals a withdrawal", async () => {
    const direct = await as(
      "north",
      async (c) =>
        (
          await c.query<{ ok: boolean }>(
            "SELECT app.competence_withdrawn_after($1::uuid, 'moving_and_handling_hoist', DATE '2026-07-01') AS ok",
            [W_SOUTH],
          )
        ).rows[0]?.ok,
    );
    expect(direct).toBe(false);
  });
});

describe("H-693 a revalidation confirmer's scope covers the nurse (ADR-0136)", () => {
  const candidates = (nurse: string) =>
    as("hr", async (c) =>
      (
        await c.query<{ id: string }>(
          "SELECT id FROM app.revalidation_confirmer_candidates($1::uuid) AS id",
          [nurse],
        )
      ).rows.map((r) => r.id),
    );
  const name = (nurse: string, confirmer: string) =>
    as("hr", (c) =>
      c.query(
        "UPDATE revalidation_evidence SET confirmer_id = $2 WHERE worker_id = $1 AND cycle_due_on = DATE '2027-03-31'",
        [nurse, confirmer],
      ),
    ).then(
      () => "ok",
      (error: Error) => error.message,
    );

  it("offers North House's manager for a North House nurse, never for a South House nurse", async () => {
    expect(await candidates(W_NORTH)).toContain(NORTH_LEAD);
    expect(await candidates(W_SOUTH)).not.toContain(NORTH_LEAD);
    // HR, organisation-wide, may confirm for either.
    expect(await candidates(W_SOUTH)).toContain(ORG);
  });

  it("refuses naming a confirmer whose scope does not cover the nurse, and names one that does", async () => {
    expect(await name(W_SOUTH, NORTH_LEAD)).toMatch(/revalidation_confirmer_not_permitted/);
    expect(await name(W_NORTH, NORTH_LEAD)).toBe("ok");
  });
});

describe("hazard HZ-011 the context definers that read tasks evaluate the task policy (ADR-0133)", () => {
  it.each(["harbour_care_definer", "harbour_platform_definer"])(
    "%s reads or routes tasks about members without error",
    async (role) => {
      const touched = await inContext(
        db.pool("harbour_owner"),
        ctx(TENANT_A, NORTH_LEAD, "locations", [a.locationNorth]),
        async (c) => {
          await c.query(`SET LOCAL ROLE ${role}`);
          if (role === "harbour_care_definer") {
            return Number(
              (
                await c.query<{ n: string }>(
                  "SELECT count(*) AS n FROM task WHERE kind = 'workforce.supervision_due'",
                )
              ).rows[0]?.n,
            );
          }
          // The routing definer updates only the routing column, and evaluates the policy to do so.
          const { rowCount } = await c.query(
            "UPDATE task SET sync_location_id = sync_location_id WHERE person_id IS NULL AND location_id IS NULL",
          );
          return rowCount ?? 0;
        },
      );
      expect(touched).toBeGreaterThan(0);
    },
  );
});
