import { readFileSync } from "node:fs";
import { DEPENDENCY_ASSESSMENT_KINDS, DEPENDENCY_SCALE_STATES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPENDENCY_ASSESSMENT_KIND_CODES, DEPENDENCY_SCALE_VERSION_STATES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The dependency tool in the database (scheduling.md section 12; migration 0074; hazards HZ-011
 * and HZ-123): cross-tenant denial on all three tables; a scale changed only by a holder of
 * scheduling.dependency.manage where it applies; one live scale per location; versions fixed once
 * approved and approved by someone who neither wrote nor changed them; a person's category
 * append-only, in the person's scope, recorded by a holder of care.dependency.assess, only from an
 * approved version with a category and periods that version has, one chain per person.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwnerRole = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** Holds both permissions across the organisation. */
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** Holds both permissions at North House only. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A care worker assigned to Ada, with neither permission. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const ROLE_OWNER = "0199d100-0000-7000-8000-000000000501";
const ROLE_DEPUTY = "0199d100-0000-7000-8000-000000000502";
const ROLE_TEAM_LEADER = "0199d100-0000-7000-8000-000000000503";

/** Invented figures: the organisation's own scale. */
const DEFINITION = {
  periods: [
    { key: "day", label: "Day", startMinute: 480 },
    { key: "night", label: "Night", startMinute: 1200 },
  ],
  categories: [
    {
      key: "low",
      label: "Low",
      description: null,
      careMinutes: [
        { periodKey: "day", minutes: 60 },
        { periodKey: "night", minutes: 20 },
      ],
    },
  ],
  skillMix: [],
  reviewIntervalDays: null,
};

const one = async <T = string>(c: pg.PoolClient, text: string, params: unknown[]) =>
  (await c.query(text, params)).rows[0] as T;

const newScale = (c: pg.PoolClient, location: string | null, name = "North House scale") =>
  one<{ id: string }>(
    c,
    "INSERT INTO dependency_scale (location_id, name) VALUES ($1, $2) RETURNING id",
    [location, name],
  ).then((r) => r.id);

const newDraft = (c: pg.PoolClient, scale: string, number: number, definition = DEFINITION) =>
  one<{ id: string; contributor_ids: string[] }>(
    c,
    `INSERT INTO dependency_scale_version (scale_id, version_number, definition)
     VALUES ($1, $2, $3) RETURNING id, contributor_ids`,
    [scale, number, JSON.stringify(definition)],
  );

const approve = (c: pg.PoolClient, version: string) =>
  c.query(
    `UPDATE dependency_scale_version SET state = 'approved', approved_by = app.current_user_id(),
       approved_at = now() WHERE id = $1`,
    [version],
  );

interface Record {
  person?: string;
  scale: string;
  version: string;
  category?: string;
  oneToOne?: unknown[];
  kind?: string;
  from?: string;
  supersedes?: string | null;
  decidedBy?: string;
  createdBy?: string | null;
}

const recordCategory = (c: pg.PoolClient, r: Record) =>
  one<{ id: string }>(
    c,
    `INSERT INTO dependency_assessment (person_id, scale_id, scale_version_id, category_key,
       one_to_one, kind, effective_from, reason, decided_by, supersedes_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'Needs help with washing and dressing', $8, $9,
       COALESCE($10, app.current_user_id())) RETURNING id`,
    [
      r.person ?? a.personAda,
      r.scale,
      r.version,
      r.category ?? "low",
      JSON.stringify(r.oneToOne ?? []),
      r.kind ?? "initial",
      r.from ?? "2026-10-20",
      r.decidedBy ?? a.northManager,
      r.supersedes ?? null,
      r.createdBy ?? null,
    ],
  ).then((row) => row.id);

let northScale = "";
let approved = "";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwnerRole(TENANT_A, async (c) => {
    const both = "{scheduling.dependency.manage,care.dependency.assess,people.person.read}";
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin) VALUES
         ($1, 'owner', 'Owner', 'tenant', $4, true),
         ($2, 'deputy_manager', 'Deputy', 'location', $4, true),
         ($3, 'team_leader', 'Team leader', 'location', '{people.person.read}', true)`,
      [ROLE_OWNER, ROLE_DEPUTY, ROLE_TEAM_LEADER, both],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5)`,
      [a.manager, ROLE_OWNER, a.northManager, ROLE_DEPUTY, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-123 the organisation's dependency scale (migration 0074)", () => {
  it("keeps the database's codes in step with the domain", () => {
    expect([...DEPENDENCY_SCALE_VERSION_STATES]).toEqual([...DEPENDENCY_SCALE_STATES]);
    expect([...DEPENDENCY_ASSESSMENT_KIND_CODES]).toEqual([...DEPENDENCY_ASSESSMENT_KINDS]);
  });

  it("makes a scale only where the member may manage it, one live scale per location", async () => {
    northScale = await asNorth((c) => newScale(c, a.locationNorth));
    await expect(asNorth((c) => newScale(c, a.locationSouth))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asNorth((c) => newScale(c, null, "Organisation scale"))).rejects.toThrow(
      /row-level security/,
    );
    await expect(asCarer((c) => newScale(c, a.locationNorth))).rejects.toThrow(
      /row-level security/,
    );
    await asManager((c) => newScale(c, null, "Organisation scale"));
    await expect(asManager((c) => newScale(c, a.locationNorth, "Another"))).rejects.toThrow(
      /dependency_scale_location_key/,
    );
  });

  it("keeps a scale's location, and an archived scale never changes", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE dependency_scale SET location_id = $1 WHERE id = $2", [
          a.locationSouth,
          northScale,
        ]),
      ),
    ).rejects.toThrow(/keeps its location/);
    const renamed = await asNorth((c) =>
      one<{ version: number }>(
        c,
        "UPDATE dependency_scale SET name = 'North House dependency scale' WHERE id = $1 RETURNING version",
        [northScale],
      ),
    );
    expect(renamed.version).toBe(2);
  });

  it("approves a draft only by a member who neither wrote nor changed it, and fixes it", async () => {
    const draft = await asNorth((c) => newDraft(c, northScale, 1));
    expect(draft.contributor_ids).toEqual([a.northManager]);
    await expect(asNorth((c) => approve(c, draft.id))).rejects.toThrow(/neither wrote nor changed/);
    await expect(asCarer((c) => approve(c, draft.id))).resolves.toMatchObject({ rowCount: 0 });
    await asManager((c) => approve(c, draft.id));
    approved = draft.id;
    await expect(
      asManager((c) =>
        c.query("UPDATE dependency_scale_version SET definition = '{}'::jsonb WHERE id = $1", [
          approved,
        ]),
      ),
    ).rejects.toThrow(/never changes/);

    const second = await asNorth((c) => newDraft(c, northScale, 2));
    await asManager((c) =>
      c.query(
        `UPDATE dependency_scale_version SET definition = jsonb_set(definition, '{reviewIntervalDays}', '28')
         WHERE id = $1`,
        [second.id],
      ),
    );
    const contributors = await asManager((c) =>
      one<{ contributor_ids: string[] }>(
        c,
        "SELECT contributor_ids FROM dependency_scale_version WHERE id = $1",
        [second.id],
      ),
    );
    expect(contributors.contributor_ids).toEqual([a.northManager, a.manager]);
    await expect(asManager((c) => approve(c, second.id))).rejects.toThrow(
      /neither wrote nor changed/,
    );
    await asNorth((c) =>
      c.query(
        "UPDATE dependency_scale_version SET state = 'discarded', discard_reason = 'Started again' WHERE id = $1",
        [second.id],
      ),
    );
    await expect(
      asNorth((c) =>
        c.query("UPDATE dependency_scale_version SET state = 'draft' WHERE id = $1", [second.id]),
      ),
    ).rejects.toThrow(/never changes/);
  });

  it("never lets the application delete a scale or a version", async () => {
    await expect(
      asManager((c) => c.query("DELETE FROM dependency_scale_version WHERE id = $1", [approved])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asManager((c) => c.query("DELETE FROM dependency_scale WHERE id = $1", [northScale])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("hazard HZ-123 hazard HZ-011 a person's dependency category (migration 0074)", () => {
  let first = "";

  it("records a category only in the person's scope, by a holder of care.dependency.assess", async () => {
    first = await asNorth((c) => recordCategory(c, { scale: northScale, version: approved }));
    await expect(
      asNorth((c) =>
        recordCategory(c, { person: a.personCara, scale: northScale, version: approved }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asCarer((c) =>
        recordCategory(c, { person: a.personBen, scale: northScale, version: approved }),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorth((c) =>
        recordCategory(c, {
          person: a.personBen,
          scale: northScale,
          version: approved,
          createdBy: a.manager,
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it.each([
    ["a draft version", { draft: true }, /approved version/],
    ["a category the version lacks", { category: "medium" }, /not in the scale version/],
    [
      "one-to-one for a period the version lacks",
      { oneToOne: [{ periodKey: "twilight", minutes: 60 }] },
      /One-to-one/,
    ],
    ["one-to-one of no minutes", { oneToOne: [{ periodKey: "day", minutes: 0 }] }, /One-to-one/],
    [
      "one-to-one twice for a period",
      {
        oneToOne: [
          { periodKey: "day", minutes: 30 },
          { periodKey: "day", minutes: 30 },
        ],
      },
      /One-to-one/,
    ],
    [
      "one-to-one of part minutes",
      { oneToOne: [{ periodKey: "day", minutes: 1.5 }] },
      /One-to-one/,
    ],
  ])("refuses a category from %s", async (_, over, error) => {
    const version =
      "draft" in over ? (await asNorth((c) => newDraft(c, northScale, 9))).id : approved;
    await expect(
      asNorth((c) =>
        recordCategory(c, { person: a.personBen, scale: northScale, version, ...over }),
      ),
    ).rejects.toThrow(error);
  });

  it("keeps one chain per person: one first record, each record superseded once", async () => {
    await expect(
      asNorth((c) => recordCategory(c, { scale: northScale, version: approved })),
    ).rejects.toThrow(/dependency_assessment_one_chain_key/);
    await expect(
      asNorth((c) => recordCategory(c, { scale: northScale, version: approved, kind: "review" })),
    ).rejects.toThrow(/dependency_assessment_chain/);
    await expect(
      asNorth((c) =>
        recordCategory(c, {
          scale: northScale,
          version: approved,
          kind: "review",
          supersedes: first,
          from: "2026-10-19",
        }),
      ),
    ).rejects.toThrow(/or later/);
    await expect(
      asNorth((c) =>
        recordCategory(c, {
          scale: northScale,
          version: approved,
          kind: "correction",
          supersedes: first,
          from: "2026-10-21",
        }),
      ),
    ).rejects.toThrow(/correction from that date/);
    await asNorth((c) =>
      recordCategory(c, {
        scale: northScale,
        version: approved,
        kind: "review",
        supersedes: first,
        from: "2026-10-25",
        oneToOne: [{ periodKey: "day", minutes: 120 }],
      }),
    );
    await expect(
      asNorth((c) =>
        recordCategory(c, {
          scale: northScale,
          version: approved,
          kind: "correction",
          supersedes: first,
          from: "2026-10-20",
        }),
      ),
    ).rejects.toThrow(/dependency_assessment_superseded_once_key/);
  });

  it("is append-only: never changed or deleted", async () => {
    await expect(
      asNorth((c) =>
        c.query("UPDATE dependency_assessment SET category_key = 'low' WHERE id = $1", [first]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asNorth((c) => c.query("DELETE FROM dependency_assessment WHERE id = $1", [first])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asOwnerRole(TENANT_A, (c) =>
        c.query("UPDATE dependency_assessment SET reason = 'x' WHERE id = $1", [first]),
      ),
    ).rejects.toThrow(/append-only/);
  });

  it("shows a person's categories only to those who may see the person", async () => {
    const count = (rows: { n: number }) => Number(rows.n);
    expect(
      count(await asNorth((c) => one(c, "SELECT count(*) AS n FROM dependency_assessment", []))),
    ).toBe(2);
    const south = await inContext(
      app(),
      ctx(TENANT_A, a.northManager, "locations", [a.locationSouth]),
      (c) => one<{ n: number }>(c, "SELECT count(*) AS n FROM dependency_assessment", []),
    );
    expect(count(south)).toBe(0);
  });

  it("hazard HZ-011 shows no scale, version or category to another organisation, and links none", async () => {
    for (const table of ["dependency_scale", "dependency_scale_version", "dependency_assessment"]) {
      const rows = await asOtherTenant((c) => c.query(`SELECT id FROM ${table}`));
      expect(rows.rowCount, table).toBe(0);
    }
    await expect(
      asOtherTenant((c) =>
        recordCategory(c, {
          person: b.personDev,
          scale: northScale,
          version: approved,
          decidedBy: b.manager,
        }),
      ),
    ).rejects.toThrow(/approved version|foreign key/);
    await expect(
      asOtherTenant((c) =>
        c.query(
          "INSERT INTO dependency_scale_version (scale_id, version_number, definition) VALUES ($1, 1, '{}')",
          [northScale],
        ),
      ),
    ).rejects.toThrow(/row-level security|foreign key/);
  });
});

describe("existing tenants' built-in roles gain the dependency permissions (migration 0074)", () => {
  it("adds them once, as a new version, audited", async () => {
    const sql = readFileSync(
      new URL("../drizzle/0074_dependency_tool.sql", import.meta.url),
      "utf8",
    );
    const start = sql.indexOf("ALTER TABLE public.role NO FORCE ROW LEVEL SECURITY;");
    const statements = sql
      .slice(start)
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    const admin = db.pool("harbour_owner");
    for (let run = 0; run < 2; run++) {
      for (const statement of statements) await admin.query(statement);
    }
    const roles = await asOwnerRole(TENANT_A, (c) =>
      c.query<{ key: string; permissions: string[] }>(
        "SELECT key, permissions FROM role WHERE id = ANY ($1) ORDER BY key",
        [[ROLE_DEPUTY, ROLE_TEAM_LEADER]],
      ),
    );
    expect(roles.rows).toEqual([
      {
        key: "deputy_manager",
        permissions: [
          "scheduling.dependency.manage",
          "care.dependency.assess",
          "people.person.read",
        ],
      },
      { key: "team_leader", permissions: ["people.person.read", "care.dependency.assess"] },
    ]);
    const audited = await asOwnerRole(TENANT_A, (c) =>
      c.query(
        `SELECT resource_id FROM audit_event
          WHERE action = 'platform.role.permissions_migrated'
            AND scope ->> 'migration' = '0074_dependency_tool'`,
      ),
    );
    expect(audited.rows.map((r) => r.resource_id)).toEqual([ROLE_TEAM_LEADER]);
  });
});
