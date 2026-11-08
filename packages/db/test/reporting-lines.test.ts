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
const ROLE = { hr: id(501), home: id(502), staff: id(503), keyworker: id(504) };
const HR = id(601);
const HOME = id(602);
const LINE = id(603);
const FORMER = id(604);
const LEAD = id(605);
const BARE = id(606);
const W_NORTH = id(611);
const W_SOUTH = id(612);
const W_TEAM = id(613);
const W_OTHER = id(614);
const WORKERS: readonly string[] = [W_NORTH, W_SOUTH, W_TEAM, W_OTHER];
const TEAM = id(701);
const B_HR = id(801);

const READERS = {
  hr: () => ctx(TENANT_A, HR, "none"),
  home: () => ctx(TENANT_A, HOME, "locations", [a.locationNorth]),
  line: () => ctx(TENANT_A, LINE, "assigned"),
  former: () => ctx(TENANT_A, FORMER, "assigned"),
  lead: () => ctx(TENANT_A, LEAD, "assigned"),
  bare: () => ctx(TENANT_A, BARE, "locations", [a.locationSouth]),
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
  const DEV = "{workforce.training.manage,workforce.supervision.manage}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'hr_lines', 'HR', 'none', '{workforce.training.manage,workforce.staff_file.manage}'),
         ($2, 'home_lines', 'Home manager', 'location', $5),
         ($3, 'staff_lines', 'Staff', 'location', '{workforce.self.read}'),
         ($4, 'keyworker_lines', 'Senior carer', 'assigned', $5)`,
      [ROLE.hr, ROLE.home, ROLE.staff, ROLE.keyworker, DEV],
    );
    const people: [string, string][] = [
      [HR, "hana.lines"],
      [HOME, "hugo.home"],
      [LINE, "lena.line"],
      [FORMER, "fred.former"],
      [LEAD, "tia.lead"],
      [BARE, "ben.bare"],
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
  // HR records the reporting lines: Lena line manages Sid (at South House, not her home); Fred
  // managed Nell until yesterday; Ben line manages Otto but holds no development permission; Tia
  // leads a team with Tam in it.
  await as("hr", async (c) => {
    const today = "(now() AT TIME ZONE 'Europe/London')::date";
    await c.query(
      `INSERT INTO staff_line_manager (worker_id, manager_id, valid_from, valid_to) VALUES
         ($1, $2, DATE '2026-01-01', NULL),
         ($3, $4, DATE '2026-01-01', ${today}),
         ($5, $6, DATE '2026-01-01', NULL)`,
      [W_SOUTH, LINE, W_NORTH, FORMER, W_OTHER, BARE],
    );
    await c.query("INSERT INTO staff_team (id, name) VALUES ($1, 'Night team')", [TEAM]);
    await c.query(
      `INSERT INTO staff_team_member (team_id, member_id, is_lead, valid_from) VALUES
         ($1, $2, true, DATE '2026-01-01'), ($1, $3, false, DATE '2026-01-01')`,
      [TEAM, LEAD, W_TEAM],
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
    ["HR, organisation-wide", "hr", [W_NORTH, W_SOUTH, W_TEAM, W_OTHER]],
    ["a home's manager: their home", "home", [W_NORTH]],
    ["a line manager: only their current direct report, at another home", "line", [W_SOUTH]],
    ["a team lead: only their team", "lead", [W_TEAM]],
    ["a former line manager, once the line has ended", "former", []],
    ["a line manager holding no development permission", "bare", []],
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
    expect(await seen("line", "SELECT worker_id AS w FROM staff_line_manager")).toEqual([W_SOUTH]);
    expect(await seen("other", "SELECT worker_id AS w FROM staff_line_manager")).toEqual([]);
    expect(await seen("hr", "SELECT worker_id AS w FROM staff_line_manager")).toEqual(
      sorted([W_SOUTH, W_NORTH, W_OTHER]),
    );
    expect(await seen("lead", "SELECT member_id AS w FROM staff_team_member")).toEqual([W_TEAM]);
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
        [W_TEAM, LINE],
      ),
    ).not.toBe("ok");
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
        [W_TEAM, B_HR],
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
  });
});
