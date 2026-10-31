import { AUDIT_KINDS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUDIT_KIND_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The audit programme in the database (quality.md section 19; QUAL-004; migration 0081):
 * global starter templates read-only to the application; an organisation's templates for its
 * quality leads; audits seen only where the member runs audits at the audit's location, keeping
 * the questions and framework version they started with, fixed once completed; append-only actions
 * on a completed audit; nothing crossing tenants.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const TEMPLATE = "0199f000-0000-7000-8000-0000000007a1";
const AUDIT_NORTH = "0199f000-0000-7000-8000-0000000007b1";
const AUDIT_SOUTH = "0199f000-0000-7000-8000-0000000007b2";

const startAudit = (c: pg.PoolClient, id: string, location: string) =>
  c.query(
    `INSERT INTO audit_record (id, template_id, template_version, kind, title, questions,
       framework_version_id, location_id, audited_on)
     VALUES ($1, $2, 0, 'other', 'x', '[]'::jsonb, '0192f1a0-0000-7000-8000-000000000001', $3, '2026-10-31')`,
    [id, TEMPLATE, location],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const audits = "{quality.audit.manage}";
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f000-0000-7000-8000-000000000701', 'quality_owner', 'Owner', 'tenant', $1),
         ('0199f000-0000-7000-8000-000000000702', 'quality_north', 'North', 'location', $1)`,
      [audits],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f000-0000-7000-8000-000000000701', NULL),
         ($2, '0199f000-0000-7000-8000-000000000702', $3)`,
      [a.manager, a.northManager, a.locationNorth],
    );
  });
  await inContext(db.pool("harbour_owner"), ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199f000-0000-7000-8000-000000000703', 'quality_owner_b', 'Owner', 'tenant', $1)`,
      [audits],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199f000-0000-7000-8000-000000000703')",
      [b.manager],
    );
  });
  await asLead(async (c) => {
    await c.query(
      `INSERT INTO audit_template (id, key, kind, title, framework_version_id, questions, starter_key)
       SELECT $1, 'medication', kind, title, framework_version_id, questions, key
         FROM audit_starter_template WHERE key = 'medication'`,
      [TEMPLATE],
    );
    await startAudit(c, AUDIT_NORTH, a.locationNorth);
    await startAudit(c, AUDIT_SOUTH, a.locationSouth);
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("starter templates (migration 0081)", () => {
  it("seeds the seven starters, the IPC one included, for every role to read but not write", async () => {
    const { rows } = await asCarer((c) =>
      c.query<{ key: string }>("SELECT key FROM audit_starter_template ORDER BY key"),
    );
    expect(rows.map((r) => r.key)).toEqual([
      "care_plans",
      "dignity",
      "environment",
      "ipc",
      "medication",
      "mock_inspection",
      "night_visit",
    ]);
    await expect(
      asLead((c) => c.query("UPDATE audit_starter_template SET title = 'x' WHERE key = 'ipc'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("keeps the database's audit kinds in step with the domain", () => {
    expect([...AUDIT_KIND_CODES]).toEqual([...AUDIT_KINDS]);
  });
});

describe("audits keep what they were scored against (rule 4)", () => {
  it("copies the template's questions, version and framework into the audit, whatever was sent", async () => {
    const { rows } = await asLead((c) =>
      c.query<{ kind: string; n: number; fw: string }>(
        `SELECT kind, jsonb_array_length(questions) AS n, framework_version_id AS fw
           FROM audit_record WHERE id = $1`,
        [AUDIT_NORTH],
      ),
    );
    expect(rows[0]).toMatchObject({
      kind: "medication",
      fw: "0192f1a0-0000-7000-8000-000000000001",
    });
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("keeps the template, framework and place, and fixes a completed audit", async () => {
    await expect(
      asLead((c) =>
        c.query("UPDATE audit_record SET location_id = $2 WHERE id = $1", [
          AUDIT_NORTH,
          a.locationSouth,
        ]),
      ),
    ).rejects.toThrow(/keeps the template/);
    await expect(
      asLead((c) =>
        c.query("UPDATE audit_record SET self_rating = 3 WHERE id = $1", [AUDIT_NORTH]),
      ),
    ).rejects.toThrow(/Only completion/);
    await asLead((c) =>
      c.query(
        `UPDATE audit_record SET answers = (SELECT jsonb_object_agg(q->>'key',
           CASE q->>'key' WHEN 'mar_complete' THEN 'no' ELSE 'yes' END)
           FROM jsonb_array_elements(questions) q) WHERE id = $1`,
        [AUDIT_NORTH],
      ),
    );
    await expect(
      asLead((c) => c.query("UPDATE audit_record SET possible = 1 WHERE id = $1", [AUDIT_NORTH])),
    ).rejects.toThrow(/Only completion/);
    const complete = (scoreOffset: number) =>
      asLead((c) =>
        c.query(
          `WITH s AS (
             SELECT sum((q->>'weight')::numeric) AS possible,
                    sum((q->>'weight')::numeric) FILTER (WHERE q->>'key' <> 'mar_complete') AS achieved
               FROM audit_record, jsonb_array_elements(questions) q WHERE id = $1)
           UPDATE audit_record SET state = 'completed', self_rating = 3, possible = s.possible,
             achieved = s.achieved, score_percent = round(s.achieved * 100 / s.possible, 3) + $2
             FROM s WHERE id = $1`,
          [AUDIT_NORTH, scoreOffset],
        ),
      );
    await expect(complete(5)).rejects.toThrow(/score of its answers/);
    await complete(0);
    await expect(
      asLead((c) =>
        c.query("UPDATE audit_record SET self_rating = 4 WHERE id = $1", [AUDIT_NORTH]),
      ),
    ).rejects.toThrow(/never changes/);
    await expect(
      asLead((c) => c.query("DELETE FROM audit_record WHERE id = $1", [AUDIT_NORTH])),
    ).rejects.toThrow();
  });

  it("takes append-only actions on a question of a completed audit, due on or after it", async () => {
    const add = (audit: string, question: string, due: string) =>
      asLead((c) =>
        c.query(
          "INSERT INTO audit_action (audit_id, question_key, description, owner_id, due_on) VALUES ($1, $2, 'Retrain on MAR', $3, $4)",
          [audit, question, a.manager, due],
        ),
      );
    await add(AUDIT_NORTH, "mar_complete", "2026-11-28");
    await expect(add(AUDIT_NORTH, "not_a_question", "2026-11-28")).rejects.toThrow(
      /completed audit/,
    );
    await expect(add(AUDIT_NORTH, "mar_complete", "2026-10-01")).rejects.toThrow(/completed audit/);
    await expect(add(AUDIT_SOUTH, "mar_complete", "2026-11-28")).rejects.toThrow(/completed audit/);
    await expect(
      asLead((c) => c.query("UPDATE audit_action SET due_on = '2027-01-01'")),
    ).rejects.toThrow();
  });

  it("ties audits to the organisation's own locations, and actions to its members and tasks", async () => {
    await expect(
      asLead((c) => startAudit(c, "0199f000-0000-7000-8000-0000000007b4", b.location)),
    ).rejects.toThrow(/audit_record_location_fk/);
    await expect(
      asLead((c) =>
        c.query(
          "INSERT INTO audit_action (audit_id, question_key, description, owner_id, due_on) VALUES ($1, 'mar_complete', 'Retrain on MAR', $2, '2026-11-28')",
          [AUDIT_NORTH, b.manager],
        ),
      ),
    ).rejects.toThrow(/audit_action_owner_fk/);
  });

  it("never changes a retired template", async () => {
    const other = "0199f000-0000-7000-8000-0000000007a2";
    await asLead((c) =>
      c.query(
        `INSERT INTO audit_template (id, key, kind, title, framework_version_id, questions)
         SELECT $1, 'dignity-old', kind, title, framework_version_id, questions
           FROM audit_starter_template WHERE key = 'dignity'`,
        [other],
      ),
    );
    await asLead((c) =>
      c.query("UPDATE audit_template SET state = 'retired' WHERE id = $1", [other]),
    );
    await expect(
      asLead((c) => c.query("UPDATE audit_template SET title = 'Back' WHERE id = $1", [other])),
    ).rejects.toThrow(/retired audit template/);
  });
});

describe("hazard HZ-011 who sees audits", () => {
  it("shows a location's audits only to those who run audits there", async () => {
    const north = await asNorth((c) =>
      c.query<{ id: string }>("SELECT id FROM audit_record ORDER BY id"),
    );
    expect(north.rows.map((r) => r.id)).toEqual([AUDIT_NORTH]);
    await expect(
      asNorth((c) => startAudit(c, "0199f000-0000-7000-8000-0000000007b3", a.locationSouth)),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows nothing to a care worker or another organisation", async () => {
    for (const run of [asCarer, asOtherTenant]) {
      for (const table of ["audit_template", "audit_record", "audit_action", "audit_schedule"]) {
        const { rows } = await run((c) => c.query(`SELECT id FROM ${table}`));
        expect(rows, table).toEqual([]);
      }
    }
  });
});
