import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Bank and agency workers through the API (scheduling.md section 15; SCHED-009; ADR-0088; hazards
 * HZ-124 and HZ-011): agencies; registering a worker and the agency's confirmation; booking an open
 * shift under the rostering rule, with the cost; induction; feedback and do not rebook; the AWR
 * clock; cost per agency; and the access window: an agency member reaches nothing outside a booked
 * shift and their own shifts during it.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const { rows } = await client.query(text, params);
    await client.query("COMMIT");
    return rows as T[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const LOC = DEMO.locationId;
const today = () => ukIsoDate(new Date());
const inDays = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

let ash: string;
let agencyId: string;
let workerId: string;
let workerVersion: number;
let rotaId: string;

interface Booking {
  id: string;
  version: number;
  costPence: number;
  inductionDue: boolean;
  status: string;
}

/** An open shift on the rota from `startHours` to `endHours` from now (made directly). */
async function openShift(startHours: number, endHours: number) {
  const [row] = await sql<{ id: string; version: number }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at, break_minutes)
     VALUES ($1, $2, 'Agency cover', 'work', now() + make_interval(hours => $3::int),
       now() + make_interval(hours => $4::int), 30) RETURNING id, version`,
    [rotaId, LOC, startHours, endHours],
  );
  return row as { id: string; version: number };
}

const myShifts = () =>
  h.request(`/v1/me/shifts?from=${inDays(-1)}&to=${inDays(1)}`, {
    token: h.tokens.agency,
    tenant: DEMO.tenantId,
  });

beforeAll(async () => {
  h = await createHarness();
  const [member] = await sql<{ id: string }>(
    "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid'",
  );
  ash = member?.id as string;
  await sql(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1, id, $2 FROM role WHERE key = 'agency_worker' LIMIT 1`,
    [ash, LOC],
  );
  const made = await as("manager", `/v1/locations/${LOC}/rotas`, {
    method: "POST",
    body: { startsOn: inDays(-1), endsOn: inDays(1) },
  });
  rotaId = ((await made.json()) as { id: string }).id;
});
afterAll(async () => {
  await h?.close();
});

describe("agencies and workers", () => {
  it("adds an agency, and refuses a care worker", async () => {
    const body = {
      name: "Example Staffing",
      contactEmail: "bookings@example.invalid",
      defaultChargePencePerHour: 2500,
    };
    expect((await as("carer", "/v1/agencies", { method: "POST", body })).status).toBe(403);
    const made = await as("manager", "/v1/agencies", { method: "POST", body });
    expect(made.status).toBe(201);
    agencyId = ((await made.json()) as { id: string }).id;
  });

  it("refuses to register a member who holds another role", async () => {
    const response = await as("manager", "/v1/agency-workers", {
      method: "POST",
      body: { tenantUserId: DEMO.users.carer.id, kind: "agency", agencyId, roleTitle: "Carer" },
    });
    expect(response.status).toBe(422);
  });

  it("hazard HZ-011 an agency member reaches nothing before they are booked", async () => {
    const register = await as("manager", "/v1/agency-workers", {
      method: "POST",
      body: { tenantUserId: ash, kind: "agency", agencyId, roleTitle: "Care assistant" },
    });
    expect(register.status).toBe(201);
    const worker = (await register.json()) as { id: string; version: number };
    workerId = worker.id;
    workerVersion = worker.version;
    expect((await myShifts()).status).toBe(403);
  });
});

describe("hazard HZ-124 booking applies the rostering rule", () => {
  it("hazard HZ-124 refuses an agency worker with nothing confirmed, never overridable", async () => {
    const shift = await openShift(-1, 4);
    const response = await as("manager", `/v1/shifts/${shift.id}/booking`, {
      method: "POST",
      body: { workerId: ash, version: shift.version },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("right_to_work");
    await sql("UPDATE shift SET deleted_at = now(), cancel_reason = 'Test' WHERE id = $1", [
      shift.id,
    ]);
  });

  it("records the agency's confirmation in the recorder's name", async () => {
    const response = await as("manager", `/v1/agency-workers/${workerId}/confirmation`, {
      method: "PUT",
      body: {
        version: workerVersion,
        dbsConfirmedOn: inDays(-30),
        dbsEnhancedBarred: true,
        rightToWorkConfirmedOn: inDays(-30),
        rightToWorkExpiresOn: null,
        registrationBody: null,
        registrationValidUntil: null,
      },
    });
    expect(response.status).toBe(200);
    const worker = (await response.json()) as { confirmation: { confirmedBy: string } };
    expect(worker.confirmation.confirmedBy).toBe(DEMO.users.manager.id);
  });

  let booking: Booking;
  it("hazard HZ-011 books an open shift with its cost, and opens the worker's access for it", async () => {
    const shift = await openShift(-1, 4);
    const response = await as("manager", `/v1/shifts/${shift.id}/booking`, {
      method: "POST",
      body: { workerId: ash, version: shift.version, bookingRef: "EX-1001" },
    });
    expect(response.status).toBe(201);
    booking = (await response.json()) as Booking;
    expect(booking.costPence).toBe(Math.round(((5 * 60 - 30) * 2500) / 60));
    expect(booking.inductionDue).toBe(true);
    const mine = await myShifts();
    expect(mine.status).toBe(200);
    // Not yet published: the worker does not see it among their shifts.
    expect(((await mine.json()) as { items: unknown[] }).items).toHaveLength(0);
  });

  it("refuses a second booking on a shift that is no longer open", async () => {
    const [row] = await sql<{ shift_id: string; version: number }>(
      "SELECT b.shift_id, s.version FROM agency_booking b JOIN shift s ON s.id = b.shift_id WHERE b.id = $1",
      [booking.id],
    );
    const response = await as("manager", `/v1/shifts/${row?.shift_id}/booking`, {
      method: "POST",
      body: { workerId: ash, version: row?.version },
    });
    expect(response.status).toBe(409);
  });

  it("records an induction, and refuses one with no items", async () => {
    const bad = await as("manager", `/v1/agency-workers/${workerId}/inductions`, {
      method: "POST",
      body: { locationId: LOC, inductedOn: today(), items: [] },
    });
    expect(bad.status).toBe(422);
    const made = await as("manager", `/v1/agency-workers/${workerId}/inductions`, {
      method: "POST",
      body: { locationId: LOC, inductedOn: today(), items: ["fire_exits", "emergency_procedures"] },
    });
    expect(made.status).toBe(201);
  });

  it("shows the AWR clock with the weeks counted and the method", async () => {
    const response = await as("manager", `/v1/agency-workers/${workerId}/awr`);
    expect(response.status).toBe(200);
    const clock = (await response.json()) as {
      qualifyingWeeks: number;
      qualifyingWeeksNeeded: number;
      method: string[];
    };
    expect(clock.qualifyingWeeks).toBe(1);
    expect(clock.qualifyingWeeksNeeded).toBeGreaterThan(1);
    expect(clock.method.join(" ")).toMatch(/regulation 7/);
  });

  it("totals the cost per agency at the location", async () => {
    const response = await as(
      "manager",
      `/v1/locations/${LOC}/agency-costs?from=${inDays(-1)}&to=${inDays(1)}`,
    );
    expect(response.status).toBe(200);
    const cost = (await response.json()) as { totalPence: number; items: { agencyId: string }[] };
    expect(cost.totalPence).toBe(booking.costPence);
    expect(cost.items[0]?.agencyId).toBe(agencyId);
  });

  it("hazard HZ-011 closes the worker's access when the booking is cancelled", async () => {
    const response = await as("manager", `/v1/agency-bookings/${booking.id}/cancel`, {
      method: "POST",
      body: { version: booking.version, reason: "Cover found in house" },
    });
    expect(response.status).toBe(200);
    expect((await myShifts()).status).toBe(403);
  });

  it("marks a worker not to be booked again after do-not-rebook feedback, and refuses the next booking", async () => {
    const feedback = await as("manager", `/v1/agency-workers/${workerId}/feedback`, {
      method: "POST",
      body: {
        bookingId: booking.id,
        kind: "do_not_rebook",
        notes: "Left the floor without handing over",
      },
    });
    expect(feedback.status).toBe(201);
    const audits = await sql<{ detail: string }>(
      "SELECT row_to_json(a)::text AS detail FROM audit_event a WHERE action = 'scheduling.agency_feedback.recorded'",
    );
    expect(audits[0]?.detail).not.toContain("handing over");
    const shift = await openShift(6, 12);
    const response = await as("manager", `/v1/shifts/${shift.id}/booking`, {
      method: "POST",
      body: { workerId: ash, version: shift.version },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("do_not_book");
  });
});
