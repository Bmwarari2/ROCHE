import {
  LMS_IMPORT_FORMATS,
  LMS_ROW_CLASSES,
  LMS_ROW_OUTCOMES,
  LMS_SOURCE_KINDS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LMS_IMPORT_FORMAT_CODES,
  LMS_ROW_CLASS_CODES,
  LMS_ROW_OUTCOME_CODES,
  LMS_SOURCE_KIND_CODES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Learning platform imports in the database (workforce.md section 13; WORK-006, slice 78;
 * migration 0132):
 * - cross-tenant denial, and only holders of workforce.training.manage;
 * - an API source's secret named by the database; a source fixed, ending once;
 * - learners linked to someone else, in the linker's name, one live link each way;
 * - an import's dry runs counting up one at a time; rows fixed, resolved once, only while open;
 * - an imported training record made only from a ready row, exactly as it says, and fixed after;
 *   a Harbour record never turned into an imported one;
 * - training certificates read as their training record.
 * All the people here are invented.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR: workforce.training.manage, organisation-wide. */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** A North House team leader: reads development records, cannot manage training. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The care worker, with workforce.self.read only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, ids.b.manager, "none"), fn);

const code = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: { message?: string }) => e.message ?? "error",
  );
const one = async <T extends pg.QueryResultRow>(p: Promise<pg.QueryResult<T>>) =>
  (await p).rows[0] as T;
const HASH = "a".repeat(64);

const source = (
  c: pg.PoolClient,
  kind: "file" | "api",
  name: string,
  secret: string | null = null,
) =>
  c.query<{ id: string; secret_ref: string | null; tenant_id: string }>(
    `INSERT INTO lms_source (name, kind, external_organisation_id, secret_ref)
     VALUES ($1, $2, $3, $4) RETURNING id, secret_ref, tenant_id`,
    [name, kind, kind === "api" ? "lms-org-1" : null, secret],
  );
const link = (c: pg.PoolClient, src: string, learner: string, worker: string, by?: string) =>
  c.query<{ id: string }>(
    `INSERT INTO lms_learner_link (source_id, learner_id, worker_id, linked_by)
     VALUES ($1, $2, $3, COALESCE($4, app.current_user_id())) RETURNING id`,
    [src, learner, worker, by ?? null],
  );
const newImport = (c: pg.PoolClient, src: string) =>
  c.query<{ id: string; status: string }>(
    `INSERT INTO lms_import (source_id, format, row_count, content_sha256, uploaded_by)
     VALUES ($1, 'csv', 2, $2, app.current_user_id()) RETURNING id, status`,
    [src, HASH],
  );
const newRow = (c: pg.PoolClient, imp: string, n: number, worker: string, recordId: string) =>
  c.query<{ id: string }>(
    `INSERT INTO lms_import_row (import_id, row_number, learner_id, course_code, completed_on,
       record_id, problems, class, worker_id, topic)
     VALUES ($1, $2, 'L-1', 'FIRE-01', DATE '2026-10-01', $4, '{}', 'ready', $3, 'fire_safety')
     RETURNING id`,
    [imp, n, worker, recordId],
  );
const imported = (
  c: pg.PoolClient,
  v: { src: string; row: string; worker: string; recordId: string; completed?: string },
) =>
  c.query<{ id: string }>(
    `INSERT INTO training_record (worker_id, topic, completed_on, source, lms_source_id,
       lms_import_row_id, external_record_id)
     VALUES ($1, 'fire_safety', $2::date, 'lms', $3, $4, $5) RETURNING id`,
    [v.worker, v.completed ?? "2026-10-01", v.src, v.row, v.recordId],
  );

let FILE = "";
let IMPORT = "";
let ROW = "";
let RECORD = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f780-0000-7000-8000-000000000501', 'hr', 'HR', 'none', '{workforce.training.manage}'),
         ('0199f780-0000-7000-8000-000000000502', 'team_leader', 'Team leader', 'location',
          '{workforce.competence.observe}'),
         ('0199f780-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f780-0000-7000-8000-000000000501', NULL),
         ($2, '0199f780-0000-7000-8000-000000000502', $3),
         ($4, '0199f780-0000-7000-8000-000000000503', $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer],
    );
  });
  FILE = (await asHr(async (c) => one(source(c, "file", "Learning Hub")))).id;
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-124 WORK-006 the LMS import schema", () => {
  it("is in step with packages/domain", () => {
    expect([...LMS_SOURCE_KIND_CODES]).toEqual([...LMS_SOURCE_KINDS]);
    expect([...LMS_IMPORT_FORMAT_CODES]).toEqual([...LMS_IMPORT_FORMATS]);
    expect([...LMS_ROW_CLASS_CODES]).toEqual([...LMS_ROW_CLASSES]);
    expect([...LMS_ROW_OUTCOME_CODES]).toEqual([...LMS_ROW_OUTCOMES]);
  });

  it("names an API source's secret itself, and keeps a source fixed until it ends, once", async () => {
    const api = await asHr((c) => one(source(c, "api", "Platform API", "lms/another/one")));
    expect(api.secret_ref).toBe(`lms/${api.tenant_id}/${api.id}`);
    const file = await asHr((c) =>
      c.query<{ secret_ref: string | null }>("SELECT secret_ref FROM lms_source WHERE id = $1", [
        FILE,
      ]),
    );
    expect(file.rows[0]?.secret_ref).toBeNull();
    expect(await code(asHr((c) => source(c, "file", "learning hub")))).toMatch(
      /lms_source_name_key/,
    );
    expect(
      await code(
        asHr((c) => c.query("UPDATE lms_source SET secret_ref = 'x' WHERE id = $1", [api.id])),
      ),
    ).toBe("lms_source_fixed");
    await asHr((c) => c.query("UPDATE lms_source SET status = 'ended' WHERE id = $1", [api.id]));
    expect(
      await code(
        asHr((c) => c.query("UPDATE lms_source SET status = 'active' WHERE id = $1", [api.id])),
      ),
    ).toBe("lms_source_ended");
    expect(await code(asHr((c) => newImport(c, api.id)))).toBe("lms_source_ended");
  });

  it("links a learner to someone else, in the linker's name, once each way", async () => {
    expect(await code(asHr((c) => link(c, FILE, "L-0", a.manager)))).toMatch(/row-level security/);
    expect(await code(asHr((c) => link(c, FILE, "L-0", a.carer, a.northManager)))).toMatch(
      /row-level security/,
    );
    expect(await code(asHr((c) => link(c, FILE, "ada@example.invalid", a.carer)))).toMatch(
      /lms_learner_link_learner/,
    );
    const made = await asHr((c) => one(link(c, FILE, "L-1", a.carer)));
    expect(await code(asHr((c) => link(c, FILE, "L-1", a.northManager)))).toMatch(
      /lms_learner_link_learner_key/,
    );
    expect(await code(asHr((c) => link(c, FILE, "L-2", a.carer)))).toMatch(
      /lms_learner_link_worker_key/,
    );
    expect(
      await code(
        asHr((c) =>
          c.query("UPDATE lms_learner_link SET worker_id = $2 WHERE id = $1", [
            made.id,
            a.northManager,
          ]),
        ),
      ),
    ).toBe("lms_learner_link_fixed");
  });

  it("counts an import's dry runs up one at a time, in the runner's name", async () => {
    const imp = await asHr((c) => one(newImport(c, FILE)));
    IMPORT = imp.id;
    expect(imp.status).toBe("open");
    const run = (n: number) =>
      asHr((c) =>
        c.query(
          `UPDATE lms_import SET dry_run_number = $2, dry_run_counts = '{}', dry_run_sha256 = $3
           WHERE id = $1 RETURNING dry_run_by`,
          [IMPORT, n, HASH],
        ),
      );
    expect(await code(run(2))).toBe("lms_import_dry_run_number");
    expect((await run(1)).rows[0]).toEqual({ dry_run_by: a.manager });
    expect(
      await code(
        asHr((c) => c.query("UPDATE lms_import SET row_count = 9 WHERE id = $1", [IMPORT])),
      ),
    ).toBe("lms_import_fixed");
  });

  it("makes an imported record only from a ready row, as it says, and never changes it", async () => {
    ROW = (await asHr((c) => one(newRow(c, IMPORT, 1, a.carer, "rec-1")))).id;
    expect(
      await code(
        asHr((c) =>
          imported(c, {
            src: FILE,
            row: ROW,
            worker: a.carer,
            recordId: "rec-1",
            completed: "2026-09-30",
          }),
        ),
      ),
    ).toBe("training_record_import_mismatch");
    expect(
      await code(
        asHr((c) =>
          c.query(
            "UPDATE lms_import_row SET outcome = 'imported', training_record_id = app.uuid_v7() WHERE id = $1",
            [ROW],
          ),
        ),
      ),
    ).toMatch(/lms_import_row_training_record_fk|lms_import_row_not_imported/);
    RECORD = (
      await asHr(async (c) => {
        const r = await one(
          imported(c, { src: FILE, row: ROW, worker: a.carer, recordId: "rec-1" }),
        );
        await c.query(
          "UPDATE lms_import_row SET outcome = 'imported', training_record_id = $2 WHERE id = $1",
          [ROW, r.id],
        );
        return r;
      })
    ).id;
    // The same completion again: one record per platform record id.
    const row2 = (await asHr((c) => one(newRow(c, IMPORT, 2, a.carer, "rec-1")))).id;
    expect(
      await code(
        asHr((c) => imported(c, { src: FILE, row: row2, worker: a.carer, recordId: "rec-1" })),
      ),
    ).toMatch(/training_record_external_key/);
    expect(
      await code(
        asHr((c) =>
          c.query(
            "UPDATE lms_import_row SET skip_reason = 'Not ours', outcome = 'skipped' WHERE id = $1",
            [ROW],
          ),
        ),
      ),
    ).toBe("lms_import_row_resolved");
    expect(
      await code(
        asHr((c) =>
          c.query("UPDATE training_record SET completed_on = DATE '2026-09-01' WHERE id = $1", [
            RECORD,
          ]),
        ),
      ),
    ).toBe("training_record_imported_fixed");
    expect(
      await code(
        asHr((c) =>
          c.query("UPDATE training_record SET source = 'harbour' WHERE id = $1", [RECORD]),
        ),
      ),
    ).toBe("training_record_source_fixed");
    // A record made in Harbour stays Harbour's.
    const own = await asHr((c) =>
      one(
        c.query<{ id: string }>(
          `INSERT INTO training_record (worker_id, topic, completed_on)
           VALUES ($1, 'fire_safety', DATE '2026-08-01') RETURNING id`,
          [a.northManager],
        ),
      ),
    );
    expect(
      await code(
        asHr((c) =>
          c.query(
            "UPDATE training_record SET source = 'lms', lms_source_id = $2, lms_import_row_id = $3, external_record_id = 'x' WHERE id = $1",
            [own.id, FILE, ROW],
          ),
        ),
      ),
    ).toBe("training_record_source_fixed");
    // Skipped with a reason, once; then the import closes, and takes no more rows.
    await asHr((c) =>
      c.query(
        "UPDATE lms_import_row SET outcome = 'skipped', skip_reason = 'Duplicate row' WHERE id = $1",
        [row2],
      ),
    );
    await asHr((c) => c.query("UPDATE lms_import SET status = 'closed' WHERE id = $1", [IMPORT]));
    expect(await code(asHr((c) => newRow(c, IMPORT, 3, a.carer, "rec-3")))).toBe(
      "lms_import_closed",
    );
  });

  it("keeps the import tables to holders of workforce.training.manage, in their organisation", async () => {
    for (const as of [asNorth, asCarer, asOtherTenant]) {
      const seen = await as(async (c) => ({
        sources: (await c.query("SELECT 1 FROM lms_source")).rowCount,
        links: (await c.query("SELECT 1 FROM lms_learner_link")).rowCount,
        imports: (await c.query("SELECT 1 FROM lms_import")).rowCount,
        rows: (await c.query("SELECT 1 FROM lms_import_row")).rowCount,
      }));
      expect(seen).toEqual({ sources: 0, links: 0, imports: 0, rows: 0 });
    }
    expect(await code(asNorth((c) => source(c, "file", "Other")))).toMatch(/row-level security/);
    // The imported record itself is read as any training record: the member sees their own.
    const mine = await asCarer((c) =>
      c.query<{ source: string }>("SELECT source FROM training_record WHERE id = $1", [RECORD]),
    );
    expect(mine.rows).toEqual([{ source: "lms" }]);
  });

  it("reads a training certificate as its training record, added only for someone else", async () => {
    const cert = (c: pg.PoolClient, recordId: string) =>
      c.query(
        `INSERT INTO document (category, title, retention_class, storage_key, content_type,
           size_bytes, sha256, subject_type, subject_id)
         VALUES ('training_certificate', 'Certificate', 'staff_file', 'k/' || app.uuid_v7(),
           'application/pdf', 10, $2, 'training_record', $1)`,
        [recordId, HASH],
      );
    expect(await code(asHr((c) => cert(c, RECORD)))).toBe("ok");
    expect(await code(asNorth((c) => cert(c, RECORD)))).toMatch(/row-level security/);
    const counted = (as: typeof asHr) =>
      as(
        async (c) =>
          (await c.query("SELECT 1 FROM document WHERE category = 'training_certificate'"))
            .rowCount,
      );
    expect(await counted(asCarer)).toBe(1);
    expect(await counted(asNorth)).toBe(1);
    expect(await counted(asOtherTenant)).toBe(0);
  });
});
