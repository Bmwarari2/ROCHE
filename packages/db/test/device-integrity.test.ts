import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUILTIN_ROLES } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Care mode devices in the database (care.md section 6, Device integrity; hazards HZ-011 and
 * HZ-040): which member has used which device, written only in the system's view and read by the
 * member or the organisation's managers; deletion lists; copies of refused entries; one open sync
 * task per source; shared quotas.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;

const DEVICE = "0199d000-0000-4000-8000-0000000000d1";
const DEVICE_2 = "0199d000-0000-4000-8000-0000000000d2";
const DEVICE_B = "0199d000-0000-4000-8000-0000000000d3";

const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const app = () => db.pool("harbour_app");
/** The system's view: the API binds and revokes in the organisation's view. */
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);
/** A tenant-wide role in its own view (not the system's: it acts as a member). */
const asTenantWide = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** A job with no member: tenant scope and no user. */
const asJob = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);

const devicesSeen = (c: pg.PoolClient) =>
  c
    .query<{ device_id: string; tenant_user_id: string }>(
      "SELECT device_id, tenant_user_id FROM device_binding ORDER BY device_id, tenant_user_id",
    )
    .then((r) => r.rows.map((row) => `${row.device_id}:${row.tenant_user_id}`));

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  // The carer works at North House; the manager has no located role there.
  await asOwner(TENANT_A, (c) =>
    c.query(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [a.carer, a.roleCarer, a.locationNorth],
    ),
  );
  await asSystem((c) =>
    c.query(
      `INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2), ($1, $3), ($4, $3)`,
      [DEVICE, a.carer, a.manager, DEVICE_2],
    ),
  );
  await inContext(app(), ctx(TENANT_B, b.manager, "tenant"), (c) =>
    c.query("INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2)", [
      DEVICE_B,
      b.manager,
    ]),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 device bindings (part 1)", () => {
  it("keeps each organisation's bindings to itself", async () => {
    expect(await asOtherTenant(devicesSeen)).toEqual([`${DEVICE_B}:${b.manager}`]);
    expect(await asNorthManager(devicesSeen)).not.toContain(`${DEVICE_B}:${b.manager}`);
  });

  it("shows a member their own devices, a location role its staff's and a tenant-wide role the organisation's", async () => {
    expect(await asCarer(devicesSeen)).toEqual([`${DEVICE}:${a.carer}`]);
    // North House's manager reads the carer's binding (the carer works there), not the bindings
    // of a member with no role at North House (#25 review round 2, low).
    expect(await asNorthManager(devicesSeen)).toEqual([`${DEVICE}:${a.carer}`]);
    expect(await asTenantWide(devicesSeen)).toEqual(
      [`${DEVICE}:${a.carer}`, `${DEVICE}:${a.manager}`, `${DEVICE_2}:${a.manager}`].sort(),
    );
  });

  it("lets only the system's view bind or revoke", async () => {
    await expect(
      asCarer((c) =>
        c.query("INSERT INTO device_binding (device_id, tenant_user_id) VALUES ($1, $2)", [
          DEVICE_2,
          a.carer,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
    const updated = await asNorthManager((c) =>
      c.query(
        `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'lost_or_stolen'
         WHERE device_id = $2`,
        [a.northManager, DEVICE],
      ),
    );
    expect(updated.rowCount).toBe(0);
  });

  it("never moves a binding, never moves a sighting back, and never undoes a revocation", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE device_binding SET tenant_user_id = $1 WHERE device_id = $2", [
          a.northManager,
          DEVICE_2,
        ]),
      ),
    ).rejects.toThrow(/keeps its device, member and first sighting/);
    const seen = await asSystem(async (c) => {
      await c.query(
        "UPDATE device_binding SET last_seen_at = '2000-01-01T00:00:00Z' WHERE device_id = $1",
        [DEVICE_2],
      );
      return c.query<{ later: boolean }>(
        "SELECT last_seen_at > '2001-01-01' AS later FROM device_binding WHERE device_id = $1",
        [DEVICE_2],
      );
    });
    expect(seen.rows[0]?.later).toBe(true);
    await asSystem((c) =>
      c.query(
        `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'replaced'
         WHERE device_id = $2`,
        [a.manager, DEVICE_2],
      ),
    );
    await expect(
      asSystem((c) =>
        c.query(
          "UPDATE device_binding SET revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL WHERE device_id = $1",
          [DEVICE_2],
        ),
      ),
    ).rejects.toThrow(/stays revoked/);
  });

  it("refuses a revocation without who or why, or with a reason not on the list", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE device_binding SET revoked_at = now() WHERE device_id = $1", [DEVICE]),
      ),
    ).rejects.toThrow(/device_binding_revocation/);
    await expect(
      asSystem((c) =>
        c.query(
          `UPDATE device_binding SET revoked_at = now(), revoked_by = $1, revocation_reason = 'because'
           WHERE device_id = $2`,
          [a.manager, DEVICE],
        ),
      ),
    ).rejects.toThrow(/device_binding_revocation/);
  });

  it("binds every member with an event from a device before migration 0030, first and last seen (backfill)", async () => {
    const sql = readFileSync(
      fileURLToPath(new URL("../drizzle/0030_device_binding_security.sql", import.meta.url)),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf("-- backfill: begin"), sql.indexOf("-- backfill: end"));
    const OLD = "0199d000-0000-4000-8000-0000000000e1";
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, actor_tenant_user_id, device_id, occurred_at)
         VALUES
           ($1, 'sync.token.issue', 'device', $2, $3, $2, '2026-10-01T08:00:00Z'),
           ($1, 'sync.device.report', 'device', upper($2), $3, $2, '2026-10-03T08:00:00Z'),
           ($1, 'sync.token.issue', 'device', 'not-a-device', $3, NULL, '2026-10-02T08:00:00Z'),
           ($1, 'sync.token.issue', 'device', $2, $4, $2, '2026-10-02T08:00:00Z')`,
        [TENANT_A, OLD, a.northManager, "0193a000-0000-7000-8000-000000000999"],
      ),
    );
    const run = async () => {
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
    };
    await run();
    await run();
    const rows = await asOwner(TENANT_A, (c) =>
      c.query<{ tenant_user_id: string; first_seen_at: Date; last_seen_at: Date }>(
        "SELECT tenant_user_id, first_seen_at, last_seen_at FROM device_binding WHERE device_id = $1",
        [OLD],
      ),
    );
    // One row: the member who is staff here, from the first event to the last; an event naming
    // no device, or from someone who is not a member, binds nothing.
    expect(rows.rows).toEqual([
      {
        tenant_user_id: a.northManager,
        first_seen_at: new Date("2026-10-01T08:00:00Z"),
        last_seen_at: new Date("2026-10-03T08:00:00Z"),
      },
    ]);
    // Row-level security is forced on the audit trail again.
    const forced = await db
      .pool("harbour_owner")
      .query<{ relforcerowsecurity: boolean }>(
        "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'audit_event'",
      );
    expect(forced.rows[0]?.relforcerowsecurity).toBe(true);
  });
});

/** Runs a migration file (or one section of it) again, statement by statement, as the owner. */
async function rerun(file: string, section?: { begin: string; end: string }) {
  let sql = readFileSync(fileURLToPath(new URL(`../drizzle/${file}`, import.meta.url)), "utf8");
  if (section) sql = sql.slice(sql.indexOf(section.begin), sql.indexOf(section.end));
  const client = await db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    for (const statement of sql.split("--> statement-breakpoint")) {
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

/** The permissions a role-permission migration adds for each built-in key, read from the file. */
function grantsIn(file: string): Map<string, string[]> {
  const sql = readFileSync(fileURLToPath(new URL(`../drizzle/${file}`, import.meta.url)), "utf8");
  const grants = new Map<string, string[]>();
  for (const match of sql.matchAll(/\('([a-z_]+)', ARRAY\[([^\]]*)\]\)/g)) {
    grants.set(
      match[1] ?? "",
      [...(match[2] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? ""),
    );
  }
  return grants;
}

describe("existing tenants' role copies gain the device permissions (migration 0031)", () => {
  const FILE = "0031_device_permissions.sql";
  const PERMISSIONS = ["platform.device.read", "platform.device.revoke"];

  it("lists the same roles as the built-in definitions", () => {
    const grants = grantsIn(FILE);
    for (const permission of PERMISSIONS) {
      const holders = BUILTIN_ROLES.filter((r) =>
        (r.permissions as readonly string[]).includes(permission),
      ).map((r) => r.key);
      const named = [...grants].filter(([, add]) => add.includes(permission)).map(([key]) => key);
      expect(named.sort()).toEqual([...holders].sort());
    }
  });

  it("adds them once to each copy that lacks them, as a new version, audited as the system", async () => {
    await asOwner(TENANT_B, (c) =>
      c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('registered_manager', 'Registered Manager', 'location', '{people.person.read}', true),
           ('deputy_manager', 'Deputy manager', 'location', '{people.person.read,platform.device.read}', true),
           ('care_worker', 'Care worker', 'assigned', '{people.person.read}', true)`,
      ),
    );
    await rerun(FILE);
    await rerun(FILE);
    const roles = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string; permissions: string[]; version: number }>(
        "SELECT key, permissions, version FROM role ORDER BY key",
      ),
    );
    expect(roles.rows.map((r) => [r.key, r.permissions, r.version])).toEqual([
      ["care_worker", ["people.person.read"], 1],
      [
        "deputy_manager",
        ["people.person.read", "platform.device.read", "platform.device.revoke"],
        2,
      ],
      [
        "registered_manager",
        ["people.person.read", "platform.device.read", "platform.device.revoke"],
        2,
      ],
    ]);
    const audit = await asOwner(TENANT_B, (c) =>
      c.query<{ actor: string; scope: { roleKey: string; added: string[] } }>(
        `SELECT actor_auth_user_id AS actor, scope FROM audit_event
         WHERE action = 'platform.role.permissions_migrated' ORDER BY scope ->> 'roleKey'`,
      ),
    );
    expect(audit.rows.map((r) => [r.actor, r.scope.roleKey, r.scope.added])).toEqual([
      ["system", "deputy_manager", ["platform.device.revoke"]],
      ["system", "registered_manager", ["platform.device.read", "platform.device.revoke"]],
    ]);
  });
});

describe("hazard HZ-040 hazard HZ-011 deletion lists (part 3)", () => {
  const DISCARD_CARER = "0199d000-0000-4000-8000-0000000000f1";
  const DISCARD_MANAGER = "0199d000-0000-4000-8000-0000000000f2";
  const ENTRY_1 = "0199d000-0000-7000-8000-0000000000a1";
  const ENTRY_2 = "0199d000-0000-7000-8000-0000000000a2";
  const listed = (c: pg.PoolClient) =>
    c
      .query<{ discard_id: string; entry_id: string }>(
        "SELECT discard_id, entry_id FROM device_discard_entry ORDER BY discard_id, entry_id",
      )
      .then((r) => r.rows.map((row) => `${row.discard_id}:${row.entry_id}`));

  beforeAll(async () => {
    // The carer records their own deletion; the manager records one of their own.
    await asCarer((c) =>
      c.query(
        `INSERT INTO device_discard_entry (discard_id, stage, entry_id, owner_tenant_user_id)
         VALUES ($1, 'deleted', $2, $3)`,
        [DISCARD_CARER, ENTRY_1, a.carer],
      ),
    );
    await asNorthManager((c) =>
      c.query(
        `INSERT INTO device_discard_entry (discard_id, stage, entry_id, owner_tenant_user_id)
         VALUES ($1, 'deleted', $2, $3)`,
        [DISCARD_MANAGER, ENTRY_2, a.manager],
      ),
    );
  });

  it("shows a member only their own deletions' entries, a location role its staff's and a tenant-wide role the organisation's", async () => {
    expect(await asCarer(listed)).toEqual([`${DISCARD_CARER}:${ENTRY_1}`]);
    // A location role writes any deletion's list (the API checks the manager first) but reads only
    // those of owners working at its locations (#25 review round 2, low).
    expect(await asNorthManager(listed)).toEqual([`${DISCARD_CARER}:${ENTRY_1}`]);
    expect(await asTenantWide(listed)).toEqual(
      [`${DISCARD_CARER}:${ENTRY_1}`, `${DISCARD_MANAGER}:${ENTRY_2}`].sort(),
    );
    expect(await asOtherTenant(listed)).toEqual([]);
  });

  it("refuses a member listing a deletion of someone else's entries", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO device_discard_entry (discard_id, stage, entry_id, owner_tenant_user_id)
           VALUES ($1, 'deleted', $2, $3)`,
          [DISCARD_MANAGER, ENTRY_1, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps the lists append-only and their stages to the list", async () => {
    await expect(
      asOwner(TENANT_A, (c) => c.query("UPDATE device_discard_entry SET stage = 'failed'")),
    ).rejects.toThrow(/append-only/);
    await expect(asSystem((c) => c.query("DELETE FROM device_discard_entry"))).rejects.toThrow(
      /permission denied|append-only/,
    );
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO device_discard_entry (discard_id, stage, entry_id) VALUES ($1, 'gone', $2)`,
          [DISCARD_CARER, ENTRY_2],
        ),
      ),
    ).rejects.toThrow(/device_discard_entry_stage/);
  });

  it("lists every entry id of the deletion records before migration 0033, by stage (backfill)", async () => {
    const OLD = "0199d000-0000-4000-8000-0000000000f9";
    const ENTRY_OLD = "0199d000-0000-7000-8000-0000000000a9";
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope, occurred_at) VALUES
           ($1, 'sync.entries.discard_requested', 'device_discard', $2,
            jsonb_build_object('ownerTenantUserId', $3::text, 'entryIds', jsonb_build_array($4::text, 'not-an-id')), '2026-10-01T08:00:00Z'),
           ($1, 'sync.entries.discarded', 'device_discard', $2,
            jsonb_build_object('ownerTenantUserId', $3::text, 'entryIds', jsonb_build_array($4::text)), '2026-10-01T08:05:00Z'),
           ($1, 'sync.entries.discarded', 'device_discard', 'not-a-record',
            jsonb_build_object('ownerTenantUserId', $3::text, 'entryIds', jsonb_build_array($4::text)), '2026-10-01T08:06:00Z')`,
        [TENANT_A, OLD, a.carer, ENTRY_OLD],
      ),
    );
    const section = { begin: "-- backfill: begin", end: "-- backfill: end" };
    await rerun("0033_device_discard_entry_security.sql", section);
    await rerun("0033_device_discard_entry_security.sql", section);
    const rows = await asOwner(TENANT_A, (c) =>
      c.query<{ stage: string; entry_id: string; owner: string; recorded_at: Date }>(
        `SELECT stage, entry_id, owner_tenant_user_id AS owner, recorded_at
         FROM device_discard_entry WHERE discard_id = $1 ORDER BY recorded_at`,
        [OLD],
      ),
    );
    expect(rows.rows).toEqual([
      {
        stage: "requested",
        entry_id: ENTRY_OLD,
        owner: a.carer,
        recorded_at: new Date("2026-10-01T08:00:00Z"),
      },
      {
        stage: "deleted",
        entry_id: ENTRY_OLD,
        owner: a.carer,
        recorded_at: new Date("2026-10-01T08:05:00Z"),
      },
    ]);
  });
});

describe("hazard HZ-008 one open sync task per source (part 4)", () => {
  const HOLD_DEVICE = "0199d000-0000-4000-8000-0000000000c1";
  const RECORD = "0199d000-0000-4000-8000-0000000000c2";
  const insertTask = (
    c: pg.PoolClient,
    fields: { kind: string; sourceType: string; sourceId: string; location: string | null },
  ) =>
    c.query(
      `INSERT INTO task (kind, title, required_permission, source_type, source_id, location_id, due_at)
       VALUES ($1, 'A sync task', 'safety.incident.manage', $2, $3, $4, now()) RETURNING id`,
      [fields.kind, fields.sourceType, fields.sourceId, fields.location],
    );
  const hold = { kind: "sync.device_hold", sourceType: "device_hold", sourceId: HOLD_DEVICE };

  it("refuses a second open task for the same device and location, and allows one after the first closes", async () => {
    const first = await asSystem((c) => insertTask(c, { ...hold, location: a.locationNorth }));
    await expect(
      asSystem((c) => insertTask(c, { ...hold, location: a.locationNorth })),
    ).rejects.toThrow(/task_sync_open_source_key/);
    // Another location, or no location, is another task (each location's managers have their own).
    await asSystem((c) => insertTask(c, { ...hold, location: a.locationSouth }));
    await asSystem((c) => insertTask(c, { ...hold, location: null }));
    await expect(asSystem((c) => insertTask(c, { ...hold, location: null }))).rejects.toThrow(
      /task_sync_open_source_key/,
    );
    await asSystem((c) =>
      c.query("UPDATE task SET status = 'done' WHERE id = $1", [first.rows[0]?.id]),
    );
    await asSystem((c) => insertTask(c, { ...hold, location: a.locationNorth }));
  });

  it("refuses a second open flagged-entry task for the same deletion record and location", async () => {
    const flagged = {
      kind: "sync.entry_reported_deleted",
      sourceType: "device_discard",
      sourceId: RECORD,
    };
    await asSystem((c) => insertTask(c, { ...flagged, location: a.locationNorth }));
    await expect(
      asSystem((c) => insertTask(c, { ...flagged, location: a.locationNorth })),
    ).rejects.toThrow(/task_sync_open_source_key/);
    // Other kinds of task are not limited.
    await asSystem((c) =>
      insertTask(c, {
        kind: "platform.manual",
        sourceType: "device_discard",
        sourceId: RECORD,
        location: a.locationNorth,
      }),
    );
    await asSystem((c) =>
      insertTask(c, {
        kind: "platform.manual",
        sourceType: "device_discard",
        sourceId: RECORD,
        location: a.locationNorth,
      }),
    );
  });

  it("closes duplicates an earlier race left, keeping the oldest with what they carried, and gives flagged tasks their owner and count (migration 0034)", async () => {
    const DUP = "0199d000-0000-4000-8000-0000000000c3";
    const FLAG = "0199d000-0000-4000-8000-0000000000c4";
    const ids = await inContext(
      db.pool("harbour_owner"),
      ctx(TENANT_A, null, "tenant"),
      async (c) => {
        // As before 0035: no index.
        await c.query("DROP INDEX task_sync_open_source_key");
        const made: string[] = [];
        // The second is due two hours earlier and urgent, the third in progress: the kept task
        // takes all three over (#25 review round 2, low).
        for (let i = 0; i < 3; i += 1) {
          const row = await c.query<{ id: string }>(
            `INSERT INTO task (kind, title, required_permission, source_type, source_id, location_id, due_at, created_at, priority, status)
           VALUES ('sync.device_hold', 'Unsent care entries are waiting on a device', 'safety.incident.manage',
                   'device_hold', $1, $2, now() - make_interval(hours => $4), now() + make_interval(secs => $3), $5, $6) RETURNING id`,
            [
              DUP,
              a.locationNorth,
              i,
              i === 1 ? 2 : 0,
              i === 1 ? "urgent" : "routine",
              i === 2 ? "in_progress" : "open",
            ],
          );
          made.push(row.rows[0]?.id ?? "");
        }
        const flagged = await c.query<{ id: string }>(
          `INSERT INTO task (kind, title, required_permission, source_type, source_id, location_id, due_at)
         VALUES ('sync.entry_reported_deleted', 'Check entries: 2', 'safety.incident.manage',
                 'device_discard', $1, $2, now()) RETURNING id`,
          [FLAG, a.locationNorth],
        );
        const flagId = flagged.rows[0]?.id ?? "";
        await c.query(
          `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope) VALUES
           ($1, 'sync.entry_flag.raised', 'task', $2, jsonb_build_object('ownerTenantUserId', $3::text, 'count', 1)),
           ($1, 'sync.entry_flag.added', 'task', $2, jsonb_build_object('count', 2))`,
          [TENANT_A, flagId, a.carer],
        );
        // A duplicate flagged task for the same deletion, already carrying its entries.
        await c.query(
          `INSERT INTO task (kind, title, required_permission, source_type, source_id, location_id, due_at, created_at, details)
         VALUES ('sync.entry_reported_deleted', 'Check entries: 3', 'safety.incident.manage',
                 'device_discard', $1, $2, now(), now() + interval '1 minute',
                 jsonb_build_object('ownerTenantUserId', $3::text, 'entryCount', 3,
                   'entries', jsonb_build_array(jsonb_build_object('kind', 'care_note', 'entryId', $4::text))))`,
          [FLAG, a.locationNorth, a.carer, "0199d000-0000-7000-8000-0000000000c5"],
        );
        return { made, flagId };
      },
    );
    await rerun("0034_sync_task_dedupe.sql");
    await rerun("0034_sync_task_dedupe.sql");
    await rerun("0035_sync_task_open_key.sql");
    const rows = await asOwner(TENANT_A, (c) =>
      c.query<{ id: string; status: string; status_reason: string | null }>(
        "SELECT id, status, status_reason FROM task WHERE source_id = $1 ORDER BY created_at",
        [DUP],
      ),
    );
    expect(rows.rows.map((r) => [r.id, r.status])).toEqual([
      [ids.made[0], "in_progress"],
      [ids.made[1], "cancelled"],
      [ids.made[2], "cancelled"],
    ]);
    expect(rows.rows[1]?.status_reason).toMatch(/duplicate/);
    const kept = await asOwner(TENANT_A, (c) =>
      c.query<{ early: boolean; priority: string; status: string }>(
        `SELECT due_at < now() - interval '1 hour' AS early, priority, status FROM task WHERE id = $1`,
        [ids.made[0]],
      ),
    );
    expect(kept.rows[0]).toEqual({ early: true, priority: "urgent", status: "in_progress" });
    const audit = await asOwner(TENANT_A, (c) =>
      c.query<{ resource_id: string; kept: string }>(
        "SELECT resource_id, scope ->> 'keptTaskId' AS kept FROM audit_event WHERE action = 'platform.task.duplicate_closed' AND scope ->> 'keptTaskId' = $1 ORDER BY resource_id",
        [ids.made[0]],
      ),
    );
    expect(audit.rows).toEqual(
      [ids.made[1], ids.made[2]].sort().map((id) => ({ resource_id: id, kept: ids.made[0] })),
    );
    const details = await asOwner(TENANT_A, (c) =>
      c.query<{ details: unknown }>("SELECT details FROM task WHERE id = $1", [ids.flagId]),
    );
    // Its own count (2, from its audit events) and the duplicate's (3), with the duplicate's entry.
    expect(details.rows[0]?.details).toEqual({
      ownerTenantUserId: a.carer,
      entryCount: 5,
      entries: [{ kind: "care_note", entryId: "0199d000-0000-7000-8000-0000000000c5" }],
    });
  });
});

describe("hazard HZ-006 hazard HZ-011 copies of refused entries (part 5)", () => {
  const ENTRY_ADA = "0199d000-0000-7000-8000-0000000000b1";
  const ENTRY_CARA = "0199d000-0000-7000-8000-0000000000b2";
  const ENTRY_NOBODY = "0199d000-0000-7000-8000-0000000000b3";
  const ENTRY_B = "0199d000-0000-7000-8000-0000000000b4";
  const copy = (
    c: pg.PoolClient,
    entryId: string,
    personId: string | null,
    locationId: string | null,
    author: string,
  ) =>
    c.query(
      `INSERT INTO refused_entry (entry_id, record_table, person_id, location_id, payload, http_status,
         refusal_code, refusal_message, refused_at, author_tenant_user_id)
       VALUES ($1, 'care_note', $2, $3, '{"body":"Assisted with a wash."}', 422, 'care_event_after_exit',
         'The person had left.', now(), $4)`,
      [entryId, personId, locationId, author],
    );
  const copies = (c: pg.PoolClient) =>
    c
      .query<{ entry_id: string }>("SELECT entry_id FROM refused_entry ORDER BY entry_id")
      .then((r) => r.rows.map((row) => row.entry_id));

  beforeAll(async () => {
    await asSystem(async (c) => {
      await copy(c, ENTRY_ADA, a.personAda, a.locationNorth, a.carer);
      await copy(c, ENTRY_CARA, a.personCara, a.locationSouth, a.carer);
      await copy(c, ENTRY_NOBODY, null, a.locationNorth, a.carer);
    });
    await inContext(app(), ctx(TENANT_B, b.manager, "tenant"), (c) =>
      copy(c, ENTRY_B, b.personDev, b.location, b.manager),
    );
  });

  it("reads a copy like the care record it would have been", async () => {
    // The carer is assigned to Ada only, so sees Ada's copy and not Cara's or the one about nobody.
    expect(await asCarer(copies)).toEqual([ENTRY_ADA]);
    // North's manager sees North's people and the copy about nobody at North.
    expect(await asNorthManager(copies)).toEqual([ENTRY_ADA, ENTRY_NOBODY].sort());
    // The organisation sees its own; the other organisation sees only its own.
    expect(await asSystem(copies)).toEqual([ENTRY_ADA, ENTRY_CARA, ENTRY_NOBODY].sort());
    expect(await asOtherTenant(copies)).toEqual([ENTRY_B]);
  });

  it("is written only in the system's view, once per entry, and never changed", async () => {
    await expect(
      asCarer((c) => copy(c, "0199d000-0000-7000-8000-0000000000b5", a.personAda, null, a.carer)),
    ).rejects.toThrow(/row-level security/);
    await expect(asSystem((c) => copy(c, ENTRY_ADA, a.personAda, null, a.carer))).rejects.toThrow(
      /refused_entry_entry_key/,
    );
    await expect(
      asOwner(TENANT_A, (c) => c.query("UPDATE refused_entry SET refusal_code = 'other'")),
    ).rejects.toThrow(/append-only/);
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO refused_entry (entry_id, record_table, payload, refusal_code, refused_at, author_tenant_user_id)
           VALUES ($1, 'person', '[]', 'Not a code!', now(), $2)`,
          ["0199d000-0000-7000-8000-0000000000b6", a.carer],
        ),
      ),
    ).rejects.toThrow(/refused_entry_(table|payload|code)/);
  });

  it("never points at another organisation's person, location or member", async () => {
    await expect(
      asSystem((c) => copy(c, "0199d000-0000-7000-8000-0000000000b7", b.personDev, null, a.carer)),
    ).rejects.toThrow(/refused_entry_person_fk/);
  });
});

describe("existing tenants' role copies gain the hand-over permission (migration 0038)", () => {
  const FILE = "0038_handover_permission.sql";

  it("lists the same roles as the built-in definitions", () => {
    const holders = BUILTIN_ROLES.filter((r) =>
      (r.permissions as readonly string[]).includes("care.held_entry.hand_over"),
    ).map((r) => r.key);
    const named = [...grantsIn(FILE)]
      .filter(([, add]) => add.includes("care.held_entry.hand_over"))
      .map(([key]) => key);
    expect(named.sort()).toEqual([...holders].sort());
    // The same people who may delete held entries (safety.incident.manage).
    const deleters = BUILTIN_ROLES.filter((r) =>
      (r.permissions as readonly string[]).includes("safety.incident.manage"),
    ).map((r) => r.key);
    expect([...holders].sort()).toEqual([...deleters].sort());
  });

  it("adds it once to each copy that lacks it, audited as the system", async () => {
    await asOwner(TENANT_B, (c) =>
      c.query(
        `INSERT INTO role (key, name, scope_kind, permissions, is_builtin) VALUES
           ('clinical_lead', 'Clinical lead', 'location', '{people.person.read}', true)`,
      ),
    );
    await rerun(FILE);
    await rerun(FILE);
    const roles = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string; has: boolean }>(
        "SELECT key, 'care.held_entry.hand_over' = ANY (permissions) AS has FROM role ORDER BY key",
      ),
    );
    expect(roles.rows).toEqual([
      { key: "care_worker", has: false },
      { key: "clinical_lead", has: true },
      { key: "deputy_manager", has: true },
      { key: "registered_manager", has: true },
    ]);
    const audit = await asOwner(TENANT_B, (c) =>
      c.query<{ key: string }>(
        `SELECT scope ->> 'roleKey' AS key FROM audit_event
         WHERE action = 'platform.role.permissions_migrated'
           AND scope ->> 'migration' = '0038_handover_permission' ORDER BY 1`,
      ),
    );
    expect(audit.rows.map((r) => r.key)).toEqual([
      "clinical_lead",
      "deputy_manager",
      "registered_manager",
    ]);
  });
});

describe("hazard HZ-011 shared request limits (part 7)", () => {
  const hit = (c: pg.PoolClient, user: string) =>
    c.query(
      `INSERT INTO request_quota (quota, tenant_user_id, hits) VALUES ('sync.reports', $1, '[{"at": 1, "amount": 1}]')`,
      [user],
    );
  const owners = (c: pg.PoolClient) =>
    c
      .query<{ tenant_user_id: string }>("SELECT tenant_user_id FROM request_quota ORDER BY 1")
      .then((r) => r.rows.map((row) => row.tenant_user_id));

  it("counts a member's own requests in their own view, and nobody else's", async () => {
    await asCarer((c) => hit(c, a.carer));
    await expect(asCarer((c) => hit(c, a.manager))).rejects.toThrow(/row-level security/);
    // A tenant-wide role, even in the system's view acting for a member, neither writes nor reads
    // another member's hits (#25 review round 2, low); a job with no member may.
    await expect(asTenantWide((c) => hit(c, a.northManager))).rejects.toThrow(/row-level security/);
    await expect(asSystem((c) => hit(c, a.northManager))).rejects.toThrow(/row-level security/);
    await asJob((c) => hit(c, a.northManager));
    expect(await asCarer(owners)).toEqual([a.carer]);
    expect(await asTenantWide(owners)).toEqual([]);
    expect(await asJob(owners)).toEqual([a.carer, a.northManager].sort());
    expect(await asOtherTenant(owners)).toEqual([]);
    // One row per member and limit.
    await expect(asCarer((c) => hit(c, a.carer))).rejects.toThrow(/request_quota_key/);
  });
});

describe("hazard HZ-011 hazard HZ-040 device sessions and hand-overs (#25 review round 2)", () => {
  const SESSION = "session-a-carer-1";
  const HANDOVER = "0199d000-0000-4000-8000-0000000000e1";
  const ENTRY = "0199d000-0000-7000-8000-0000000000e2";
  const sessions = (c: pg.PoolClient) =>
    c
      .query<{ session_id: string }>("SELECT session_id FROM device_session ORDER BY 1")
      .then((r) => r.rows.map((row) => row.session_id));
  const handedOver = (c: pg.PoolClient) =>
    c
      .query<{ entry_id: string }>("SELECT entry_id FROM handed_over_entry ORDER BY 1")
      .then((r) => r.rows.map((row) => row.entry_id));

  beforeAll(async () => {
    await asSystem((c) =>
      c.query(
        "INSERT INTO device_session (device_id, tenant_user_id, session_id) VALUES ($1, $2, $3)",
        [DEVICE, a.carer, SESSION],
      ),
    );
    await asSystem((c) =>
      c.query(
        `INSERT INTO handed_over_entry (handover_id, device_id, owner_tenant_user_id, sent_by, record_table, entry_id)
         VALUES ($1, $2, $3, $4, 'care_note', $5)`,
        [HANDOVER, DEVICE, a.carer, a.manager, ENTRY],
      ),
    );
  });

  it("binds a session only to a device its member is bound to, written in the system's view", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO device_session (device_id, tenant_user_id, session_id) VALUES ($1, $2, 'x')",
          [DEVICE, a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // The carer was never bound to the second device.
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO device_session (device_id, tenant_user_id, session_id) VALUES ($1, $2, 'y')",
          [DEVICE_2, a.carer],
        ),
      ),
    ).rejects.toThrow(/device_session_binding_fk/);
  });

  it("shows a member their own sessions and nobody else, and keeps them append-only", async () => {
    expect(await asCarer(sessions)).toEqual([SESSION]);
    expect(await asNorthManager(sessions)).toEqual([]);
    expect(await asOtherTenant(sessions)).toEqual([]);
    await expect(
      asOwner(TENANT_A, (c) => c.query("UPDATE device_session SET session_id = 'z'")),
    ).rejects.toThrow(/append-only|not allowed|forbid/i);
  });

  it("shows a hand-over to its sender, its owner and the organisation's managers, and keeps it append-only", async () => {
    expect(await asCarer(handedOver)).toEqual([ENTRY]);
    expect(await asTenantWide(handedOver)).toEqual([ENTRY]);
    // North House's manager: the owner works there.
    expect(await asNorthManager(handedOver)).toEqual([ENTRY]);
    expect(await asOtherTenant(handedOver)).toEqual([]);
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO handed_over_entry (handover_id, device_id, owner_tenant_user_id, sent_by, record_table, entry_id)
           VALUES ($1, $2, $3, $3, 'care_note', $4)`,
          [HANDOVER, DEVICE, a.carer, "0199d000-0000-7000-8000-0000000000e3"],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    // One row per entry, whatever the hand-over.
    await expect(
      asSystem((c) =>
        c.query(
          `INSERT INTO handed_over_entry (handover_id, device_id, owner_tenant_user_id, sent_by, record_table, entry_id)
           VALUES ($1, $2, $3, $4, 'care_note', $5)`,
          [crypto.randomUUID(), DEVICE, a.carer, a.manager, ENTRY],
        ),
      ),
    ).rejects.toThrow(/handed_over_entry_entry_key/);
    await expect(
      asOwner(TENANT_A, (c) => c.query("DELETE FROM handed_over_entry")),
    ).rejects.toThrow(/append-only|not allowed|forbid/i);
  });
});

describe("hazard HZ-011 hazard HZ-040 live assignments, device sessions and hand-over admission (#25 review round 3)", () => {
  const HANDOVER = "0199d000-0000-4000-8000-0000000000e5";
  const entry = (n: number) => `0199d000-0000-7000-8000-0000000003${n.toString().padStart(2, "0")}`;
  /** A member sending a hand-over, in their own view. */
  const asSender = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
    inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
  const admit = (
    c: pg.PoolClient,
    input: {
      readonly entryId: string;
      readonly since: string;
      readonly limit: number;
      readonly owner?: string;
      readonly sender?: string;
      readonly handover?: string;
    },
  ) =>
    c
      .query<{ reason: string | null }>(
        "SELECT app.admit_handed_over_entry($1, $2, $3, $4, 'care_note', $5, $6, $7) AS reason",
        [
          input.handover ?? HANDOVER,
          DEVICE,
          input.owner ?? a.carer,
          input.sender ?? a.northManager,
          input.entryId,
          input.since,
          input.limit,
        ],
      )
      .then((r) => r.rows[0]?.reason ?? null);
  const admitted = (entryId: string) =>
    asOwner(TENANT_A, (c) =>
      c.query("SELECT sent_by FROM handed_over_entry WHERE entry_id = $1", [entryId]),
    ).then((r) => r.rows);

  it("lets a location role read only the devices, deletions and hand-overs of staff with a live, undeleted role assignment at its locations", async () => {
    // The manager's role at North House ended yesterday; another there was deleted.
    await asOwner(TENANT_A, async (c) => {
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from, valid_to)
         VALUES ($1, $2, $3, now() - interval '2 days', now() - interval '1 day')`,
        [a.manager, a.roleCarer, a.locationNorth],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, deleted_at)
         VALUES ($1, $2, $3, now())`,
        [a.manager, a.roleCarer, a.locationNorth],
      );
    });
    await asSystem((c) =>
      c.query(
        `INSERT INTO handed_over_entry (handover_id, device_id, owner_tenant_user_id, sent_by, record_table, entry_id)
         VALUES ($1, $2, $3, $4, 'care_note', $5)`,
        [crypto.randomUUID(), DEVICE, a.manager, a.carer, entry(1)],
      ),
    );
    const owners = (table: string) => (c: pg.PoolClient) =>
      c
        .query<{ owner: string }>(
          `SELECT DISTINCT ${table === "device_binding" ? "tenant_user_id" : "owner_tenant_user_id"} AS owner FROM ${table}`,
        )
        .then((r) => r.rows.map((row) => row.owner));
    for (const table of ["device_binding", "device_discard_entry", "handed_over_entry"]) {
      expect(await asNorthManager(owners(table))).not.toContain(a.manager);
      expect(await asTenantWide(owners(table))).toContain(a.manager);
    }
    expect(await asNorthManager(owners("device_binding"))).toContain(a.carer);
  });

  it("shows a session to its member or a job only, never to a tenant-wide role, and binds only the member's own", async () => {
    const sessions = (c: pg.PoolClient) =>
      c.query("SELECT session_id FROM device_session").then((r) => r.rows.length);
    expect(await asTenantWide(sessions)).toBe(0);
    expect(await asCarer(sessions)).toBeGreaterThan(0);
    expect(await asJob(sessions)).toBeGreaterThan(0);
    // The system's view acting for the carer binds only the carer's sessions; a job binds none.
    await expect(
      asSystem((c) =>
        c.query(
          "INSERT INTO device_session (device_id, tenant_user_id, session_id) VALUES ($1, $2, 'm')",
          [DEVICE, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asJob((c) =>
        c.query(
          "INSERT INTO device_session (device_id, tenant_user_id, session_id) VALUES ($1, $2, 'j')",
          [DEVICE, a.carer],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("admits a handed-over entry for its sender only, within the hold's count, one owner, device and sender per id, and restores the sender's view", async () => {
    const since = new Date().toISOString();
    expect(await asSender((c) => admit(c, { entryId: entry(2), since, limit: 2 }))).toBeNull();
    // The sender's own view is back once it returns.
    expect(
      await asSender(async (c) => {
        await admit(c, { entryId: entry(2), since, limit: 2 });
        return (await c.query<{ s: string }>("SELECT current_setting('app.scope') AS s")).rows[0]
          ?.s;
      }),
    ).toBe("locations");
    // A replay passes again without counting; one row per entry.
    expect(await admitted(entry(2))).toEqual([{ sent_by: a.northManager }]);
    expect(await asSender((c) => admit(c, { entryId: entry(3), since, limit: 2 }))).toBeNull();
    expect(await asSender((c) => admit(c, { entryId: entry(4), since, limit: 2 }))).toMatch(
      /All 2 entries/,
    );
    expect(await admitted(entry(4))).toEqual([]);
    // The same id cannot name another owner.
    expect(
      await asSender((c) => admit(c, { entryId: entry(5), since, limit: 9, owner: a.manager })),
    ).toMatch(/already used/);
    // Only the member sending it, never in someone else's name or as a job.
    await expect(
      asSender((c) => admit(c, { entryId: entry(6), since, limit: 9, sender: a.manager })),
    ).rejects.toThrow(/only for the member sending it/);
    await expect(
      asJob((c) => admit(c, { entryId: entry(6), since, limit: 9, sender: a.manager })),
    ).rejects.toThrow(/only for the member sending it/);
    // A write refused after its admission takes the admission back with it.
    await expect(
      asSender(async (c) => {
        await admit(c, { entryId: entry(7), since, limit: 9, handover: crypto.randomUUID() });
        throw new Error("the entry was refused");
      }),
    ).rejects.toThrow(/the entry was refused/);
    expect(await admitted(entry(7))).toEqual([]);
  });
});
