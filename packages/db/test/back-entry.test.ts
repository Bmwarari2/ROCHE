import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Back-entry from paper in the database (operations.md rules 11 to 15; hazards HZ-009, HZ-011 and
 * HZ-017; migration 0053): the expand-only columns on the five care entries, the rule tying them
 * together, an outage at the entry's own location that is neither cancelled nor reconciled, the
 * entry's time being the instant the paper gives in UK time, a reason for any time outside the
 * outage, corrections staying back-entries of the same outage, no cancelling once a back-entry
 * cites an outage, no start or end leaving one outside it, and reconciliation only by someone who
 * entered and sent none of its back-entries, all counted in the organisation's view whatever the
 * caller can see.
 */

let db: TestDatabase;
const a = ids.a;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const northManagerContext = () => ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), northManagerContext(), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);

const ENTRY_TABLES = ["care_note", "observation", "body_map_mark", "activity_record", "visit_log"];
const outageId = (n: number) =>
  `0199f000-0000-7000-8000-0000000000${n.toString(16).padStart(2, "0")}`;
const entryId = (n: number) =>
  `0199f000-0000-7000-8000-0000000001${n.toString(16).padStart(2, "0")}`;
const OUTAGE_NORTH = outageId(0xc1);
const OUTAGE_SOUTH = outageId(0xc2);
const OUTAGE_CITED = outageId(0xc3);
const OUTAGE_ERROR = outageId(0xc4);
const OUTAGE_B = outageId(0xc5);
const OUTAGE_CORRECTED = outageId(0xc7);
const OUTAGE_HANDED_OVER = outageId(0xc8);
const OUTAGE_RACE = outageId(0xc9);
const OUTAGE_AUTUMN = outageId(0xca);
const OUTAGE_SPRING = outageId(0xcb);

const MINUTE = 60_000;
/** An instant `minutes` ago, to the minute (a paper time has no seconds). */
const ago = (minutes: number) =>
  new Date(Math.floor(Date.now() / MINUTE) * MINUTE - minutes * MINUTE);
const HOUR = 60;

const londonWall = (at: Date) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
};

/** What a paper form written at `at` says: the UK date and time, and which of a repeated hour. */
const paperAt = (at: Date) => {
  const wall = londonWall(at);
  const bst = Date.parse(`${wall.date}T${wall.time}:00Z`) - at.getTime() === 60 * MINUTE;
  const other = londonWall(new Date(at.getTime() + (bst ? 60 : -60) * MINUTE));
  const repeated = other.date === wall.date && other.time === wall.time;
  return {
    paper_date: wall.date,
    paper_time: wall.time,
    paper_occurrence: repeated ? (bst ? "earlier" : "later") : "only",
  };
};

type Details = Record<string, string | null>;

/** A note about `person` at North at `at`; `details` adds back-entry (or other) columns. */
const note = (c: pg.PoolClient, person: string, details: Details, at: Date = ago(3 * HOUR)) => {
  const columns = Object.keys(details);
  return c.query(
    `INSERT INTO care_note (person_id, location_id, occurred_at, category, body${columns.map((k) => `, ${k}`).join("")})
     VALUES ($1, $2, $3, 'personal_care', 'Assisted with a wash.'${columns.map((_, i) => `, $${i + 4}`).join("")})`,
    [person, a.locationNorth, at, ...Object.values(details)],
  );
};
/** The back-entry details of a form written at `at` for `outage`. */
const backEntry = (outage: string, at: Date = ago(3 * HOUR)): Details => ({
  late_entry_reason: "downtime",
  outage_id: outage,
  ...paperAt(at),
  paper_reference: "DT-001",
});

const declare = (id: string, startedAgo: number, endedAgo: number | null) =>
  asOwner(TENANT_A, (c) =>
    c.query(
      `INSERT INTO outage (id, location_id, kind, description, started_at, ended_at, declared_by)
       VALUES ($1, $2, 'power', 'Power cut, whole building', $3, $4, $5)`,
      [
        id,
        a.locationNorth,
        ago(startedAgo),
        endedAgo === null ? null : ago(endedAgo),
        a.northManager,
      ],
    ),
  );
const close = (c: pg.PoolClient, id: string, by: string, endedAt?: Date) =>
  c.query(
    `UPDATE outage SET state = 'closed', ended_at = coalesce($3, ended_at), closed_at = now(),
       closed_by = $2, back_entry_due_at = now() + interval '72 hours' WHERE id = $1`,
    [id, by, endedAt ?? null],
  );
const reconcile = (c: pg.PoolClient, id: string, by: string) =>
  c.query(
    `UPDATE outage SET state = 'reconciled', reconciled_at = now(), reconciled_by = $2,
       reconciliation_statement = 'All forms entered and checked', forms_entered = 2
     WHERE id = $1`,
    [id, by],
  );
const cancel = (c: pg.PoolClient, id: string, by: string) =>
  c.query(
    `UPDATE outage SET state = 'cancelled', cancelled_at = now(), cancelled_by = $2,
       cancellation_reason = 'Declared in error' WHERE id = $1`,
    [id, by],
  );
const correctStart = (id: string, startedAt: Date, reason: string) =>
  asNorthManager((c) =>
    c.query("UPDATE outage SET started_at = $2, correction_reason = $3 WHERE id = $1", [
      id,
      startedAt,
      reason,
    ]),
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
    const at = ago(3 * HOUR);
    const { rows } = await asCarer(async (c) => {
      await note(c, a.personAda, backEntry(OUTAGE_NORTH, at), at);
      return c.query<{ paper_time: string; paper_date: string; occurred_at: Date }>(
        `SELECT paper_time::text, paper_date::text, occurred_at FROM care_note WHERE outage_id = $1`,
        [OUTAGE_NORTH],
      );
    });
    const paper = paperAt(at);
    expect(rows).toEqual([
      { paper_time: `${paper.paper_time}:00`, paper_date: paper.paper_date, occurred_at: at },
    ]);
    await asCarer((c) =>
      note(c, a.personAda, {
        outage_id: OUTAGE_NORTH,
        not_from_paper_reason: "Recorded from memory at handover",
      }),
    );
  });

  it("refuses a back-entry without what the paper said, and back-entry details on any other entry", async () => {
    const refused: Details[] = [
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
      ).rejects.toThrow(/care_note_back_entry|paper record's time is the date and time written/);
    }
  });

  it("refuses an outage at another location, a cancelled one, or another organisation's", async () => {
    await asNorthManager((c) => cancel(c, OUTAGE_ERROR, a.northManager));
    for (const outage of [OUTAGE_SOUTH, OUTAGE_ERROR, OUTAGE_B]) {
      await expect(asManager((c) => note(c, a.personAda, backEntry(outage)))).rejects.toThrow(
        /names an outage at its own location that is neither cancelled nor reconciled/,
      );
    }
  });
});

describe("hazard HZ-009 hazard HZ-017 a back-entry's time is the time on the paper in UK time", () => {
  it("reads the paper date and time in Europe/London, with the occurrence for the repeated hour", async () => {
    const cases: [string, string, string, string | null][] = [
      ["2026-10-25", "01:30", "earlier", "2026-10-25T00:30:00.000Z"],
      ["2026-10-25", "01:30", "later", "2026-10-25T01:30:00.000Z"],
      ["2026-10-25", "01:30", "only", null],
      ["2026-10-25", "02:30", "only", "2026-10-25T02:30:00.000Z"],
      ["2026-10-25", "02:30", "later", null],
      ["2026-03-29", "01:30", "only", null],
      ["2026-03-29", "01:30", "earlier", null],
      ["2026-03-29", "01:30", "later", null],
      ["2026-03-29", "02:30", "only", "2026-03-29T01:30:00.000Z"],
      ["2026-10-11", "15:05", "only", "2026-10-11T14:05:00.000Z"],
      ["2026-12-01", "15:05", "only", "2026-12-01T15:05:00.000Z"],
    ];
    for (const [date, time, occurrence, expected] of cases) {
      const { rows } = await asManager((c) =>
        c.query<{ at: Date | null }>("SELECT app.paper_instant($1, $2, $3) AS at", [
          date,
          time,
          occurrence,
        ]),
      );
      expect(rows[0]?.at?.toISOString() ?? null, `${date} ${time} ${occurrence}`).toBe(expected);
    }
  });

  it("refuses an entry whose time is not the instant its paper date, time and occurrence give", async () => {
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO outage (id, location_id, kind, description, started_at, ended_at, declared_by)
         VALUES ($1, $3, 'power', 'Power cut on the night the clocks went back',
                 '2025-10-26T00:00:00Z', '2025-10-26T03:00:00Z', $4),
                ($2, $3, 'power', 'Power cut on the night the clocks went forward',
                 '2026-03-29T00:00:00Z', '2026-03-29T03:00:00Z', $4)`,
        [OUTAGE_AUTUMN, OUTAGE_SPRING, a.locationNorth, a.northManager],
      ),
    );
    const paper = (outage: string, date: string, occurrence: string) => ({
      late_entry_reason: "downtime",
      outage_id: outage,
      paper_date: date,
      paper_time: "01:30",
      paper_occurrence: occurrence,
    });
    const first = new Date("2025-10-26T00:30:00Z");
    const second = new Date("2025-10-26T01:30:00Z");
    await asCarer((c) =>
      note(c, a.personAda, paper(OUTAGE_AUTUMN, "2025-10-26", "earlier"), first),
    );
    await asCarer((c) => note(c, a.personAda, paper(OUTAGE_AUTUMN, "2025-10-26", "later"), second));
    const refused: [Details, Date][] = [
      [paper(OUTAGE_AUTUMN, "2025-10-26", "only"), first],
      [paper(OUTAGE_AUTUMN, "2025-10-26", "only"), second],
      [paper(OUTAGE_AUTUMN, "2025-10-26", "later"), first],
      [paper(OUTAGE_AUTUMN, "2025-10-26", "earlier"), second],
      [paper(OUTAGE_SPRING, "2026-03-29", "only"), new Date("2026-03-29T01:30:00Z")],
      [paper(OUTAGE_SPRING, "2026-03-29", "only"), new Date("2026-03-29T00:30:00Z")],
      [paper(OUTAGE_SPRING, "2026-03-29", "earlier"), new Date("2026-03-29T00:30:00Z")],
      // The pairing the first fixture had: three hours ago against a form saying 15:05.
      [
        { ...backEntry(OUTAGE_NORTH), paper_date: "2026-10-11", paper_time: "15:05" },
        ago(3 * HOUR),
      ],
    ];
    for (const [details, at] of refused) {
      await expect(
        asCarer((c) => note(c, a.personAda, details, at)),
        `${JSON.stringify(details)} at ${at.toISOString()}`,
      ).rejects.toThrow(/paper record's time is the date and time written on it in UK time/);
    }
  });
});

describe("hazard HZ-017 the outage window", () => {
  it("refuses an entry outside its outage unless a back-entry says why", async () => {
    const before = ago(21 * HOUR);
    await expect(
      asCarer((c) => note(c, a.personAda, backEntry(OUTAGE_CITED, before), before)),
    ).rejects.toThrow(/A paper record with a time outside its outage says why/);
    // The start is inside the window and the end outside, as for the no-overlap rule.
    const edges = outageId(0xcc);
    await declare(edges, 15 * HOUR, 14 * HOUR);
    const { rows } = await asOwner(TENANT_A, (c) =>
      c.query<{ started_at: Date; ended_at: Date }>(
        "SELECT started_at, ended_at FROM outage WHERE id = $1",
        [edges],
      ),
    );
    const [start, end] = [rows[0]?.started_at ?? ago(0), rows[0]?.ended_at ?? ago(0)];
    await asCarer((c) => note(c, a.personAda, backEntry(edges, start), start));
    await expect(asCarer((c) => note(c, a.personAda, backEntry(edges, end), end))).rejects.toThrow(
      /outside its outage says why/,
    );
    // An open outage runs to now, give or take the clock-drift allowance.
    const later = ago(-2 * HOUR);
    await expect(
      asCarer((c) => note(c, a.personAda, backEntry(OUTAGE_NORTH, later), later)),
    ).rejects.toThrow(/outside its outage says why/);
    await expect(
      asCarer((c) =>
        note(
          c,
          a.personAda,
          { outage_id: OUTAGE_CITED, not_from_paper_reason: "Recorded from memory" },
          before,
        ),
      ),
    ).rejects.toThrow(/An entry not written on paper names only an outage its time falls in/);
    await asCarer((c) =>
      note(
        c,
        a.personAda,
        {
          ...backEntry(OUTAGE_CITED, before),
          outside_outage_reason: "Form found in the east wing folder",
        },
        before,
      ),
    );
  });
});

describe("hazard HZ-011 hazard HZ-017 cancelling and reconciling an outage with back-entries", () => {
  it("refuses an end given on closing that would leave a back-entry outside the outage", async () => {
    const at = ago(2 * HOUR);
    await asCarer((c) => note(c, a.personAda, backEntry(OUTAGE_NORTH, at), at));
    await expect(
      asNorthManager((c) =>
        close(c, OUTAGE_NORTH, a.northManager, new Date(ago(2 * HOUR).getTime() - 30 * MINUTE)),
      ),
    ).rejects.toThrow(/would leave a paper record entered against the outage outside it/);
    await expect(asNorthManager((c) => close(c, OUTAGE_NORTH, a.northManager, at))).rejects.toThrow(
      /would leave a paper record entered against the outage outside it/,
    );
  });

  it("lets only someone who entered none of its back-entries reconcile it", async () => {
    await asNorthManager(async (c) => {
      await note(c, a.personAda, { ...backEntry(OUTAGE_NORTH), paper_reference: "DT-003" });
      await close(c, OUTAGE_NORTH, a.northManager, ago(HOUR));
    });
    await expect(asNorthManager((c) => reconcile(c, OUTAGE_NORTH, a.northManager))).rejects.toThrow(
      /entered none of the outage's paper records/,
    );
    await asManager((c) => reconcile(c, OUTAGE_NORTH, a.manager));
  });

  it("refuses a back-entry once the outage is reconciled", async () => {
    await expect(asCarer((c) => note(c, a.personAda, backEntry(OUTAGE_NORTH)))).rejects.toThrow(
      /names an outage at its own location that is neither cancelled nor reconciled/,
    );
  });

  it("refuses to cancel an outage a back-entry cites, even one about someone the canceller cannot see", async () => {
    const at = ago(19 * HOUR);
    await asManager((c) => note(c, a.personBen, backEntry(OUTAGE_CITED, at), at));
    await asOwner(TENANT_A, (c) =>
      c.query("UPDATE person SET location_id = $2 WHERE id = $1", [a.personBen, a.locationSouth]),
    );
    const seen = await asNorthManager((c) =>
      c.query("SELECT id FROM care_note WHERE outage_id = $1 AND person_id = $2", [
        OUTAGE_CITED,
        a.personBen,
      ]),
    );
    expect(seen.rowCount).toBe(0);
    await expect(asNorthManager((c) => cancel(c, OUTAGE_CITED, a.northManager))).rejects.toThrow(
      /cannot be cancelled once a paper record entered against it cites it/,
    );
  });

  it("makes a cancel at the same time as a back-entry wait for it, then count it", async () => {
    await declare(OUTAGE_RACE, 40 * HOUR, 38 * HOUR);
    const at = ago(39 * HOUR);
    const writer = await app().connect();
    const canceller = await app().connect();
    const begin = async (c: pg.PoolClient, userId: string, scope: string, locations: string[]) => {
      await c.query("BEGIN");
      await c.query(
        `SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true),
                set_config('app.scope', $3, true), set_config('app.location_ids', $4, true)`,
        [TENANT_A, userId, scope, locations.join(",")],
      );
    };
    try {
      await begin(writer, a.manager, "tenant", []);
      await note(writer, a.personAda, backEntry(OUTAGE_RACE, at), at);
      await begin(canceller, a.northManager, "locations", [a.locationNorth]);
      const { rows } = await canceller.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const cancelling = cancel(canceller, OUTAGE_RACE, a.northManager).then(
        () => "cancelled",
        (error: Error) => error.message,
      );
      let waiting = false;
      for (let i = 0; i < 200 && !waiting; i += 1) {
        const state = await writer.query(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [rows[0]?.pid],
        );
        waiting = state.rowCount === 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await writer.query("COMMIT");
      expect(await cancelling).toMatch(
        /cannot be cancelled once a paper record entered against it cites it/,
      );
      await canceller.query("ROLLBACK");
    } finally {
      writer.release();
      canceller.release();
    }
  });

  it("refuses a correction that would leave a back-entry outside the outage, unless it gave a reason", async () => {
    const window = outageId(0xc6);
    await declare(window, 12 * HOUR, 10 * HOUR);
    const inside = ago(11 * HOUR);
    const after = ago(9 * HOUR);
    await asManager(async (c) => {
      await note(c, a.personAda, backEntry(window, inside), inside);
      await note(
        c,
        a.personAda,
        {
          ...backEntry(window, after),
          outside_outage_reason: "Form found after the power came back",
        },
        after,
      );
    });
    await expect(
      correctStart(window, ago(10 * HOUR + 30), "The power went at 13:30"),
    ).rejects.toThrow(/would leave a paper record entered against the outage outside it/);
    await correctStart(window, ago(11 * HOUR + 30), "The power went at 12:30");
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

describe("hazard HZ-011 hazard HZ-017 corrections of back-entries", () => {
  const original = entryId(1);
  const moved = entryId(2);
  const correction = (
    c: pg.PoolClient,
    supersedes: string,
    details: Details,
    at: Date,
    id: string | null = null,
  ) => {
    const columns = Object.keys(details);
    return c.query(
      `INSERT INTO care_note (id, person_id, location_id, occurred_at, category, body, supersedes_id,
         correction_reason${columns.map((k) => `, ${k}`).join("")})
       VALUES (coalesce($1, app.uuid_v7()), $2, $3, $4, 'personal_care',
               'Assisted with a wash and a shave.', $5, 'Shave left off the first entry'${columns.map((_, i) => `, $${i + 6}`).join("")})`,
      [id, a.personAda, a.locationNorth, at, supersedes, ...Object.values(details)],
    );
  };

  it("carries a back-entry's paper details to a correction that gives none, and keeps it on the same outage", async () => {
    await declare(OUTAGE_CORRECTED, 70 * HOUR, 65 * HOUR);
    const first = ago(66 * HOUR);
    const second = ago(69 * HOUR);
    await asNorthManager(async (c) => {
      await c.query(
        `INSERT INTO care_note (id, person_id, location_id, occurred_at, category, body,
           late_entry_reason, outage_id, paper_date, paper_time, paper_occurrence, paper_reference)
         VALUES ($1, $3, $4, $5, 'personal_care', 'Assisted with a wash.', 'downtime', $7, $8, $9,
                 $10, 'DT-010'),
                ($2, $3, $4, $6, 'personal_care', 'Settled for the night.', 'downtime', $7, $11, $12,
                 $13, 'DT-011')`,
        [
          original,
          moved,
          a.personAda,
          a.locationNorth,
          first,
          second,
          OUTAGE_CORRECTED,
          paperAt(first).paper_date,
          paperAt(first).paper_time,
          paperAt(first).paper_occurrence,
          paperAt(second).paper_date,
          paperAt(second).paper_time,
          paperAt(second).paper_occurrence,
        ],
      );
    });
    const carried = entryId(3);
    await asManager((c) => correction(c, original, {}, first, carried));
    const { rows } = await asManager((c) =>
      c.query(
        `SELECT late_entry_reason, outage_id, paper_date::text, paper_time::text, paper_occurrence,
           paper_reference FROM care_note WHERE id = $1`,
        [carried],
      ),
    );
    expect(rows).toEqual([
      {
        late_entry_reason: "downtime",
        outage_id: OUTAGE_CORRECTED,
        paper_date: paperAt(first).paper_date,
        paper_time: `${paperAt(first).paper_time}:00`,
        paper_occurrence: paperAt(first).paper_occurrence,
        paper_reference: "DT-010",
      },
    ]);
    const refused: Details[] = [
      backEntry(OUTAGE_CITED, first),
      { outage_id: OUTAGE_CORRECTED, not_from_paper_reason: "Recorded from memory" },
      { late_entry_reason: "other" },
    ];
    for (const details of refused) {
      await expect(
        asManager((c) => correction(c, original, details, first)),
        JSON.stringify(details),
      ).rejects.toThrow(/A correction of a paper record stays a paper record of the same outage/);
    }
  });

  it("leaves out a corrected back-entry when the outage's start or end changes", async () => {
    // The entry at 69 hours ago is corrected to 67 hours ago, a time it gives on its own paper.
    const corrected = ago(67 * HOUR);
    await asManager((c) =>
      correction(
        c,
        moved,
        { ...backEntry(OUTAGE_CORRECTED, corrected), paper_reference: "DT-011" },
        corrected,
      ),
    );
    await expect(
      correctStart(OUTAGE_CORRECTED, ago(66 * HOUR + 30), "The power went later than first said"),
    ).rejects.toThrow(/would leave a paper record entered against the outage outside it/);
    await correctStart(
      OUTAGE_CORRECTED,
      ago(67 * HOUR + 30),
      "The power went later than first said",
    );
  });

  it("counts the original author and the sender of each back-entry against reconciling, not someone who only corrected one", async () => {
    await asNorthManager((c) => close(c, OUTAGE_CORRECTED, a.northManager));
    await expect(
      asNorthManager((c) => reconcile(c, OUTAGE_CORRECTED, a.northManager)),
    ).rejects.toThrow(/entered none of the outage's paper records/);

    await declare(OUTAGE_HANDED_OVER, 90 * HOUR, 85 * HOUR);
    const at = ago(88 * HOUR);
    await asOwner(TENANT_A, (c) =>
      c.query(
        `INSERT INTO care_note (person_id, location_id, occurred_at, category, body, created_by,
           handed_over_by, late_entry_reason, outage_id, paper_date, paper_time, paper_occurrence)
         VALUES ($1, $2, $3, 'personal_care', 'Assisted with a wash.', $4, $5, 'downtime', $6, $7,
                 $8, $9)`,
        [
          a.personAda,
          a.locationNorth,
          at,
          a.carer,
          a.northManager,
          OUTAGE_HANDED_OVER,
          paperAt(at).paper_date,
          paperAt(at).paper_time,
          paperAt(at).paper_occurrence,
        ],
      ),
    );
    await asManager((c) => close(c, OUTAGE_HANDED_OVER, a.manager));
    await expect(
      asNorthManager((c) => reconcile(c, OUTAGE_HANDED_OVER, a.northManager)),
    ).rejects.toThrow(/entered none of the outage's paper records/);

    await asManager((c) => reconcile(c, OUTAGE_CORRECTED, a.manager));
  });
});
