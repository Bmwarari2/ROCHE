import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { ctx, ids, inContext, seedTwoTenants, TENANT_A, TENANT_B } from "./support/fixtures";

/**
 * Bank and agency workers in the database (scheduling.md section 15; ADR-0088; hazards HZ-124 and
 * HZ-011; migration 0104): cross-tenant denial; who reads and writes; never by the worker; only a
 * member with no other role registered, then flagged and held to the agency worker role; bookings
 * guarded; and the access window: an agency member holds nothing outside a confirmed booking of a
 * live shift, from its start to its end plus the rate table's hours.
 */

let db: TestDatabase;
const a = ids.a;
const b = ids.b;
const app = () => db.pool("harbour_app");
const owner = () => db.pool("harbour_owner");
const asOwner = <T>(tenantId: string, fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(owner(), ctx(tenantId, null, "tenant"), fn);
/** North's rota lead: builds and approves North's rota. */
const asNorth = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.northManager, "locations", [a.locationNorth]), fn);
/** A rota reader at North (scheduling.rota.read only). */
const asReader = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, a.manager, "locations", [a.locationNorth]), fn);
const asOtherTenant = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_B, b.manager, "locations", [b.location]), fn);

const ASH = "0199f400-0000-7000-8000-000000000301";
const AGENCY = "0199f400-0000-7000-8000-0000000000a1";
const WORKER = "0199f400-0000-7000-8000-0000000000b1";
const ROTA = "0199f400-0000-7000-8000-0000000000c1";
const AGENCY_ROLE = "0199f400-0000-7000-8000-000000000503";
const asAsh = <T>(fn: (c: pg.PoolClient) => Promise<T>) =>
  inContext(app(), ctx(TENANT_A, ASH, "assigned"), fn);

const count = async (c: pg.PoolClient, text: string, params: unknown[] = []) =>
  Number((await c.query<{ n: string }>(text, params)).rows[0]?.n);
/** What Ash holds right now: their own role rows and the self permission. */
const ashHolds = () =>
  asAsh(async (c) => ({
    rows: await count(c, "SELECT count(*) AS n FROM role_assignment WHERE tenant_user_id = $1", [
      ASH,
    ]),
    self: (
      await c.query<{ ok: boolean }>(
        "SELECT app.holds_self_permission('scheduling.timesheet.self') AS ok",
      )
    ).rows[0]?.ok,
  }));

/** A shift on North's rota from `startHours` to `endHours` from now, booked for Ash. */
async function book(startHours: number, endHours: number) {
  return asNorth(async (c) => {
    const s = await c.query<{ id: string }>(
      `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at)
       VALUES ($1, $2, 'Agency', 'work', now() + make_interval(hours => $3::int),
         now() + make_interval(hours => $4::int)) RETURNING id`,
      [ROTA, a.locationNorth, startHours, endHours],
    );
    const shiftId = s.rows[0]?.id as string;
    const asg = await c.query<{ id: string }>(
      `INSERT INTO shift_assignment (shift_id, location_id, worker_id) VALUES ($1, $2, $3) RETURNING id`,
      [shiftId, a.locationNorth, ASH],
    );
    const bk = await c.query<{ id: string }>(
      `INSERT INTO agency_booking (shift_id, assignment_id, location_id, worker_id, agency_id, kind,
         charge_pence_per_hour, cost_pence)
       VALUES ($1, $2, $3, $4, $5, 'agency', 2500, 10000) RETURNING id`,
      [shiftId, asg.rows[0]?.id, a.locationNorth, ASH, AGENCY],
    );
    return {
      shiftId,
      assignmentId: asg.rows[0]?.id as string,
      bookingId: bk.rows[0]?.id as string,
    };
  });
}
/** Cancels a booking and takes the worker off the shift, as the API does. */
const cancel = (bookingId: string) =>
  asNorth(async (c) => {
    await c.query(
      `UPDATE shift_assignment SET deleted_at = now(), remove_reason = 'Booking cancelled'
        WHERE id = (SELECT assignment_id FROM agency_booking WHERE id = $1) AND deleted_at IS NULL`,
      [bookingId],
    );
    return c.query(
      "UPDATE agency_booking SET status = 'cancelled', cancelled_at = now(), cancel_reason = 'Not needed' WHERE id = $1",
      [bookingId],
    );
  });

beforeAll(async () => {
  db = await createTestDatabase();
  await seedTwoTenants(owner());
  await inContext(owner(), null, (c) =>
    c.query(
      `INSERT INTO rate_table (key, value, unit, nation, valid_from, source, verification_status)
       VALUES ('access.agency.post_shift_hours', 2, 'hours', 'all', '2000-01-01', 'rates.md', 'master-prompt')`,
    ),
  );
  await asOwner(TENANT_A, async (c) => {
    await c.query(
      `INSERT INTO role (id, key, name, scope_kind, permissions) VALUES
         ('0199f400-0000-7000-8000-000000000501', 'rota_lead', 'Rota lead', 'location',
          '{scheduling.rota.manage,scheduling.rota.approve}'),
         ('0199f400-0000-7000-8000-000000000502', 'rota_reader', 'Rota reader', 'location',
          '{scheduling.rota.read}'),
         ($1, 'agency_worker', 'Agency or bank worker', 'assigned', '{scheduling.timesheet.self}')`,
      [AGENCY_ROLE],
    );
    await c.query(
      `INSERT INTO tenant_user (id, display_name, email, status)
       VALUES ($1, 'Ash Agency', 'ash.agency@example.invalid', 'active')`,
      [ASH],
    );
    await c.query(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES
         ($1, '0199f400-0000-7000-8000-000000000501', $4),
         ($2, '0199f400-0000-7000-8000-000000000502', $4),
         ($3, $5, $4)`,
      [a.northManager, a.manager, ASH, a.locationNorth, AGENCY_ROLE],
    );
  });
  await asNorth(async (c) => {
    await c.query(
      `INSERT INTO agency (id, name, contact_email) VALUES ($1, 'Example Staffing', 'bookings@example.invalid')`,
      [AGENCY],
    );
    await c.query(
      `INSERT INTO rota (id, location_id, starts_on, ends_on)
       VALUES ($1, $2, (now() AT TIME ZONE 'Europe/London')::date - 2,
         (now() AT TIME ZONE 'Europe/London')::date + 3)`,
      [ROTA, a.locationNorth],
    );
  });
});

afterAll(async () => {
  await db?.drop();
});

describe("registering bank and agency workers", () => {
  it("refuses a member who holds another role", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO agency_worker (tenant_user_id, kind, agency_id, role_title) VALUES ($1, 'agency', $2, 'Carer')`,
          [a.manager, AGENCY],
        ),
      ),
    ).rejects.toThrow(/no role but agency/);
  });

  it("refuses a confirmation recorded in someone else's name", async () => {
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO agency_worker (tenant_user_id, kind, agency_id, role_title, confirmed_by)
           VALUES ($1, 'agency', $2, 'Carer', $3)`,
          [ASH, AGENCY, a.manager],
        ),
      ),
    ).rejects.toThrow(/own name/);
  });

  it("registers an agency-only member, flags them and holds them to the agency worker role", async () => {
    await asNorth((c) =>
      c.query(
        `INSERT INTO agency_worker (id, tenant_user_id, kind, agency_id, role_title, dbs_confirmed_on,
           dbs_enhanced_barred, right_to_work_confirmed_on, confirmed_by)
         VALUES ($1, $2, 'agency', $3, 'Carer', '2026-10-01', true, '2026-10-01', $4)`,
        [WORKER, ASH, AGENCY, a.northManager],
      ),
    );
    const [flag] = (
      await asOwner(TENANT_A, (c) =>
        c.query<{ is_agency: boolean }>("SELECT is_agency FROM tenant_user WHERE id = $1", [ASH]),
      )
    ).rows;
    expect(flag?.is_agency).toBe(true);
    await expect(
      asOwner(TENANT_A, (c) =>
        c.query(
          `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
           VALUES ($1, '0199f400-0000-7000-8000-000000000501', $2)`,
          [ASH, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/only the agency worker role/);
  });

  it("refuses an agency worker without an agency, or a bank worker with one", async () => {
    await expect(
      asNorth((c) => c.query(`UPDATE agency_worker SET kind = 'bank' WHERE id = $1`, [WORKER])),
    ).rejects.toThrow();
  });
});

describe("hazard HZ-011 agency access comes only from a booked shift (ADR-0088)", () => {
  it("hazard HZ-011 gives an agency member nothing with no booking", async () => {
    expect(await ashHolds()).toEqual({ rows: 0, self: false });
  });

  it("hazard HZ-011 opens from the start of a booked shift", async () => {
    const { bookingId } = await book(-1, 4);
    expect(await ashHolds()).toEqual({ rows: 1, self: true });
    await cancel(bookingId);
    expect(await ashHolds()).toEqual({ rows: 0, self: false });
  });

  it("hazard HZ-011 stays open for the rate table's hours after the shift ends, and no longer", async () => {
    const recent = await book(-10, -1);
    expect(await ashHolds()).toEqual({ rows: 1, self: true });
    await cancel(recent.bookingId);
    const older = await book(-14, -3);
    expect(await ashHolds()).toEqual({ rows: 0, self: false });
    await cancel(older.bookingId);
  });

  it("hazard HZ-011 does not open before the shift starts", async () => {
    const later = await book(2, 10);
    expect(await ashHolds()).toEqual({ rows: 0, self: false });
    await cancel(later.bookingId);
  });

  it("hazard HZ-011 closes when the shift is cancelled", async () => {
    const { shiftId, bookingId } = await book(-1, 4);
    expect((await ashHolds()).self).toBe(true);
    await asNorth((c) =>
      c.query("UPDATE shift SET deleted_at = now(), cancel_reason = 'Not needed' WHERE id = $1", [
        shiftId,
      ]),
    );
    expect((await ashHolds()).self).toBe(false);
    await expect(cancel(bookingId)).resolves.toBeDefined();
  });

  it("leaves other members' roles alone", async () => {
    const rows = await asNorth((c) =>
      count(c, "SELECT count(*) AS n FROM role_assignment WHERE tenant_user_id = $1", [
        a.northManager,
      ]),
    );
    expect(rows).toBe(1);
  });
});

describe("bookings, inductions and feedback", () => {
  it("hazard HZ-011 never shows another organisation's rows", async () => {
    const seen = await asOtherTenant(async (c) => ({
      agencies: await count(c, "SELECT count(*) AS n FROM agency"),
      workers: await count(c, "SELECT count(*) AS n FROM agency_worker"),
      bookings: await count(c, "SELECT count(*) AS n FROM agency_booking"),
    }));
    expect(seen).toEqual({ agencies: 0, workers: 0, bookings: 0 });
  });

  it("refuses a booking that is not its worker's live assignment", async () => {
    await expect(
      asNorth(async (c) => {
        const s = await c.query<{ id: string }>(
          `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at)
           VALUES ($1, $2, 'Day', 'work', now() + interval '30 hours', now() + interval '38 hours') RETURNING id`,
          [ROTA, a.locationNorth],
        );
        const asg = await c.query<{ id: string }>(
          `INSERT INTO shift_assignment (shift_id, location_id, worker_id) VALUES ($1, $2, $3) RETURNING id`,
          [s.rows[0]?.id, a.locationNorth, a.carer],
        );
        await c.query(
          `INSERT INTO agency_booking (shift_id, assignment_id, location_id, worker_id, agency_id, kind,
             charge_pence_per_hour, cost_pence) VALUES ($1, $2, $3, $4, $5, 'agency', 2500, 0)`,
          [s.rows[0]?.id, asg.rows[0]?.id, a.locationNorth, ASH, AGENCY],
        );
      }),
    ).rejects.toThrow(/live assignment of its worker/);
  });

  it("keeps a cancelled booking cancelled", async () => {
    const { bookingId } = await book(20, 28);
    await cancel(bookingId);
    await expect(
      asNorth((c) =>
        c.query(
          "UPDATE agency_booking SET status = 'confirmed', cancelled_at = NULL, cancel_reason = NULL WHERE id = $1",
          [bookingId],
        ),
      ),
    ).rejects.toThrow(/stays cancelled/);
  });

  it("refuses a booking of a worker marked do not book", async () => {
    await asNorth((c) =>
      c.query(
        "UPDATE agency_worker SET do_not_book = true, do_not_book_reason = 'Concerns raised' WHERE id = $1",
        [WORKER],
      ),
    );
    await expect(book(30, 38)).rejects.toThrow(/not to be booked/);
    await asNorth((c) =>
      c.query(
        "UPDATE agency_worker SET do_not_book = false, do_not_book_reason = NULL WHERE id = $1",
        [WORKER],
      ),
    );
  });

  it("records inductions and feedback in the recorder's name, never the worker's, never changed", async () => {
    const { bookingId } = await book(40, 48);
    await asNorth((c) =>
      c.query(
        `INSERT INTO location_induction (worker_id, location_id, inducted_on, items)
         VALUES ($1, $2, current_date, '{fire_exits,emergency_procedures}')`,
        [ASH, a.locationNorth],
      ),
    );
    await asNorth((c) =>
      c.query(
        `INSERT INTO agency_worker_feedback (worker_id, booking_id, location_id, kind, notes)
         VALUES ($1, $2, $3, 'positive', 'Settled in well')`,
        [ASH, bookingId, a.locationNorth],
      ),
    );
    await expect(
      asNorth((c) => c.query("UPDATE agency_worker_feedback SET notes = 'Changed'")),
    ).rejects.toThrow();
    await expect(
      asNorth((c) =>
        c.query(
          `INSERT INTO location_induction (worker_id, location_id, inducted_on, items)
           VALUES ($1, $2, current_date, '{fire_exits}')`,
          [a.northManager, a.locationNorth],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("lets a rota reader see bookings and inductions but not feedback", async () => {
    const seen = await asReader(async (c) => ({
      bookings: await count(c, "SELECT count(*) AS n FROM agency_booking"),
      inductions: await count(c, "SELECT count(*) AS n FROM location_induction"),
      feedback: await count(c, "SELECT count(*) AS n FROM agency_worker_feedback"),
    }));
    expect(seen.bookings).toBeGreaterThan(0);
    expect(seen.inductions).toBe(1);
    expect(seen.feedback).toBe(0);
  });

  it("refuses agency writes from a rota reader", async () => {
    await expect(
      asReader((c) => c.query(`INSERT INTO agency (name) VALUES ('Another agency')`)),
    ).rejects.toThrow(/row-level security/);
  });
});
