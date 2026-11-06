import {
  PATHWAY_CATEGORIES as DOMAIN_PATHWAY,
  CLOSING_REASONS as DOMAIN_REASONS,
  APPLICATION_STAGES as DOMAIN_STAGES,
  VACANCY_STATUSES as DOMAIN_VACANCY,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APPLICATION_STAGES,
  CLOSING_REASONS,
  PATHWAY_CATEGORIES,
  VACANCY_STATUSES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Applicant tracking in the database (workforce.md section 2c, rules 11 to 13; WORK-001;
 * migration 0085; hazard HZ-011): another organisation's records never seen or written; only
 * holders of workforce.recruitment.manage read or write them; equality monitoring added but never
 * read, only counted through app.equality_monitoring_counts; stage events and interviews never
 * changed or deleted; a closed application never reopens; nothing deleted.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** HR, with workforce.recruitment.manage (a role with no person scope). */
const asHr = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "none"), fn);
/** The care worker: no recruitment permission. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "none"), fn);

const TEMPLATE = "0199f200-0000-7000-8000-000000000001";
const VACANCY = "0199f200-0000-7000-8000-000000000002";
const APPLICANT = "0199f200-0000-7000-8000-000000000003";
const APPLICATION = "0199f200-0000-7000-8000-000000000004";
const INTERVIEW = "0199f200-0000-7000-8000-000000000005";
const B_TEMPLATE = "0199f200-0000-7000-8000-0000000000b1";
const B_VACANCY = "0199f200-0000-7000-8000-0000000000b2";

const count = async (c: pg.PoolClient, sql: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(sql, params)).rows[0]?.n);

async function seedRecruitment(c: pg.PoolClient, template: string, vacancy: string) {
  await c.query(
    `INSERT INTO job_template (id, title, pathway_category, essential_criteria, values_questions)
     VALUES ($1, 'Care worker', 'care_worker', '["Can work weekends", "Right to work"]'::jsonb,
       '[{"key":"q1","value":"compassion","question":"Q1"},{"key":"q2","value":"courage","question":"Q2"}]'::jsonb)`,
    [template],
  );
  await c.query(
    `INSERT INTO vacancy (id, job_template_id, title, opens_on, status)
     VALUES ($1, $2, 'Care worker, nights', '2026-10-01', 'open')`,
    [vacancy, template],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  for (const [tenant, member, role] of [
    [TENANT_A, a.manager, "0199f200-0000-7000-8000-000000000501"],
    [TENANT_B, b.manager, "0199f200-0000-7000-8000-000000000502"],
  ] as const) {
    await asOwner(tenant, async (c) => {
      await c.query(
        `INSERT INTO role (id, key, name, scope_kind, permissions)
         VALUES ($1, 'hr', 'HR', 'none', '{workforce.recruitment.manage}')`,
        [role],
      );
      await c.query(`INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)`, [
        member,
        role,
      ]);
    });
  }
  await asHr(async (c) => {
    await seedRecruitment(c, TEMPLATE, VACANCY);
    await c.query(
      `INSERT INTO applicant (id, given_name, family_name, email)
       VALUES ($1, 'Ada', 'Applicant', 'ada.applicant@example.invalid')`,
      [APPLICANT],
    );
    await c.query(`INSERT INTO application (id, vacancy_id, applicant_id) VALUES ($1, $2, $3)`, [
      APPLICATION,
      VACANCY,
      APPLICANT,
    ]);
    await c.query(
      `INSERT INTO application_event (application_id, to_stage) VALUES ($1, 'applied')`,
      [APPLICATION],
    );
    await c.query(
      `INSERT INTO interview (id, application_id, held_on, panel, scores, recommendation)
       VALUES ($1, $2, '2026-10-20', ARRAY[$3::uuid], '{"q1":3,"q2":4}'::jsonb, 'proceed')`,
      [INTERVIEW, APPLICATION, a.manager],
    );
    // Forms are added once applications have closed (rule 12).
    await c.query("UPDATE vacancy SET status = 'closed' WHERE id = $1", [VACANCY]);
    for (const answers of [
      { sex: "female", disability: "no" },
      { sex: "female" },
      { sex: "female" },
      { sex: "female" },
      { sex: "female" },
      { sex: "male", disability: "prefer_not_to_say" },
    ]) {
      await c.query(
        `INSERT INTO equality_monitoring (vacancy_id, answers) VALUES ($1, $2::jsonb)`,
        [VACANCY, JSON.stringify(answers)],
      );
    }
  });
  await inContext(app(), ctx(TENANT_B, b.manager, "none"), (c) =>
    seedRecruitment(c, B_TEMPLATE, B_VACANCY),
  );
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("the codes match the domain", () => {
  it("keeps the stages, reasons, statuses and pathway categories in step", () => {
    expect([...APPLICATION_STAGES]).toEqual([...DOMAIN_STAGES]);
    expect([...CLOSING_REASONS]).toEqual([...DOMAIN_REASONS]);
    expect([...VACANCY_STATUSES]).toEqual([...DOMAIN_VACANCY]);
    expect([...PATHWAY_CATEGORIES]).toEqual([...DOMAIN_PATHWAY]);
  });
});

describe("hazard HZ-011 applicant tracking isolation (migration 0085)", () => {
  const TABLES = [
    "job_template",
    "vacancy",
    "applicant",
    "application",
    "application_event",
    "interview",
  ];

  it("shows HR their own organisation's records and none of another's", async () => {
    await asHr(async (c) => {
      for (const table of TABLES) {
        expect(await count(c, `SELECT count(*) AS n FROM ${table}`), table).toBeGreaterThan(0);
      }
      expect(
        await count(c, "SELECT count(*) AS n FROM job_template WHERE id = $1", [B_TEMPLATE]),
      ).toBe(0);
    });
    await asOtherTenant(async (c) => {
      for (const table of TABLES.slice(2)) {
        expect(await count(c, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
      expect(await count(c, "SELECT count(*) AS n FROM vacancy WHERE id = $1", [VACANCY])).toBe(0);
    });
  });

  it("refuses another organisation's writes to these records", async () => {
    await asOtherTenant(async (c) => {
      const updated = await c.query("UPDATE applicant SET phone = '0' WHERE id = $1", [APPLICANT]);
      expect(updated.rowCount).toBe(0);
      await expect(
        c.query(`INSERT INTO application (vacancy_id, applicant_id) VALUES ($1, $2)`, [
          VACANCY,
          APPLICANT,
        ]),
      ).rejects.toThrow();
    });
  });

  it("hides every record from someone without workforce.recruitment.manage", async () => {
    await asCarer(async (c) => {
      for (const table of TABLES) {
        expect(await count(c, `SELECT count(*) AS n FROM ${table}`), table).toBe(0);
      }
      await expect(
        c.query(`INSERT INTO applicant (given_name, family_name) VALUES ('Bea', 'Applicant')`),
      ).rejects.toThrow(/row-level security/);
    });
  });
});

describe("rule 12: equality monitoring is counted, never read", () => {
  it("lets nobody read a form, not even HR", async () => {
    await asHr(async (c) => {
      await expect(c.query("SELECT * FROM equality_monitoring")).rejects.toThrow(
        /permission denied/,
      );
    });
  });

  it("takes forms only after applications close and before the counts are released", async () => {
    await inContext(app(), ctx(TENANT_B, b.manager, "none"), async (c) => {
      // Another organisation's vacancy B is open: no form, and no counts yet.
      await expect(
        c.query(`INSERT INTO equality_monitoring (vacancy_id, answers) VALUES ($1, '{}'::jsonb)`, [
          B_VACANCY,
        ]),
      ).rejects.toThrow(/row-level security/);
    });
    await inContext(app(), ctx(TENANT_B, b.manager, "none"), async (c) => {
      await expect(
        c.query("SELECT * FROM app.equality_monitoring_counts($1)", [B_VACANCY]),
      ).rejects.toThrow(/once the vacancy has closed/);
    });
    await inContext(app(), ctx(TENANT_B, b.manager, "none"), async (c) => {
      await c.query(
        "UPDATE vacancy SET status = 'closed', equality_summarised_at = now() WHERE id = $1",
        [B_VACANCY],
      );
    });
    await inContext(app(), ctx(TENANT_B, b.manager, "none"), async (c) => {
      await expect(
        c.query(`INSERT INTO equality_monitoring (vacancy_id, answers) VALUES ($1, '{}'::jsonb)`, [
          B_VACANCY,
        ]),
      ).rejects.toThrow(/row-level security/);
    });
  });

  it("counts a vacancy's answers for HR, and for nobody else", async () => {
    const rows = await asHr((c) =>
      c.query<{ question: string; answer: string; n: string | null }>(
        "SELECT question, answer, n FROM app.equality_monitoring_counts($1) ORDER BY question, answer",
        [VACANCY],
      ),
    );
    const counts = Object.fromEntries(
      rows.rows.map((r) => [`${r.question}:${r.answer}`, r.n === null ? Number.NaN : Number(r.n)]),
    );
    // Counts from 1 to 4 never leave the database: they come back as null.
    expect(counts).toEqual({
      "__forms:": 6,
      "sex:female": 5,
      "sex:male": Number.NaN,
      "disability:no": Number.NaN,
      "disability:prefer_not_to_say": Number.NaN,
    });
    await asCarer(async (c) => {
      await expect(
        c.query("SELECT * FROM app.equality_monitoring_counts($1)", [VACANCY]),
      ).rejects.toThrow(/workforce.recruitment.manage/);
    });
    // Another organisation's HR counts nothing of this vacancy.
    const other = await asOtherTenant((c) =>
      c.query<{ n: string }>(
        "SELECT n FROM app.equality_monitoring_counts($1) WHERE question = '__forms'",
        [VACANCY],
      ),
    );
    expect(Number(other.rows[0]?.n)).toBe(0);
  });
});

describe("history and closed applications", () => {
  it("never changes or deletes a stage event or an interview", async () => {
    await asHr(async (c) => {
      await expect(
        c.query("UPDATE interview SET recommendation = 'do_not_proceed' WHERE id = $1", [
          INTERVIEW,
        ]),
      ).rejects.toThrow();
    });
    // Each in its own transaction: a refusal aborts the one it is in.
    for (const table of ["application_event", "interview", "applicant"]) {
      await asOwner(TENANT_A, async (c) => {
        await expect(c.query(`DELETE FROM ${table}`), table).rejects.toThrow();
      });
    }
  });

  it("never reopens a closed application, nor moves it to another applicant", async () => {
    await asHr(async (c) => {
      await c.query(
        `UPDATE application SET stage = 'rejected', stage_reason = 'criteria_not_met',
           closed_on = '2026-10-22' WHERE id = $1`,
        [APPLICATION],
      );
      await expect(
        c.query("UPDATE application SET stage = 'shortlisted', closed_on = NULL WHERE id = $1", [
          APPLICATION,
        ]),
      ).rejects.toThrow(/does not reopen/);
    });
  });

  it("keeps an open application without a closing date, and a closed one with it", async () => {
    await asHr(async (c) => {
      await expect(
        c.query(
          `INSERT INTO application (vacancy_id, applicant_id, stage, closed_on)
           VALUES ($1, $2, 'withdrawn', NULL)`,
          [VACANCY, APPLICANT],
        ),
      ).rejects.toThrow();
    });
  });

  it("keeps a redacted applicant redacted, and a talent pool with its consent", async () => {
    await asHr(async (c) => {
      await expect(
        c.query("UPDATE applicant SET talent_pool_until = '2027-10-01' WHERE id = $1", [APPLICANT]),
      ).rejects.toThrow();
    });
    await asHr((c) =>
      c.query(
        `UPDATE applicant SET given_name = NULL, family_name = NULL, email = NULL, phone = NULL,
           redacted_at = now() WHERE id = $1`,
        [APPLICANT],
      ),
    );
    await asHr(async (c) => {
      await expect(
        c.query(
          "UPDATE applicant SET redacted_at = NULL, given_name = 'Ada', family_name = 'A' WHERE id = $1",
          [APPLICANT],
        ),
      ).rejects.toThrow(/stays redacted/);
    });
  });
});
