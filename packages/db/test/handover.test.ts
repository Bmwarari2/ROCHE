import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The shift handover (care.md rule 8, COMMS-006; slice 5) in the database: handovers follow the
 * location and the people on their items (HZ-011), items can only be added to (HZ-018), notes and
 * acknowledgements are append-only and nobody acknowledges for someone else; one live task series
 * per care plan action (care.md rule 14); alerts name their location (HZ-018).
 */

let db: TestDatabase;
const a = ids.a;

const HANDOVER_NORTH = "0193a000-0000-7000-8000-00000000d001";
const HANDOVER_SOUTH = "0193a000-0000-7000-8000-00000000d002";
const HANDOVER_B = "0193b000-0000-7000-8000-00000000d001";

const item = (key: string, personId: string | null) => ({
  key,
  kind: "fall",
  personId,
  sourceType: "incident",
  sourceId: key,
  at: "2026-10-11T09:00:00.000Z",
  lateAddition: false,
  addedAt: "2026-10-11T18:30:00.000Z",
});
const NORTH_ITEMS = [item("fall:ada", a.personAda), item("fall:ben", a.personBen)];

const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    for (const [id, locationId, items] of [
      [HANDOVER_NORTH, a.locationNorth, NORTH_ITEMS],
      [HANDOVER_SOUTH, a.locationSouth, [item("fall:cara", a.personCara)]],
    ] as const) {
      await c.query(
        `INSERT INTO handover (id, location_id, shift_name, shift_start, shift_end, items, compiled_at, refreshed_at)
         VALUES ($1, $2, 'day', '2026-10-11T07:00:00Z', '2026-10-11T19:00:00Z', $3, now(), now())`,
        [id, locationId, JSON.stringify(items)],
      );
    }
    await c.query(
      `INSERT INTO handover_note (handover_id, item_key, person_id, body) VALUES
         ($1, NULL, NULL, 'Lift out of order on the first floor.'),
         ($1, 'fall:ada', $2, 'GP called back.'),
         ($1, 'fall:ben', $3, 'Hip x-ray booked.')`,
      [HANDOVER_NORTH, a.personAda, a.personBen],
    );
  });
  // Only the person acknowledging can record it, so the manager does.
  await asManager((c) =>
    c.query("INSERT INTO handover_acknowledgement (handover_id, items_seen) VALUES ($1, 2)", [
      HANDOVER_NORTH,
    ]),
  );
  await asOwner(TENANT_B, (c) =>
    c.query(
      `INSERT INTO handover (id, location_id, shift_name, shift_start, shift_end, items, compiled_at, refreshed_at)
       VALUES ($1, $2, 'day', '2026-10-11T07:00:00Z', '2026-10-11T19:00:00Z', '[]', now(), now())`,
      [HANDOVER_B, ids.b.location],
    ),
  );
});

afterAll(async () => {
  await db?.drop();
});

async function visible(context: ReturnType<typeof ctx>) {
  return inContext(app(), context, async (c) => {
    const handovers = await c.query<{ id: string }>("SELECT id FROM handover ORDER BY id");
    const notes = await c.query<{ body: string }>("SELECT body FROM handover_note ORDER BY body");
    const acks = await c.query<{ id: string }>("SELECT id FROM handover_acknowledgement");
    return {
      handovers: handovers.rows.map((r) => r.id),
      notes: notes.rows.map((r) => r.body),
      acknowledgements: acks.rows.length,
    };
  });
}

describe("hazard HZ-011 handovers follow the location and the people on their items", () => {
  it("shows tenant-wide roles every handover of their organisation", async () => {
    expect(await visible(ctx(TENANT_A, a.manager, "tenant"))).toEqual({
      handovers: [HANDOVER_NORTH, HANDOVER_SOUTH],
      notes: ["GP called back.", "Hip x-ray booked.", "Lift out of order on the first floor."],
      acknowledgements: 1,
    });
  });

  it("shows a location manager their location's handover only", async () => {
    const seen = await visible(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]));
    expect(seen.handovers).toEqual([HANDOVER_NORTH]);
  });

  it("shows a care worker the handover where their person lives, and only notes about them", async () => {
    expect(await visible(ctx(TENANT_A, a.carer, "assigned"))).toEqual({
      handovers: [HANDOVER_NORTH],
      notes: ["GP called back.", "Lift out of order on the first floor."],
      acknowledgements: 1,
    });
  });

  it("shows another organisation nothing, and a role with no person scope nothing", async () => {
    expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual({
      handovers: [HANDOVER_B],
      notes: [],
      acknowledgements: 0,
    });
    expect((await visible(ctx(TENANT_A, a.manager, "none"))).handovers).toEqual([]);
  });

  it("refuses a handover at another organisation's location", async () => {
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO handover (location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
           VALUES ($1, 'night', '2026-10-11T19:00:00Z', '2026-10-12T07:00:00Z', now(), now())`,
          [ids.b.location],
        ),
      ),
    ).rejects.toThrow(/handover_location_fk/);
  });

  it("refuses a note about a person outside the writer's scope", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO handover_note (handover_id, item_key, person_id, body) VALUES ($1, 'fall:ben', $2, 'Seen.')",
          [HANDOVER_NORTH, a.personBen],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("hazard HZ-018 acknowledgements are each person's own and append-only", () => {
  it("lets a care worker acknowledge for themselves, never for someone else", async () => {
    await asCarer((c) =>
      c.query("INSERT INTO handover_acknowledgement (handover_id, items_seen) VALUES ($1, 2)", [
        HANDOVER_NORTH,
      ]),
    );
    const mine = await asCarer((c) =>
      c.query<{ tenant_user_id: string }>(
        "SELECT tenant_user_id FROM handover_acknowledgement WHERE tenant_user_id = $1",
        [a.carer],
      ),
    );
    expect(mine.rows).toHaveLength(1);
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO handover_acknowledgement (handover_id, tenant_user_id, items_seen) VALUES ($1, $2, 2)",
          [HANDOVER_NORTH, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses an acknowledgement of a handover the person cannot see", async () => {
    await expect(
      asCarer((c) =>
        c.query("INSERT INTO handover_acknowledgement (handover_id, items_seen) VALUES ($1, 1)", [
          HANDOVER_SOUTH,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it.each([
    ["update a note", "UPDATE handover_note SET body = 'changed'"],
    ["delete a note", "DELETE FROM handover_note"],
    ["update an acknowledgement", "UPDATE handover_acknowledgement SET items_seen = 0"],
    ["delete an acknowledgement", "DELETE FROM handover_acknowledgement"],
    ["delete a handover", "DELETE FROM handover"],
  ])("refuses to %s", async (_label, statement) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it("blocks even the owner role with the append-only trigger", async () => {
    await expect(
      asOwner(TENANT_A, (c) => c.query("UPDATE handover_note SET body = 'changed'")),
    ).rejects.toThrow(/append-only/);
  });
});

describe("hazard HZ-018 a handover's items can only be added to", () => {
  const update = (statement: string, params: unknown[] = []) =>
    asManager((c) => c.query(statement, [HANDOVER_NORTH, ...params]));

  it.each([
    ["dropping an item", "UPDATE handover SET items = items - 1 WHERE id = $1"],
    ["emptying the list", "UPDATE handover SET items = '[]' WHERE id = $1"],
    [
      "changing an item",
      `UPDATE handover SET items = jsonb_set(items, '{0,kind}', '"incident"') WHERE id = $1`,
    ],
    [
      "reordering the items",
      "UPDATE handover SET items = jsonb_build_array(items -> 1, items -> 0) WHERE id = $1",
    ],
    [
      "moving the shift",
      "UPDATE handover SET shift_end = shift_end + interval '1 hour' WHERE id = $1",
    ],
  ])("refuses %s", async (_label, statement) => {
    await expect(update(statement)).rejects.toThrow(
      /cannot be removed or changed|keeps its location, shift/,
    );
  });

  it("appends a late addition, locks, versions each change and never unlocks", async () => {
    const late = { ...item("news2:cara", a.personAda), lateAddition: true };
    await update(
      "UPDATE handover SET items = items || $2::jsonb, refreshed_at = now() WHERE id = $1",
      [JSON.stringify([late])],
    );
    await update("UPDATE handover SET locked_at = now() WHERE id = $1");
    const row = await asManager((c) =>
      c.query<{ n: number; version: number; history: number }>(
        `SELECT jsonb_array_length(items) AS n, version,
           (SELECT count(*)::int FROM record_version WHERE table_name = 'handover' AND record_id = $1) AS history
         FROM handover WHERE id = $1`,
        [HANDOVER_NORTH],
      ),
    );
    expect(row.rows[0]).toEqual({ n: 3, version: 3, history: 2 });
    await expect(update("UPDATE handover SET locked_at = NULL WHERE id = $1")).rejects.toThrow(
      /stays locked/,
    );
    // Late additions still reach a locked handover.
    await update("UPDATE handover SET items = items || $2::jsonb WHERE id = $1", [
      JSON.stringify([{ ...late, key: "alert:x" }]),
    ]);
  });
});

describe("rule 14: one live task series per care plan action", () => {
  const ACTION = "0193a000-0000-7000-8000-00000000e001";
  const insertSeries = (c: pg.PoolClient) =>
    c.query<{ id: string }>(
      `INSERT INTO task_series (person_id, location_id, kind, title, required_permission, source_type,
         source_id, assignee_role_key, recurrence, starts_on)
       VALUES ($1, $2, 'care.plan_action', 'Care plan: mobility', 'care.note.write', 'care_plan_action',
         $3, 'care_worker', '{"freq":"daily","times":["10:00"]}', '2026-10-11')
       RETURNING id`,
      [a.personAda, a.locationNorth, ACTION],
    );

  it("refuses a second live series for an action, active or stopped by the lifecycle", async () => {
    const first = await asManager((c) => insertSeries(c));
    await expect(asManager((c) => insertSeries(c))).rejects.toThrow(
      /task_series_care_plan_action_key/,
    );
    // Paused at an exit, it still belongs to its action.
    await asManager((c) =>
      c.query(
        "UPDATE task_series SET active = false, inactive_code = 'ended_at_exit' WHERE id = $1",
        [first.rows[0]?.id],
      ),
    );
    await expect(asManager((c) => insertSeries(c))).rejects.toThrow(
      /task_series_care_plan_action_key/,
    );
    // Ended by a new version of the plan, it no longer counts.
    await asManager((c) =>
      c.query("UPDATE task_series SET inactive_code = NULL WHERE id = $1", [first.rows[0]?.id]),
    );
    await asManager((c) => insertSeries(c));
  });
});

describe("hazard HZ-018 alerts name the location and person they concern", () => {
  it("refuses an alert at another organisation's location", async () => {
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query(
          `INSERT INTO notification (recipient_tenant_user_id, kind, severity, title, location_id)
           VALUES ($1, 'care.urgent_result', 'urgent', 'An observation needs a response now', $2)`,
          [a.manager, ids.b.location],
        ),
      ),
    ).rejects.toThrow(/notification_location_fk/);
  });

  it("names the person and location of alerts raised before migration 0028 (backfill)", async () => {
    const sql = readFileSync(
      fileURLToPath(
        new URL("../drizzle/0028_care_tasks_and_handover_security.sql", import.meta.url),
      ),
      "utf8",
    );
    const backfill = sql.slice(sql.indexOf("-- backfill: begin"), sql.indexOf("-- backfill: end"));
    const made = await asOwner(TENANT_A, async (c) => {
      const t = await c.query<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at)
         VALUES ($1, $2, 'care.news2_response', 'Respond to the NEWS2 score', 'care.note.write', now())
         RETURNING id`,
        [a.personBen, a.locationNorth],
      );
      const taskId = t.rows[0]?.id ?? "";
      const n = await c.query<{ id: string }>(
        `INSERT INTO notification (recipient_tenant_user_id, kind, severity, title, source_type, source_id)
         VALUES ($1, 'platform.task.overdue', 'urgent', 'A task is overdue', 'task', $2) RETURNING id`,
        [a.manager, taskId],
      );
      const original = n.rows[0]?.id ?? "";
      const copy = await c.query<{ id: string }>(
        `INSERT INTO notification (recipient_tenant_user_id, kind, severity, title, source_type, source_id)
         VALUES ($1, 'platform.task.overdue', 'urgent', 'Escalated: A task is overdue', 'notification', $2)
         RETURNING id`,
        [a.northManager, original],
      );
      return { original, copy: copy.rows[0]?.id ?? "" };
    });
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
    const rows = await asOwner(TENANT_A, (c) =>
      c.query<{ id: string; person_id: string; location_id: string }>(
        "SELECT id, person_id, location_id FROM notification WHERE id = ANY($1) ORDER BY id",
        [[made.original, made.copy]],
      ),
    );
    expect(rows.rows.map((r) => [r.person_id, r.location_id])).toEqual([
      [a.personBen, a.locationNorth],
      [a.personBen, a.locationNorth],
    ]);
    const forced = await db
      .pool("harbour_owner")
      .query<{ relname: string }>(
        `SELECT relname FROM pg_class WHERE relname = ANY($1) AND NOT relforcerowsecurity`,
        [["notification", "task", "observation", "assessment", "statutory_notification"]],
      );
    expect(forced.rows).toEqual([]);
  });
});
