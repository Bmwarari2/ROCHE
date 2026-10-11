import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The point-of-care record follows the person's scope (HZ-011) and cannot be edited or deleted
 * by the application (HZ-017): a correction is a new row that supersedes the original.
 */

let db: TestDatabase;
const a = ids.a;

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await inContext(db.pool("harbour_owner"), ctx(TENANT_A, null, "tenant"), async (c) => {
    await c.query(
      `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
       VALUES ($1, $3, 'personal_care', 'Ada note', now()), ($2, $3, 'personal_care', 'Ben note', now())`,
      [a.personAda, a.personBen, a.locationNorth],
    );
    await c.query(
      `INSERT INTO observation (person_id, location_id, chart, values, occurred_at)
       VALUES ($1, $2, 'fluid_intake', '{"ml":200}', now())`,
      [a.personBen, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

const app = () => db.pool("harbour_app");

describe("hazard HZ-011 care record scope", () => {
  it("shows a care worker notes and charts only for their assigned people", async () => {
    const seen = await inContext(app(), ctx(TENANT_A, a.carer, "assigned"), async (c) => {
      const notes = await c.query<{ body: string }>("SELECT body FROM care_note ORDER BY body");
      const obs = await c.query("SELECT id FROM observation");
      return { notes: notes.rows.map((r) => r.body), observations: obs.rows.length };
    });
    expect(seen).toEqual({ notes: ["Ada note"], observations: 0 });
  });

  it("stops a care worker writing for someone outside their scope", async () => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.carer, "assigned"), (c) =>
        c.query(
          `INSERT INTO care_note (person_id, location_id, category, body, occurred_at)
           VALUES ($1, $2, 'health', 'Not mine', now())`,
          [a.personBen, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows another tenant nothing", async () => {
    const count = await inContext(app(), ctx(TENANT_B, ids.b.manager, "tenant"), async (c) => {
      const { rows } = await c.query(
        "SELECT id FROM care_note UNION ALL SELECT id FROM observation",
      );
      return rows.length;
    });
    expect(count).toBe(0);
  });
});

describe("hazard HZ-017 notes and observations cannot be updated or deleted by the app", () => {
  it.each([
    ["update a note", "UPDATE care_note SET body = 'changed'"],
    ["delete a note", "DELETE FROM care_note"],
    ["update an observation", "UPDATE observation SET values = '{\"ml\":999}'"],
  ])("refuses to %s", async (_label, statement) => {
    await expect(
      inContext(app(), ctx(TENANT_A, a.manager, "tenant"), (c) => c.query(statement)),
    ).rejects.toThrow(/permission denied/);
  });

  it("records a correction as a new row that supersedes the original", async () => {
    const result = await inContext(app(), ctx(TENANT_A, a.manager, "tenant"), async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM care_note WHERE body = 'Ada note'",
      );
      const original = rows[0]?.id;
      await c.query(
        `INSERT INTO care_note (person_id, location_id, category, body, occurred_at, supersedes_id, correction_reason)
         VALUES ($1, $2, 'personal_care', 'Ada note (corrected)', now(), $3, 'Wrong time recorded')`,
        [a.personAda, a.locationNorth, original],
      );
      const all = await c.query<{ body: string }>(
        "SELECT body FROM care_note WHERE person_id = $1 ORDER BY body",
        [a.personAda],
      );
      return all.rows.map((r) => r.body);
    });
    expect(result).toEqual(["Ada note", "Ada note (corrected)"]);
  });

  it("accepts a device-generated id once and ignores a replayed upload", async () => {
    const id = "0193a000-0000-7000-8000-00000000cafe";
    const count = await inContext(app(), ctx(TENANT_A, a.carer, "assigned"), async (c) => {
      for (let i = 0; i < 2; i++) {
        await c.query(
          `INSERT INTO observation (id, person_id, location_id, chart, values, occurred_at)
           VALUES ($1, $2, $3, 'fluid_intake', '{"ml":150}', now()) ON CONFLICT (id) DO NOTHING`,
          [id, a.personAda, a.locationNorth],
        );
      }
      const { rows } = await c.query("SELECT id FROM observation WHERE id = $1", [id]);
      return rows.length;
    });
    expect(count).toBe(1);
  });
});
