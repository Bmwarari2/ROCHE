import { SHIFT_KINDS } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SHIFT_KIND_CODES } from "../src/schema";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * The rota builder in the database (scheduling.md section 14; hazards HZ-123 and HZ-124; migration
 * 0083): cross-tenant denial on every table; rotas read and built only by holders of the rota
 * permissions where the rota is; a worker sees only their own published shifts; rotas never
 * overlap; shifts sit inside their rota; a worker is never on two shifts at once; overrides are
 * given by a holder of scheduling.rota.approve, never for themselves, never for a right to work,
 * with a real justification, and never changed; publications are append-only.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(db.pool("harbour_owner"), ctx(tenantId, null, "tenant"), fn);
/** The North House manager: builds and approves North's rota. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** The registered manager: builds North's rota, without approve. */
const asPlanner = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "locations", [a.locationNorth]), fn);
/** The care worker, with scheduling.timesheet.self only. */
const asCarer = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.carer, "assigned"), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "locations", [b.location]), fn);

const ROTA = "0199f300-0000-7000-8000-0000000000a1";
const SOUTH_ROTA = "0199f300-0000-7000-8000-0000000000a2";
const TEMPLATE = "0199f300-0000-7000-8000-0000000000b1";
const DAY_SHIFT = "0199f300-0000-7000-8000-0000000000c1";
const LATE_SHIFT = "0199f300-0000-7000-8000-0000000000c2";
const OPEN_SHIFT = "0199f300-0000-7000-8000-0000000000c3";
const ASSIGNMENT = "0199f300-0000-7000-8000-0000000000d1";
const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);

const insertShift = (
  c: pg.PoolClient,
  v: { id?: string; rota?: string; location?: string; start: string; end: string },
) =>
  c.query(
    `INSERT INTO shift (id, rota_id, location_id, label, kind, starts_at, ends_at, break_minutes)
     VALUES (COALESCE($1, app.uuid_v7()), $2, $3, 'Day', 'work', $4, $5, 30)`,
    [v.id ?? null, v.rota ?? ROTA, v.location ?? a.locationNorth, v.start, v.end],
  );
const assign = (c: pg.PoolClient, shiftId: string, worker: string, id: string | null = null) =>
  c.query(
    `INSERT INTO shift_assignment (id, shift_id, location_id, worker_id)
     VALUES (COALESCE($1, app.uuid_v7()), $2, $3, $4)`,
    [id, shiftId, a.locationNorth, worker],
  );
/** A new assignment of the worker on its own shift with an override, in one transaction. */
const override = async (
  c: pg.PoolClient,
  v: { worker?: string; keys?: string[]; justification?: string; by?: string | null; day?: number },
) => {
  const worker = v.worker ?? a.carer;
  const day = `2026-11-0${v.day ?? 6}`;
  const { rows } = await c.query<{ id: string }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at)
     VALUES ($1, $2, 'Day', 'work', $3::timestamptz, $3::timestamptz + interval '8 hours') RETURNING id`,
    [ROTA, a.locationNorth, `${day}T09:00:00Z`],
  );
  const shiftId = rows[0]?.id as string;
  const assignment = await c.query<{ id: string }>(
    `INSERT INTO shift_assignment (shift_id, location_id, worker_id) VALUES ($1, $2, $3) RETURNING id`,
    [shiftId, a.locationNorth, a.carer],
  );
  return c.query(
    `INSERT INTO roster_override (assignment_id, location_id, worker_id, blocker_keys, justification, created_by)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, app.current_user_id()))`,
    [
      assignment.rows[0]?.id,
      a.locationNorth,
      worker,
      v.keys ?? ["competence:moving_and_handling_hoist:expired"],
      v.justification ?? "Hoist trained colleague on the same shift",
      v.by ?? null,
    ],
  );
};

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(db.pool("harbour_owner"));
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000501', 'rota_lead', 'Rota lead', 'location',
          '{scheduling.rota.manage,scheduling.rota.approve}'),
         ('0199f300-0000-7000-8000-000000000502', 'planner', 'Planner', 'location',
          '{scheduling.rota.manage}'),
         ('0199f300-0000-7000-8000-000000000503', 'self', 'Self', 'assigned',
          '{scheduling.timesheet.self}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f300-0000-7000-8000-000000000501', $4),
         ($2, '0199f300-0000-7000-8000-000000000502', $4),
         ($3, '0199f300-0000-7000-8000-000000000503', $4)`,
      [a.northManager, a.manager, a.carer, a.locationNorth],
    );
    // South's rota, made as the owner: nobody in these tests holds a rota permission at South.
    await c.query(
      `INSERT INTO rota (id, location_id, starts_on, ends_on) VALUES ($1, $2, '2026-11-02', '2026-11-08')`,
      [SOUTH_ROTA, a.locationSouth],
    );
  });
  await asOwner(TENANT_B, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f300-0000-7000-8000-000000000504', 'rota_lead', 'Rota lead', 'location', '{scheduling.rota.manage}')`,
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       VALUES ($1, '0199f300-0000-7000-8000-000000000504', $2)`,
      [b.manager, b.location],
    );
  });
  await asNorth(async (c) => {
    await c.query(
      `INSERT INTO shift_template (id, location_id, name, kind, start_minute, end_minute, break_minutes)
       VALUES ($1, $2, 'Day', 'work', 480, 1200, 30)`,
      [TEMPLATE, a.locationNorth],
    );
    await c.query(
      `INSERT INTO rota (id, location_id, starts_on, ends_on) VALUES ($1, $2, '2026-11-02', '2026-11-08')`,
      [ROTA, a.locationNorth],
    );
    await insertShift(c, {
      id: DAY_SHIFT,
      start: "2026-11-02T08:00:00Z",
      end: "2026-11-02T20:00:00Z",
    });
    await insertShift(c, {
      id: LATE_SHIFT,
      start: "2026-11-03T14:00:00Z",
      end: "2026-11-03T22:00:00Z",
    });
    await insertShift(c, {
      id: OPEN_SHIFT,
      start: "2026-11-04T08:00:00Z",
      end: "2026-11-04T20:00:00Z",
    });
    await assign(c, DAY_SHIFT, a.carer, ASSIGNMENT);
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("the rota schema is in step with packages/domain", () => {
  it("lists the shift kinds", () => {
    expect([...SHIFT_KIND_CODES]).toEqual([...SHIFT_KINDS]);
  });
});

describe("hazard HZ-011 rotas stay in their organisation", () => {
  it("never shows another organisation's rows", async () => {
    const seen = await asOtherTenant(async (c) => ({
      rotas: await count(c, "SELECT count(*) AS n FROM rota"),
      shifts: await count(c, "SELECT count(*) AS n FROM shift"),
      assignments: await count(c, "SELECT count(*) AS n FROM shift_assignment"),
      templates: await count(c, "SELECT count(*) AS n FROM shift_template"),
      overrides: await count(c, "SELECT count(*) AS n FROM roster_override"),
      publications: await count(c, "SELECT count(*) AS n FROM rota_publication"),
    }));
    expect(seen).toEqual({
      rotas: 0,
      shifts: 0,
      assignments: 0,
      templates: 0,
      overrides: 0,
      publications: 0,
    });
  });

  it("refuses a rota at another organisation's location", async () => {
    await expect(
      asOtherTenant((c) =>
        c.query(
          `INSERT INTO rota (location_id, starts_on, ends_on) VALUES ($1, '2026-12-01', '2026-12-07')`,
          [a.locationNorth],
        ),
      ),
    ).rejects.toThrow();
  });
});

describe("who reads and builds a rota (scheduling.md section 3)", () => {
  it("lets the holders at North read North's rota but not South's", async () => {
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM rota"))).toBe(1);
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM shift"))).toBe(3);
  });

  it("refuses a shift on South's rota from someone without the permission there", async () => {
    await expect(
      asNorth((c) =>
        insertShift(c, {
          rota: SOUTH_ROTA,
          location: a.locationSouth,
          start: "2026-11-02T08:00:00Z",
          end: "2026-11-02T20:00:00Z",
        }),
      ),
    ).rejects.toThrow(/row-level security|live rota at its location/);
  });

  it("refuses a rota from a care worker", async () => {
    await expect(
      asCarer((c) =>
        c.query(
          `INSERT INTO rota (location_id, starts_on, ends_on) VALUES ($1, '2026-12-01', '2026-12-07')`,
          [a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("shows a worker only their own shifts, and only once published", async () => {
    expect(await asCarer((c) => count(c, "SELECT count(*) AS n FROM shift"))).toBe(0);
    await asNorth(async (c) => {
      await c.query("UPDATE shift SET published_at = now() WHERE id IN ($1, $2)", [
        DAY_SHIFT,
        OPEN_SHIFT,
      ]);
      await c.query("UPDATE shift_assignment SET published_at = now() WHERE id = $1", [ASSIGNMENT]);
    });
    const seen = await asCarer(async (c) => ({
      shifts: (await c.query<{ id: string }>("SELECT id FROM shift")).rows.map((r) => r.id),
      assignments: await count(c, "SELECT count(*) AS n FROM shift_assignment"),
      rotas: await count(c, "SELECT count(*) AS n FROM rota"),
      overrides: await count(c, "SELECT count(*) AS n FROM roster_override"),
    }));
    expect(seen).toEqual({ shifts: [DAY_SHIFT], assignments: 1, rotas: 0, overrides: 0 });
  });
});

describe("the rota's own rules in the database", () => {
  it("refuses a rota that overlaps another at the location", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO rota (location_id, starts_on, ends_on) VALUES ($1, '2026-11-08', '2026-11-14')`,
          [a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/do not overlap/);
  });

  it("refuses a shift outside its rota's dates", async () => {
    await expect(
      asNorth((c) =>
        insertShift(c, { start: "2026-11-09T08:00:00Z", end: "2026-11-09T20:00:00Z" }),
      ),
    ).rejects.toThrow(/one of its rota's dates/);
  });

  it("refuses a worker on two shifts at once", async () => {
    await expect(
      asNorth(async (c) => {
        await insertShift(c, {
          id: "0199f300-0000-7000-8000-0000000000c9",
          start: "2026-11-02T19:00:00Z",
          end: "2026-11-03T07:00:00Z",
        });
        await assign(c, "0199f300-0000-7000-8000-0000000000c9", a.carer);
      }),
    ).rejects.toThrow(/two shifts at once/);
  });

  it("refuses a second live assignment on one shift", async () => {
    await expect(asNorth((c) => assign(c, DAY_SHIFT, a.northManager))).rejects.toThrow(
      /shift_assignment_live_key/,
    );
  });

  it("refuses moving a shift to another rota or an assignment to another worker", async () => {
    await expect(
      asNorth((c) =>
        c.query("UPDATE shift SET rota_id = $1 WHERE id = $2", [SOUTH_ROTA, DAY_SHIFT]),
      ),
    ).rejects.toThrow();
    await expect(
      asNorth((c) =>
        c.query("UPDATE shift_assignment SET worker_id = $1 WHERE id = $2", [
          a.manager,
          ASSIGNMENT,
        ]),
      ),
    ).rejects.toThrow(/keeps its shift and worker/);
  });

  it("never deletes a shift; it is cancelled with a reason", async () => {
    await expect(
      asNorth((c) => c.query("DELETE FROM shift WHERE id = $1", [OPEN_SHIFT])),
    ).rejects.toThrow();
    await expect(
      asNorth((c) => c.query("UPDATE shift SET deleted_at = now() WHERE id = $1", [OPEN_SHIFT])),
    ).rejects.toThrow(/shift_cancelled/);
  });
});

describe("hazard HZ-124 overrides of the rostering rule in the database", () => {
  it("hazard HZ-124 refuses an override from someone without scheduling.rota.approve", async () => {
    await expect(asPlanner((c) => override(c, {}))).rejects.toThrow(/row-level security/);
  });

  it("hazard HZ-124 never overrides a missing right to work or a member who is not active", async () => {
    for (const keys of [
      ["right_to_work:lapsed"],
      ["not_active"],
      ["dbs:no_certificate", "right_to_work:none"],
    ]) {
      await expect(asNorth((c) => override(c, { keys }))).rejects.toThrow(
        /roster_override_blockers/,
      );
    }
  });

  it("hazard HZ-124 refuses an override added later to an existing assignment", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO roster_override (assignment_id, location_id, worker_id, blocker_keys, justification)
           VALUES ($1, $2, $3, '{registration}', 'Added after the assignment was made')`,
          [ASSIGNMENT, a.locationNorth, a.carer],
        ),
      ),
    ).rejects.toThrow(/live assignment of its worker/);
  });

  it("hazard HZ-124 refuses an override without a real justification", async () => {
    await expect(asNorth((c) => override(c, { justification: "ok" }))).rejects.toThrow(
      /roster_override_justification/,
    );
  });

  it("hazard HZ-124 refuses an override given in someone else's name", async () => {
    await expect(asNorth((c) => override(c, { by: a.manager }))).rejects.toThrow(
      /row-level security/,
    );
  });

  it("hazard HZ-124 refuses an override about a worker not on the assignment", async () => {
    await expect(asNorth((c) => override(c, { worker: a.manager }))).rejects.toThrow(
      /live assignment of its worker/,
    );
  });

  it("hazard HZ-124 takes a justified override and never changes it", async () => {
    await asNorth((c) => override(c, {}));
    expect(await asPlanner((c) => count(c, "SELECT count(*) AS n FROM roster_override"))).toBe(1);
    await expect(
      asNorth((c) => c.query("UPDATE roster_override SET justification = 'Changed my mind later'")),
    ).rejects.toThrow();
    await expect(asNorth((c) => c.query("DELETE FROM roster_override"))).rejects.toThrow();
  });

  it("hazard HZ-124 refuses an override for oneself", async () => {
    await expect(
      asNorth(async (c) => {
        await insertShift(c, {
          id: "0199f300-0000-7000-8000-0000000000c8",
          start: "2026-11-07T08:00:00Z",
          end: "2026-11-07T20:00:00Z",
        });
        await assign(
          c,
          "0199f300-0000-7000-8000-0000000000c8",
          a.northManager,
          "0199f300-0000-7000-8000-0000000000d2",
        );
        await c.query(
          `INSERT INTO roster_override (assignment_id, location_id, worker_id, blocker_keys, justification)
           VALUES ($1, $2, $3, '{registration}', 'Covering my own shift tonight')`,
          ["0199f300-0000-7000-8000-0000000000d2", a.locationNorth, a.northManager],
        );
      }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("publications are append-only and in the publisher's name", () => {
  const publish = (c: pg.PoolClient, by: string | null = null) =>
    c.query(
      `INSERT INTO rota_publication (rota_id, location_id, published_by, shift_count, open_shift_count,
         override_count, working_time_breaches, working_time_conditionals, staffing, check_digest)
       VALUES ($1, $2, COALESCE($3, app.current_user_id()), 3, 1, 0, 0, 0, '[]', 'digest')`,
      [ROTA, a.locationNorth, by],
    );

  it("records a publication by the builder", async () => {
    await asPlanner((c) => publish(c));
    expect(await asNorth((c) => count(c, "SELECT count(*) AS n FROM rota_publication"))).toBe(1);
  });

  it("refuses one in someone else's name, and any change", async () => {
    await expect(asPlanner((c) => publish(c, a.northManager))).rejects.toThrow(
      /row-level security/,
    );
    await expect(
      asPlanner((c) => c.query("UPDATE rota_publication SET shift_count = 0")),
    ).rejects.toThrow();
  });
});
