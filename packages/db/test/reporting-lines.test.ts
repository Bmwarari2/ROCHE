import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Reporting lines widen development scope (ADR-0137, amending ADR-0136; migration 0162): a line
 * manager reads their current direct reports' development records, wherever those reports work; a
 * team lead reads their current team's; a former line manager reads none once the line has ended;
 * a line manager who holds no development permission reads none (the relationship grants nothing by
 * itself); HR reads everyone; a home's manager reads their home; another organisation reads nothing.
 * Reporting lines are maintained only by organisation-wide holders of workforce.staff_file.manage,
 * never with oneself as line manager, never across organisations, and every change keeps a version.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

const id = (n: number) => `0199f400-0000-7000-8000-${String(n).padStart(12, "0")}`;
const ROLE = { hr: id(501), home: id(502), staff: id(503), keyworker: id(504), selfie: id(505) };
const HR = id(601);
const HOME = id(602);
const LINE = id(603);
const FORMER = id(604);
const LEAD = id(605);
const BARE = id(606);
const MGR_A = id(607);
const SELFIE = id(608);
const W_NORTH = id(611);
const W_SOUTH = id(612);
const W_TEAM = id(613);
const W_OTHER = id(614);
const W_B = id(615);
const WORKERS: readonly string[] = [W_NORTH, W_SOUTH, W_TEAM, W_OTHER, W_B];
const TEAM = id(701);
const OLD_TEAM = id(702);
const DAY_TEAM = id(703);
const B_HR = id(801);

const READERS = {
  hr: () => ctx(TENANT_A, HR, "none"),
  home: () => ctx(TENANT_A, HOME, "locations", [a.locationNorth]),
  line: () => ctx(TENANT_A, LINE, "assigned"),
  former: () => ctx(TENANT_A, FORMER, "assigned"),
  lead: () => ctx(TENANT_A, LEAD, "assigned"),
  bare: () => ctx(TENANT_A, BARE, "locations", [a.locationSouth]),
  mgrA: () => ctx(TENANT_A, MGR_A, "locations", [a.locationNorth]),
  selfie: () => ctx(TENANT_A, SELFIE, "assigned"),
  other: () => ctx(TENANT_B, B_HR, "none"),
};
type Who = keyof typeof READERS;
const as = <T>(who: Who, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), READERS[who](), fn);
const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
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
              ('competence.default_refresh_months', 12, 'months', 'all', '2000-01-01', 'rates.md', 'to-verify')
       ON CONFLICT DO NOTHING`,
    ),
  );
  const DEV =
    "{workforce.training.manage,workforce.supervision.manage,workforce.competence.observe}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'hr_lines', 'HR', 'none',
          '{workforce.training.manage,workforce.staff_file.manage,workforce.competence.observe}'),
         ($2, 'home_lines', 'Home manager', 'location', $5),
         ($3, 'staff_lines', 'Staff', 'location', '{workforce.self.read}'),
         ($4, 'keyworker_lines', 'Senior carer', 'assigned', $5),
         ($6, 'self_lines', 'Self only', 'self', $5)`,
      [ROLE.hr, ROLE.home, ROLE.staff, ROLE.keyworker, DEV, ROLE.selfie],
    );
    const people: [string, string][] = [
      [HR, "hana.lines"],
      [HOME, "hugo.home"],
      [LINE, "lena.line"],
      [FORMER, "fred.former"],
      [LEAD, "tia.lead"],
      [BARE, "ben.bare"],
      [MGR_A, "mae.mgr"],
      [SELFIE, "sol.self"],
      [W_B, "bea.b"],
      [W_NORTH, "nell.north"],
      [W_SOUTH, "sid.south"],
      [W_TEAM, "tam.team"],
      [W_OTHER, "otto.other"],
    ];
    for (const [member, email] of people) {
      await c.query(
        "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, $2, $3, 'active')",
        [member, email, `${email}@example.invalid`],
      );
    }
    const assign = (member: string, role: string, location: string | null) =>
      c.query(
        "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
        [member, role, location],
      );
    await assign(HR, ROLE.hr, null);
    await assign(HOME, ROLE.home, a.locationNorth);
    await assign(LINE, ROLE.keyworker, a.locationNorth);
    await assign(FORMER, ROLE.keyworker, a.locationNorth);
    await assign(LEAD, ROLE.keyworker, a.locationNorth);
    await assign(BARE, ROLE.staff, a.locationSouth);
    await assign(W_NORTH, ROLE.staff, a.locationNorth);
    await assign(W_SOUTH, ROLE.staff, a.locationSouth);
    await assign(W_TEAM, ROLE.staff, a.locationSouth);
    await assign(W_OTHER, ROLE.staff, a.locationSouth);
    await assign(MGR_A, ROLE.home, a.locationNorth);
    await assign(SELFIE, ROLE.selfie, a.locationNorth);
    await assign(W_B, ROLE.staff, a.locationSouth);
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      "INSERT INTO role (id, key, name, scope_kind, permissions) VALUES ($1, 'hr_lines', 'HR', 'none', $2)",
      [id(509), DEV],
    );
    await c.query(
      "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, 'Bo Other', 'bo.other@example.invalid', 'active')",
      [B_HR],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      B_HR,
      id(509),
    ]);
  });
  // HR records the reporting lines: Lena line manages Sid (at South House, not her home), and will
  // manage Nell from tomorrow; Fred managed Nell until today; Ben line manages Otto but holds no
  // development permission; Mae (manager at North House) line manages Bea at South House; Sol holds
  // the permissions only in a self-scoped role and line manages Tam. Tia leads the night team with
  // Tam in it, and Lena is in it but does not lead it; Tia also led an archived team with Nell in it;
  // Fred led the day team, with Otto in it, until today.
  await as("hr", async (c) => {
    const today = "(now() AT TIME ZONE 'Europe/London')::date";
    await c.query(
      `INSERT INTO staff_line_manager (worker_id, manager_id, valid_from, valid_to) VALUES
         ($1, $2, DATE '2026-01-01', NULL),
         ($3, $4, DATE '2026-01-01', ${today}),
         ($5, $6, DATE '2026-01-01', NULL),
         ($3, $2, ${today} + 1, NULL),
         ($7, $8, DATE '2026-01-01', NULL),
         ($9, $10, DATE '2026-01-01', NULL)`,
      [W_SOUTH, LINE, W_NORTH, FORMER, W_OTHER, BARE, W_B, MGR_A, W_TEAM, SELFIE],
    );
    await c.query("INSERT INTO staff_team (id, name) VALUES ($1, 'Night team')", [TEAM]);
    await c.query(
      `INSERT INTO staff_team_member (team_id, member_id, is_lead, valid_from) VALUES
         ($1, $2, true, DATE '2026-01-01'), ($1, $3, false, DATE '2026-01-01'),
         ($1, $4, false, DATE '2026-01-01')`,
      [TEAM, LEAD, W_TEAM, LINE],
    );
    await c.query(
      "INSERT INTO staff_team (id, name, archived_at) VALUES ($1, 'Old team', now()), ($2, 'Day team', NULL)",
      [OLD_TEAM, DAY_TEAM],
    );
    await c.query(
      `INSERT INTO staff_team_member (team_id, member_id, is_lead, valid_from, valid_to) VALUES
         ($1, $2, true, DATE '2026-01-01', NULL), ($1, $3, false, DATE '2026-01-01', NULL),
         ($4, $5, true, DATE '2026-01-01', ${today}), ($4, $6, false, DATE '2026-01-01', NULL)`,
      [OLD_TEAM, LEAD, W_NORTH, DAY_TEAM, FORMER, W_OTHER],
    );
  });
  await asSystem(async (c) => {
    for (const worker of WORKERS) {
      await c.query(
        `INSERT INTO training_record (worker_id, topic, completed_on)
         VALUES ($1, 'fire_safety', DATE '2026-09-01')`,
        [worker],
      );
      await c.query(
        `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key,
                           source_type, source_id, details)
         VALUES ('workforce.supervision_due', 'Hold a supervision that is due',
                 'workforce.supervision.manage', now(), 'hr', 'tenant_user', $1::uuid,
                 jsonb_build_object('memberId', $1::uuid))`,
        [worker],
      );
    }
  });
}, 120_000);

afterAll(async () => {
  await db?.drop();
});

describe("ADR-0137 reporting lines widen development scope (migration 0162)", () => {
  it.each([
    ["HR, organisation-wide", "hr", [W_NORTH, W_SOUTH, W_TEAM, W_OTHER, W_B]],
    ["a home's manager: their home", "home", [W_NORTH]],
    [
      "a line manager: only their current direct report, at another home, never a future one or a team they do not lead",
      "line",
      [W_SOUTH],
    ],
    ["a team lead: only their current team, never an archived one", "lead", [W_TEAM]],
    ["a former line manager and former lead, once the line and lead have ended", "former", []],
    ["a line manager holding no development permission", "bare", []],
    ["a home's manager who line manages a report at another home", "mgrA", [W_NORTH, W_B]],
    ["a line manager holding the permissions only in a self-scoped role", "selfie", []],
    ["another organisation", "other", []],
  ] as const)("%s reads training records of %j", async (_name, who, expected) => {
    expect(await seen(who, "SELECT worker_id AS w FROM training_record")).toEqual(sorted(expected));
  });

  it.each([
    ["line", [W_SOUTH]],
    ["lead", [W_TEAM]],
    ["former", []],
    ["bare", []],
  ] as const)("reminder tasks follow the same scope for %s", async (who, expected) => {
    expect(
      await seen(
        who,
        "SELECT source_id AS w FROM task WHERE kind = 'workforce.supervision_due' AND source_type = 'tenant_user'",
      ),
    ).toEqual(sorted(expected));
  });

  it("the reporting lines themselves: each member sees their own, HR all, others in scope", async () => {
    expect(await seen("line", "SELECT worker_id AS w FROM staff_line_manager")).toEqual(
      sorted([W_SOUTH, W_NORTH]),
    );
    expect(await seen("other", "SELECT worker_id AS w FROM staff_line_manager")).toEqual([]);
    expect(await seen("hr", "SELECT worker_id AS w FROM staff_line_manager")).toEqual(
      sorted([W_SOUTH, W_NORTH, W_OTHER, W_B, W_TEAM]),
    );
    expect(await seen("lead", "SELECT member_id AS w FROM staff_team_member")).toEqual([W_TEAM]);
  });
});

describe("hazard HZ-119 reporting lines widen reads only, never who signs off or withdraws competence", () => {
  const SIGN_OFF = `INSERT INTO competence_sign_off (worker_id, competence, observed_on, observer_id, valid_until)
    VALUES ($1, 'moving_and_handling_hoist', DATE '2026-06-01', app.current_user_id(), DATE '2027-05-31')
    RETURNING id`;
  let signOff = "";
  const attempt = (who: Who, sql: string, params: unknown[]) =>
    as(who, (c) => c.query(sql, params)).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  beforeAll(async () => {
    signOff = await as("hr", async (c) => {
      const row = (await c.query<{ id: string }>(SIGN_OFF, [W_B])).rows[0];
      return row?.id ?? "";
    });
  });

  it("hazard HZ-119 a line manager at another home reads their report's competence", async () => {
    expect(await seen("mgrA", "SELECT worker_id AS w FROM competence_sign_off")).toContain(W_B);
  });

  it.each([
    ["sign off their report's competence", SIGN_OFF, () => [W_B]],
    [
      "withdraw their report's competence",
      `INSERT INTO competence_withdrawal (sign_off_id, reason, withdrawn_by)
       VALUES ($1, 'Observed unsafe practice on a shift', app.current_user_id())`,
      () => [signOff],
    ],
    [
      "record their report's training",
      "INSERT INTO training_record (worker_id, topic, completed_on) VALUES ($1, 'fire_safety', DATE '2026-10-01') RETURNING id",
      () => [W_B],
    ],
    [
      "record a supervision of their report",
      "INSERT INTO supervision_record (worker_id, kind, held_on, held_by) VALUES ($1, 'supervision', DATE '2026-10-01', app.current_user_id()) RETURNING id",
      () => [W_B],
    ],
  ] as const)(
    "hazard HZ-119 a line manager at another home cannot %s",
    async (_name, sql, params) => {
      expect(await attempt("mgrA", sql, params())).toBe("42501");
    },
  );

  it("hazard HZ-119 the same manager still writes for staff at their own home", async () => {
    expect(
      await attempt(
        "mgrA",
        "INSERT INTO training_record (worker_id, topic, completed_on) VALUES ($1, 'fire_safety', DATE '2026-10-01') RETURNING id",
        [W_NORTH],
      ),
    ).toBe("ok");
  });

  it("hazard HZ-119 a team lead cannot sign off a team member's competence", async () => {
    expect(await attempt("lead", SIGN_OFF, [W_TEAM])).toBe("42501");
    expect(await seen("lead", "SELECT worker_id AS w FROM training_record")).toContain(W_TEAM);
  });
});

describe("ADR-0137 only HR maintains reporting lines", () => {
  const tryAs = (who: Who, sql: string, params: unknown[]) =>
    as(who, (c) => c.query(sql, params)).then(
      () => "ok",
      (e: { code?: string }) => e.code ?? "error",
    );

  it.each([
    ["a home's manager", "home"],
    ["a line manager", "line"],
    ["another organisation's HR", "other"],
  ] as const)("%s cannot set a line manager", async (_name, who) => {
    expect(
      await tryAs(
        who,
        "INSERT INTO staff_line_manager (worker_id, manager_id, valid_from) VALUES ($1, $2, DATE '2026-02-01')",
        [LEAD, LINE],
      ),
    ).toBe("42501");
  });

  it("never oneself as line manager, and one current line per member", async () => {
    expect(
      await tryAs(
        "hr",
        "INSERT INTO staff_line_manager (worker_id, manager_id, valid_from) VALUES ($1, $1, DATE '2026-02-01')",
        [W_TEAM],
      ),
    ).toBe("23514");
    expect(
      await tryAs(
        "hr",
        "INSERT INTO staff_line_manager (worker_id, manager_id, valid_from) VALUES ($1, $2, DATE '2026-02-01')",
        [W_SOUTH, HOME],
      ),
    ).toBe("23505");
  });

  it("never names another organisation's member", async () => {
    expect(
      await tryAs(
        "hr",
        "INSERT INTO staff_line_manager (worker_id, manager_id, valid_from) VALUES ($1, $2, DATE '2026-02-01')",
        [LEAD, B_HR],
      ),
    ).toBe("23503");
  });

  it("a line keeps its member, manager and start, keeps a version, and is never deleted", async () => {
    const line = await as("hr", async (c) => {
      const row = (
        await c.query<{ id: string; version: number }>(
          "SELECT id, version FROM staff_line_manager WHERE worker_id = $1 AND valid_to IS NULL",
          [W_SOUTH],
        )
      ).rows[0];
      return row as { id: string; version: number };
    });
    expect(
      await tryAs("hr", "UPDATE staff_line_manager SET manager_id = $2 WHERE id = $1", [
        line.id,
        HOME,
      ]),
    ).toBe("23000");
    expect(await tryAs("hr", "DELETE FROM staff_line_manager WHERE id = $1", [line.id])).not.toBe(
      "ok",
    );
    const versions = await asSystem(async (c) => {
      await c.query("UPDATE staff_line_manager SET valid_to = DATE '2099-01-01' WHERE id = $1", [
        line.id,
      ]);
      return (
        await c.query<{ n: string }>(
          "SELECT count(*) AS n FROM record_version WHERE table_name = 'staff_line_manager' AND record_id = $1",
          [line.id],
        )
      ).rows[0]?.n;
    });
    expect(Number(versions)).toBe(1);
    const versionsSeen = (who: Who) =>
      as(who, async (c) =>
        Number(
          (
            await c.query<{ n: string }>(
              "SELECT count(*) AS n FROM record_version WHERE table_name = 'staff_line_manager' AND record_id = $1",
              [line.id],
            )
          ).rows[0]?.n,
        ),
      );
    // The manager on the line reads its history; a home's manager with no reach to Sid does not.
    expect(await versionsSeen("line")).toBe(1);
    expect(await versionsSeen("home")).toBe(0);
  });
});
