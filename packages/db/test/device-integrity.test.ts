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

const devicesSeen = (c: pg.PoolClient) =>
  c
    .query<{ device_id: string; tenant_user_id: string }>(
      "SELECT device_id, tenant_user_id FROM device_binding ORDER BY device_id, tenant_user_id",
    )
    .then((r) => r.rows.map((row) => `${row.device_id}:${row.tenant_user_id}`));

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
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

  it("shows a member their own devices and a manager the organisation's", async () => {
    expect(await asCarer(devicesSeen)).toEqual([`${DEVICE}:${a.carer}`]);
    expect(await asNorthManager(devicesSeen)).toEqual(
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

  it("shows a member only their own deletions' entries, and a manager the organisation's", async () => {
    expect(await asCarer(listed)).toEqual([`${DISCARD_CARER}:${ENTRY_1}`]);
    expect(await asNorthManager(listed)).toEqual(
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

  it("closes duplicates an earlier race left, keeping the oldest, and gives flagged tasks their owner and count (migration 0034)", async () => {
    const DUP = "0199d000-0000-4000-8000-0000000000c3";
    const FLAG = "0199d000-0000-4000-8000-0000000000c4";
    const ids = await inContext(
      db.pool("harbour_owner"),
      ctx(TENANT_A, null, "tenant"),
      async (c) => {
        // As before 0035: no index.
        await c.query("DROP INDEX task_sync_open_source_key");
        const made: string[] = [];
        for (let i = 0; i < 3; i += 1) {
          const row = await c.query<{ id: string }>(
            `INSERT INTO task (kind, title, required_permission, source_type, source_id, location_id, due_at, created_at)
           VALUES ('sync.device_hold', 'Unsent care entries are waiting on a device', 'safety.incident.manage',
                   'device_hold', $1, $2, now(), now() + make_interval(secs => $3)) RETURNING id`,
            [DUP, a.locationNorth, i],
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
      [ids.made[0], "open"],
      [ids.made[1], "cancelled"],
      [ids.made[2], "cancelled"],
    ]);
    expect(rows.rows[1]?.status_reason).toMatch(/duplicate/);
    const audit = await asOwner(TENANT_A, (c) =>
      c.query<{ resource_id: string; kept: string }>(
        "SELECT resource_id, scope ->> 'keptTaskId' AS kept FROM audit_event WHERE action = 'platform.task.duplicate_closed' ORDER BY resource_id",
      ),
    );
    expect(audit.rows).toEqual(
      [ids.made[1], ids.made[2]].sort().map((id) => ({ resource_id: id, kept: ids.made[0] })),
    );
    const details = await asOwner(TENANT_A, (c) =>
      c.query<{ details: unknown }>("SELECT details FROM task WHERE id = $1", [ids.flagId]),
    );
    expect(details.rows[0]?.details).toEqual({ ownerTenantUserId: a.carer, entryCount: 2 });
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
