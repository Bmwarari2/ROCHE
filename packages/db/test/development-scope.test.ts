import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Development reads follow attribute scope (ADR-0136, migration 0161; WORK-009 follow-up): an
 * organisation-wide holder (HR's role with no person scope, a tenant-scoped role) reads every
 * member's training, supervision and reminder tasks; a holder at a home reads only the members who
 * work there, as app.works_at counts it (a role in force there or across the organisation, or that
 * home on their staff profile); a member reads their own; another organisation reads nothing.
 * There is no team or line-manager scope for staff yet (a recorded gap), so none is tested.
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
const ROLE = { hr: id(501), org: id(502), home: id(503), staff: id(504), roam: id(505) };
const HR = id(601);
const ORG = id(602);
const NORTH_LEAD = id(603);
const W_NORTH = id(611);
const W_SOUTH = id(612);
const W_ROAM = id(613);
const W_PROFILE = id(614);
const WORKERS = [W_NORTH, W_SOUTH, W_ROAM, W_PROFILE];
const B_HR = id(701);

type Reader = { readonly name: string; readonly context: () => ReturnType<typeof ctx> };
const READERS: Record<string, Reader> = {
  hr: { name: "HR (no person scope)", context: () => ctx(TENANT_A, HR, "none") },
  org: { name: "a tenant-scoped holder", context: () => ctx(TENANT_A, ORG, "tenant") },
  north: {
    name: "a North House manager",
    context: () => ctx(TENANT_A, NORTH_LEAD, "locations", [a.locationNorth]),
  },
  self: {
    name: "the South House worker",
    context: () => ctx(TENANT_A, W_SOUTH, "locations", [a.locationSouth]),
  },
  other: { name: "another organisation's HR", context: () => ctx(TENANT_B, B_HR, "none") },
};
const as = <T>(reader: Reader, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), reader.context(), fn);
const workersSeen = (reader: Reader, table: string) =>
  as(reader, async (c) =>
    (
      await c.query<{ worker_id: string }>(
        `SELECT DISTINCT worker_id FROM ${table} WHERE worker_id = ANY ($1::uuid[])`,
        [WORKERS],
      )
    ).rows
      .map((r) => r.worker_id)
      .sort(),
  );
const sorted = (xs: readonly string[]) => [...xs].sort();

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ($1, 'hr_scope', 'HR', 'none', '{workforce.training.manage,workforce.supervision.manage}'),
         ($2, 'org_scope', 'Organisation', 'tenant', '{workforce.training.manage,workforce.supervision.manage}'),
         ($3, 'home_scope', 'Home manager', 'location', '{workforce.training.manage,workforce.supervision.manage}'),
         ($4, 'staff_scope', 'Staff', 'location', '{workforce.self.read}'),
         ($5, 'roam_scope', 'Roaming staff', 'tenant', '{workforce.self.read}')`,
      [ROLE.hr, ROLE.org, ROLE.home, ROLE.staff, ROLE.roam],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status) VALUES
         ($1, 'Hari Scope', 'hari.scope@example.invalid', 'active'),
         ($2, 'Orla Scope', 'orla.scope@example.invalid', 'active'),
         ($3, 'Nia Lead', 'nia.lead@example.invalid', 'active'),
         ($4, 'Noor North', 'noor.north@example.invalid', 'active'),
         ($5, 'Sam South', 'sam.south@example.invalid', 'active'),
         ($6, 'Rory Roam', 'rory.roam@example.invalid', 'active'),
         ($7, 'Pia Profile', 'pia.profile@example.invalid', 'active')`,
      [HR, ORG, NORTH_LEAD, W_NORTH, W_SOUTH, W_ROAM, W_PROFILE],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $8, NULL), ($2, $9, NULL), ($3, $10, $12),
         ($4, $11, $12), ($5, $11, $13), ($6, $14, NULL), ($7, $11, $13)`,
      [
        HR,
        ORG,
        NORTH_LEAD,
        W_NORTH,
        W_SOUTH,
        W_ROAM,
        W_PROFILE,
        ROLE.hr,
        ROLE.org,
        ROLE.home,
        ROLE.staff,
        a.locationNorth,
        a.locationSouth,
        ROLE.roam,
      ],
    );
    // Pia's roles are at South House, and her staff file names North House as her home.
    await c.query(
      `INSERT INTO staff_profile (tenant_user_id, job_title, location_id)
       VALUES ($1, 'Care worker', $2)`,
      [W_PROFILE, a.locationNorth],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'hr_scope', 'HR', 'none', '{workforce.training.manage,workforce.supervision.manage}')`,
      [id(506)],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Bea Other', 'bea.other@example.invalid', 'active')`,
      [B_HR],
    );
    await c.query("INSERT INTO role_assignment (tenant_user_id, role_id) VALUES ($1, $2)", [
      B_HR,
      id(506),
    ]);
  });
  await asSystem(async (c) => {
    for (const worker of WORKERS) {
      await c.query(
        `INSERT INTO training_record (worker_id, topic, completed_on)
         VALUES ($1, 'fire_safety', DATE '2026-09-01')`,
        [worker],
      );
      await c.query(
        `INSERT INTO supervision_record (worker_id, kind, held_on, held_by)
         VALUES ($1, 'supervision', DATE '2026-10-01', $2)`,
        [worker, HR],
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
    await c.query(
      `INSERT INTO task (kind, title, required_permission, due_at, assignee_role_key)
       VALUES ('workforce.training_expiry', 'Renew training before it expires',
               'workforce.training.manage', now(), 'hr')`,
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const EVERYONE = sorted(WORKERS);
// North House's manager: Noor (a role there), Rory (organisation-wide role), Pia (North on her
// staff file); never Sam, who works only at South House.
const NORTH = sorted([W_NORTH, W_ROAM, W_PROFILE]);

describe("hazard HZ-011 development records follow attribute scope (ADR-0136)", () => {
  it.each([
    ["hr", EVERYONE],
    ["org", EVERYONE],
    ["north", NORTH],
    ["self", [W_SOUTH]],
    ["other", []],
  ] as const)("%s reads the training and supervision records in scope", async (who, expected) => {
    const reader = READERS[who] as Reader;
    expect(await workersSeen(reader, "training_record")).toEqual(expected);
    expect(await workersSeen(reader, "supervision_record")).toEqual(expected);
  });

  it.each([
    ["hr", EVERYONE, true],
    ["org", EVERYONE, true],
    ["north", NORTH, true],
    ["self", [], false],
    ["other", [], false],
  ] as const)(
    "%s sees the reminder tasks about members in scope only",
    async (who, expected, seesUnsourced) => {
      const reader = READERS[who] as Reader;
      const rows = await as(
        reader,
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

  it("answers the scope question per member, and not for another organisation's member", async () => {
    const answer = (reader: Reader, worker: string) =>
      as(
        reader,
        async (c) =>
          (
            await c.query<{ ok: boolean }>("SELECT app.reads_development_of($1::uuid) AS ok", [
              worker,
            ])
          ).rows[0]?.ok,
      );
    expect(await answer(READERS.north as Reader, W_NORTH)).toBe(true);
    expect(await answer(READERS.north as Reader, W_SOUTH)).toBe(false);
    expect(await answer(READERS.hr as Reader, W_SOUTH)).toBe(true);
    expect(await answer(READERS.other as Reader, W_SOUTH)).toBe(false);
    expect(await answer(READERS.hr as Reader, b.manager)).toBe(false);
  });
});
