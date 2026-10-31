import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Time and attendance through the API (scheduling.md section 16; hazards HZ-010, HZ-124, HZ-011):
 * clock events with flags, idempotent; the rule on the day at clock-in, refused online and flagged
 * with a task when late; a clock-out drafting a timesheet with its breaks; approval never by the
 * worker, storing a working time result; corrections superseding; opt-outs on file; clock evidence
 * only with the DPIA; a bank or agency member's late upload accepted and flagged outside their window.
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
const CARER = DEMO.users.carer.id;
const MANAGER = DEMO.users.manager.id;
const OWNER = DEMO.users.owner.id;
const today = () => ukIsoDate(new Date());
const inDays = (n: number) => {
  const d = new Date(`${today()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const hoursFromNow = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

let rotaId: string;

/** A staff file with a verified DBS and right to work (invented details). */
async function staffFile(worker: string) {
  const [profile] = await sql<{ id: string }>(
    `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, date_of_birth, starts_on)
     VALUES ($1, $2, 'Care worker', '1990-05-01', '2025-01-06') RETURNING id`,
    [worker, LOC],
  );
  await sql(
    `INSERT INTO compliance_item (staff_profile_id, kind, detail, verified_on, verified_by) VALUES
       ($1, 'dbs_certificate', $2, '2025-01-02', $4), ($1, 'right_to_work', $3, '2025-01-02', $4)`,
    [
      profile?.id,
      JSON.stringify({
        kind: "dbs_certificate",
        certificate: {
          level: "enhanced_adults_barred",
          issuedOn: "2025-01-01",
          number: "009999999999",
          result: "clear",
        },
        updateService: null,
        barredListClearOn: null,
      }),
      JSON.stringify({
        kind: "right_to_work",
        checks: [
          {
            checkedOn: "2025-01-02",
            permission: "unlimited",
            expiresOn: null,
            method: "online_share_code",
          },
        ],
      }),
      worker === OWNER ? MANAGER : OWNER,
    ],
  );
}

/** A shift on the rota from `startHours` to `endHours` from now, assigned to `worker` if given. */
async function shiftFor(startHours: number, endHours: number, worker: string | null) {
  const [s] = await sql<{ id: string; version: number }>(
    `INSERT INTO shift (rota_id, location_id, label, kind, starts_at, ends_at)
     VALUES ($1, $2, 'Day', 'work', now() + make_interval(hours => $3::int),
       now() + make_interval(hours => $4::int)) RETURNING id, version`,
    [rotaId, LOC, startHours, endHours],
  );
  if (worker) {
    await sql(
      `INSERT INTO shift_assignment (shift_id, location_id, worker_id) VALUES ($1, $2, $3)`,
      [s?.id, LOC, worker],
    );
  }
  return s as { id: string; version: number };
}

const clock = (
  who: string,
  body: { kind: string; shiftId?: string | null; deviceTime?: string; id?: string },
) =>
  h.request("/v1/me/clock-events", {
    method: "POST",
    token: h.tokens[who],
    tenant: DEMO.tenantId,
    body: {
      id: body.id ?? randomUUID(),
      kind: body.kind,
      locationId: LOC,
      shiftId: body.shiftId ?? null,
      deviceTime: body.deviceTime ?? new Date().toISOString(),
    },
  });

interface Entry {
  id: string;
  version: number;
  status: string;
  superseded: boolean;
  breaks: unknown[];
  workedMinutes: number;
}

beforeAll(async () => {
  h = await createHarness();
  const made = await as("manager", `/v1/locations/${LOC}/rotas`, {
    method: "POST",
    body: { startsOn: inDays(-1), endsOn: inDays(1) },
  });
  rotaId = ((await made.json()) as { id: string }).id;
  await staffFile(CARER);
});
afterAll(async () => {
  await h?.close();
});

let entryId: string;

describe("hazard HZ-010 clock events", () => {
  let shiftId: string;
  const eventId = randomUUID();

  it("hazard HZ-010 records a clock-in with both times, and a replay returns it", async () => {
    shiftId = (await shiftFor(-1, 7, CARER)).id;
    const made = await clock("carer", {
      id: eventId,
      kind: "in",
      shiftId,
      deviceTime: hoursFromNow(-0.5),
    });
    expect(made.status).toBe(201);
    const item = (await made.json()) as { flags: string[]; recordedAt: string; deviceTime: string };
    expect(item.flags).toEqual(["late_upload"]);
    const replay = await clock("carer", {
      id: eventId,
      kind: "in",
      shiftId,
      deviceTime: item.deviceTime,
    });
    expect(replay.status).toBe(200);
    const reused = await clock("carer", {
      id: eventId,
      kind: "out",
      shiftId,
      deviceTime: item.deviceTime,
    });
    expect(reused.status).toBe(409);
  });

  it("refuses clocking for a shift that is not the member's", async () => {
    const other = await shiftFor(-1, 7, null);
    expect((await clock("carer", { kind: "in", shiftId: other.id })).status).toBe(422);
  });

  it("flags a clock-in with no shift", async () => {
    const made = await clock("carer", { kind: "break_start", deviceTime: hoursFromNow(0) });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { flags: string[] }).flags).toContain("no_shift");
  });

  it("drafts a timesheet from the clock-out with its breaks", async () => {
    await clock("carer", { kind: "break_end", deviceTime: hoursFromNow(0.25) });
    const out = await clock("carer", { kind: "out", shiftId, deviceTime: hoursFromNow(0.5) });
    expect(out.status).toBe(201);
    const item = (await out.json()) as { timesheetEntryId: string | null };
    expect(item.timesheetEntryId).not.toBeNull();
    entryId = item.timesheetEntryId as string;
    const list = await as(
      "manager",
      `/v1/locations/${LOC}/timesheets?from=${inDays(-1)}&to=${inDays(1)}`,
    );
    const entry = ((await list.json()) as { items: Entry[] }).items.find((e) => e.id === entryId);
    expect(entry?.status).toBe("draft");
    expect(entry?.breaks).toHaveLength(1);
  });
});

describe("hazard HZ-124 the rule on the day at clock-in", () => {
  it("hazard HZ-124 refuses an online clock-in when the right to work has lapsed, and flags a late one with a task", async () => {
    const s = await shiftFor(8, 16, CARER);
    await sql(
      `UPDATE compliance_item SET verified_on = NULL, verified_by = NULL WHERE kind = 'right_to_work'
         AND staff_profile_id = (SELECT id FROM staff_profile WHERE tenant_user_id = $1)`,
      [CARER],
    );
    try {
      const online = await clock("carer", { kind: "in", shiftId: s.id });
      expect(online.status).toBe(422);
      expect(((await online.json()) as { code: string }).code).toBe("not_eligible");
      const late = await clock("carer", {
        kind: "in",
        shiftId: s.id,
        deviceTime: hoursFromNow(-0.5),
      });
      expect(late.status).toBe(201);
      expect(((await late.json()) as { flags: string[] }).flags).toContain("not_eligible");
      const tasks = await sql("SELECT 1 FROM task WHERE kind = 'scheduling.clock_exception'");
      expect(tasks.length).toBeGreaterThan(0);
    } finally {
      await sql(
        `UPDATE compliance_item SET verified_on = '2025-01-02', verified_by = $2 WHERE kind = 'right_to_work'
           AND staff_profile_id = (SELECT id FROM staff_profile WHERE tenant_user_id = $1)`,
        [CARER, OWNER],
      );
    }
  });
});

describe("approval never by the worker, and corrections", () => {
  it("refuses the worker approving their own time", async () => {
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM timesheet_entry WHERE id = $1",
      [entryId],
    );
    const own = await as("carer", `/v1/timesheet-entries/${entryId}/approve`, {
      method: "POST",
      body: { version: row?.version },
    });
    expect(own.status).toBe(403);
  });

  it("approves with a stored working time result, as advice", async () => {
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM timesheet_entry WHERE id = $1",
      [entryId],
    );
    const approved = await as("manager", `/v1/timesheet-entries/${entryId}/approve`, {
      method: "POST",
      body: { version: row?.version },
    });
    expect(approved.status).toBe(200);
    const body = (await approved.json()) as {
      entry: Entry;
      workingTime: { resultId: string; notes: string[] };
    };
    expect(body.entry.status).toBe("approved");
    expect(body.workingTime.notes.join(" ")).toMatch(/advice/);
    const results = await sql("SELECT 1 FROM working_time_result WHERE id = $1", [
      body.workingTime.resultId,
    ]);
    expect(results).toHaveLength(1);
    const events = await sql(
      "SELECT 1 FROM outbox_event WHERE event_type = 'scheduling.timesheet_approved' AND aggregate_id = $1",
      [entryId],
    );
    expect(events).toHaveLength(1);
  });

  it("never changes an approved entry; corrects it by a superseding entry, approved by someone else", async () => {
    const [row] = await sql<{ version: number; started_at: Date; ended_at: Date }>(
      "SELECT version, started_at, ended_at FROM timesheet_entry WHERE id = $1",
      [entryId],
    );
    if (!row) throw new Error("entry missing");
    const fields = {
      kind: "work",
      startedAt: row.started_at.toISOString(),
      endedAt: new Date(row.ended_at.getTime() + 15 * 60_000).toISOString(),
    };
    const patch = await as("manager", `/v1/timesheet-entries/${entryId}`, {
      method: "PATCH",
      body: { version: row?.version, ...fields },
    });
    expect(patch.status).toBe(409);
    const corrected = await as("manager", `/v1/timesheet-entries/${entryId}/corrections`, {
      method: "POST",
      body: { reason: "Stayed for the handover", ...fields },
    });
    expect(corrected.status).toBe(201);
    const correction = (await corrected.json()) as Entry;
    const second = await as("manager", `/v1/timesheet-entries/${entryId}/corrections`, {
      method: "POST",
      body: { reason: "Again", ...fields },
    });
    expect(second.status).toBe(409);
    const approved = await as("owner", `/v1/timesheet-entries/${correction.id}/approve`, {
      method: "POST",
      body: { version: correction.version },
    });
    expect(approved.status).toBe(200);
    const list = await as(
      "manager",
      `/v1/locations/${LOC}/timesheets?from=${inDays(-1)}&to=${inDays(1)}`,
    );
    const items = ((await list.json()) as { items: Entry[] }).items;
    expect(items.find((e) => e.id === entryId)?.superseded).toBe(true);
    expect(items.find((e) => e.id === correction.id)?.superseded).toBe(false);
  });

  it("refuses a manager entering their own time", async () => {
    const response = await as("manager", `/v1/locations/${LOC}/timesheets`, {
      method: "POST",
      body: {
        workerId: MANAGER,
        kind: "work",
        startedAt: hoursFromNow(-10),
        endedAt: hoursFromNow(-2),
      },
    });
    expect(response.status).toBe(403);
  });
});

describe("opt-outs and clock evidence", () => {
  it("records an opt-out from the signed agreement, which the worker can read", async () => {
    const made = await as("manager", `/v1/members/${CARER}/working-time-opt-outs`, {
      method: "POST",
      body: { signedOn: inDays(-10), noticeAmount: 7, noticeUnit: "days" },
    });
    expect(made.status).toBe(201);
    const own = await as("carer", `/v1/members/${CARER}/working-time-opt-outs`);
    expect(own.status).toBe(200);
    expect(((await own.json()) as { items: unknown[] }).items).toHaveLength(1);
    const self = await as("manager", `/v1/members/${MANAGER}/working-time-opt-outs`, {
      method: "POST",
      body: { signedOn: inDays(-10) },
    });
    expect(self.status).toBe(403);
  });

  it("turns on location evidence only with the employee-monitoring DPIA approved (H-527)", async () => {
    const without = await as("manager", `/v1/locations/${LOC}/clock-setting`, {
      method: "PUT",
      body: { version: null, evidence: "at_location" },
    });
    expect(without.status).toBe(422);
    const withDpia = await as("manager", `/v1/locations/${LOC}/clock-setting`, {
      method: "PUT",
      body: { version: null, evidence: "at_location", dpiaApproved: true },
    });
    expect(withDpia.status).toBe(200);
  });
});

describe("hazard HZ-011 bank and agency clock events (ADR-0088)", () => {
  let ash: string;
  let workerId: string;
  beforeAll(async () => {
    const [member] = await sql<{ id: string }>(
      "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid'",
    );
    ash = member?.id as string;
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'agency_worker' LIMIT 1`,
      [ash, LOC],
    );
    const agency = await as("manager", "/v1/agencies", {
      method: "POST",
      body: { name: "Example Staffing", defaultChargePencePerHour: 2500 },
    });
    const agencyId = ((await agency.json()) as { id: string }).id;
    const reg = await as("owner", "/v1/agency-workers", {
      method: "POST",
      body: { tenantUserId: ash, kind: "agency", agencyId, roleTitle: "Care assistant" },
    });
    const worker = (await reg.json()) as { id: string; version: number };
    workerId = worker.id;
    await as("manager", `/v1/agency-workers/${workerId}/confirmation`, {
      method: "PUT",
      body: {
        version: worker.version,
        dbsConfirmedOn: inDays(-30),
        dbsEnhancedBarred: true,
        rightToWorkConfirmedOn: inDays(-30),
        rightToWorkExpiresOn: null,
        registrationBody: null,
        registrationValidUntil: null,
      },
    });
  });

  const book = async (start: number, end: number) => {
    const s = await shiftFor(start, end, null);
    const response = await as("manager", `/v1/shifts/${s.id}/booking`, {
      method: "POST",
      body: { workerId: ash, version: s.version },
    });
    expect(response.status).toBe(201);
    return s.id;
  };

  it("hazard HZ-124 refuses an agency worker's online clock-in with no induction at the location", async () => {
    const shiftId = await book(-1, 6);
    const response = await clock("agency", { kind: "in", shiftId });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe("no_induction");
  });

  it("hazard HZ-011 accepts a late upload after the window closed, flagged, never dropped", async () => {
    await as("manager", `/v1/agency-workers/${workerId}/inductions`, {
      method: "POST",
      body: { locationId: LOC, inductedOn: today(), items: ["fire_exits"] },
    });
    // Cancel the open booking so no window is open now.
    await sql(
      "UPDATE shift SET deleted_at = now(), cancel_reason = 'Test' WHERE label = 'Day' AND starts_at > now() - interval '2 hours' AND starts_at < now()",
    );
    const shiftId = await book(-9, -4);
    const response = await clock("agency", {
      kind: "out",
      shiftId,
      deviceTime: hoursFromNow(-4.1),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { flags: string[] }).flags).toEqual(
      expect.arrayContaining(["late_upload", "outside_access_window"]),
    );
  });

  it("refuses an event outside any booking of theirs", async () => {
    const other = await shiftFor(-1, 6, null);
    expect((await clock("agency", { kind: "in", shiftId: other.id })).status).toBe(422);
  });
});
