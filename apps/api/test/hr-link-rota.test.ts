import { randomUUID } from "node:crypto";
import { DEMO } from "@harbour/db/seed";
import { OUTBOUND_FIELDS } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { deliveryKey } from "../src/integrations/hr-rota";
import { MockThapsusHr } from "../src/integrations/thapsus-hr";
import { outboxHandlers } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

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
    expect(body.role).toBe("Care worker");
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

  it("hazard HZ-133 raises a not-found cancellation for review when Thapsus-HR never acknowledged the shift", async () => {
    const cancel = mock.cancelShift.bind(mock);
    mock.cancelShift = async () => ({ ok: false, error: "not_found" }) as never;
    try {
      // As if the create's answer was lost: no Thapsus-HR id, the attempt failed.
      await sql(
        "UPDATE hr_delivery SET state = 'failed', hr_id = NULL, sent_at = NULL WHERE harbour_ref = $1",
        [assignmentId],
      );
      await sql(
        "UPDATE shift_assignment SET deleted_at = now(), remove_reason = 'Swapped' WHERE id = $1",
        [assignmentId],
      );
      expect((await sync()).deliveries).toMatchObject({ cancelled: 0, refused: 1 });
      const [row] = await sql<{ state: string }>(
        "SELECT state FROM hr_delivery WHERE harbour_ref = $1",
        [assignmentId],
      );
      expect(row?.state).toBe("refused");
      const alert = await sql(
        "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.delivery_refused' AND source_id = $1",
        [assignmentId],
      );
      expect(alert).toHaveLength(1);
    } finally {
      mock.cancelShift = cancel;
      await sql(
        "UPDATE shift_assignment SET deleted_at = NULL, remove_reason = NULL WHERE id = $1",
        [assignmentId],
      );
      // Sent again from scratch for the tests that follow.
      await sql("UPDATE hr_delivery SET payload_sha256 = repeat('d', 64) WHERE harbour_ref = $1", [
        assignmentId,
      ]);
      await sync();
    }
  });

  it("hazard HZ-133 takes a cancellation Thapsus-HR answers not found as done, never retried every run", async () => {
    const cancel = mock.cancelShift.bind(mock);
    let calls = 0;
    mock.cancelShift = async () => {
      calls += 1;
      return { ok: false, error: "not_found" } as never;
    };
    try {
      await sql(
        "UPDATE shift_assignment SET deleted_at = now(), remove_reason = 'Swapped' WHERE id = $1",
        [assignmentId],
      );
      // Sent again first, so the cancellation is a new attempt.
      await sql("UPDATE hr_delivery SET payload_sha256 = repeat('c', 64) WHERE harbour_ref = $1", [
        assignmentId,
      ]);
      expect((await sync()).deliveries).toMatchObject({ cancelled: 1 });
      await sync();
      expect(calls).toBe(1);
    } finally {
      mock.cancelShift = cancel;
      await sql(
        "UPDATE shift_assignment SET deleted_at = NULL, remove_reason = NULL WHERE id = $1",
        [assignmentId],
      );
    }
  });

  it("sends a shift that goes back to an earlier version with a new key, never a replay", async () => {
    const keys = () =>
      sql<{ idempotency_key: string }>(
        "SELECT idempotency_key FROM hr_delivery WHERE kind = 'shift' AND harbour_ref = $1",
        [assignmentId],
      );
    await sql("UPDATE shift SET break_minutes = 20 WHERE id = $1", [shiftId]);
    await sync();
    const first = (await keys())[0]?.idempotency_key;
    await sql("UPDATE shift SET break_minutes = 25 WHERE id = $1", [shiftId]);
    await sync();
    await sql("UPDATE shift SET break_minutes = 20 WHERE id = $1", [shiftId]);
    const before = mock.writes.length;
    await sync();
    expect((await keys())[0]?.idempotency_key).not.toBe(first);
    expect(mock.writes.length).toBe(before + 1);
    const last = mock.writes.at(-1)?.body as { breakMinutes: number };
    expect(last.breakMinutes).toBe(20);
  });

  it("retries a failed change with the same key while no other send has succeeded", async () => {
    const key = async () =>
      (
        await sql<{ idempotency_key: string }>(
          "SELECT idempotency_key FROM hr_delivery WHERE kind = 'shift' AND harbour_ref = $1",
          [assignmentId],
        )
      )[0]?.idempotency_key;
    const upsert = mock.upsertShift.bind(mock);
    const used: string[] = [];
    mock.upsertShift = async (_shift, k) => {
      used.push(k);
      return { ok: false, error: "unavailable" } as never;
    };
    try {
      await sql("UPDATE shift SET break_minutes = 35 WHERE id = $1", [shiftId]);
      await sync();
      await sync();
    } finally {
      mock.upsertShift = upsert;
    }
    expect(used).toHaveLength(2);
    expect(used[1]).toBe(used[0]);
    await sync();
    expect(await key()).toBe(used[0]);
  });

  it("never repeats a key after two lost answers and a return to the first change", async () => {
    const upsert = mock.upsertShift.bind(mock);
    const used: string[] = [];
    // Thapsus-HR applies each change, but its answer is lost on the way back.
    mock.upsertShift = async (s, k) => {
      used.push(k);
      await upsert(s, k);
      return { ok: false, error: "unavailable" } as never;
    };
    try {
      await sql("UPDATE shift SET break_minutes = 40 WHERE id = $1", [shiftId]);
      await sync();
      await sql("UPDATE shift SET break_minutes = 45 WHERE id = $1", [shiftId]);
      await sync();
    } finally {
      mock.upsertShift = upsert;
    }
    await sql("UPDATE shift SET break_minutes = 40 WHERE id = $1", [shiftId]);
    const before = mock.writes.length;
    await sync();
    const [row] = await sql<{ idempotency_key: string; state: string }>(
      "SELECT idempotency_key, state FROM hr_delivery WHERE kind = 'shift' AND harbour_ref = $1",
      [assignmentId],
    );
    expect(used).toHaveLength(2);
    expect(used).not.toContain(row?.idempotency_key);
    expect(row?.state).toBe("sent");
    // Applied again, not answered from the replay store: Thapsus-HR now holds 40, not 45.
    expect(mock.writes.length).toBe(before + 1);
    const last = mock.writes.at(-1)?.body as { breakMinutes: number } | undefined;
    expect(last?.breakMinutes).toBe(40);
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
    } as never);
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
      version: row?.version,
      reason: "Recorded twice by mistake",
    });
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("managed_in_thapsus_hr");
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

describe("hazard HZ-133 many copies dropping out at once are held until a person releases them (rule 13)", () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `held_${i + 1}`);
  const release = (expectedHrIds: string[], who = "manager", reason = "checked_in_hr_platform") =>
    send("POST", "/v1/integrations/hr-link/absences/release", who, { expectedHrIds, reason });
  const states = async () =>
    (
      await sql<{ hr_id: string; state: string }>(
        "SELECT hr_id, state FROM absence WHERE hr_id LIKE 'held_%' ORDER BY hr_id",
      )
    ).map((r) => r.state);

  it("holds current copies, still blocking, but lets one already over go at once", async () => {
    for (let i = 1; i <= 7; i++) {
      await sql(
        `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state, source, hr_id)
         VALUES ($1, $2, 'annual_leave', $3, $4, 'recorded', 'thapsus_hr', $5)`,
        [CARER, LOC, inDays(20 + i * 3), inDays(21 + i * 3), `held_${i}`],
      );
    }
    await sql(
      `INSERT INTO absence (member_id, location_id, kind, starts_on, ends_on, state, source, hr_id)
       VALUES ($1, $2, 'annual_leave', $3, $4, 'recorded', 'thapsus_hr', 'old_1')`,
      [CARER, LOC, inDays(-6), inDays(-4)],
    );
    mock.absencesList.length = 0;
    const r = (await sync()).absences as unknown as { held: number; cancelled: number };
    expect(r).toMatchObject({ held: 7, cancelled: 1, error: "drift_held" });
    expect(await states()).toEqual(Array(7).fill("recorded"));
    const [old] = await sql<{ state: string }>("SELECT state FROM absence WHERE hr_id = 'old_1'");
    expect(old?.state).toBe("cancelled");
    const alert = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.absence_drift_held' AND status = 'open' AND required_permission = 'integrations.hr_link.manage'",
    );
    expect(alert).toHaveLength(1);
    // Held again on the next run, not released by it.
    expect(((await sync()).absences as unknown as { held: number }).held).toBe(7);
  });

  it("lists the held copies a release would cancel, read again now, changing nothing (slice 90)", async () => {
    const r = await send("GET", "/v1/integrations/hr-link/absences/held", "manager");
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      mode: string;
      items: { hrId: string; kind: string; startsOn: string; endsOn: string | null }[];
      error: string | null;
    };
    expect(body.mode).toBe("drift");
    expect(body.error).toBeNull();
    expect(body.items.map((i) => i.hrId)).toEqual(ids(7));
    expect(body.items[0]).toEqual({
      hrId: "held_1",
      memberId: CARER,
      kind: "annual_leave",
      startsOn: inDays(23),
      endsOn: inDays(24),
    });
    expect(await states()).toEqual(Array(7).fill("recorded"));
    // A copy shows where it is kept, so the absence screen says it is managed in the HR platform.
    const listed = (await (
      await send("GET", `/v1/absences?locationId=${LOC}&from=${inDays(0)}`, "manager")
    ).json()) as { items: { source: string }[] };
    expect(listed.items.length).toBeGreaterThan(0);
    expect(listed.items.every((i) => i.source === "thapsus_hr")).toBe(true);
    expect((await send("GET", "/v1/integrations/hr-link/absences/held", "carer")).status).toBe(403);
  });

  it("hazard HZ-133 lists the held copies only after a fresh step-up, a few times a minute, audited", async () => {
    const session = h.tokens.manager?.split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), session, 3_600);
    try {
      expect((await send("GET", "/v1/integrations/hr-link/absences/held", "manager")).status).toBe(
        403,
      );
    } finally {
      await ageSession(h.db.pool("harbour_auth"), session, 0);
    }
    const viewed = await sql(
      "SELECT 1 FROM audit_event WHERE action = 'integrations.hr_link.held_viewed'",
    );
    expect(viewed.length).toBeGreaterThan(0);
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      // Another person's allowance, so the manager's later reads here are not limited.
      statuses.push((await send("GET", "/v1/integrations/hr-link/absences/held", "owner")).status);
    }
    expect(statuses).toContain(429);
  });

  it("refuses ending every copy while the link is connected but turned off", async () => {
    await sql("UPDATE feature_flag SET enabled = false WHERE flag_key = 'integrations.thapsus_hr'");
    try {
      const r = await send("POST", "/v1/integrations/hr-link/absences/release", "manager", {
        expectedHrIds: ["abs_1"],
        reason: "link_ended",
      });
      expect(r.status).toBe(409);
      expect(((await r.json()) as { code: string }).code).toBe("hr_link_off_while_connected");
    } finally {
      await sql(
        "UPDATE feature_flag SET enabled = true WHERE flag_key = 'integrations.thapsus_hr'",
      );
    }
  });

  it("refuses someone without the link's manage permission", async () => {
    expect((await release(ids(7), "carer")).status).toBe(403);
  });

  it("releases nothing when the copies the person saw are no longer the ones held", async () => {
    const r = await release([...ids(6), "held_9"]);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { code: string }).code).toBe("hr_link_drift_changed");
    expect(await states()).toEqual(Array(7).fill("recorded"));
  });

  it("releases the held copies, re-read from Thapsus-HR, audited, and closes the alert", async () => {
    // One came back in the meantime: it is kept, and the person's number no longer matches.
    mock.absencesList.push({
      id: "held_7",
      employeeId: "emp_carer",
      type: "annual_leave",
      startsOn: inDays(41),
      endsOn: inDays(42),
      status: "approved",
    } as never);
    expect((await release(ids(7))).status).toBe(409);
    const held = (await (
      await send("GET", "/v1/integrations/hr-link/absences/held", "manager")
    ).json()) as { items: { hrId: string }[] };
    expect(held.items.map((i) => i.hrId)).toEqual(ids(6));
    expect((await release(ids(6), "manager", "link_ended")).status).toBe(422);
    const r = await release(ids(6));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ released: 6, mode: "drift" });
    expect(await states()).toEqual([...Array(6).fill("cancelled"), "recorded"]);
    const done = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.absence_drift_held' AND status = 'done' AND completed_by IS NOT NULL",
    );
    expect(done).toHaveLength(1);
    const audited = await sql(
      "SELECT 1 FROM audit_event WHERE action = 'integrations.hr_link.drift_released' AND resource_type = 'absence'",
    );
    expect(audited).toHaveLength(6);
    mock.absencesList.length = 0;
    await sync();
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

describe("hazard HZ-133 nothing goes to or comes from a workspace no longer in the UK (rule 1)", () => {
  it("sends no shift and takes no absence while the workspace says it is elsewhere", async () => {
    const workspace = mock.workspaceInfo as { homeRegion: string };
    workspace.homeRegion = "eu";
    await sql("UPDATE shift SET break_minutes = 15 WHERE id = $1", [shiftId]);
    const before = mock.writes.length;
    try {
      const r = await sync();
      expect(r.deliveries).toBeNull();
      expect(r.absences).toBeNull();
      expect(mock.writes.length).toBe(before);
    } finally {
      workspace.homeRegion = "uk";
    }
  });
});

describe("hazard HZ-123 absences that keep blocking whatever goes wrong (rule 10)", () => {
  it("keeps open-ended leave blocking until Thapsus-HR ends it", async () => {
    mock.absencesList.push({
      id: "abs_open",
      employeeId: "emp_carer",
      type: "leave",
      startsOn: inDays(6),
      status: "approved",
    } as never);
    await sync();
    const [row] = await sql<{ ends_on: string | null; state: string }>(
      "SELECT ends_on, state FROM absence WHERE hr_id = 'abs_open' AND state <> 'cancelled'",
    );
    expect(row).toEqual({ ends_on: null, state: "recorded" });
  });

  it("never frees a member because a later version of their absence could not be read", async () => {
    const entry = mock.absencesList.find((a) => a.id === "abs_open") as Record<string, unknown>;
    entry.endsOn = inDays(2); // before its start: not readable
    try {
      const r = await sync();
      expect(r.absences).toMatchObject({ cancelled: 0, error: "record_failed" });
      const [row] = await sql<{ state: string }>(
        "SELECT state FROM absence WHERE hr_id = 'abs_open' AND state <> 'cancelled'",
      );
      expect(row?.state).toBe("recorded");
      const tasks = await sql(
        "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.absence_record_failed' AND status = 'open'",
      );
      expect(tasks).toHaveLength(1);
    } finally {
      delete entry.endsOn;
    }
  });

  it("copies an absence of a type it does not know, still blocking, and says so", async () => {
    mock.absencesList.push({
      id: "abs_unknown",
      employeeId: "emp_carer",
      type: "suspension",
      startsOn: inDays(20),
      endsOn: inDays(22),
      status: "approved",
    } as never);
    await sync();
    const [row] = await sql<{ kind: string }>(
      "SELECT kind FROM absence WHERE hr_id = 'abs_unknown' AND state = 'recorded'",
    );
    expect(row?.kind).toBe("other");
    const tasks = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.absence_type_unknown' AND status = 'open'",
    );
    expect(tasks).toHaveLength(1);
  });

  it("raises an approved absence for someone whose match is not confirmed, never copying it", async () => {
    mock.employeesById.set("emp_unmatched", {
      id: "emp_unmatched",
      employeeNumber: null,
      workEmail: "nobody@example.invalid",
      dateOfBirth: "1970-01-01",
      givenName: "Ada",
      familyName: "Example",
      leavingDate: null,
    } as never);
    mock.absencesList.push({
      id: "abs_unconfirmed",
      employeeId: "emp_unmatched",
      type: "sickness",
      startsOn: inDays(3),
      status: "approved",
    } as never);
    await sync();
    expect(await sql("SELECT 1 FROM absence WHERE hr_id = 'abs_unconfirmed'")).toHaveLength(0);
    const tasks = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.absence_unconfirmed' AND status = 'open'",
    );
    expect(tasks).toHaveLength(1);
  });
});

describe("hazard HZ-133 a retry is the same request (rule 5)", () => {
  it("gives the same key for the same record and payload, and another for a change", () => {
    const a = deliveryKey("shift", "ref-1", "a".repeat(64));
    expect(deliveryKey("shift", "ref-1", "a".repeat(64))).toBe(a);
    expect(deliveryKey("shift", "ref-1", "b".repeat(64))).not.toBe(a);
    expect(deliveryKey("clock_event", "ref-1", "a".repeat(64))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("hazard HZ-133 the rota still says so when the link stops but its absences remain (rule 9)", () => {
  it("shows the note after a disconnect while copies still shape the rota", async () => {
    expect((await send("DELETE", "/v1/integrations/hr-link", "manager")).status).toBe(204);
    const r = (await (
      await send("GET", "/v1/integrations/hr-link/staleness", "manager")
    ).json()) as {
      linked: boolean;
      stale: boolean;
    };
    expect(r).toMatchObject({ linked: true, stale: true });
  });

  it("lets the link's manager end the copies still in force once disconnected", async () => {
    await sql(
      `INSERT INTO absence (member_id, location_id, kind, starts_on, state, source, hr_id)
       VALUES ($1, $2, 'other', $3, 'recorded', 'thapsus_hr', 'after_1')`,
      [CARER, LOC, inDays(60)],
    );
    const live = (
      await sql<{ hr_id: string }>(
        "SELECT hr_id FROM absence WHERE source = 'thapsus_hr' AND state <> 'cancelled'",
      )
    ).map((r) => r.hr_id);
    const held = (await (
      await send("GET", "/v1/integrations/hr-link/absences/held", "manager")
    ).json()) as { mode: string; items: { hrId: string }[] };
    expect(held.mode).toBe("disconnected");
    expect(held.items.map((i) => i.hrId).sort()).toEqual([...live].sort());
    const r = await send("POST", "/v1/integrations/hr-link/absences/release", "manager", {
      expectedHrIds: live,
      reason: "link_ended",
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ released: live.length, mode: "disconnected" });
    const left = await sql(
      "SELECT 1 FROM absence WHERE source = 'thapsus_hr' AND state <> 'cancelled'",
    );
    expect(left).toHaveLength(0);
  });
});
