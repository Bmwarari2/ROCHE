import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * The home whose phones hold a record (migration 0146; ADR-0134). The sync streams go by the row's
 * own `sync_location_id`, one bucket per home and day, so the database sets it from the person's
 * home on insert, and moves it with the person, for the records in the sync window (the last 35
 * days), when their home changes (HZ-138): the new home's phones keep the recent record. The
 * record itself never changes: `location_id` stays where it was made, and the append-only guard
 * still refuses every other change. Invented people only.
 */

let db: TestDatabase;
const a = ids.a;
const owner = () => db.pool("harbour_owner");
const app = () => db.pool("harbour_app");
const tenant = () => ctx(TENANT_A, a.manager, "tenant");

type Row = { id: string; location_id: string; sync_location_id: string | null };

async function rows(table: string, personId: string): Promise<Row[]> {
  return inContext(
    owner(),
    ctx(TENANT_A, null, "tenant"),
    async (c) =>
      (
        await c.query<Row>(
          `SELECT id, location_id::text, sync_location_id::text FROM ${table}
          WHERE person_id = $1 ORDER BY occurred_at`,
          [personId],
        )
      ).rows,
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  await inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
    // A recent note and chart, and one from before the window, for Ada at the north home; the
    // client claims another home for the sync column, which the database replaces.
    await c.query(
      `INSERT INTO care_note (person_id, location_id, sync_location_id, category, body, occurred_at)
       VALUES ($1, $2, $3, 'personal_care', 'Recent note', now() - interval '2 days'),
              ($1, $2, $3, 'personal_care', 'Old note', now() - interval '60 days')`,
      [a.personAda, a.locationNorth, a.locationSouth],
    );
    await c.query(
      `INSERT INTO observation (person_id, location_id, chart, values, occurred_at)
       VALUES ($1, $2, 'fluid_intake', '{"ml":200}', now() - interval '1 day')`,
      [a.personAda, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-138 a person's recent record moves to their new home's phones", () => {
  it("sets the sync home from the person's home on insert, whatever the client sent", async () => {
    const notes = await rows("care_note", a.personAda);
    expect(notes.map((n) => n.sync_location_id)).toEqual([a.locationNorth, a.locationNorth]);
  });

  it("moves the last 35 days to the new home when the person moves, and leaves the record as made", async () => {
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personAda, a.locationSouth]),
    );
    const notes = await rows("care_note", a.personAda);
    // Oldest first: the 60-day-old note stays with the old home's phones; the recent one moves.
    expect(notes.map((n) => n.sync_location_id)).toEqual([a.locationNorth, a.locationSouth]);
    expect(notes.map((n) => n.location_id)).toEqual([a.locationNorth, a.locationNorth]);
    const charts = await rows("observation", a.personAda);
    expect(charts.map((n) => n.sync_location_id)).toEqual([a.locationSouth]);
  });

  it("moves them even when the member who moves the person cannot see the new home", async () => {
    // Back to the north home, moved by a manager whose scope is the south home only.
    await inContext(app(), ctx(TENANT_A, a.manager, "locations", [a.locationSouth]), (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personAda, a.locationNorth]),
    ).catch(() => undefined);
    const notes = await rows("care_note", a.personAda);
    const person = await inContext(
      owner(),
      ctx(TENANT_A, null, "tenant"),
      async (c) =>
        (
          await c.query<{ l: string }>("SELECT location_id::text AS l FROM person WHERE id = $1", [
            a.personAda,
          ])
        ).rows[0]?.l,
    );
    // Whatever the member's scope allowed, the recent note follows the person's home.
    expect(notes.at(-1)?.sync_location_id).toBe(person);
  });

  it("takes the recent record off every home's phones when the person leaves care, and back on return", async () => {
    const status = (value: string) =>
      inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
        c.query("UPDATE person SET status = $2 WHERE id = $1", [a.personAda, value]),
      );
    const home = async () =>
      inContext(
        owner(),
        ctx(TENANT_A, null, "tenant"),
        async (c) =>
          (
            await c.query<{ l: string }>(
              "SELECT location_id::text AS l FROM person WHERE id = $1",
              [a.personAda],
            )
          ).rows[0]?.l,
      );
    await status("discharged");
    expect((await rows("care_note", a.personAda)).at(-1)?.sync_location_id).toBeNull();
    // A note recorded after the exit (a phone that was offline) goes to no home's phones.
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query(
        `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
         VALUES ($1, $2, 'personal_care', 'After exit', now() - interval '1 hour')`,
        [a.personAda, a.locationNorth],
      ),
    );
    expect((await rows("care_note", a.personAda)).at(-1)?.sync_location_id).toBeNull();
    await status("active");
    const back = await rows("care_note", a.personAda);
    expect(back.slice(1).map((n) => n.sync_location_id)).toEqual([await home(), await home()]);
  });

  it("keeps a person's tasks with their home on a move, as the round on the server does, and takes them off on leaving care without a new version or history", async () => {
    const task = await inContext(
      owner(),
      ctx(TENANT_A, null, "tenant"),
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (location_id, person_id, kind, title, required_permission, due_at, sync_location_id)
           VALUES ($2, $1, 'care_plan_action', 'Turn', 'care.note.write', now() + interval '2 hours', $3)
           RETURNING id`,
            [a.personBen, a.locationNorth, a.locationSouth],
          )
        ).rows[0]?.id,
    );
    const read = () =>
      inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => ({
        task: (
          await c.query<{ version: number; s: string | null }>(
            "SELECT version, sync_location_id::text AS s FROM task WHERE id = $1",
            [task],
          )
        ).rows[0],
        history: Number(
          (
            await c.query<{ n: string }>(
              "SELECT count(*) AS n FROM record_version WHERE table_name = 'task' AND record_id = $1",
              [task],
            )
          ).rows[0]?.n,
        ),
      }));
    const person = (sql: string, value: string) =>
      inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) => c.query(sql, [a.personBen, value]));
    const before = await read();
    // The client's value is replaced: the task's own home.
    expect(before.task?.s).toBe(a.locationNorth);
    await person("UPDATE person SET location_id = $2 WHERE id = $1", a.locationSouth);
    expect((await read()).task?.s).toBe(a.locationNorth);
    await person("UPDATE person SET status = $2 WHERE id = $1", "discharged");
    const after = await read();
    expect(after.task).toEqual({ version: before.task?.version, s: null });
    expect(after.history).toBe(before.history);
    // A direct change by the application is recomputed, never kept, even with the move flag set
    // (security re-check, N5).
    await inContext(app(), tenant(), async (c) => {
      await c.query("SELECT set_config('app.sync_location_move', 'on', true)");
      await c.query("UPDATE task SET sync_location_id = $2 WHERE id = $1", [task, a.locationSouth]);
    }).catch(() => undefined);
    expect((await read()).task?.s).toBeNull();
    // A direct change by the application is recomputed, never kept.
    await inContext(app(), tenant(), (c) =>
      c.query("UPDATE task SET sync_location_id = $2 WHERE id = $1", [task, a.locationSouth]),
    ).catch(() => undefined);
    expect((await read()).task?.s).toBeNull();
  });

  it("still refuses the application any change to the record, the sync home included", async () => {
    for (const statement of [
      "UPDATE care_note SET sync_location_id = location_id",
      "UPDATE care_note SET body = 'changed'",
    ]) {
      await expect(inContext(app(), tenant(), (c) => c.query(statement))).rejects.toThrow(
        /permission denied|append-only/,
      );
    }
  });

  it("refuses the migrator even a routing-only change: only the move's own definer makes one (ADR-0133)", async () => {
    await expect(
      inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
        await c.query("SELECT set_config('app.sync_location_move', 'on', true)");
        await c.query("UPDATE care_note SET sync_location_id = location_id");
      }),
    ).rejects.toThrow(/append-only/);
  });

  it("refuses the owner a change to anything but the sync home, even while moving", async () => {
    await expect(
      inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
        await c.query("SELECT set_config('app.sync_location_move', 'on', true)");
        await c.query("UPDATE care_note SET body = 'changed'");
      }),
    ).rejects.toThrow(/append-only/);
  });
});

describe("hazard HZ-138 every table, the window's edge, handovers and a move during an insert", () => {
  const cara = a.personCara;
  const sql = (text: string, values: unknown[] = []) =>
    inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) => c.query(text, values));
  const routing = async (table: string, id: string) =>
    (
      await sql(
        `SELECT sync_location_id::text AS s${table.startsWith("handover") ? ", person_location_id::text AS p, at_home" : ""}
           FROM ${table} WHERE id = $1`,
        [id],
      )
    ).rows[0] as { s: string | null; p?: string | null; at_home?: boolean };

  it("moves activities and visits too, keeps a row from 36 days ago where it was and moves one from 34", async () => {
    await sql("UPDATE person SET location_id = $2, status = 'active' WHERE id = $1", [
      cara,
      a.locationNorth,
    ]);
    const add = async (text: string, values: unknown[]) =>
      (await sql(`${text} RETURNING id::text`, values)).rows[0]?.id as string;
    const activity = await add(
      `INSERT INTO activity_record (person_id, location_id, occurred_at, activity, format, attendance)
       VALUES ($1, $2, now() - interval '1 day', 'Quiz', 'one_to_one', 'declined')`,
      [cara, a.locationNorth],
    );
    const visit = await add(
      `INSERT INTO visit_log (person_id, location_id, occurred_at, kind, visitor_name)
       VALUES ($1, $2, now() - interval '3 hours', 'facilitated_visit', 'Visitor Example')`,
      [cara, a.locationNorth],
    );
    const old = await add(
      `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
       VALUES ($1, $2, 'personal_care', '36 days ago', now() - interval '36 days')`,
      [cara, a.locationNorth],
    );
    const edge = await add(
      `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
       VALUES ($1, $2, 'personal_care', '34 days ago', now() - interval '34 days')`,
      [cara, a.locationNorth],
    );
    await sql("UPDATE person SET location_id = $2 WHERE id = $1", [cara, a.locationSouth]);
    expect((await routing("activity_record", activity)).s).toBe(a.locationSouth);
    expect((await routing("visit_log", visit)).s).toBe(a.locationSouth);
    expect((await routing("care_note", edge)).s).toBe(a.locationSouth);
    expect((await routing("care_note", old)).s).toBe(a.locationNorth);
  });

  it("hazard HZ-018 keeps a handover item about the person with their new home, and with them through a death", async () => {
    await sql("UPDATE person SET location_id = $2, status = 'active' WHERE id = $1", [
      cara,
      a.locationNorth,
    ]);
    const handover = (
      await sql(
        `INSERT INTO handover (location_id, shift_name, shift_start, shift_end, compiled_at, refreshed_at)
         VALUES ($1, 'day', now() - interval '6 hours', now() + interval '6 hours', now(), now())
         RETURNING id::text`,
        [a.locationNorth],
      )
    ).rows[0]?.id as string;
    const item = (
      await sql(
        `INSERT INTO handover_item (handover_id, key, position, kind, person_id, source_type, source_id,
           at, late_addition, added_at)
         VALUES ($1, 'fall:1', 1, 'fall', $2, 'incident', $3, now(), false, now()) RETURNING id::text`,
        [handover, cara, a.personAda],
      )
    ).rows[0]?.id as string;
    expect(await routing("handover_item", item)).toEqual({
      s: a.locationNorth,
      p: a.locationNorth,
      at_home: true,
    });
    await sql("UPDATE person SET status = 'deceased' WHERE id = $1", [cara]);
    expect(await routing("handover_item", item)).toEqual({
      s: a.locationNorth,
      p: a.locationNorth,
      at_home: true,
    });
    await sql("UPDATE person SET status = 'active', location_id = $2 WHERE id = $1", [
      cara,
      a.locationSouth,
    ]);
    expect(await routing("handover_item", item)).toEqual({
      s: a.locationNorth,
      p: a.locationSouth,
      at_home: false,
    });
  });

  it("orders an insert against a move in progress, so the row never keeps the old home", async () => {
    await sql("UPDATE person SET location_id = $2, status = 'active' WHERE id = $1", [
      cara,
      a.locationNorth,
    ]);
    const mover = await owner().connect();
    try {
      await mover.query("BEGIN");
      await mover.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [TENANT_A],
      );
      await mover.query("UPDATE person SET location_id = $2 WHERE id = $1", [
        cara,
        a.locationSouth,
      ]);
      // The insert waits on the move's lock, then reads the person as moved.
      const inserted = sql(
        `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
         VALUES ($1, $2, 'personal_care', 'During the move', now()) RETURNING id::text`,
        [cara, a.locationNorth],
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      await mover.query("COMMIT");
      const id = (await inserted).rows[0]?.id as string;
      expect((await routing("care_note", id)).s).toBe(a.locationSouth);
    } finally {
      mover.release();
    }
  });
});
