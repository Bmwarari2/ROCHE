import {
  DEFAULT_PAPER_MAR_LOCATION,
  DEFAULT_PEEP_LOCATION,
  OUTAGE_KINDS,
  OUTAGE_WORKFLOW,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OUTAGE_KIND_CODES, OUTAGE_STATES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Downtime packs and outages in the database (operations.md sections 2 and 3; hazards HZ-011,
 * HZ-017 and HZ-021; migrations 0050 and 0051): cross-tenant denial, a pack only for holders of
 * operations.downtime.read who can see every person it names, outages for staff at the location and
 * written by holders of operations.downtime.manage, append-only packs, declaring an outage open,
 * the outage workflow guard and corrections, and the location's MAR and PEEP places.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** The nightly job: no member, the organisation's view. */
const asSystem = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, null, "tenant"), fn);
const asManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "tenant"), fn);
const asNorthManager = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "tenant"), fn);

const PACK_NORTH = "0199e000-0000-7000-8000-0000000000a1";
const PACK_SOUTH = "0199e000-0000-7000-8000-0000000000a2";
const PACK_B = "0199e000-0000-7000-8000-0000000000b1";
const OUTAGE_NORTH = "0199e000-0000-7000-8000-0000000000c1";
const OUTAGE_B = "0199e000-0000-7000-8000-0000000000c2";
const OUTAGE_SOUTH = "0199e000-0000-7000-8000-0000000000c4";

/** A pack whose content has a page for each of `people`; the people column is worked out from it. */
const insertPack = (
  c: pg.PoolClient,
  values: { id?: string; location: string; people: string[]; personIds?: string[] },
) =>
  c.query(
    `INSERT INTO downtime_pack (id, location_id, source, generated_at, as_at, valid_until,
       generated_by, person_ids, content)
     VALUES (COALESCE($1, app.uuid_v7()), $2,
       CASE WHEN app.current_user_id() IS NULL THEN 'server_nightly' ELSE 'server_on_demand' END,
       now(), now(), now() + interval '36 hours', app.current_user_id(), COALESCE($4::uuid[], '{}'),
       jsonb_build_object('pages', COALESCE((SELECT jsonb_agg(jsonb_build_object('personId', p))
         FROM unnest($3::uuid[]) AS p), '[]'::jsonb)))`,
    [values.id ?? null, values.location, values.people, values.personIds ?? null],
  );

/** An outage started some hours ago: open, or declared after it ended when `endedHoursAgo` is set. */
const insertOutage = (
  c: pg.PoolClient,
  location: string,
  startedHoursAgo: number,
  options: { id?: string; endedHoursAgo?: number; declaredBy?: string } = {},
) =>
  c.query(
    `INSERT INTO outage (id, location_id, kind, description, started_at, ended_at, declared_by)
     VALUES (COALESCE($1, app.uuid_v7()), $2, 'power', 'Power cut, whole building',
       now() - make_interval(hours => $3), now() - make_interval(hours => $4),
       COALESCE($5, app.current_user_id()))`,
    [
      options.id ?? null,
      location,
      startedHoursAgo,
      options.endedHoursAgo ?? null,
      options.declaredBy ?? null,
    ],
  );

const packIds = (c: pg.PoolClient) =>
  c
    .query<{ id: string }>("SELECT id FROM downtime_pack ORDER BY id")
    .then((r) => r.rows.map((x) => x.id));
const outageIds = (c: pg.PoolClient) =>
  c.query<{ id: string }>("SELECT id FROM outage ORDER BY id").then((r) => r.rows.map((x) => x.id));

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  const downtime = "{operations.downtime.read,operations.downtime.manage,people.person.read}";
  await inContext(db.pool("harbour_owner"), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('care_note.late_entry_hours', 2, 'hours', 'all', '2000-01-01', 'master prompt 10.1', 'master-prompt')`,
    ),
  );
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199e000-0000-7000-8000-000000000501', 'owner', 'Owner', 'tenant',
          array_append($1::text[], 'platform.location.manage')),
         ('0199e000-0000-7000-8000-000000000502', 'team_leader', 'Team leader', 'location', $1)`,
      [downtime],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199e000-0000-7000-8000-000000000501', NULL),
         ($2, '0199e000-0000-7000-8000-000000000502', $3),
         ($4, $5, $3)`,
      [a.manager, a.northManager, a.locationNorth, a.carer, a.roleCarer],
    );
    await insertPack(c, {
      id: PACK_NORTH,
      location: a.locationNorth,
      people: [a.personAda, a.personBen],
    });
    await insertPack(c, { id: PACK_SOUTH, location: a.locationSouth, people: [a.personCara] });
    await insertOutage(c, a.locationNorth, 30, { id: OUTAGE_NORTH, declaredBy: a.northManager });
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ('0199e000-0000-7000-8000-000000000503', 'owner', 'Owner', 'tenant', $1)`,
      [downtime],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       VALUES ($1, '0199e000-0000-7000-8000-000000000503')`,
      [b.manager],
    );
    await insertPack(c, { id: PACK_B, location: b.location, people: [b.personDev] });
    await insertOutage(c, b.location, 2, { id: OUTAGE_B, declaredBy: b.manager });
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("hazard HZ-011 downtime packs and outages stay in their organisation", () => {
  it("never shows another organisation's packs or outages", async () => {
    expect(await asManager(packIds)).toEqual([PACK_NORTH, PACK_SOUTH]);
    expect(await asManager(outageIds)).toEqual([OUTAGE_NORTH]);
    expect(await asOtherTenant(packIds)).toEqual([PACK_B]);
    expect(await asOtherTenant(outageIds)).toEqual([OUTAGE_B]);
  });

  it("refuses a pack or an outage for another organisation's location, and changes none of theirs", async () => {
    await expect(
      asManager((c) => insertPack(c, { location: b.location, people: [] })),
    ).rejects.toThrow(/foreign key|row-level security/);
    await expect(asManager((c) => insertOutage(c, b.location, 1))).rejects.toThrow(
      /foreign key|row-level security/,
    );
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO outage (tenant_id, location_id, kind, description, started_at)
           VALUES ($1, $2, 'power', 'Power cut, whole building', now())`,
          [TENANT_B, b.location],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    const changed = await asOtherTenant((c) =>
      c.query("UPDATE outage SET description = 'Changed by another organisation' WHERE id = $1", [
        OUTAGE_NORTH,
      ]),
    );
    expect(changed.rowCount).toBe(0);
  });
});

describe("hazard HZ-011 hazard HZ-021 a downtime pack follows its location and its people", () => {
  it("shows a location's pack to holders of operations.downtime.read there, never a care worker", async () => {
    expect(await asNorthManager(packIds)).toEqual([PACK_NORTH]);
    expect(await asCarer(packIds)).toEqual([]);
    expect(
      await inContext(app(), ctx(TENANT_A, a.carer, "locations", [a.locationNorth]), packIds),
    ).toEqual([]);
  });

  it("takes the people from the pack's content, whatever the caller says, and hides it from a reader who cannot see one", async () => {
    const id = "0199e000-0000-7000-8000-0000000000a3";
    const stored = await asOwner(TENANT_A, async (c) => {
      await insertPack(c, {
        id,
        location: a.locationNorth,
        people: [a.personAda, a.personCara],
        personIds: [a.personAda],
      });
      return c.query<{ person_ids: string[] }>(
        "SELECT person_ids FROM downtime_pack WHERE id = $1",
        [id],
      );
    });
    expect(stored.rows[0]?.person_ids).toEqual([a.personAda, a.personCara].sort());
    expect(await asNorthManager(packIds)).toEqual([PACK_NORTH]);
    expect(await asManager(packIds)).toContain(id);
    const ada = `{"personId": "${a.personAda}"}`;
    const nightly = (location: string, content: string, warnings = "{}") =>
      asSystem((c) =>
        c.query(
          `INSERT INTO downtime_pack (location_id, source, generated_at, as_at, valid_until, content,
             warnings)
           VALUES ($1, 'server_nightly', now(), now(), now() + interval '1 hour', $2, $3)`,
          [location, content, warnings],
        ),
      );
    // Round 2: no one left out is named, no other keys, warnings about the pack's own people and
    // counts only, and no empty pack while anyone is receiving care at the location.
    const cara = `"personId": "${a.personCara}"`;
    for (const [content, warnings] of [
      ["{}", "{}"],
      ['{"pages": {}}', "{}"],
      ['{"pages": [{"name": "No id"}]}', "{}"],
      [`{"pages": [${ada}], "excluded": [{${cara}, "reason": "other_location"}]}`, "{}"],
      [`{"pages": [${ada}], "extra": true}`, "{}"],
      [`{"pages": [${ada}], "warnings": [{${cara}, "kind": "critical_not_recorded"}]}`, "{}"],
      [`{"pages": [${ada}]}`, `{"people": ["${a.personAda}"]}`],
      ['{"pages": [], "excluded": []}', "{}"],
    ] as const) {
      await expect(nightly(a.locationNorth, content, warnings), content).rejects.toThrow(
        /downtime pack/,
      );
    }
    await nightly(
      a.locationNorth,
      `{"pages": [${ada}], "excluded": [], "warnings": []}`,
      '{"critical_not_recorded": 2}',
    );
    const empty = "0199e000-0000-7000-8000-000000000105";
    await asOwner(TENANT_A, (c) =>
      c.query("INSERT INTO location (id, name) VALUES ($1, 'Empty House')", [empty]),
    );
    await nightly(empty, '{"pages": []}');
  });

  it("lets a holder build a pack at their location in their own name only", async () => {
    await asNorthManager((c) =>
      insertPack(c, { location: a.locationNorth, people: [a.personAda] }),
    );
    await expect(
      asNorthManager((c) => insertPack(c, { location: a.locationSouth, people: [] })),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorthManager((c) =>
        c.query(
          `INSERT INTO downtime_pack (location_id, source, generated_at, as_at, valid_until,
             generated_by, content)
           VALUES ($1, 'server_on_demand', now(), now(), now() + interval '1 hour', $2,
             jsonb_build_object('pages', jsonb_build_array(jsonb_build_object('personId', $3::uuid))))`,
          [a.locationNorth, a.manager, a.personAda],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asCarer((c) => insertPack(c, { location: a.locationNorth, people: [a.personAda] })),
    ).rejects.toThrow(/row-level security/);
  });

  it("builds the nightly pack as the system, never as a member", async () => {
    await asSystem((c) => insertPack(c, { location: a.locationSouth, people: [a.personCara] }));
    await expect(
      asManager((c) =>
        c.query(
          `INSERT INTO downtime_pack (location_id, source, generated_at, as_at, valid_until, content)
           VALUES ($1, 'server_nightly', now(), now(), now() + interval '1 hour',
             jsonb_build_object('pages', jsonb_build_array(jsonb_build_object('personId', $2::uuid))))`,
          [a.locationNorth, a.personAda],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("keeps a pack append-only for the application and the owner", async () => {
    await expect(
      asManager((c) =>
        c.query("UPDATE downtime_pack SET content = '{}' WHERE id = $1", [PACK_NORTH]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asManager((c) => c.query("DELETE FROM downtime_pack WHERE id = $1", [PACK_NORTH])),
    ).rejects.toThrow(/permission denied/);
    for (const statement of [
      "UPDATE downtime_pack SET valid_until = now()",
      "DELETE FROM downtime_pack",
      "TRUNCATE downtime_pack",
    ]) {
      await expect(
        asOwner(TENANT_A, (c) => c.query(statement)),
        statement,
      ).rejects.toThrow(/append-only/);
    }
  });
});

describe("hazard HZ-011 hazard HZ-017 outages at a location", () => {
  it("shows an outage to staff at its location, a care worker there included", async () => {
    expect(await asNorthManager(outageIds)).toEqual([OUTAGE_NORTH]);
    expect(await asCarer(outageIds)).toEqual([OUTAGE_NORTH]);
    expect(await inContext(app(), ctx(TENANT_A, a.carer, "none"), outageIds)).toEqual([]);
    expect(
      await inContext(
        app(),
        ctx(TENANT_A, a.northManager, "locations", [a.locationSouth]),
        outageIds,
      ),
    ).toEqual([]);
  });

  it("lets only a holder of operations.downtime.manage there declare or change one, in their own name", async () => {
    await asNorthManager((c) => insertOutage(c, a.locationNorth, 40, { endedHoursAgo: 35 }));
    await expect(asNorthManager((c) => insertOutage(c, a.locationSouth, 1))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      asCarer((c) => insertOutage(c, a.locationNorth, 50, { endedHoursAgo: 45 })),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asNorthManager((c) =>
        c.query(
          `INSERT INTO outage (location_id, kind, description, started_at, ended_at, declared_by)
           VALUES ($1, 'power', 'Power cut, whole building', now() - interval '60 hours',
             now() - interval '55 hours', $2)`,
          [a.locationNorth, a.manager],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
    for (const change of [
      `state = 'closed', ended_at = now(), closed_at = now(), closed_by = '${a.carer}',
         back_entry_due_at = now() + interval '1 day'`,
      `state = 'cancelled', cancelled_at = now(), cancelled_by = '${a.carer}',
         cancellation_reason = 'Declared in error'`,
    ]) {
      const changed = await asCarer((c) =>
        c.query(`UPDATE outage SET ${change} WHERE id = $1`, [OUTAGE_NORTH]),
      );
      expect(changed.rowCount).toBe(0);
    }
  });

  it("declares an outage open and now, and works out whether it was declared late", async () => {
    const refused = [
      `state, closed_at, closed_by, back_entry_due_at, reconciled_at, reconciled_by,
         reconciliation_statement, forms_entered) VALUES ('reconciled', now(), '${a.manager}',
         now(), now(), '${a.northManager}', 'All forms entered', 1`,
      `closed_by) VALUES ('${a.northManager}'`,
      `cancellation_reason) VALUES ('Declared in error'`,
    ];
    for (const extra of refused) {
      await expect(
        asManager((c) =>
          c.query(
            `INSERT INTO outage (location_id, kind, description, started_at, ended_at, ${extra.replace(") VALUES (", `) VALUES ('${a.locationSouth}', 'power', 'Power cut, whole building', now() - interval '80 hours', now() - interval '79 hours', `)})`,
          ),
        ),
        extra,
      ).rejects.toThrow(/declared open/);
    }
    const declared = await asManager(async (c) => {
      const late = await c.query<{ declared_at: Date; now: Date; declared_late: boolean }>(
        `INSERT INTO outage (location_id, kind, description, started_at, ended_at, declared_at,
           declared_late)
         VALUES ($1, 'power', 'Power cut, whole building', now() - interval '70 hours',
           now() - interval '69 hours', '2026-01-01', false)
         RETURNING declared_at, now() AS now, declared_late`,
        [a.locationSouth],
      );
      const prompt = await c.query<{ id: string; declared_late: boolean }>(
        `INSERT INTO outage (location_id, kind, description, started_at, declared_late)
         VALUES ($1, 'power', 'Power cut, whole building', now() - interval '1 hour', true)
         RETURNING id, declared_late`,
        [a.locationSouth],
      );
      // Cancelled, so it leaves South free for the tests below.
      await c.query(
        `UPDATE outage SET state = 'cancelled', cancelled_at = now(), cancelled_by = $2,
           cancellation_reason = 'Declared to test the late flag' WHERE id = $1`,
        [prompt.rows[0]?.id, a.manager],
      );
      return { late: late.rows[0], prompt: prompt.rows[0] };
    });
    expect(declared.late?.declared_at).toEqual(declared.late?.now);
    expect(declared.late?.declared_late).toBe(true);
    expect(declared.prompt?.declared_late).toBe(false); // started within care_note.late_entry_hours
    const flag = await asManager(async (c) => {
      await c.query("UPDATE outage SET declared_late = NOT declared_late WHERE id = $1", [
        OUTAGE_NORTH,
      ]);
      return c.query<{ declared_late: boolean }>("SELECT declared_late FROM outage WHERE id = $1", [
        OUTAGE_NORTH,
      ]);
    });
    expect(flag.rows).toEqual([{ declared_late: true }]);
    await expect(
      asManager((c) =>
        c.query("UPDATE outage SET declared_at = now() - interval '1 day' WHERE id = $1", [
          OUTAGE_NORTH,
        ]),
      ),
    ).rejects.toThrow(/keeps its location and declaration/);
  });

  it("never lets two outages at a location overlap, cancelled ones aside", async () => {
    await expect(asManager((c) => insertOutage(c, a.locationNorth, 1))).rejects.toThrow(
      /outage_no_overlap/,
    );
    await asManager(async (c) => {
      await insertOutage(c, a.locationSouth, 5, { id: "0199e000-0000-7000-8000-0000000000c3" });
      await c.query(
        `UPDATE outage SET state = 'cancelled', cancelled_at = now(), cancelled_by = $1,
           cancellation_reason = 'Declared at the wrong home' WHERE id = '0199e000-0000-7000-8000-0000000000c3'`,
        [a.manager],
      );
      await insertOutage(c, a.locationSouth, 4, { id: OUTAGE_SOUTH });
    });
    await expect(
      asManager((c) =>
        c.query(
          "UPDATE outage SET description = 'Changed' WHERE id = '0199e000-0000-7000-8000-0000000000c3'",
        ),
      ),
    ).rejects.toThrow(/cancelled outage is final/);
  });

  it("corrects a start or end only with a reason of its own, before reconciliation", async () => {
    const correct = (set: string) =>
      asManager((c) =>
        c.query(`UPDATE outage SET ${set} WHERE id = $1 RETURNING version, declared_late`, [
          OUTAGE_SOUTH,
        ]),
      );
    const corrected = await correct(
      "started_at = now() - interval '1 hour', correction_reason = 'Typed 05:00, the power went at 08:00'",
    );
    expect(corrected.rows).toEqual([{ version: 2, declared_late: false }]);
    const refused: [string, RegExp][] = [
      ["started_at = now() - interval '2 hours'", /corrected only with a reason of its own/],
      [
        "started_at = now() - interval '2 hours', correction_reason = 'Typed 05:00, the power went at 08:00'",
        /corrected only with a reason of its own/,
      ],
      ["ended_at = now(), correction_reason = 'It ended at noon'", /an open outage stays open/],
      ["correction_reason = 'No change'", /goes with a corrected start or end/],
      [
        "started_at = now() - interval '3 hours', correction_reason = '  '",
        /corrected only with a reason of its own/,
      ],
      [
        `state = 'cancelled', cancelled_at = now(), cancelled_by = '${a.manager}', cancellation_reason = ' '`,
        /outage_words/,
      ],
    ];
    for (const [set, reason] of refused) {
      await expect(correct(set), set).rejects.toThrow(reason);
    }
    const history = await asManager((c) =>
      c.query<{ started_at: string }>(
        "SELECT data ->> 'started_at' AS started_at FROM record_version WHERE record_id = $1",
        [OUTAGE_SOUTH],
      ),
    );
    expect(history.rowCount).toBe(1);
  });

  it("moves only along the workflow, in the name of the member moving it", async () => {
    const close = (by: string) =>
      asNorthManager((c) =>
        c.query(
          `UPDATE outage SET state = 'closed', ended_at = now() - interval '1 hour', closed_at = now(),
             closed_by = $2, back_entry_due_at = now() + interval '72 hours'
           WHERE id = $1 RETURNING version`,
          [OUTAGE_NORTH, by],
        ),
      );
    await expect(close(a.manager)).rejects.toThrow(/in the name of the member/);
    expect((await close(a.northManager)).rows).toEqual([{ version: 3 }]);
    const refused: [string, RegExp][] = [
      [
        "state = 'declared', closed_at = NULL, closed_by = NULL, back_entry_due_at = NULL",
        /cannot move from closed to declared/,
      ],
      [
        `state = 'cancelled', cancelled_at = now(), cancelled_by = '${a.manager}', cancellation_reason = 'Too late'`,
        /cannot move from closed to cancelled/,
      ],
      ["closed_at = now() - interval '1 minute'", /closure is set once/],
      ["ended_at = now()", /corrected only with a reason of its own/],
      [`location_id = '${a.locationSouth}'`, /keeps its location/],
      ["deleted_at = now()", /is never deleted/],
    ];
    for (const [change, reason] of refused) {
      await expect(
        asManager((c) => c.query(`UPDATE outage SET ${change} WHERE id = $1`, [OUTAGE_NORTH])),
        change,
      ).rejects.toThrow(reason);
    }
    await asNorthManager((c) =>
      c.query(
        `UPDATE outage SET state = 'reconciled', reconciled_at = now(), reconciled_by = $2,
           reconciliation_statement = 'All 3 forms entered and checked', forms_entered = 3
         WHERE id = $1`,
        [OUTAGE_NORTH, a.northManager],
      ),
    );
    for (const change of [
      "description = 'Changed'",
      "ended_at = now(), correction_reason = 'It ended later than written'",
    ]) {
      await expect(
        asManager((c) => c.query(`UPDATE outage SET ${change} WHERE id = $1`, [OUTAGE_NORTH])),
        change,
      ).rejects.toThrow(/reconciled outage is final/);
    }
    const history = await asManager((c) =>
      c.query("SELECT count(*)::int AS n FROM record_version WHERE record_id = $1", [OUTAGE_NORTH]),
    );
    expect(history.rows[0]?.n).toBe(3); // the flag left as it was, closed, reconciled
  });
});

describe("downtime codes and the location's MAR and PEEP places", () => {
  it("keeps the outage codes in step with packages/domain", () => {
    expect([...OUTAGE_KIND_CODES]).toEqual([...OUTAGE_KINDS]);
    expect([...OUTAGE_STATES]).toEqual([...OUTAGE_WORKFLOW.states]);
  });

  it("hazard HZ-021 seeds every location with the default places, unconfirmed, and refuses a blank one", async () => {
    const places = () =>
      asManager((c) =>
        c.query(
          `SELECT downtime_mar_location AS mar, downtime_peep_location AS peep,
             downtime_places_confirmed_by AS by,
             downtime_places_confirmed_at > now() - interval '1 minute' AS now
           FROM location WHERE id = $1`,
          [a.locationNorth],
        ),
      );
    expect((await places()).rows).toEqual([
      { mar: DEFAULT_PAPER_MAR_LOCATION, peep: DEFAULT_PEEP_LOCATION, by: null, now: null },
    ]);
    const mar = "The MAR folder in the clinical room";
    await expect(
      asNorthManager((c) =>
        c.query("UPDATE location SET downtime_mar_location = $2 WHERE id = $1", [
          a.locationNorth,
          mar,
        ]),
      ),
    ).rejects.toThrow(/platform.location.manage/);
    await expect(
      asManager((c) =>
        c.query("UPDATE location SET downtime_places_confirmed_by = $2 WHERE id = $1", [
          a.locationNorth,
          a.northManager,
        ]),
      ),
    ).rejects.toThrow(/in the name of the member confirming them/);
    await asManager((c) =>
      c.query(
        `UPDATE location SET downtime_mar_location = $2, downtime_places_confirmed_by = $3,
           downtime_places_confirmed_at = '2020-01-01' WHERE id = $1`,
        [a.locationNorth, mar, a.manager],
      ),
    );
    expect((await places()).rows).toEqual([
      { mar, peep: DEFAULT_PEEP_LOCATION, by: a.manager, now: true },
    ]);
    await asManager((c) =>
      c.query("UPDATE location SET downtime_peep_location = 'The red fire file' WHERE id = $1", [
        a.locationNorth,
      ]),
    );
    expect((await places()).rows).toEqual([
      { mar, peep: "The red fire file", by: null, now: null },
    ]);
    await expect(
      asManager((c) =>
        c.query("UPDATE location SET downtime_peep_location = '  ' WHERE id = $1", [
          a.locationNorth,
        ]),
      ),
    ).rejects.toThrow(/location_downtime_places/);
  });
});
