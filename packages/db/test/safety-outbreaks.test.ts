import { readFileSync } from "node:fs";
import {
  BUILTIN_ROLES,
  checkIpcTemplate,
  IPC_CODE_CRITERIA,
  type IpcAuditQuestion,
  OUTBREAK_CASE_OUTCOMES,
  OUTBREAK_CASE_TYPES,
  OUTBREAK_STATES,
  OUTBREAK_SYMPTOMS,
  OUTBREAK_SYNDROMES,
  OUTBREAK_TEST_RESULTS,
  OUTBREAK_TEST_TYPES,
  VACCINATION_ANSWERS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OUTBREAK_CASE_OUTCOME_CODES,
  OUTBREAK_CASE_TYPE_CODES,
  OUTBREAK_STATE_CODES,
  OUTBREAK_SYMPTOM_CODES,
  OUTBREAK_SYNDROME_CODES,
  OUTBREAK_TEST_RESULT_CODES,
  OUTBREAK_TEST_TYPE_CODES,
  VACCINATION_ANSWER_CODES,
} from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Outbreaks and IPC audits in the database (safety.md section 11; SAFE-013; migration 0093): the
 * Code of Practice criteria and the IPC starter mapped to them; outbreaks declared in the
 * declarer's name, one open per place and illness, closed once and only when the UKHSA report is
 * decided (HZ-013); an append-only line list of residents at the place and staff; nothing seen
 * without `safety.outbreak.manage` at the place or across organisations (HZ-011).
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const owner = () => db.pool("harbour_owner");
const asLead = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const NORTH = "0199f000-0000-7000-8000-000000000931";
const SOUTH = "0199f000-0000-7000-8000-000000000932";
const REPORT = "0199f000-0000-7000-8000-000000000941";

const declare = (c: pg.PoolClient, id: string, location: string, syndrome = "acute_respiratory") =>
  c.query("INSERT INTO outbreak (id, location_id, syndrome) VALUES ($1, $2, $3)", [
    id,
    location,
    syndrome,
  ]);

const addCase = (
  c: pg.PoolClient,
  outbreakId: string,
  over: {
    person?: string | null;
    staff?: string | null;
    supersedes?: string | null;
    onset?: string;
  } = {},
) =>
  c.query<{ id: string }>(
    `INSERT INTO outbreak_case (outbreak_id, case_type, person_id, tenant_user_id, onset_on,
       symptoms, test_result, flu_vaccinated, covid_vaccinated, outcome, supersedes_id)
     VALUES ($1, $2, $3, $4, $5, '{cough,fever}', 'not_tested', 'yes', 'unknown', 'unwell', $6)
     RETURNING id`,
    [
      outbreakId,
      over.staff ? "staff" : "resident",
      over.staff ? null : (over.person ?? a.personAda),
      over.staff ?? null,
      over.onset ?? "2026-10-28",
      over.supersedes ?? null,
    ],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  const perms = "{safety.outbreak.manage,people.person.read}";
  await inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f000-0000-7000-8000-000000000901', 'outbreak_owner', 'Owner', 'tenant', $1),
         ('0199f000-0000-7000-8000-000000000902', 'outbreak_north', 'North', 'location', $1)`,
      [perms],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f000-0000-7000-8000-000000000901', NULL),
         ($2, '0199f000-0000-7000-8000-000000000902', $3)`,
      [a.manager, a.northManager, a.locationNorth],
    );
    // The carer works at North (a staff case is someone working at the outbreak's location).
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.carer, a.roleCarer, a.locationNorth],
    );
    await c.query(
      `INSERT INTO statutory_notification (id, location_id, source_key, kind, due_at, retention_class)
       VALUES ($1, $2, 'outbreak:test', 'ukhsa_outbreak', now(), 'serious_incident')`,
      [REPORT, a.locationNorth],
    );
  });
  await inContext(owner(), ctx(TENANT_B, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199f000-0000-7000-8000-000000000903', 'outbreak_owner_b', 'Owner', 'tenant', $1)`,
      [perms],
    );
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, '0199f000-0000-7000-8000-000000000903')",
      [b.manager],
    );
  });
  await asLead(async (c) => {
    await declare(c, NORTH, a.locationNorth);
    await declare(c, SOUTH, a.locationSouth, "diarrhoea_vomiting");
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("IPC audits against the Code of Practice criteria (migration 0093)", () => {
  it("seeds the ten criteria, in step with the domain, for every role to read but not write", async () => {
    const { rows } = await asCarer((c) =>
      c.query<{ id: string; title: string }>(
        "SELECT id, title FROM ipc_code_criterion ORDER BY number",
      ),
    );
    expect(rows).toEqual(IPC_CODE_CRITERIA.map(({ id, title }) => ({ id, title })));
    await expect(
      asLead((c) => c.query("UPDATE ipc_code_criterion SET title = 'x' WHERE number = 1")),
    ).rejects.toThrow(/permission denied/);
  });

  it("maps every question of the IPC starter to criteria, covering all ten", async () => {
    const { rows } = await asLead((c) =>
      c.query<{ questions: IpcAuditQuestion[] }>(
        "SELECT questions FROM audit_starter_template WHERE key = 'ipc'",
      ),
    );
    const questions = rows[0]?.questions ?? [];
    expect(checkIpcTemplate(questions)).toEqual([]);
    const covered = new Set(questions.flatMap((q) => q.ipcCriteria ?? []));
    expect([...covered].sort()).toEqual(IPC_CODE_CRITERIA.map((c) => c.id).sort());
  });

  it("keeps the database's outbreak codes in step with the domain", () => {
    expect([...OUTBREAK_SYNDROME_CODES]).toEqual([...OUTBREAK_SYNDROMES]);
    expect([...OUTBREAK_STATE_CODES]).toEqual([...OUTBREAK_STATES]);
    expect([...OUTBREAK_CASE_TYPE_CODES]).toEqual([...OUTBREAK_CASE_TYPES]);
    expect([...OUTBREAK_SYMPTOM_CODES]).toEqual([...OUTBREAK_SYMPTOMS]);
    expect([...OUTBREAK_TEST_TYPE_CODES]).toEqual([...OUTBREAK_TEST_TYPES]);
    expect([...OUTBREAK_TEST_RESULT_CODES]).toEqual([...OUTBREAK_TEST_RESULTS]);
    expect([...VACCINATION_ANSWER_CODES]).toEqual([...VACCINATION_ANSWERS]);
    expect([...OUTBREAK_CASE_OUTCOME_CODES]).toEqual([...OUTBREAK_CASE_OUTCOMES]);
  });
});

describe("outbreaks", () => {
  it("are declared open in the declarer's name, one open per place and illness", async () => {
    const { rows } = await asLead((c) =>
      c.query<{ declared_by: string; state: string }>(
        "SELECT declared_by, state FROM outbreak WHERE id = $1",
        [NORTH],
      ),
    );
    expect(rows[0]).toEqual({ declared_by: a.manager, state: "declared" });
    await expect(
      asLead((c) => declare(c, "0199f000-0000-7000-8000-000000000933", a.locationNorth)),
    ).rejects.toThrow(/outbreak_one_open/);
    await expect(
      asLead((c) =>
        c.query(
          "INSERT INTO outbreak (location_id, syndrome, declared_by) VALUES ($1, 'flu', $2)",
          [a.locationNorth, a.northManager],
        ),
      ),
    ).rejects.toThrow(/declarer's name/);
    await expect(
      asLead((c) => declare(c, "0199f000-0000-7000-8000-000000000934", b.location)),
    ).rejects.toThrow(/outbreak_location_fk/);
  });

  it("keep their place and illness, and record a closure only by closing", async () => {
    await expect(
      asLead((c) => c.query("UPDATE outbreak SET syndrome = 'flu' WHERE id = $1", [NORTH])),
    ).rejects.toThrow(/keeps its place/);
    await expect(
      asLead((c) => c.query("UPDATE outbreak SET closure_reason = 'Over' WHERE id = $1", [NORTH])),
    ).rejects.toThrow(/Only closing/);
    await asLead((c) =>
      c.query("UPDATE outbreak SET hpt_reference = 'HPT-1' WHERE id = $1", [NORTH]),
    );
  });
});

describe("the line list", () => {
  let first: string;

  it("takes residents of the outbreak's place and staff, once each, superseded by updates", async () => {
    first = (await asLead((c) => addCase(c, NORTH))).rows[0]?.id as string;
    await asLead((c) => addCase(c, NORTH, { staff: a.carer }));
    await expect(asLead((c) => addCase(c, NORTH, { person: a.personCara }))).rejects.toThrow(
      /living at the outbreak's location/,
    );
    await expect(asLead((c) => addCase(c, NORTH))).rejects.toThrow(/already on the line list/);
    await asLead((c) => addCase(c, NORTH, { supersedes: first }));
    await expect(asLead((c) => addCase(c, NORTH, { supersedes: first }))).rejects.toThrow(
      /outbreak_case_superseded_once/,
    );
    await expect(
      asLead((c) => addCase(c, NORTH, { person: a.personBen, supersedes: first })),
    ).rejects.toThrow(/same person's case/);
  });

  it("refuses a case dated in the future, and never changes or deletes one", async () => {
    await expect(
      asLead((c) => addCase(c, NORTH, { person: a.personBen, onset: "2999-01-01" })),
    ).rejects.toThrow(/future/);
    await expect(
      asLead((c) => c.query("UPDATE outbreak_case SET outcome = 'died' WHERE id = $1", [first])),
    ).rejects.toThrow();
    await expect(
      asLead((c) => c.query("DELETE FROM outbreak_case WHERE id = $1", [first])),
    ).rejects.toThrow();
  });
});

describe("hazard HZ-013 an outbreak closes only once its report is decided", () => {
  it("refuses closure while the linked report is a draft, then closes once and stays closed", async () => {
    await asLead((c) =>
      c.query("UPDATE outbreak SET notification_id = $2 WHERE id = $1", [NORTH, REPORT]),
    );
    const close = () =>
      asLead((c) =>
        c.query(
          "UPDATE outbreak SET state = 'closed', closed_on = (now() AT TIME ZONE 'Europe/London')::date, closed_by = $2, closure_reason = 'No new cases; agreed with the HPT' WHERE id = $1",
          [NORTH, a.manager],
        ),
      );
    await expect(close()).rejects.toThrow(/report is submitted or recorded as not needed/);
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        "UPDATE statutory_notification SET status = 'not_required', not_required_reason = 'Reported by phone' WHERE id = $1",
        [REPORT],
      ),
    );
    await close();
    const { rows } = await asLead((c) =>
      c.query<{ closed_by: string }>("SELECT closed_by FROM outbreak WHERE id = $1", [NORTH]),
    );
    expect(rows[0]?.closed_by).toBe(a.manager);
    await expect(
      asLead((c) => c.query("UPDATE outbreak SET hpt_reference = 'HPT-2' WHERE id = $1", [NORTH])),
    ).rejects.toThrow(/closed outbreak never changes/);
    await expect(asLead((c) => addCase(c, NORTH, { person: a.personBen }))).rejects.toThrow(
      /open outbreak/,
    );
    await expect(
      asLead((c) => c.query("DELETE FROM outbreak WHERE id = $1", [NORTH])),
    ).rejects.toThrow();
  });
});

describe("hazard HZ-011 who sees outbreaks", () => {
  it("shows a place's outbreaks and cases only to those who manage outbreaks there", async () => {
    const north = await asNorth((c) =>
      c.query<{ id: string }>("SELECT id FROM outbreak ORDER BY id"),
    );
    expect(north.rows.map((r) => r.id)).toEqual([NORTH]);
    await expect(
      asNorth((c) => declare(c, "0199f000-0000-7000-8000-000000000935", a.locationSouth, "flu")),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows nothing to a care worker or another organisation", async () => {
    for (const run of [asCarer, asOtherTenant]) {
      for (const table of ["outbreak", "outbreak_case"]) {
        const { rows } = await run((c) => c.query(`SELECT id FROM ${table}`));
        expect(rows, table).toEqual([]);
      }
    }
  });
});

describe("existing organisations' built-in roles (migration 0093)", () => {
  it("gain safety.outbreak.manage where the built-in definitions now hold it, once", async () => {
    const sql = readFileSync(
      new URL("../drizzle/0093_safety_outbreaks_ipc.sql", import.meta.url),
      "utf8",
    );
    const start = sql.indexOf("ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;");
    const block = sql
      .slice(start)
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        "INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES ('clinical_lead', 'Clinical lead', 'location', '{care.plan.read}', true)",
      ),
    );
    const run = async () => {
      const client = await owner().connect();
      try {
        await client.query("BEGIN");
        for (const statement of block) await client.query(statement);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
    };
    await run();
    await run();
    const roles = await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query<{ permissions: string[] }>(
        "SELECT permissions FROM role WHERE key = 'clinical_lead' AND is_builtin",
      ),
    );
    expect(roles.rows[0]?.permissions).toEqual(["care.plan.read", "safety.outbreak.manage"]);
    const events = await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        "SELECT 1 FROM audit_event WHERE action = 'platform.role.permissions_migrated' AND scope->>'migration' = '0093_safety_outbreaks_ipc'",
      ),
    );
    expect(events.rows).toHaveLength(1);
    const builtIn = BUILTIN_ROLES.filter((r) =>
      r.permissions.includes("safety.outbreak.manage"),
    ).map((r) => r.key);
    expect(builtIn.sort()).toEqual([
      "clinical_lead",
      "deputy_manager",
      "owner",
      "registered_manager",
    ]);
  });
});

describe("the line list's edges (security and clinical review, round 1)", () => {
  const asAssignedNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(TENANT_A, a.northManager, "assigned"), fn);

  it("refuses staff who do not work at the outbreak's place, and people of another organisation", async () => {
    await expect(asLead((c) => addCase(c, SOUTH, { staff: a.northManager }))).rejects.toThrow(
      /working at the outbreak's location/,
    );
    await expect(asLead((c) => addCase(c, SOUTH, { person: b.personDev }))).rejects.toThrow();
    await expect(asLead((c) => addCase(c, SOUTH, { staff: b.manager }))).rejects.toThrow();
  });

  it("lets an update follow its row after the person has moved", async () => {
    const cara = (await asLead((c) => addCase(c, SOUTH, { person: a.personCara }))).rows[0]?.id;
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personCara, a.locationNorth]),
    );
    try {
      await asLead((c) => addCase(c, SOUTH, { person: a.personCara, supersedes: cara }));
    } finally {
      await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query("UPDATE person SET location_id = $2 WHERE id = $1", [
          a.personCara,
          a.locationSouth,
        ]),
      );
    }
  });

  it("hides residents' rows from a manager who cannot see them", async () => {
    const rows = await asAssignedNorth((c) =>
      c.query<{ case_type: string }>("SELECT case_type FROM outbreak_case WHERE outbreak_id = $1", [
        NORTH,
      ]),
    );
    expect(rows.rows.map((r) => r.case_type)).toEqual(["staff"]);
  });

  it("gives each report to one outbreak, and never closes one without its report", async () => {
    await expect(
      asLead((c) =>
        c.query("UPDATE outbreak SET notification_id = $2 WHERE id = $1", [SOUTH, REPORT]),
      ),
    ).rejects.toThrow(/outbreak_notification_once/);
    await expect(
      asLead((c) =>
        c.query(
          "UPDATE outbreak SET state = 'closed', closed_on = (now() AT TIME ZONE 'Europe/London')::date, closed_by = $2, closure_reason = 'Over' WHERE id = $1",
          [SOUTH, a.manager],
        ),
      ),
    ).rejects.toThrow(/report is submitted or recorded as not needed/);
  });

  it("grants the application no delete on outbreaks or cases", async () => {
    for (const table of ["outbreak", "outbreak_case"]) {
      await expect(asLead((c) => c.query(`DELETE FROM ${table}`))).rejects.toThrow(
        /permission denied/,
      );
    }
  });
});
