import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A } from "./support/fixtures";

/**
 * The home whose phones hold a record (migration 0145; ADR-0134). The sync streams go by the row's
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

  it("moves a person's tasks without changing their version or writing history", async () => {
    const task = await inContext(
      owner(),
      ctx(TENANT_A, null, "tenant"),
      async (c) =>
        (
          await c.query<{ id: string }>(
            `INSERT INTO task (location_id, person_id, kind, title, required_permission, due_at)
           VALUES ($2, $1, 'care_plan_action', 'Turn', 'care.note.write', now() + interval '2 hours')
           RETURNING id`,
            [a.personBen, a.locationNorth],
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
    const before = await read();
    expect(before.task?.s).toBe(a.locationNorth);
    await inContext(owner(), ctx(TENANT_A, null, "tenant"), (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personBen, a.locationSouth]),
    );
    const after = await read();
    expect(after.task).toEqual({ version: before.task?.version, s: a.locationSouth });
    expect(after.history).toBe(before.history);
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

  it("refuses the owner a change to anything but the sync home, even while moving", async () => {
    await expect(
      inContext(owner(), ctx(TENANT_A, null, "tenant"), async (c) => {
        await c.query("SELECT set_config('app.sync_location_move', 'on', true)");
        await c.query("UPDATE care_note SET body = 'changed'");
      }),
    ).rejects.toThrow(/append-only/);
  });
});
