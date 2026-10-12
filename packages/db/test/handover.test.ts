import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The shift handover (care.md rule 8, COMMS-006; slice 5) in the database: handovers follow the
 * location, and each item, and each note on an item, follows its person (HZ-011); only the
 * system's view writes a handover or its items, and items can only be added to (HZ-018); notes and
 * acknowledgements are append-only and nobody acknowledges for someone else; one live task series
 * per care plan action (care.md rule 14); alerts name their location and person (HZ-018).
 */

let db: TestDatabase;
const a = ids.a;

const HANDOVER_NORTH = "0193a000-0000-7000-8000-00000000d001";
const HANDOVER_SOUTH = "0193a000-0000-7000-8000-00000000d002";
const HANDOVER_B = "0193b000-0000-7000-8000-00000000d001";
const SOURCE = {
  ada: "0193a000-0000-7000-8000-00000000f001",
  ben: "0193a000-0000-7000-8000-00000000f002",
  cara: "0193a000-0000-7000-8000-00000000f003",
  lift: "0193a000-0000-7000-8000-00000000f004",
};

const insertItem = (
  c: pg.PoolClient,
  handoverId: string,
  key: string,
  position: number,
  personId: string | null,
  sourceId: string,
) =>
  c.query(
    `INSERT INTO handover_item (handover_id, key, position, kind, person_id, source_type, source_id,
       at, late_addition, added_at)
     VALUES ($1, $2, $3, 'fall', $4, 'incident', $5, '2026-10-11T09:00:00Z', $3 > 2, now())`,
    [handoverId, key, position, personId, sourceId],
  );

const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const app = () => db.pool("harbour_app");
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
/** The care worker is assigned to Ada only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  // The system's view compiles: tenant scope.
  await asManager(async (c) => {
    for (const [id, locationId] of [
      [HANDOVER_NORTH, a.locationNorth],
      [HANDOVER_SOUTH, a.locationSouth],
    ] as const) {
      await c.query(
        `INSERT INTO handover (id, location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
         VALUES ($1, $2, 'day', '2026-10-11T07:00:00Z', '2026-10-11T19:00:00Z', now(), now())`,
        [id, locationId],
      );
    }
    await insertItem(c, HANDOVER_NORTH, "fall:ada", 0, a.personAda, SOURCE.ada);
    await insertItem(c, HANDOVER_NORTH, "fall:ben", 1, a.personBen, SOURCE.ben);
    await insertItem(c, HANDOVER_NORTH, "incident:lift", 2, null, SOURCE.lift);
    await insertItem(c, HANDOVER_SOUTH, "fall:cara", 0, a.personCara, SOURCE.cara);
    // The person comes from the item, whatever the writer sends.
    await c.query(
      `INSERT INTO handover_note (handover_id, item_key, person_id, body) VALUES
         ($1, NULL, $2, 'Lift out of order on the first floor.'),
         ($1, 'fall:ada', NULL, 'GP called back.'),
         ($1, 'fall:ben', $2, 'Hip x-ray booked.')`,
      [HANDOVER_NORTH, a.personAda],
    );
    // Only the person acknowledging can record it, so the manager does.
    await c.query("INSERT INTO handover_acknowledgement (handover_id, item_keys) VALUES ($1, $2)", [
      HANDOVER_NORTH,
      ["fall:ada", "fall:ben", "incident:lift"],
    ]);
  });
  await asOwner(TENANT_B, (c) =>
    c.query(
      `INSERT INTO handover (id, location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
       VALUES ($1, $2, 'day', '2026-10-11T07:00:00Z', '2026-10-11T19:00:00Z', now(), now())`,
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
    const items = await c.query<{ key: string }>("SELECT key FROM handover_item ORDER BY key");
    const notes = await c.query<{ body: string }>("SELECT body FROM handover_note ORDER BY body");
    const acks = await c.query<{ id: string }>("SELECT id FROM handover_acknowledgement");
    return {
      handovers: handovers.rows.map((r) => r.id),
      items: items.rows.map((r) => r.key),
      notes: notes.rows.map((r) => r.body),
      acknowledgements: acks.rows.length,
    };
  });
}

describe("hazard HZ-011 handovers follow the location, and their items the people on them", () => {
  it("shows tenant-wide roles every handover of their organisation, whole", async () => {
    expect(await visible(ctx(TENANT_A, a.manager, "tenant"))).toEqual({
      handovers: [HANDOVER_NORTH, HANDOVER_SOUTH],
      items: ["fall:ada", "fall:ben", "fall:cara", "incident:lift"],
      notes: ["GP called back.", "Hip x-ray booked.", "Lift out of order on the first floor."],
      acknowledgements: 1,
    });
  });

  it("shows a location manager their location's handover whole, with its acknowledgements", async () => {
    expect(await visible(ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]))).toEqual({
      handovers: [HANDOVER_NORTH],
      items: ["fall:ada", "fall:ben", "incident:lift"],
      notes: ["GP called back.", "Hip x-ray booked.", "Lift out of order on the first floor."],
      acknowledgements: 1,
    });
  });

  it("shows a care worker only the items and notes about their own people, and nobody else's acknowledgement", async () => {
    expect(await visible(ctx(TENANT_A, a.carer, "assigned"))).toEqual({
      handovers: [HANDOVER_NORTH],
      items: ["fall:ada", "incident:lift"],
      notes: ["GP called back.", "Lift out of order on the first floor."],
      acknowledgements: 0,
    });
  });

  it("shows another organisation nothing, and a role with no person scope nothing", async () => {
    expect(await visible(ctx(TENANT_B, ids.b.manager, "tenant"))).toEqual({
      handovers: [HANDOVER_B],
      items: [],
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

  it("takes a note's person from its item, whatever the writer sent", async () => {
    const rows = await asManager((c) =>
      c.query<{ body: string; person_id: string | null }>(
        "SELECT body, person_id FROM handover_note ORDER BY body",
      ),
    );
    expect(rows.rows.map((r) => [r.body, r.person_id])).toEqual([
      ["GP called back.", a.personAda],
      ["Hip x-ray booked.", a.personBen],
      ["Lift out of order on the first floor.", null],
    ]);
  });

  it("refuses a note on an item about a person outside the writer's scope", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO handover_note (handover_id, item_key, person_id, body) VALUES ($1, 'fall:ben', $2, 'Seen.')",
          [HANDOVER_NORTH, a.personAda],
        ),
      ),
    ).rejects.toThrow(/an item of its handover that its writer can see/);
  });

  it("refuses a note on an item another handover holds", async () => {
    await expect(
      asManager((c) =>
        c.query(
          "INSERT INTO handover_note (handover_id, item_key, body) VALUES ($1, 'fall:cara', 'Seen.')",
          [HANDOVER_NORTH],
        ),
      ),
    ).rejects.toThrow(/an item of its handover that its writer can see/);
  });
});

describe("hazard HZ-018 only the system's view writes a handover or its items", () => {
  it("refuses a care worker or a location manager compiling a handover or adding an item", async () => {
    for (const as of [asCarer, asNorthManager]) {
      await expect(
        as((c) =>
          c.query(
            `INSERT INTO handover (location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
             VALUES ($1, 'night', '2026-10-11T19:00:00Z', '2026-10-12T07:00:00Z', now(), now())`,
            [a.locationNorth],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as((c) => insertItem(c, HANDOVER_NORTH, "fall:extra", 9, a.personAda, SOURCE.ada)),
      ).rejects.toThrow(/row-level security/);
    }
  });

  it("lets a care worker neither lock, refresh nor soft-delete a handover", async () => {
    for (const statement of [
      "UPDATE handover SET locked_at = now() WHERE id = $1",
      "UPDATE handover SET refreshed_at = now() WHERE id = $1",
      "UPDATE handover SET deleted_at = now() WHERE id = $1",
    ]) {
      const result = await asCarer((c) => c.query(statement, [HANDOVER_NORTH]));
      expect(result.rowCount).toBe(0);
    }
    const row = await asManager((c) =>
      c.query<{ locked_at: Date | null; deleted_at: Date | null; version: number }>(
        "SELECT locked_at, deleted_at, version FROM handover WHERE id = $1",
        [HANDOVER_NORTH],
      ),
    );
    expect(row.rows[0]).toMatchObject({ locked_at: null, deleted_at: null, version: 1 });
  });

  it("refuses even the system's view soft-deleting a handover", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE handover SET deleted_at = now() WHERE id = $1", [HANDOVER_SOUTH]),
      ),
    ).rejects.toThrow(/never deleted/);
  });
});

describe("hazard HZ-018 acknowledgements are each person's own and append-only", () => {
  it("lets a care worker acknowledge for themselves, never for someone else", async () => {
    await asCarer((c) =>
      c.query("INSERT INTO handover_acknowledgement (handover_id, item_keys) VALUES ($1, $2)", [
        HANDOVER_NORTH,
        ["fall:ada", "incident:lift"],
      ]),
    );
    const mine = await asCarer((c) =>
      c.query<{ tenant_user_id: string }>("SELECT tenant_user_id FROM handover_acknowledgement"),
    );
    expect(mine.rows.map((r) => r.tenant_user_id)).toEqual([a.carer]);
    await expect(
      asCarer((c) =>
        c.query(
          "INSERT INTO handover_acknowledgement (handover_id, tenant_user_id, item_keys) VALUES ($1, $2, '{}')",
          [HANDOVER_NORTH, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("refuses an acknowledgement of a handover the person cannot see", async () => {
    await expect(
      asCarer((c) =>
        c.query("INSERT INTO handover_acknowledgement (handover_id, item_keys) VALUES ($1, '{}')", [
          HANDOVER_SOUTH,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it.each([
    ["update an item", "UPDATE handover_item SET kind = 'incident'"],
    ["delete an item", "DELETE FROM handover_item"],
    ["update a note", "UPDATE handover_note SET body = 'changed'"],
    ["delete a note", "DELETE FROM handover_note"],
    ["update an acknowledgement", "UPDATE handover_acknowledgement SET item_keys = '{}'"],
    ["delete an acknowledgement", "DELETE FROM handover_acknowledgement"],
    ["delete a handover", "DELETE FROM handover"],
  ])("refuses to %s", async (_label, statement) => {
    await expect(asManager((c) => c.query(statement))).rejects.toThrow(/permission denied/);
  });

  it.each([
    ["an item", "UPDATE handover_item SET kind = 'incident'"],
    ["a note", "UPDATE handover_note SET body = 'changed'"],
  ])(
    "blocks even the owner role from changing %s with the append-only trigger",
    async (_l, sql) => {
      await expect(asOwner(TENANT_A, (c) => c.query(sql))).rejects.toThrow(/append-only/);
    },
  );
});

describe("hazard HZ-018 a handover can only be added to", () => {
  const update = (statement: string, params: unknown[] = []) =>
    asManager((c) => c.query(statement, [HANDOVER_NORTH, ...params]));

  it.each([
    [
      "moving the shift",
      "UPDATE handover SET shift_end = shift_end + interval '1 hour' WHERE id = $1",
    ],
    ["changing the first compilation", "UPDATE handover SET compiled_at = now() WHERE id = $1"],
  ])("refuses %s", async (_label, statement) => {
    await expect(update(statement)).rejects.toThrow(/keeps its organisation, location, shift/);
  });

  it("refuses an item twice, or two items in one place", async () => {
    await expect(
      asManager((c) => insertItem(c, HANDOVER_NORTH, "fall:ada", 7, a.personAda, SOURCE.ada)),
    ).rejects.toThrow(/handover_item_key/);
    await expect(
      asManager((c) => insertItem(c, HANDOVER_NORTH, "fall:new", 0, a.personAda, SOURCE.ada)),
    ).rejects.toThrow(/handover_item_position_key/);
  });

  it("appends a late addition, locks, versions each change and never unlocks", async () => {
    await asManager((c) => insertItem(c, HANDOVER_NORTH, "news2:ada", 3, a.personAda, SOURCE.ada));
    await update("UPDATE handover SET refreshed_at = now() + interval '1 minute' WHERE id = $1");
    await update("UPDATE handover SET locked_at = now() WHERE id = $1");
    const row = await asManager((c) =>
      c.query<{ n: number; version: number; history: number }>(
        `SELECT (SELECT count(*)::int FROM handover_item WHERE handover_id = $1) AS n, version,
           (SELECT count(*)::int FROM record_version WHERE table_name = 'handover' AND record_id = $1) AS history
         FROM handover WHERE id = $1`,
        [HANDOVER_NORTH],
      ),
    );
    expect(row.rows[0]).toEqual({ n: 4, version: 3, history: 2 });
    await expect(update("UPDATE handover SET locked_at = NULL WHERE id = $1")).rejects.toThrow(
      /stays locked/,
    );
    // Late additions still reach a locked handover.
    await asManager((c) => insertItem(c, HANDOVER_NORTH, "alert:ada", 4, a.personAda, SOURCE.ada));
  });
});

describe("hazard HZ-024 rule 14: one live task series per care plan action", () => {
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
  it("refuses an alert about another organisation's person", async () => {
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query(
          `INSERT INTO notification (recipient_tenant_user_id, kind, severity, title, person_id)
           VALUES ($1, 'care.urgent_result', 'urgent', 'An observation needs a response now', $2)`,
          [a.manager, ids.b.personDev],
        ),
      ),
    ).rejects.toThrow(/notification_person_fk/);
  });

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
