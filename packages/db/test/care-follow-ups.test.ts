import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DISCARD_REASONS,
  ESCALATION_POLICY_BANDS,
  PORTAL_ONLY_PERMISSIONS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ESCALATION_POLICY_TOOL_BANDS } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The care API follow-ups in the database (care.md sections 5 and 6; hazards HZ-011, HZ-014,
 * HZ-019 and HZ-040; migrations 0043 and 0044): escalation policy links, coded discard reasons,
 * one deletion record row per stage (the replay index), the server's flag on entries a device
 * recorded deleting, and the drawing on body-map marks.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;

const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** The system's view: the API writes deletion records and flags in the organisation's view. */
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asTenantWide = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const NOTE_ADA = "0199d000-0000-7000-8000-0000000000a1";
const NOTE_BEN = "0199d000-0000-7000-8000-0000000000a2";
const DISCARD = "0199d000-0000-4000-8000-0000000000b1";
const DEVICE = "0199d000-0000-4000-8000-0000000000d1";
const ROLE_OWNER = "0193a000-0000-7000-8000-000000000511";
const ROLE_HOME_MANAGER = "0193a000-0000-7000-8000-000000000512";
const ROLE_ADMINISTRATOR = "0193a000-0000-7000-8000-000000000513";
const ROLE_GROUP_EXECUTIVE = "0193a000-0000-7000-8000-000000000514";
/** The North manager's extra roles, each without quality.policy.manage (#26 review round 2, S1). */
const EXTRA_ADMIN = "0193a000-0000-7000-8000-000000000611";
const EXTRA_GROUP = "0193a000-0000-7000-8000-000000000612";

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    // The carer works at North House, where Ada lives.
    await c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.carer, a.roleCarer, a.locationNorth],
    );
    // Who may change the organisation's settings is read from the roles that carry each
    // permission (migration 0046): the manager owns the organisation; the North manager manages
    // North House only.
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions, is_builtin) VALUES
         ($1, 'owner', 'Owner', 'tenant', '{quality.policy.manage,platform.tenant.manage}', true),
         ($2, 'registered_manager', 'Registered Manager', 'location', '{quality.policy.manage}', true),
         ($3, 'administrator', 'Administrator', 'location', '{people.enquiry.manage}', true),
         ($4, 'group_executive', 'Group executive', 'tenant', '{insights.group.read}', true)`,
      [ROLE_OWNER, ROLE_HOME_MANAGER, ROLE_ADMINISTRATOR, ROLE_GROUP_EXECUTIVE],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, $2, NULL), ($3, $4, $5)`,
      [a.manager, ROLE_OWNER, a.northManager, ROLE_HOME_MANAGER, a.locationNorth],
    );
    await c.query(
      `INSERT INTO care_note (id, person_id, location_id, occurred_at, category, body, created_by)
       VALUES ($1, $3, $4, now() - interval '1 hour', 'personal_care', 'Assisted with a wash.', $5),
              ($2, $6, $4, now() - interval '1 hour', 'personal_care', 'Settled after tea.', $5)`,
      [NOTE_ADA, NOTE_BEN, a.personAda, a.locationNorth, a.carer, a.personBen],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const reasonsOf = (c: pg.PoolClient) =>
  c
    .query<{ code: string; label: string; sort_order: number; seeded: boolean }>(
      "SELECT code, label, sort_order, seeded FROM discard_reason ORDER BY sort_order, code",
    )
    .then((r) => r.rows);

describe("hazard HZ-040 every organisation's coded discard reasons", () => {
  const seeded = DEFAULT_DISCARD_REASONS.map((r) => ({
    code: r.code,
    label: r.label,
    sort_order: r.sortOrder,
    seeded: true,
  }));

  it("seeds the phone's five codes for each organisation, as the domain lists them", async () => {
    expect(await asCarer(reasonsOf)).toEqual(seeded);
    expect(await asOtherTenant(reasonsOf)).toEqual(seeded);
  });

  it("seeds a new organisation when it is created, and leaves the creator's settings as they were", async () => {
    const TENANT_C = "0193c000-0000-7000-8000-00000000000c";
    const after = await inContext(
      db.pool("harbour_owner"),
      ctx(TENANT_C, null, "none"),
      async (c) => {
        await c.query(
          `INSERT INTO tenant (id, name, legal_name, legal_form, status)
           VALUES ($1, 'Third Provider', 'Third Provider Ltd', 'limited_company', 'onboarding')`,
          [TENANT_C],
        );
        return c.query<{ tenant: string; scope: string }>(
          "SELECT current_setting('app.tenant_id', true) AS tenant, current_setting('app.scope', true) AS scope",
        );
      },
    );
    expect(after.rows[0]).toEqual({ tenant: TENANT_C, scope: "none" });
    const rows = await inContext(app(), ctx(TENANT_C, null, "tenant"), reasonsOf);
    expect(rows).toEqual(seeded);
  });

  it("lets only a tenant-wide role add or retire a reason, versioned, and never delete one", async () => {
    await expect(
      asNorthManager((c) =>
        c.query("INSERT INTO discard_reason (code, label) VALUES ('north_only', 'North only')"),
      ),
    ).rejects.toThrow(/row-level security/);
    const retired = await asNorthManager((c) =>
      c.query(
        "UPDATE discard_reason SET retired_at = now(), retired_by = $1 WHERE code = 'staff_left'",
        [a.northManager],
      ),
    );
    expect(retired.rowCount).toBe(0);
    await asTenantWide(async (c) => {
      await c.query(
        "INSERT INTO discard_reason (code, label, sort_order) VALUES ('agency_shift_ended', 'Agency shift ended before the entries were sent', 60)",
      );
      await c.query(
        "UPDATE discard_reason SET retired_at = now(), retired_by = $1 WHERE code = 'agency_shift_ended'",
        [a.manager],
      );
    });
    const history = await asTenantWide((c) =>
      c.query("SELECT count(*)::int AS n FROM record_version WHERE table_name = 'discard_reason'"),
    );
    expect(history.rows[0]?.n).toBeGreaterThanOrEqual(1);
    await expect(
      asTenantWide((c) => c.query("DELETE FROM discard_reason WHERE code = 'other'")),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asTenantWide((c) =>
        c.query("INSERT INTO discard_reason (code, label) VALUES ('Bad Code', 'Bad code')"),
      ),
    ).rejects.toThrow(/discard_reason_code/);
  });
});

describe("hazard HZ-014 escalation policy links", () => {
  it("keeps the bands in the database in step with the domain", () => {
    expect(ESCALATION_POLICY_TOOL_BANDS).toEqual(ESCALATION_POLICY_BANDS);
  });

  it.each([
    ["NEWS2 for every band", "news2", null, true],
    ["NEWS2 high", "news2", "high", true],
    ["the falls pathway", "ng249_falls", null, true],
    ["MUST with a Waterlow band", "must", "very_high_risk", false],
    ["a band for the falls pathway", "ng249_falls", "high", false],
    ["a tool Harbour does not calculate", "abbey", null, false],
  ] as const)("checks %s", async (_name, tool, band, ok) => {
    const insert = asTenantWide((c) =>
      c.query(
        "INSERT INTO escalation_policy_link (tool_key, band, title) VALUES ($1, $2, 'Deterioration policy')",
        [tool, band],
      ),
    );
    if (ok) await insert;
    else await expect(insert).rejects.toThrow(/escalation_policy_link_band/);
  });

  it("keeps one live link per tool, band and place, and allows another once it is removed", async () => {
    await expect(
      asTenantWide((c) =>
        c.query(
          "INSERT INTO escalation_policy_link (tool_key, band, title) VALUES ('news2', 'high', 'Second policy')",
        ),
      ),
    ).rejects.toThrow(/escalation_policy_link_live_key/);
    await asTenantWide((c) =>
      c.query(
        "UPDATE escalation_policy_link SET deleted_at = now() WHERE tool_key = 'news2' AND band = 'high'",
      ),
    );
    await asTenantWide((c) =>
      c.query(
        "INSERT INTO escalation_policy_link (tool_key, band, title) VALUES ('news2', 'high', 'Second policy')",
      ),
    );
  });

  it("lets a location role link its own locations' policies only, and every member read them", async () => {
    await asNorthManager((c) =>
      c.query(
        "INSERT INTO escalation_policy_link (tool_key, band, location_id, title) VALUES ('must', 'high', $1, 'North House nutrition policy')",
        [a.locationNorth],
      ),
    );
    await expect(
      asNorthManager((c) =>
        c.query(
          "INSERT INTO escalation_policy_link (tool_key, location_id, title) VALUES ('must', $1, 'South House policy')",
          [a.locationSouth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorthManager((c) =>
        c.query(
          "INSERT INTO escalation_policy_link (tool_key, title) VALUES ('braden', 'Organisation policy')",
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const changed = await asNorthManager((c) =>
      c.query(
        "UPDATE escalation_policy_link SET title = 'Changed by North' WHERE location_id IS NULL",
      ),
    );
    expect(changed.rowCount).toBe(0);
    const seen = await asCarer((c) =>
      c.query<{ title: string }>("SELECT title FROM escalation_policy_link ORDER BY title"),
    );
    expect(seen.rows.map((r) => r.title)).toContain("North House nutrition policy");
    await expect(
      asTenantWide((c) => c.query("DELETE FROM escalation_policy_link")),
    ).rejects.toThrow(/permission denied/);
  });

  it("decides by the roles that carry the permission, never by the session's merged scope (#26 review round 2, S1)", async () => {
    // The North manager is also an administrator at South House and a group executive: neither
    // carries quality.policy.manage or platform.tenant.manage, so their merged scope is wider than
    // the permission they hold.
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO role_assignment (id, tenant_user_id, role_id, location_id) VALUES
           ($1, $3, $4, $5), ($2, $3, $6, NULL)`,
        [
          EXTRA_ADMIN,
          EXTRA_GROUP,
          a.northManager,
          ROLE_ADMINISTRATOR,
          a.locationSouth,
          ROLE_GROUP_EXECUTIVE,
        ],
      ),
    );
    const asMergedScope = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
      inContext(app(), ctx(TENANT_A, a.northManager, "tenant"), fn);
    try {
      await expect(
        asMergedScope((c) =>
          c.query(
            "INSERT INTO escalation_policy_link (tool_key, location_id, title) VALUES ('waterlow', $1, 'South House skin policy')",
            [a.locationSouth],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asMergedScope((c) =>
          c.query(
            "INSERT INTO escalation_policy_link (tool_key, title) VALUES ('waterlow', 'Organisation skin policy')",
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        asMergedScope((c) =>
          c.query(
            "INSERT INTO discard_reason (code, label) VALUES ('merged_scope', 'Merged scope')",
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      const changed = await asMergedScope((c) =>
        c.query("UPDATE escalation_policy_link SET title = 'Changed' WHERE location_id IS NULL"),
      );
      expect(changed.rowCount).toBe(0);
      // North House, where the role carries the permission, is still theirs to change.
      await asMergedScope((c) =>
        c.query(
          "INSERT INTO escalation_policy_link (tool_key, location_id, title) VALUES ('waterlow', $1, 'North House skin policy')",
          [a.locationNorth],
        ),
      );
    } finally {
      await asOwner(TENANT_A, (c) =>
        c.query("UPDATE role_assignment SET deleted_at = now() WHERE id = ANY($1)", [
          [EXTRA_ADMIN, EXTRA_GROUP],
        ]),
      );
    }
  });
});

describe("hazard HZ-012 hazard HZ-040 who holds a permission is read only from roles and grants in force (#26 review round 3)", () => {
  const PERMISSION = "quality.policy.manage";
  const HOUR = 3_600_000;
  const at = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();
  type Holding =
    | {
        readonly kind: "role";
        readonly scope?: "tenant" | "location" | "assigned";
        readonly permissions?: readonly string[];
        readonly organisationWide?: boolean;
        readonly validFrom?: string;
        readonly validTo?: string;
        readonly deleted?: boolean;
        readonly archived?: boolean;
      }
    | {
        readonly kind: "grant";
        readonly organisationWide?: boolean;
        readonly validFrom?: string;
        readonly validTo?: string;
        readonly revoked?: boolean;
        readonly deleted?: boolean;
      };
  const cases: readonly [string, Holding, { north: boolean; organisation: boolean }][] = [
    ["a role in force at North House", { kind: "role" }, { north: true, organisation: false }],
    [
      "a role in force across the organisation",
      { kind: "role", organisationWide: true },
      { north: true, organisation: true },
    ],
    [
      "a role whose assignment has ended",
      { kind: "role", validFrom: at(-48), validTo: at(-1) },
      { north: false, organisation: false },
    ],
    [
      "a role whose assignment has not started",
      { kind: "role", validFrom: at(24) },
      { north: false, organisation: false },
    ],
    [
      "a role whose assignment was deleted",
      { kind: "role", deleted: true },
      { north: false, organisation: false },
    ],
    ["an archived role", { kind: "role", archived: true }, { north: false, organisation: false }],
    [
      "a role mixing portal and staff permissions",
      { kind: "role", permissions: [PERMISSION, "comms.portal.family"] },
      { north: false, organisation: false },
    ],
    [
      "a role scoped to assigned people",
      { kind: "role", scope: "assigned", organisationWide: true },
      { north: false, organisation: false },
    ],
    [
      "a role without the permission",
      { kind: "role", permissions: ["care.note.read"], organisationWide: true },
      { north: false, organisation: false },
    ],
    ["a grant in force at North House", { kind: "grant" }, { north: true, organisation: false }],
    [
      "a grant in force across the organisation",
      { kind: "grant", organisationWide: true },
      { north: true, organisation: true },
    ],
    [
      "an expired grant",
      { kind: "grant", validFrom: at(-48), validTo: at(-1) },
      { north: false, organisation: false },
    ],
    ["a revoked grant", { kind: "grant", revoked: true }, { north: false, organisation: false }],
    ["a deleted grant", { kind: "grant", deleted: true }, { north: false, organisation: false }],
  ];

  it.each(cases.map(([name, holding, expected], n) => ({ name, holding, expected, n })))(
    "$name",
    async ({ holding, expected, n }) => {
      const suffix = (700 + n).toString(16).padStart(12, "0");
      const user = `0193a000-0000-7000-8000-${suffix}`;
      const roleId = `0193a000-0000-7000-8001-${suffix}`;
      const place = holding.organisationWide ? null : a.locationNorth;
      await asOwner(TENANT_A, async (c) => {
        await c.query(
          "INSERT INTO tenant_user (id, display_name, email, status) VALUES ($1, $2, $3, 'active')",
          [user, `Holder ${n}`, `holder${n}@example.invalid`],
        );
        if (holding.kind === "role") {
          await c.query(
            `INSERT INTO role (id, key, name, scope_kind, permissions, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              roleId,
              `holder_${n}`,
              `Holder ${n}`,
              holding.scope ?? "location",
              holding.permissions ?? [PERMISSION],
              holding.archived ? at(-1) : null,
            ],
          );
          await c.query(
            `INSERT INTO role_assignment
               (tenant_user_id, role_id, location_id, valid_from, valid_to, deleted_at, organisation_wide)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              user,
              roleId,
              place,
              holding.validFrom ?? at(-1),
              holding.validTo ?? null,
              holding.deleted ? at(-1) : null,
              place === null,
            ],
          );
        } else {
          await c.query(
            `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_from, valid_to,
             reason, granted_by, revoked_at, deleted_at, organisation_wide)
           VALUES ($1, $2, $3, $4, $5, 'Acting up', $6, $7, $8, $9)`,
            [
              user,
              [PERMISSION],
              place,
              holding.validFrom ?? at(-1),
              holding.validTo ?? at(24),
              a.manager,
              holding.revoked ? at(-1) : null,
              holding.deleted ? at(-1) : null,
              place === null,
            ],
          );
        }
      });
      const held = await inContext(app(), ctx(TENANT_A, user, "tenant"), (c) =>
        c
          .query<{ north: boolean; organisation: boolean }>(
            "SELECT app.holds_permission_at($1, $2) AS north, app.holds_permission_at($1, NULL) AS organisation",
            [PERMISSION, a.locationNorth],
          )
          .then((r) => r.rows[0]),
      );
      expect(held).toEqual(expected);
    },
  );

  it("knows every portal-only permission the domain lists, so a mixed role gives none", async () => {
    const definition = await asOwner(TENANT_A, (c) =>
      c
        .query<{ body: string }>(
          "SELECT pg_get_functiondef('app.holds_permission_at(text, uuid)'::regprocedure) AS body",
        )
        .then((r) => r.rows[0]?.body ?? ""),
    );
    for (const permission of PORTAL_ONLY_PERMISSIONS)
      expect(definition).toContain(`'${permission}'`);
  });
});

const record =
  (fields: { stage: string; reason?: string; sender?: string }) => (c: pg.PoolClient) =>
    c.query(
      `INSERT INTO device_discard_record (discard_id, stage, kind, reason_code, owner_tenant_user_id,
        sender_tenant_user_id, device_id, entry_count, discarded_at)
     VALUES ($1, $2, 'held_deleted', $3, $4, $5, $6, 2, now())`,
      [
        DISCARD,
        fields.stage,
        fields.reason ?? "entered_in_error",
        a.carer,
        fields.sender ?? a.carer,
        DEVICE,
      ],
    );

describe("hazard HZ-040 one deletion record row per stage (the replay index)", () => {
  it("records a stage once: a second row for the same stage is refused", async () => {
    await asSystem(record({ stage: "requested" }));
    await expect(asSystem(record({ stage: "requested" }))).rejects.toThrow(
      /device_discard_record_stage_key/,
    );
    await asSystem(record({ stage: "deleted" }));
  });

  it("takes only one of the organisation's own coded reasons", async () => {
    await expect(asSystem(record({ stage: "failed", reason: "because" }))).rejects.toThrow(
      /device_discard_record_reason_fk/,
    );
  });

  it("is written only in the system's view, never changed, and read by the member, their managers and tenant-wide roles", async () => {
    await expect(asCarer(record({ stage: "failed" }))).rejects.toThrow(/row-level security/);
    await expect(
      asSystem((c) =>
        c.query("UPDATE device_discard_record SET entry_count = 9 WHERE discard_id = $1", [
          DISCARD,
        ]),
      ),
    ).rejects.toThrow();
    const stages = (c: pg.PoolClient) =>
      c
        .query<{ stage: string }>(
          "SELECT stage FROM device_discard_record WHERE discard_id = $1 ORDER BY stage",
          [DISCARD],
        )
        .then((r) => r.rows.map((row) => row.stage));
    expect(await asCarer(stages)).toEqual(["deleted", "requested"]);
    expect(await asNorthManager(stages)).toEqual(["deleted", "requested"]);
    expect(await asTenantWide(stages)).toEqual(["deleted", "requested"]);
    expect(await asOtherTenant(stages)).toEqual([]);
  });
});

describe("hazard HZ-040 the server's flag on an entry its device recorded deleting", () => {
  const flag = (entryId: string, personId: string) => (c: pg.PoolClient) =>
    c.query(
      `INSERT INTO entry_device_deletion_flag (record_table, entry_id, person_id, location_id, flag,
          discard_id, owner_tenant_user_id)
       VALUES ('care_note', $1, $2, $3, 'uploaded_after_deletion', $4, $5)`,
      [entryId, personId, a.locationNorth, DISCARD, a.carer],
    );

  it("flags an entry once, only in the system's view, and never changes the flag", async () => {
    await asSystem(flag(NOTE_ADA, a.personAda));
    await expect(asSystem(flag(NOTE_ADA, a.personAda))).rejects.toThrow(
      /entry_device_deletion_flag_entry_key/,
    );
    await expect(asCarer(flag(NOTE_BEN, a.personBen))).rejects.toThrow(/row-level security/);
    await asSystem(flag(NOTE_BEN, a.personBen));
    await expect(
      asSystem((c) =>
        c.query("UPDATE entry_device_deletion_flag SET flag = 'deleted_after_upload'"),
      ),
    ).rejects.toThrow();
  });

  it("hazard HZ-011 is read like the entry: the carer sees Ada's flag, not Ben's, and another organisation neither", async () => {
    const flagged = (c: pg.PoolClient) =>
      c
        .query<{ entry_id: string }>(
          "SELECT entry_id FROM entry_device_deletion_flag ORDER BY entry_id",
        )
        .then((r) => r.rows.map((row) => row.entry_id));
    expect(await asCarer(flagged)).toEqual([NOTE_ADA]);
    expect(await asTenantWide(flagged)).toEqual([NOTE_ADA, NOTE_BEN].sort());
    expect(await asOtherTenant(flagged)).toEqual([]);
  });
});

describe("hazard HZ-019 the drawing on a body-map mark", () => {
  const mark = (drawing: {
    x: number | null;
    y: number | null;
    zone: string | null;
    side: string | null;
  }) =>
    asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO body_map_mark (person_id, location_id, occurred_at, view, region, side,
            drawn_x, drawn_y, drawn_zone, drawn_side, mark_type, created_by)
         VALUES ($1, $2, now(), 'front', 'knee', 'left', $3, $4, $5, $6, 'bruise', $7)`,
        [a.personAda, a.locationNorth, drawing.x, drawing.y, drawing.zone, drawing.side, a.carer],
      ),
    );

  it("keeps the point, zone and side worked out together", async () => {
    await mark({ x: 70, y: 170, zone: "viewer_right", side: "left" });
    await mark({ x: null, y: null, zone: "viewer_right", side: "left" });
    await mark({ x: null, y: null, zone: null, side: null });
  });

  it.each([
    ["a point with no zone", { x: 70, y: 170, zone: null, side: null }],
    ["half a point", { x: 70, y: null, zone: "viewer_right", side: "left" }],
    ["a point off the drawing", { x: 121, y: 170, zone: "viewer_right", side: "left" }],
    ["a zone with no side", { x: null, y: null, zone: "viewer_right", side: null }],
    ["a zone that does not exist", { x: null, y: null, zone: "middle", side: "left" }],
  ] as const)("refuses %s", async (_name, drawing) => {
    await expect(mark(drawing)).rejects.toThrow(/body_map_mark_drawing/);
  });
});

/** Runs the backfill section of migration 0044 again, as the owner. */
async function rerunBackfill() {
  const sql = readFileSync(
    fileURLToPath(new URL("../drizzle/0044_care_api_follow_ups_security.sql", import.meta.url)),
    "utf8",
  );
  const backfill = sql.slice(sql.indexOf("-- backfill: begin"), sql.indexOf("-- backfill: end"));
  const client = await db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    for (const statement of backfill.split("--> statement-breakpoint")) {
      if (statement.replace(/--.*$/gm, "").trim()) await client.query(statement);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

describe("migration 0044 fills the deletion records and flags from the audit trail (backfill)", () => {
  const OLD = "0199d000-0000-4000-8000-0000000000f1";
  const NOTE_OLD = "0199d000-0000-7000-8000-0000000000f2";

  it("records each stage once, with the staff kept only when they are staff here, and flags each entry once", async () => {
    await asOwner(TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO care_note (id, person_id, location_id, occurred_at, category, body, created_by)
         VALUES ($1, $2, $3, now() - interval '2 hours', 'night', 'Slept well.', $4)`,
        [NOTE_OLD, a.personAda, a.locationNorth, a.carer],
      );
      await c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, actor_tenant_user_id, device_id, scope, occurred_at) VALUES
           ($1, 'sync.entries.discard_requested', 'device_discard', $2, $3, $4,
            jsonb_build_object('kind', 'held_deleted', 'reasonCode', 'recorded_elsewhere', 'ownerTenantUserId', $7::text,
              'deletedByTenantUserId', '0193a000-0000-7000-8000-000000000999', 'count', 3, 'discardedAt', '2026-10-01T08:00:00.000Z'),
            '2026-10-01T08:00:05Z'),
           ($1, 'sync.entries.discarded', 'device_discard', $2, $3, $4,
            jsonb_build_object('kind', 'held_deleted', 'reasonCode', 'recorded_elsewhere', 'ownerTenantUserId', $7::text,
              'count', 3, 'discardedAt', '2026-10-01T08:01:00.000Z', 'heldOnDeviceId', $5::text),
            '2026-10-01T08:01:05Z'),
           ($1, 'sync.entries.discarded', 'device_discard', $2, $3, $4,
            jsonb_build_object('kind', 'held_deleted', 'reasonCode', 'recorded_elsewhere'), '2026-10-01T08:02:00Z'),
           ($1, 'sync.entries.discarded', 'device_discard', 'not-a-record', $3, $4,
            jsonb_build_object('kind', 'held_deleted', 'reasonCode', 'recorded_elsewhere'), '2026-10-01T08:03:00Z'),
           ($1, 'sync.entry.after_discard', 'care_note', $6, $3, $4,
            jsonb_build_object('discardId', $2::text, 'taskId', '0199d000-0000-4000-8000-0000000000ff'), '2026-10-01T09:00:00Z')`,
        [TENANT_A, OLD, a.carer, DEVICE, "0199d000-0000-4000-8000-0000000000d9", NOTE_OLD, a.carer],
      );
    });
    await rerunBackfill();
    await rerunBackfill();
    const records = await asOwner(TENANT_A, (c) =>
      c.query(
        `SELECT stage, kind, reason_code, owner_tenant_user_id AS owner,
                deleted_by_tenant_user_id AS deleter, sender_tenant_user_id AS sender,
                device_id, entry_count, discarded_at
         FROM device_discard_record WHERE discard_id = $1 ORDER BY stage`,
        [OLD],
      ),
    );
    expect(records.rows).toEqual([
      {
        stage: "deleted",
        kind: "held_deleted",
        reason_code: "recorded_elsewhere",
        owner: a.carer,
        deleter: null,
        sender: a.carer,
        device_id: "0199d000-0000-4000-8000-0000000000d9",
        entry_count: 3,
        discarded_at: new Date("2026-10-01T08:01:00Z"),
      },
      {
        stage: "requested",
        kind: "held_deleted",
        reason_code: "recorded_elsewhere",
        owner: a.carer,
        // Not staff here, so not kept.
        deleter: null,
        sender: a.carer,
        device_id: DEVICE,
        entry_count: 3,
        discarded_at: new Date("2026-10-01T08:00:00Z"),
      },
    ]);
    const flags = await asOwner(TENANT_A, (c) =>
      c.query(
        `SELECT record_table, flag, discard_id, owner_tenant_user_id AS owner, review_task_id, person_id
         FROM entry_device_deletion_flag WHERE entry_id = $1`,
        [NOTE_OLD],
      ),
    );
    expect(flags.rows).toEqual([
      {
        record_table: "care_note",
        flag: "uploaded_after_deletion",
        discard_id: OLD,
        owner: a.carer,
        // The task named no longer exists, so the flag keeps no link to it.
        review_task_id: null,
        person_id: a.personAda,
      },
    ]);
    const forced = await db
      .pool("harbour_owner")
      .query<{ relforcerowsecurity: boolean }>(
        "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'tenant'",
      );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
  });
});
