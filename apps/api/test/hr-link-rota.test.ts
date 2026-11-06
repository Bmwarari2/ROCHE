import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { OUTBOUND_FIELDS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockThapsusHr } from "../src/integrations/thapsus-hr";
import { outboxHandlers } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * The Thapsus-HR link's rota, clocking and absence (INTG-014, SCHED-002, SCHED-004, SCHED-010;
 * integrations.md section 11; slice 88; hazards HZ-123, HZ-124, HZ-133): absences from Thapsus-HR
 * become read-only copies that raise cover needs and that nobody here edits; shifts and clock
 * events go out with their listed fields only, once, again when changed, cancelled when removed;
 * a copy Thapsus-HR no longer lists stops blocking the rota; rota readers see whether the data is
 * out of date. Invented people only.
 */

let h: Harness;
let mock: MockThapsusHr;
const T = DEMO.tenantId;
const LOC = DEMO.locationId;
const CARER = DEMO.users.carer.id;
const PROJECT = "harbour-test-79";
const SECRET_REF = `projects/${PROJECT}/locations/europe-west2/secrets/harbour_int_${T}_thapsus-hr-webhook`;
const DOMAIN = "thapsus.example.invalid";
const BASE = `https://api.uk.${DOMAIN}`;
const FILE = "0199f300-0000-7000-8000-000000000001";

const as = (who: string) => ({ token: h.tokens[who], tenant: T });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const sync = async () =>
  (await (await send("POST", "/v1/integrations/hr-link/sync", "manager")).json()) as {
    absences: { copied: number; cancelled: number; coverNeeds: number } | null;
    deliveries: { sent: number; cancelled: number; refused: number } | null;
  };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function sql<R = Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [T],
    );
    const result = await client.query(text, values);
    await client.query("COMMIT");
    return result.rows as R[];
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let shiftId = "";
let assignmentId = "";

beforeAll(async () => {
  h = await createHarness({ GCP_PROJECT_ID: PROJECT, THAPSUS_HR_DOMAIN: DOMAIN });
  await sql(
    "INSERT INTO feature_flag (flag_key, enabled) VALUES ('integrations.thapsus_hr', true)",
  );
  await sql(
    `INSERT INTO staff_profile (id, tenant_user_id, location_id, job_title, date_of_birth, starts_on)
     VALUES ($1, $2, $3, 'Care worker', '1990-04-02', '2025-01-06')`,
    [FILE, CARER, LOC],
  );
  mock = new MockThapsusHr({ slug: "demo-care", homeRegion: "uk", apiBaseUrl: BASE }, BASE);
  h.handle.services.hrLink.mocks.set(T, mock);
  mock.employeesById.set("emp_carer", {
    id: "emp_carer",
    employeeNumber: "E100",
    workEmail: DEMO.users.carer.email,
    dateOfBirth: "1990-04-02",
    givenName: "Ada",
    familyName: "Example",
    leavingDate: null,
  } as never);
  mock.locationsList.push({ id: "loc_main", name: "Main house" });
  // A published rota with the carer on a night shift in a week.
  const [rota] = await sql<{ id: string }>(
    "INSERT INTO rota (location_id, starts_on, ends_on, state, published_at) VALUES ($1, $2, $3, 'published', now()) RETURNING id",
    [LOC, inDays(5), inDays(11)],
  );
  const [s] = await sql<{ id: string }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at, break_minutes, published_at)
     VALUES ($1, $2, 'Night', 'work', $3::date + time '20:00', $3::date + time '20:00' + interval '12 hours', 30, now()) RETURNING id`,
    [rota?.id, LOC, inDays(7)],
  );
  shiftId = s?.id as string;
  const [a] = await sql<{ id: string }>(
    "INSERT INTO shift_assignment (shift_id, location_id, worker_id, published_at) VALUES ($1, $2, $3, now()) RETURNING id",
    [shiftId, LOC, CARER],
  );
  assignmentId = a?.id as string;
  const connected = await send("POST", "/v1/integrations/hr-link", "manager", {
    workspaceSlug: "demo-care",
    secretRef: SECRET_REF,
  });
  expect(connected.status).toBe(201);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-133 nothing goes out for a home that is not mapped (section 11.2)", () => {
  it("sends no shift before the home is mapped to a Thapsus-HR location", async () => {
    const r = await sync();
    expect(r.deliveries).toMatchObject({ sent: 0 });
    expect(mock.writes.filter((w) => w.route === "POST /v1/shifts")).toHaveLength(0);
    expect(
      (
        await send("PUT", `/v1/integrations/hr-link/locations/${LOC}`, "manager", {
          hrLocationId: "loc_main",
        })
      ).status,
    ).toBe(204);
  });
});

describe("hazard HZ-133 shifts go out with their listed fields only, once, and again when changed (rules 4, 5 and 7)", () => {
  it("sends the published shift once, with UTC and UK wall-clock times", async () => {
    expect((await sync()).deliveries).toMatchObject({ sent: 1 });
    expect((await sync()).deliveries).toMatchObject({ sent: 0 });
    const shifts = mock.writes.filter((w) => w.route === "POST /v1/shifts");
    expect(shifts).toHaveLength(1);
    const body = shifts[0]?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...OUTBOUND_FIELDS.shift].sort());
    expect(body).toMatchObject({
      harbourRef: assignmentId,
      employeeId: "emp_carer",
      locationId: "loc_main",
    });
  });

  it("sends a changed shift again, and a cancelled one as a cancellation", async () => {
    await sql("UPDATE shift SET break_minutes = 45 WHERE id = $1", [shiftId]);
    expect((await sync()).deliveries).toMatchObject({ sent: 1 });
    await sql(
      "UPDATE shift_assignment SET deleted_at = now(), remove_reason = 'Swapped' WHERE id = $1",
      [assignmentId],
    );
    expect((await sync()).deliveries).toMatchObject({ cancelled: 1 });
    expect((await sync()).deliveries).toMatchObject({ cancelled: 0, sent: 0 });
    expect(mock.writes.filter((w) => w.route === "DELETE /v1/shifts")).toEqual([
      { route: "DELETE /v1/shifts", body: { harbourRef: assignmentId } },
    ]);
    await sql("UPDATE shift_assignment SET deleted_at = NULL, remove_reason = NULL WHERE id = $1", [
      assignmentId,
    ]);
  });

  it("is sent when the rota is published, without waiting for the sync", async () => {
    await sql("UPDATE shift SET break_minutes = 60 WHERE id = $1", [shiftId]);
    const before = mock.writes.length;
    const handler = outboxHandlers({
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger: createLogger("silent"),
      hrLink: h.handle.services.hrLink,
    }).get("scheduling.rota_published");
    await handler?.({
      id: randomUUID(),
      tenantId: T,
      eventType: "scheduling.rota_published",
      aggregateType: "rota",
      aggregateId: randomUUID(),
      payload: {},
    } as never);
    expect(mock.writes.length).toBe(before + 1);
  });
});

describe("hazard HZ-133 clock events go out in and out only, never a position (rule 4)", () => {
  it("sends each in and out once and keeps breaks here", async () => {
    for (const kind of ["in", "break_start", "out"]) {
      await sql(
        "INSERT INTO clock_event (id, worker_id, kind, location_id, device_time) VALUES ($1, $2, $3, $4, now())",
        [randomUUID(), CARER, kind, LOC],
      );
    }
    await sync();
    await sync();
    const clocks = mock.writes.filter((w) => w.route === "POST /v1/clock/events");
    expect(clocks.map((w) => (w.body as { kind: string }).kind).sort()).toEqual(["in", "out"]);
    for (const w of clocks) {
      expect(Object.keys(w.body as object).sort()).toEqual([...OUTBOUND_FIELDS.clock_event].sort());
    }
  });
});

describe("hazard HZ-123 an absence from Thapsus-HR blocks the rota and raises cover (rule 10)", () => {
  it("copies an approved sickness as read-only, dates and type only, and raises a cover need", async () => {
    mock.absencesList.push({
      id: "abs_1",
      employeeId: "emp_carer",
      type: "sickness",
      startsOn: inDays(6),
      endsOn: inDays(8),
      status: "approved",
      reason: "Not to be copied",
      fitNote: "Not to be copied",
    });
    const r = await sync();
    expect(r.absences).toMatchObject({ copied: 1, coverNeeds: 1 });
    const rows = await sql<{ kind: string; state: string; source: string; member_id: string }>(
      "SELECT kind, state, source, member_id FROM absence WHERE hr_id = 'abs_1'",
    );
    expect(rows).toEqual([
      { kind: "sickness", state: "recorded", source: "thapsus_hr", member_id: CARER },
    ]);
    expect(JSON.stringify(await sql("SELECT * FROM absence WHERE hr_id = 'abs_1'"))).not.toMatch(
      /Not to be copied/,
    );
    const needs = await sql(
      "SELECT 1 FROM shift_cover_need WHERE assignment_id = $1 AND resolved_at IS NULL",
      [assignmentId],
    );
    expect(needs).toHaveLength(1);
    expect((await sync()).absences).toMatchObject({ copied: 0, coverNeeds: 0 });
  });

  it("never lets a person here change a Thapsus-HR copy", async () => {
    const [row] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM absence WHERE hr_id = 'abs_1'",
    );
    const r = await send("POST", `/v1/absences/${row?.id}/cancel`, "manager", {
      expectedVersion: row?.version,
      reason: "Recorded twice by mistake",
    });
    expect([403, 404, 409, 422]).toContain(r.status);
    const [after] = await sql<{ state: string }>("SELECT state FROM absence WHERE hr_id = 'abs_1'");
    expect(after?.state).toBe("recorded");
  });

  it("cancels the copy and resolves its cover need when Thapsus-HR stops listing it (drift)", async () => {
    mock.absencesList.length = 0;
    expect((await sync()).absences).toMatchObject({ cancelled: 1 });
    const [after] = await sql<{ state: string }>("SELECT state FROM absence WHERE hr_id = 'abs_1'");
    expect(after?.state).toBe("cancelled");
    const open = await sql(
      "SELECT 1 FROM shift_cover_need WHERE assignment_id = $1 AND resolved_at IS NULL",
      [assignmentId],
    );
    expect(open).toHaveLength(0);
  });
});

describe("hazard HZ-133 rota readers see when the HR platform's data is out of date (rule 9)", () => {
  type S = { linked: boolean; stale: boolean; lastGoodSyncAt: string | null };
  const staleness = async (who: string) =>
    (await (await send("GET", "/v1/integrations/hr-link/staleness", who)).json()) as S;

  it("says fresh after a good sync, and stale once the older of employees and absences is past the limit", async () => {
    await sync();
    expect(await staleness("manager")).toMatchObject({ linked: true, stale: false });
    await sql(
      "UPDATE hr_sync_state SET last_good_sync_at = now() - interval '20 minutes' WHERE kind = 'absences'",
    );
    const stale = await staleness("manager");
    expect(stale.stale).toBe(true);
    expect(stale.lastGoodSyncAt).not.toBeNull();
  });

  it("shows a care worker who reads the rota only whether it is out of date and since when", async () => {
    const r = await send("GET", "/v1/integrations/hr-link/staleness", "carer");
    expect(r.status).toBe(200);
    expect(Object.keys((await r.json()) as object).sort()).toEqual([
      "lastGoodSyncAt",
      "limitMinutes",
      "linked",
      "stale",
    ]);
  });
});
