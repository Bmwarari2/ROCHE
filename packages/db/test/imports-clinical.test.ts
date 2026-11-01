import { IMPORT_RECORD_TYPES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * Importing medicines, care plans and staff files in the database (platform.md rules 27 to 31;
 * migration 0136; hazards HZ-130, HZ-024, HZ-124, HZ-072): the record types; who reaches each
 * type's batches; a record tied to its batch only as that batch commits, of its own type, a care
 * plan only as a draft and a staff file check only unverified, never changed; staff file checks
 * never deleted except by an undo; the undo of care plans and staff files, whole, only while
 * unchanged; the sample removal list holding every table. Medicines' undo is proved through the
 * API (apps/api/test/imports-clinical.test.ts), which writes entries as the medicines rules do.
 */

let db: TestDatabase;
const app = () => db.pool("harbour_app");
const owner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), fn);

const U = {
  carePlans: ids.a.manager,
  staff: "0199f700-0000-7000-8000-000000000301",
  peopleOnly: "0199f700-0000-7000-8000-000000000302",
};
const asCarePlans = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, U.carePlans, "tenant"), fn);
const asStaff = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, U.staff, "tenant"), fn);
const asPeopleOnly = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, U.peopleOnly, "tenant"), fn);

const PERSON = "0199f700-0000-7000-8000-0000000000a1";
const PERSON_2 = "0199f700-0000-7000-8000-0000000000a2";
const PERSON_3 = "0199f700-0000-7000-8000-0000000000a3";
const PERSON_4 = "0199f700-0000-7000-8000-0000000000a4";
const FILE = "0199f700-0000-7000-8000-0000000000b1";

const code = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return "ok";
  } catch (error) {
    const e = error as { code?: string; message?: string };
    return `${e.code ?? "error"}:${e.message ?? ""}`;
  }
};

async function batch(c: pg.PoolClient, type: string, dryRun = true): Promise<string> {
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO import_batch (record_type, location_id, row_count, expires_at)
     VALUES ($1, $2, 1, now() + interval '7 days') RETURNING id`,
    [type, ids.a.locationNorth],
  );
  const id = rows[0]?.id ?? "";
  if (dryRun) {
    await c.query(
      `UPDATE import_batch SET dry_run_at = now(), dry_run_by = app.current_user_id(),
         dry_run_errors = 0, dry_run_warnings = 0 WHERE id = $1`,
      [id],
    );
  }
  return id;
}
async function close(c: pg.PoolClient, id: string, records: string[]) {
  await c.query(
    `UPDATE import_batch SET status = 'committed', closed_at = now(),
       closed_by = app.current_user_id() WHERE id = $1`,
    [id],
  );
  await c.query(
    "INSERT INTO import_commit (batch_id, record_ids, record_count) VALUES ($1, $2, $3)",
    [id, records, records.length],
  );
}
const draftPlan = (c: pg.PoolClient, person: string, batchId: string | null) =>
  c
    .query<{ id: string }>(
      `INSERT INTO care_plan (person_id, location_id, import_batch_id) VALUES ($1, $2, $3)
       RETURNING id`,
      [person, ids.a.locationNorth, batchId],
    )
    .then((r) => r.rows[0]?.id ?? "");
const section = (c: pg.PoolClient, plan: string, person: string) =>
  c.query(
    `INSERT INTO care_plan_section (person_id, plan_id, domain, need, outcome)
     VALUES ($1, $2, 'mobility', 'Needs one carer to walk.', 'Walks safely.')`,
    [person, plan],
  );
const check = (c: pg.PoolClient, kind: string, batchId: string | null, verified = false) =>
  c
    .query<{ id: string }>(
      `INSERT INTO compliance_item (staff_profile_id, kind, detail, import_batch_id, verified_on,
         verified_by)
       VALUES ($1, $2, $3::jsonb, $4, CASE WHEN $5 THEN DATE '2026-10-01' END,
         CASE WHEN $5 THEN app.current_user_id() END)
       RETURNING id`,
      [FILE, kind, JSON.stringify({ kind, received: 1 }), batchId, verified],
    )
    .then((r) => r.rows[0]?.id ?? "");
const undo = (id: string) => (c: pg.PoolClient) =>
  c.query<{ n: number }>("SELECT app.undo_import_batch($1, 'req-test') AS n", [id]);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await owner(async (c) => {
    await c.query(
      `INSERT INTO tenant_user (id, auth_user_id, display_name, email, status) VALUES
         ($1, 'auth-imp-staff', 'Sol Example', 'sol.import@example.invalid', 'active'),
         ($2, 'auth-imp-people', 'Pat Example', 'pat.import@example.invalid', 'active')`,
      [U.staff, U.peopleOnly],
    );
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f700-0000-7000-8000-000000000501', 'plan_importer', 'Plan importer', 'tenant',
          '{platform.import.run,care.plan.write,care.plan.read,people.person.read}'),
         ('0199f700-0000-7000-8000-000000000502', 'staff_importer', 'Staff importer', 'tenant',
          '{platform.import.run,workforce.staff_file.manage,workforce.staff_file.read}'),
         ('0199f700-0000-7000-8000-000000000503', 'people_importer', 'People importer', 'tenant',
          '{platform.import.run,people.person.create,people.person.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id) VALUES
         ($1, '0199f700-0000-7000-8000-000000000501'),
         ($2, '0199f700-0000-7000-8000-000000000502'),
         ($3, '0199f700-0000-7000-8000-000000000503')`,
      [U.carePlans, U.staff, U.peopleOnly],
    );
    await c.query(
      `INSERT INTO person (id, location_id, status, given_name, family_name, date_of_birth,
         local_identifier) VALUES
         ($1, $3, 'active', 'Ida', 'Example', '1940-02-01', 'IMP-1'),
         ($2, $3, 'active', 'Ivy', 'Example', '1941-03-02', 'IMP-2'),
         ($4, $3, 'active', 'Iris', 'Example', '1942-04-03', 'IMP-3'),
         ($5, $3, 'active', 'Isla', 'Example', '1943-05-04', 'IMP-4')`,
      [PERSON, PERSON_2, ids.a.locationNorth, PERSON_3, PERSON_4],
    );
    await c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('import.undo_window_days', 7, 'days', 'all', '2000-01-01', 'rates.md', 'to-verify')
       ON CONFLICT DO NOTHING`,
    );
    await c.query(
      `INSERT INTO staff_profile (id, tenant_user_id, job_title) VALUES ($1, $2, 'Care worker')`,
      [FILE, ids.a.carer],
    );
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("record types and who reaches them (rule 27)", () => {
  it("takes every type the domain lists, and nothing else", async () => {
    for (const type of IMPORT_RECORD_TYPES) {
      expect(
        await code(() => asPeopleOnly((c) => c.query(`SELECT app.import_reachable($1)`, [type]))),
      ).toBe("ok");
    }
    expect(await code(() => asStaff((c) => batch(c, "allergies")))).toMatch(/^42501|^23514/);
  });

  it.each<[string, string, typeof asStaff, boolean]>([
    ["a care plan importer, care plans", "care_plans", asCarePlans, true],
    ["a care plan importer, staff files", "staff_files", asCarePlans, false],
    ["a care plan importer, medicines", "medicines", asCarePlans, false],
    ["a staff file importer, staff files", "staff_files", asStaff, true],
    ["a staff file importer, care plans", "care_plans", asStaff, false],
    ["a people importer, medicines", "medicines", asPeopleOnly, false],
  ])("%s: reachable %s", async (_name, type, as, reachable) => {
    const { rows } = await as((c) =>
      c.query<{ ok: boolean }>("SELECT app.import_reachable($1) AS ok", [type]),
    );
    expect(rows[0]?.ok).toBe(reachable);
  });
});

describe("hazard HZ-130 a record is tied to its batch only as it commits", () => {
  it("only while its batch of its own type is staged after its dry run, never changed", async () => {
    const noDryRun = await asCarePlans((c) => batch(c, "care_plans", false));
    expect(await code(() => asCarePlans((c) => draftPlan(c, PERSON, noDryRun)))).toMatch(
      /import_batch_not_committing/,
    );
    const staff = await asStaff((c) => batch(c, "staff_files"));
    expect(await code(() => asCarePlans((c) => draftPlan(c, PERSON, staff)))).toMatch(
      /^23503|import_batch_not_committing/,
    );
    const plans = await asCarePlans((c) => batch(c, "care_plans"));
    const plan = await asCarePlans((c) => draftPlan(c, PERSON, plans));
    expect(plan).not.toBe("");
    expect(
      await code(() =>
        asCarePlans((c) =>
          c.query("UPDATE care_plan SET import_batch_id = NULL WHERE id = $1", [plan]),
        ),
      ),
    ).toMatch(/import_batch_fixed/);
    await asCarePlans((c) => c.query("DELETE FROM care_plan WHERE id = $1", [plan])).catch(
      () => undefined,
    );
  });

  it("hazard HZ-124 a staff file check only unverified; hazard HZ-024 a care plan only as a draft", async () => {
    const staff = await asStaff((c) => batch(c, "staff_files"));
    expect(await code(() => asStaff((c) => check(c, "references", staff, true)))).toMatch(
      /imported_check_is_unverified/,
    );
    const plans = await asCarePlans((c) => batch(c, "care_plans"));
    expect(
      await code(() =>
        asCarePlans((c) =>
          c.query(
            `INSERT INTO care_plan (person_id, location_id, import_batch_id, status,
               published_version, published_at, published_by)
             VALUES ($1, $2, $3, 'active', 1, now(), app.current_user_id())`,
            [PERSON_2, ids.a.locationNorth, plans],
          ),
        ),
      ),
    ).toMatch(/imported_care_plan_is_a_draft|^23514|^42501/);
  });

  it("a staff file check is never deleted by the application or the owner role", async () => {
    const id = await asStaff((c) => check(c, "identity_with_photo", null));
    expect(
      await code(() => asStaff((c) => c.query("DELETE FROM compliance_item WHERE id = $1", [id]))),
    ).not.toBe("ok");
    expect(
      await code(() => owner((c) => c.query("DELETE FROM compliance_item WHERE id = $1", [id]))),
    ).toMatch(/append-only/);
  });
});

describe("undo by type (rules 29 and 30)", () => {
  it("hazard HZ-024 removes a batch's unchanged drafts and their sections, once", async () => {
    const id = await asCarePlans(async (c) => {
      const b = await batch(c, "care_plans");
      const plan = await draftPlan(c, PERSON_3, b);
      await section(c, plan, PERSON_3);
      await close(c, b, [plan]);
      return b;
    });
    const { rows } = await asCarePlans(undo(id));
    expect(rows[0]?.n).toBe(1);
    expect(
      await owner((c) =>
        c
          .query<{ n: number }>(
            "SELECT count(*)::int AS n FROM care_plan WHERE import_batch_id = $1",
            [id],
          )
          .then((r) => r.rows[0]?.n),
      ),
    ).toBe(0);
    expect(await code(() => asCarePlans(undo(id)))).toMatch(/already_undone/);
  });

  it("refuses once a draft's section has been changed, leaving it whole", async () => {
    const id = await asCarePlans(async (c) => {
      const b = await batch(c, "care_plans");
      const plan = await draftPlan(c, PERSON_4, b);
      await section(c, plan, PERSON_4);
      await close(c, b, [plan]);
      await c.query("UPDATE care_plan_section SET need = 'Needs two carers.' WHERE plan_id = $1", [
        plan,
      ]);
      return b;
    });
    expect(await code(() => asCarePlans(undo(id)))).toMatch(/changed_since/);
    expect(await code(() => asStaff(undo(id)))).toMatch(/missing_permission/);
  });

  it("hazard HZ-124 removes a batch's unverified checks, and refuses once one is verified", async () => {
    const removable = await asStaff(async (c) => {
      const b = await batch(c, "staff_files");
      const item = await check(c, "references", b);
      await close(c, b, [item]);
      return b;
    });
    expect((await asStaff(undo(removable))).rows[0]?.n).toBe(1);
    const verified = await asStaff(async (c) => {
      const b = await batch(c, "staff_files");
      const item = await check(c, "references", b);
      await close(c, b, [item]);
      await c.query(
        `UPDATE compliance_item SET verified_on = DATE '2026-10-31',
           verified_by = app.current_user_id() WHERE id = $1`,
        [item],
      );
      return b;
    });
    expect(await code(() => asStaff(undo(verified)))).toMatch(/changed_since/);
  });
});

describe("hazard HZ-072 the sample removal list holds every table that refers to a person", () => {
  it("keeps migration 0099's and 0111's tables together", async () => {
    const list = await owner((c) =>
      c
        .query<{ t: string[] }>("SELECT app.sample_removal_tables() AS t")
        .then((r) => r.rows[0]?.t ?? []),
    );
    for (const t of [
      "death_record",
      "missing_episode",
      "outbreak_case",
      "medication",
      "medication_schedule",
    ]) {
      expect(list).toContain(t);
    }
  });
});
