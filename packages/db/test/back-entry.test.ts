import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Back-entry from paper in the database (operations.md rules 11 to 15; hazards HZ-011 and HZ-017;
 * migration 0053): the expand-only columns on the five care entries, the rule tying them together,
 * an outage at the entry's own location that was not cancelled, no cancelling once a back-entry
 * cites an outage, and reconciliation only by someone who entered none of its back-entries, both
 * counted in the organisation's view whatever the caller can see.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);

const ENTRY_TABLES = ["care_note", "observation", "body_map_mark", "activity_record", "visit_log"];
const OUTAGE_NORTH = "0199f000-0000-7000-8000-0000000000c1";
const OUTAGE_SOUTH = "0199f000-0000-7000-8000-0000000000c2";
const OUTAGE_CITED = "0199f000-0000-7000-8000-0000000000c3";
const OUTAGE_ERROR = "0199f000-0000-7000-8000-0000000000c4";
const OUTAGE_B = "0199f000-0000-7000-8000-0000000000c5";

/** A note about `person` at North; `details` adds back-entry columns as SQL. */
const note = (c: pg.PoolClient, person: string, details: Record<string, string | null>) => {
  const columns = Object.keys(details);
  return c.query(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body${columns.map((k) => `, ${k}`).join("")})
     VALUES ($1, $2, now() - interval '3 hours', 'personal_care', 'Assisted with a wash.'${columns.map((_, i) => `, $${i + 3}`).join("")})`,
    [person, a.locationNorth, ...Object.values(details)],
  );
};
const backEntry = (outageId: string) => ({
  late_entry_reason: "downtime",
  outage_id: outageId,
  paper_date: "2026-10-11",
  paper_time: "15:05",
  paper_occurrence: "only",
  paper_reference: "DT-001",
});

const cancel = (c: pg.PoolClient, outageId: string, by: string) =>
  c.query(
    `UPDATE outage SET state = 'cancelled', cancelled_at = now(), cancelled_by = $2,
       cancellation_reason = 'Declared in error' WHERE id = $1`,
    [outageId, by],
  );

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const perms = "{operations.downtime.manage,people.person.read,care.note.write}";
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f000-0000-7000-8000-000000000501', 'owner', 'Owner', 'tenant', $1),
         ('0199f000-0000-7000-8000-000000000502', 'team_leader', 'Team leader', 'location', $1)`,
      [perms],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f000-0000-7000-8000-000000000501', NULL),
         ($2, '0199f000-0000-7000-8000-000000000502', $3), ($4, $5, $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer, a.roleCarer],
    );
    await c.query(
      `INSERT INTO outage (id, location_id, kind, description, started_at, ended_at, declared_by)
       VALUES ($1, $5, 'power', 'Power cut, whole building', now() - interval '6 hours', NULL, $7),
              ($2, $6, 'network', 'Internet down, whole site', now() - interval '5 hours', NULL, $7),
              ($3, $5, 'power', 'Power cut, east wing only', now() - interval '20 hours',
                now() - interval '18 hours', $7),
              ($4, $5, 'other', 'Declared at the wrong home', now() - interval '30 hours',
                now() - interval '28 hours', $7)`,
      [
        OUTAGE_NORTH,
        OUTAGE_SOUTH,
        OUTAGE_CITED,
        OUTAGE_ERROR,
        a.locationNorth,
        a.locationSouth,
        a.northManager,
      ],
    );
  });
  await asOwner(TENANT_B, (c) =>
    c.query(
      `INSERT INTO outage (id, location_id, kind, description, started_at, declared_by)
       VALUES ($1, $2, 'power', 'Power cut, whole building', now() - interval '2 hours', $3)`,
      [OUTAGE_B, ids.b.location, ids.b.manager],
    ),
  );
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-017 back-entry columns on the care entries", () => {
  it("adds the columns, the outage reference, the rule and the guard to all five entries", async () => {
    const { rows } = await db.pool("harbour_owner").query<{ t: string; n: number }>(
      `SELECT t, (SELECT count(*)::int FROM information_schema.columns
                   WHERE table_name = t AND is_nullable = 'YES' AND column_name = ANY ($2))
               + (SELECT count(*)::int FROM pg_constraint
                   WHERE conrelid = t::regclass AND conname IN (t || '_outage_fk', t || '_back_entry'))
               + (SELECT count(*)::int FROM pg_trigger
                   WHERE tgrelid = t::regclass AND tgname = 'entry_outage_guard') AS n
       FROM unnest($1::text[]) AS t`,
      [
        ENTRY_TABLES,
        [
          "late_entry_reason",
          "outage_id",
          "paper_date",
          "paper_time",
          "paper_occurrence",
          "outside_outage_reason",
          "paper_reference",
          "not_from_paper_reason",
        ],
      ],
    );
    expect(rows).toEqual(ENTRY_TABLES.map((t) => ({ t, n: 11 })));
  });

  it("keeps a back-entry from paper with its outage and the time written on the form", async () => {
    const { rows } = await asCarer(async (c) => {
      await note(c, a.personAda, backEntry(OUTAGE_NORTH));
      return c.query<{ paper_time: string; paper_date: string }>(
        `SELECT paper_time::text, paper_date::text FROM care_note WHERE outage_id = $1`,
        [OUTAGE_NORTH],
      );
    });
    expect(rows).toEqual([{ paper_time: "15:05:00", paper_date: "2026-10-11" }]);
    await asCarer((c) =>
      note(c, a.personAda, {
        outage_id: OUTAGE_NORTH,
        not_from_paper_reason: "Recorded from memory at handover",
      }),
    );
  });

  it("refuses a back-entry without what the paper said, and back-entry details on any other entry", async () => {
    const refused: Record<string, string | null>[] = [
      { ...backEntry(OUTAGE_NORTH), paper_time: null },
      { ...backEntry(OUTAGE_NORTH), outage_id: null },
      { ...backEntry(OUTAGE_NORTH), paper_occurrence: "both" },
      { ...backEntry(OUTAGE_NORTH), paper_time: "15:05:30" },
      { ...backEntry(OUTAGE_NORTH), not_from_paper_reason: "Not from paper" },
      { ...backEntry(OUTAGE_NORTH), outside_outage_reason: "  " },
      { ...backEntry(OUTAGE_NORTH), late_entry_reason: "other" },
      { paper_date: "2026-10-11" },
      { paper_reference: "DT-002" },
      { not_from_paper_reason: "Recorded from memory" },
      { outage_id: OUTAGE_NORTH },
      { outage_id: OUTAGE_NORTH, not_from_paper_reason: " " },
    ];
    for (const details of refused) {
      await expect(
        asManager((c) => note(c, a.personAda, details)),
        JSON.stringify(details),
      ).rejects.toThrow(/care_note_back_entry/);
    }
  });

  it("refuses an outage at another location, a cancelled one, or another organisation's", async () => {
    await asNorthManager((c) => cancel(c, OUTAGE_ERROR, a.northManager));
    for (const outageId of [OUTAGE_SOUTH, OUTAGE_ERROR, OUTAGE_B]) {
      await expect(asManager((c) => note(c, a.personAda, backEntry(outageId)))).rejects.toThrow(
        /names an outage at its own location that was not cancelled/,
      );
    }
  });
});

describe("hazard HZ-011 hazard HZ-017 cancelling and reconciling an outage with back-entries", () => {
  it("lets only someone who entered none of its back-entries reconcile it", async () => {
    await asNorthManager(async (c) => {
      await note(c, a.personAda, { ...backEntry(OUTAGE_NORTH), paper_reference: "DT-003" });
      await c.query(
        `UPDATE outage SET state = 'closed', ended_at = now() - interval '1 hour', closed_at = now(),
           closed_by = $2, back_entry_due_at = now() + interval '72 hours' WHERE id = $1`,
        [OUTAGE_NORTH, a.northManager],
      );
    });
    const reconcile = (c: pg.PoolClient, by: string) =>
      c.query(
        `UPDATE outage SET state = 'reconciled', reconciled_at = now(), reconciled_by = $2,
           reconciliation_statement = 'All 2 forms entered and checked', forms_entered = 2
         WHERE id = $1`,
        [OUTAGE_NORTH, by],
      );
    await expect(asNorthManager((c) => reconcile(c, a.northManager))).rejects.toThrow(
      /entered none of the outage's paper records/,
    );
    await asManager((c) => reconcile(c, a.manager));
  });

  it("refuses to cancel an outage a back-entry cites, even one about someone the canceller cannot see", async () => {
    await asManager((c) => note(c, a.personBen, backEntry(OUTAGE_CITED)));
    await asOwner(TENANT_A, (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personBen, a.locationSouth]),
    );
    const seen = await asNorthManager((c) =>
      c.query("SELECT id FROM care_note WHERE outage_id = $1", [OUTAGE_CITED]),
    );
    expect(seen.rowCount).toBe(0);
    await expect(asNorthManager((c) => cancel(c, OUTAGE_CITED, a.northManager))).rejects.toThrow(
      /cannot be cancelled once a paper record entered against it cites it/,
    );
  });

  it("gives the caller back their own view after looking in the organisation's", async () => {
    const scopes = await asNorthManager(async (c) => {
      await c.query("SAVEPOINT attempt");
      await cancel(c, OUTAGE_CITED, a.northManager).catch(() => undefined);
      await c.query("ROLLBACK TO SAVEPOINT attempt");
      const afterRefusal = await c.query<{ s: string }>("SELECT app.current_scope() AS s");
      return afterRefusal.rows.map((r) => r.s);
    });
    expect(scopes).toEqual(["locations"]);
    const afterReconcile = await asOwner(TENANT_A, (c) =>
      c.query<{ state: string }>("SELECT state FROM outage WHERE id = $1", [OUTAGE_NORTH]),
    );
    expect(afterReconcile.rows).toEqual([{ state: "reconciled" }]);
  });
});
