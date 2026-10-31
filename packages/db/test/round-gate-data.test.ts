import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { planRoundNotice } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * migration 0071: the screens gate data for the round and the handover on
 * the phone (STATUS item 15; care.md section 6). `task.from_earlier_plan` is the round view's
 * "From an earlier plan" notice kept by the database (HZ-024), and `handover_item.summary` is an
 * item's worded summary as a catalogue key and its parameters (HZ-018, H-300).
 */

let db: TestDatabase;
const a = ids.a;

const PLAN = "0193a000-0000-7000-8000-00000000d001";
const NEXT_PLAN = "0193a000-0000-7000-8000-00000000d002";
const SECTION = "0193a000-0000-7000-8000-00000000d101";
const NEXT_SECTION = "0193a000-0000-7000-8000-00000000d102";
const ACTION = "0193a000-0000-7000-8000-00000000d201";
const NEXT_ACTION = "0193a000-0000-7000-8000-00000000d202";

const owner = () => db.pool("harbour_owner");
const app = () => db.pool("harbour_app");
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(owner(), ctx(TENANT_A, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  await asSystem(async (c) => {
    for (const [plan, section, action, status, version] of [
      [PLAN, SECTION, ACTION, "active", 1],
      [NEXT_PLAN, NEXT_SECTION, NEXT_ACTION, "draft", null],
    ] as const) {
      await c.query(
        `INSERT INTO care_plan (id, person_id, location_id, status, published_version, review_due_on)
         VALUES ($1, $2, $3, $4, $5, '2026-11-11')`,
        [plan, a.personAda, a.locationNorth, status, version],
      );
      await c.query(
        `INSERT INTO care_plan_section (id, person_id, plan_id, domain, need, outcome)
         VALUES ($1, $2, $3, 'mobility', 'Needs help to stand.', 'I want to walk to the garden.')`,
        [section, a.personAda, plan],
      );
      await c.query(
        `INSERT INTO care_plan_action (id, person_id, plan_id, section_id, action, role_key, recurrence, generates_tasks)
         VALUES ($1, $2, $3, $4, 'Walk with a frame to the garden', 'care_worker',
                 '{"freq":"daily","times":["10:00"]}', true)`,
        [action, a.personAda, plan, section],
      );
    }
  });
});

afterAll(async () => {
  await db?.drop();
});

/** A live series for the plan's action, with an overdue open round and one done. */
async function seriesWithRounds(c: pg.PoolClient, actionId = ACTION) {
  const series = await c.query<{ id: string }>(
    `INSERT INTO task_series (person_id, location_id, kind, title, required_permission, source_type,
       source_id, assignee_role_key, recurrence, starts_on)
     VALUES ($1, $2, 'care.plan_action', 'Walk with a frame to the garden', 'care.note.write',
       'care_plan_action', $3, 'care_worker', '{"freq":"daily","times":["10:00"]}', '2026-10-11')
     RETURNING id`,
    [a.personAda, a.locationNorth, actionId],
  );
  const seriesId = series.rows[0]?.id as string;
  const round = (due: string, status: string) =>
    c.query<{ id: string }>(
      `INSERT INTO task (series_id, person_id, location_id, kind, title, required_permission,
         source_type, source_id, due_at, status, from_earlier_plan)
       VALUES ($1, $2, $3, 'care.plan_action', 'Walk with a frame to the garden', 'care.note.write',
         'care_plan_action', $4, $5, $6, true)
       RETURNING id`,
      [seriesId, a.personAda, a.locationNorth, actionId, due, status],
    );
  const open = (await round("2026-10-12T09:00:00Z", "open")).rows[0]?.id as string;
  const done = (await round("2026-10-11T09:00:00Z", "done")).rows[0]?.id as string;
  return { seriesId, open, done };
}

const flags = (c: pg.PoolClient, taskIds: readonly string[]) =>
  c
    .query<{ id: string; from_earlier_plan: boolean; version: number }>(
      "SELECT id, from_earlier_plan, version FROM task WHERE id = ANY($1) ORDER BY id",
      [taskIds],
    )
    .then((r) => new Map(r.rows.map((row) => [row.id, row])));

describe("hazard HZ-024 a round says it is from an earlier plan on the task itself, as the round view does", () => {
  it.each([
    ["the plan active and the series running", "active", true, null],
    ["the plan active and the series paused at an exit", "active", false, "ended_at_exit"],
    ["the plan active and the series ended", "active", false, null],
    ["the plan superseded and the series running", "superseded", true, null],
    ["the plan superseded and the series paused", "superseded", false, "ended_at_exit"],
  ] as const)("%s", async (_label, planStatus, active, inactiveCode) => {
    const rounds = await asManager((c) => seriesWithRounds(c));
    await asManager(async (c) => {
      await c.query("UPDATE task_series SET active = $2, inactive_code = $3 WHERE id = $1", [
        rounds.seriesId,
        active,
        inactiveCode,
      ]);
      await c.query("UPDATE care_plan SET status = $2 WHERE id = $1", [PLAN, planStatus]);
    });
    const expected =
      planRoundNotice({ planStatus, seriesLive: active || inactiveCode !== null }) !== null;
    const after = await asManager((c) => flags(c, [rounds.open, rounds.done]));
    expect(after.get(rounds.open)?.from_earlier_plan).toBe(expected);
    // A round already done is left alone: it is not on the round.
    expect(after.get(rounds.done)?.from_earlier_plan).toBe(false);
    // Put things back for the next case, ending the series so it no longer holds the action.
    await asManager(async (c) => {
      await c.query("UPDATE care_plan SET status = 'active' WHERE id = $1", [PLAN]);
      await c.query(
        "UPDATE task_series SET active = false, inactive_code = NULL, deleted_at = now() WHERE id = $1",
        [rounds.seriesId],
      );
    });
  });

  it("changes no round, and bumps no version, when a new version carries the series forward in the same transaction", async () => {
    const rounds = await asManager((c) => seriesWithRounds(c));
    const before = await asManager((c) => flags(c, [rounds.open]));
    await asManager(async (c) => {
      // As publishing does: the old plan superseded, the new one active, the series adopted.
      await c.query("UPDATE care_plan SET status = 'superseded' WHERE id = $1", [PLAN]);
      await c.query("UPDATE care_plan SET status = 'active', published_version = 2 WHERE id = $1", [
        NEXT_PLAN,
      ]);
      await c.query("UPDATE task_series SET source_id = $2 WHERE id = $1", [
        rounds.seriesId,
        NEXT_ACTION,
      ]);
    });
    const after = await asManager((c) => flags(c, [rounds.open]));
    expect(after.get(rounds.open)).toEqual(before.get(rounds.open));
    expect(after.get(rounds.open)?.from_earlier_plan).toBe(false);
    // The new version then drops the action: the series ends and its open round says so.
    await asManager((c) =>
      c.query("UPDATE task_series SET active = false WHERE id = $1", [rounds.seriesId]),
    );
    const ended = await asManager((c) => flags(c, [rounds.open]));
    expect(ended.get(rounds.open)?.from_earlier_plan).toBe(true);
    expect(ended.get(rounds.open)?.version).toBe((before.get(rounds.open)?.version ?? 0) + 1);
  });

  it("is the database's: a writer cannot set or clear it, and a carer's change keeps it", async () => {
    // The insert above asked for true on a live series; the database said false.
    const rounds = await asManager((c) => seriesWithRounds(c, NEXT_ACTION));
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(false);
    await asManager((c) =>
      c.query("UPDATE task SET from_earlier_plan = true WHERE id = $1", [rounds.open]),
    );
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(false);
    await asManager((c) =>
      c.query("UPDATE task_series SET active = false WHERE id = $1", [rounds.seriesId]),
    );
    // The carer starts the round: the flag is worked out in the organisation's view, not theirs.
    await asCarer((c) =>
      c.query("UPDATE task SET status = 'in_progress', from_earlier_plan = false WHERE id = $1", [
        rounds.open,
      ]),
    );
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(true);
  });

  it("fills the open rounds already from an earlier plan (the backfill, run again)", async () => {
    const rounds = await asManager((c) => seriesWithRounds(c, NEXT_ACTION));
    await asManager((c) =>
      c.query("UPDATE task_series SET active = false WHERE id = $1", [rounds.seriesId]),
    );
    // As before the migration: the flag empty, written with the trigger off.
    const client = await owner().connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE task DISABLE TRIGGER task_earlier_plan");
      await client.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)`,
        [TENANT_A],
      );
      await client.query("UPDATE task SET from_earlier_plan = false WHERE id = $1", [rounds.open]);
      await client.query("ALTER TABLE task ENABLE TRIGGER task_earlier_plan");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(false);
    const before = (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.version;
    await rerunBackfill();
    const after = (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open);
    expect(after?.from_earlier_plan).toBe(true);
    // Setting the flag on an existing row is not a change to the task: no version bump, so a
    // phone's queued move made against it is not refused as stale (#50 review round 1, low).
    expect(after?.version).toBe(before);
  });

  it("keeps the notice on a write made with no organisation in the session (#50 review round 1, low)", async () => {
    const rounds = await asManager((c) => seriesWithRounds(c, NEXT_ACTION));
    await asManager((c) =>
      c.query("UPDATE task_series SET active = false WHERE id = $1", [rounds.seriesId]),
    );
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(true);
    // The owner, as a maintenance migration would (history off, no app.tenant_id; the history
    // trigger refuses any other write without an organisation): the flag comes from the row's
    // own organisation, never reset to false.
    const client = await owner().connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE task NO FORCE ROW LEVEL SECURITY");
      await client.query("ALTER TABLE task DISABLE TRIGGER capture_version");
      await client.query("UPDATE task SET title = title WHERE id = $1", [rounds.open]);
      await client.query("ALTER TABLE task ENABLE TRIGGER capture_version");
      await client.query("ALTER TABLE task FORCE ROW LEVEL SECURITY");
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(
      (await asManager((c) => flags(c, [rounds.open]))).get(rounds.open)?.from_earlier_plan,
    ).toBe(true);
    // And the session's organisation is left as it was: none.
    const setting = await owner().query<{ tenant: string | null }>(
      "SELECT nullif(current_setting('app.tenant_id', true), '') AS tenant",
    );
    expect(setting.rows[0]?.tenant ?? null).toBeNull();
  });
});

describe("hazard HZ-018 a handover item's summary is a catalogue key with its parameters", () => {
  const HANDOVER = "0193a000-0000-7000-8000-00000000d301";
  const insertItem = (c: pg.PoolClient, position: number, summary: unknown) =>
    c.query(
      `INSERT INTO handover_item (handover_id, key, position, kind, person_id, source_type,
         source_id, at, late_addition, added_at, summary)
       VALUES ($1, $2, $3, 'news2', $4, 'observation', $5, now(), false, now(), $6)`,
      [
        HANDOVER,
        `news2:observation:${position}`,
        position,
        a.personAda,
        crypto.randomUUID(),
        summary === undefined ? null : JSON.stringify(summary),
      ],
    );

  beforeAll(async () => {
    await asSystem((c) =>
      c.query(
        `INSERT INTO handover (id, location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
         VALUES ($1, $2, 'day', '2026-10-12T07:00:00Z', '2026-10-12T19:00:00Z', now(), now())`,
        [HANDOVER, a.locationNorth],
      ),
    );
  });

  it("keeps a key in the handover summary namespace with an object of parameters, or none", async () => {
    await asSystem((c) =>
      insertItem(c, 0, { key: "handover.summary.news2", params: { band: "high", score: 7 } }),
    );
    await asSystem((c) => insertItem(c, 1, undefined));
    for (const bad of [
      "free English",
      { key: "web.title", params: {} },
      { key: "handover.summary.news2" },
      { key: "handover.summary.news2", params: "high" },
    ]) {
      await expect(asSystem((c) => insertItem(c, 2, bad))).rejects.toThrow(/handover_item_summary/);
    }
  });

  it("stays append-only with its summary (HZ-018)", async () => {
    await expect(
      asSystem((c) =>
        c.query("UPDATE handover_item SET summary = NULL WHERE handover_id = $1", [HANDOVER]),
      ),
    ).rejects.toThrow();
  });
});

/** Runs the backfill section of migration 0071 again, as the owner. */
async function rerunBackfill() {
  const sql = readFileSync(
    fileURLToPath(new URL("../drizzle/0071_round_gate_data.sql", import.meta.url)),
    "utf8",
  );
  const backfill = sql.slice(sql.indexOf("-- backfill: begin"), sql.indexOf("-- backfill: end"));
  const client = await owner().connect();
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
