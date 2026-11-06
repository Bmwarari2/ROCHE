import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * E-learning courses, attempts and statements in the database (workforce.md section 14; ADR-0093;
 * slice 43; migration 0112): cross-tenant denial; courses read by staff and written by training
 * leads; attempts and statements the member's own, read by training leads; only the system links
 * a completion's training record; a settled completion is kept; statements never change; nothing
 * is deleted. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
/** A training lead (workforce.training.manage). */
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** The care worker, with workforce.self.read only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
/** Another member with workforce.self.read only. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const HASH = "a".repeat(64);
const COURSE = "0199f300-0000-7000-8000-0000000000c1";
const ATTEMPT = "0199f300-0000-7000-8000-0000000000a1";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000501', 'lead', 'Training lead', 'none',
          '{workforce.training.manage}'),
         ('0199f300-0000-7000-8000-000000000503', 'self', 'Self', 'assigned', '{workforce.self.read}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f300-0000-7000-8000-000000000501', NULL),
         ($2, '0199f300-0000-7000-8000-000000000503', $4),
         ($3, '0199f300-0000-7000-8000-000000000503', $4)`,
      [a.manager, a.carer, a.northManager, a.locationNorth],
    );
    await c.query(
      `INSERT INTO document (id, category, title, retention_class, storage_key, content_type, size_bytes, sha256)
       VALUES ('0199f300-0000-7000-8000-0000000000d1', 'elearning_package', 'Fire safety', 'organisation_document', 'k', 'application/zip', 10, $1)`,
      [HASH],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const INDEX = JSON.stringify(
  ["index.html", "app.js", "imsmanifest.xml"].map((p, i) => ({
    p,
    o: i * 100,
    c: 50,
    u: 50,
    k: 0,
    m: 0,
  })),
);
const course = (
  c: pg.PoolClient,
  launch = "index.html",
  id = COURSE,
  documentId = "0199f300-0000-7000-8000-0000000000d1",
) =>
  c.query(
    `INSERT INTO elearning_course (id, title, topic, standard, document_id, package_sha256, launch_path, file_count, unpacked_bytes, package_index)
     VALUES ($1, 'Fire safety', 'fire_safety', 'scorm_1_2', $4, $2, $3, 3, 1000, $5)`,
    [id, HASH, launch, documentId, INDEX],
  );

describe("WORK-006 courses", () => {
  it("are added by training leads only, with a launch path inside the package", async () => {
    await expect(asCarer((c) => course(c))).rejects.toThrow(/row-level security/);
    await expect(asLead((c) => course(c, "../escape.html"))).rejects.toThrow(
      /elearning_course_launch_path/,
    );
    await asLead((c) => course(c));
  });

  it("keep an e-learning package as their package, never another document (review L1)", async () => {
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO document (id, category, title, retention_class, storage_key, content_type, size_bytes, sha256)
         VALUES ('0199f300-0000-7000-8000-0000000000d2', 'organisation_document', 'Policy', 'organisation_document', 'k2', 'application/pdf', 10, $1)`,
        [HASH],
      ),
    );
    await expect(
      asLead((c) =>
        course(
          c,
          "index.html",
          "0199f300-0000-7000-8000-0000000000c2",
          "0199f300-0000-7000-8000-0000000000d2",
        ),
      ),
    ).rejects.toThrow(/e-learning package/);
    await expect(
      asLead((c) =>
        c.query("UPDATE elearning_course SET document_id = $1 WHERE id = $2", [
          "0199f300-0000-7000-8000-0000000000d2",
          COURSE,
        ]),
      ),
    ).rejects.toThrow(/e-learning package/);
  });

  it("are read by staff and not by another organisation", async () => {
    expect((await asCarer((c) => c.query("SELECT id FROM elearning_course"))).rows).toHaveLength(1);
    expect((await asOtherTenant((c) => c.query("SELECT id FROM elearning_course"))).rows).toEqual(
      [],
    );
  });
});

describe("WORK-006 attempts and statements are the member's own", () => {
  it("are started by the member for themselves only", async () => {
    await expect(
      asNorth((c) =>
        c.query("INSERT INTO elearning_attempt (course_id, worker_id) VALUES ($1, $2)", [
          COURSE,
          a.carer,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    await asCarer((c) =>
      c.query("INSERT INTO elearning_attempt (id, course_id, worker_id) VALUES ($1, $2, $3)", [
        ATTEMPT,
        COURSE,
        a.carer,
      ]),
    );
    expect((await asNorth((c) => c.query("SELECT id FROM elearning_attempt"))).rows).toEqual([]);
    expect((await asLead((c) => c.query("SELECT id FROM elearning_attempt"))).rows).toHaveLength(1);
    expect((await asOtherTenant((c) => c.query("SELECT id FROM elearning_attempt"))).rows).toEqual(
      [],
    );
  });

  it("keep their member and course, and only the system links the training record", async () => {
    await expect(
      asCarer((c) =>
        c.query("UPDATE elearning_attempt SET worker_id = $2 WHERE id = $1", [
          ATTEMPT,
          a.northManager,
        ]),
      ),
    ).rejects.toThrow(/keeps its member/);
    await asCarer((c) =>
      c.query("UPDATE elearning_attempt SET status = 'passed', score = 0.9 WHERE id = $1", [
        ATTEMPT,
      ]),
    );
    // The member cannot write their own training record or link one.
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO training_record (worker_id, topic, completed_on) VALUES ($1, 'fire_safety', CURRENT_DATE)",
          [a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const record = await asSystem((c) =>
      c.query<{ id: string }>(
        "INSERT INTO training_record (worker_id, topic, completed_on, provider) VALUES ($1, 'fire_safety', CURRENT_DATE, 'Harbour e-learning') RETURNING id",
        [a.carer],
      ),
    );
    const recordId = record.rows[0]?.id;
    await expect(
      asCarer((c) =>
        c.query("UPDATE elearning_attempt SET training_record_id = $2 WHERE id = $1", [
          ATTEMPT,
          recordId,
        ]),
      ),
    ).rejects.toThrow(/only the system/);
    await asSystem((c) =>
      c.query("UPDATE elearning_attempt SET training_record_id = $2 WHERE id = $1", [
        ATTEMPT,
        recordId,
      ]),
    );
  });

  it("keep a settled completion", async () => {
    await expect(
      asCarer((c) =>
        c.query("UPDATE elearning_attempt SET status = 'failed' WHERE id = $1", [ATTEMPT]),
      ),
    ).rejects.toThrow(/settled outcome/);
  });

  it("keep a fail: a retake is a new attempt (review M1)", async () => {
    const failed = "0199f300-0000-7000-8000-0000000000a9";
    await asCarer((c) =>
      c.query(
        "INSERT INTO elearning_attempt (id, course_id, worker_id, status) VALUES ($1, $2, $3, 'failed')",
        [failed, COURSE, a.carer],
      ),
    );
    await expect(
      asCarer((c) =>
        c.query("UPDATE elearning_attempt SET status = 'passed' WHERE id = $1", [failed]),
      ),
    ).rejects.toThrow(/settled outcome/);
  });

  it("keep statements as sent, for the member's own attempt only", async () => {
    const insert = (c: pg.PoolClient) =>
      c.query(
        `INSERT INTO elearning_statement (attempt_id, statement_id, verb, statement)
         VALUES ($1, gen_random_uuid(), 'http://adlnet.gov/expapi/verbs/completed', '{"verb":{}}')`,
        [ATTEMPT],
      );
    await expect(asNorth(insert)).rejects.toThrow(/row-level security/);
    await asCarer(insert);
    await expect(
      asCarer((c) => c.query("UPDATE elearning_statement SET verb = 'http://x.example.invalid'")),
    ).rejects.toThrow();
    expect((await asLead((c) => c.query("SELECT id FROM elearning_statement"))).rows).toHaveLength(
      1,
    );
    expect((await asNorth((c) => c.query("SELECT id FROM elearning_statement"))).rows).toEqual([]);
  });

  it("are never deleted", async () => {
    for (const table of ["elearning_course", "elearning_attempt", "elearning_statement"]) {
      await expect(asLead((c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
