import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Pay calculation runs through the API (scheduling.md section 18; HZ-011): rule sets approved by
 * someone else; a run from approved time only, a draft timesheet blocking it; locked by a second
 * person, offered to the export, reproduced from its stored inputs; a member reading their own
 * locked line; a correction showing its difference; an override with a reason. A location's
 * manager sees no pay. Invented people only.
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
  } finally {
    client.release();
  }
}

const LOC = DEMO.locationId;
const CARER = DEMO.users.carer.id;
const OWNER = DEMO.users.owner.id;
const PERIOD = { frequency: "weekly", periodStart: "2026-10-05", periodEnd: "2026-10-11" };

interface Run {
  id: string;
  version: number;
  status: string;
  calculation: number;
  openExceptions: number;
}
interface Detail {
  run: Run;
  lines: {
    id: string;
    memberId: string;
    basicPence: number;
    totalPence: number;
    differencePence: number | null;
    working: { step: string }[];
  }[];
  exceptions: { id: string; version: number; kind: string; status: string; memberId: string }[];
}

/** A manual timesheet entry for the carer, entered by the manager. */
async function enter(start: string, end: string): Promise<{ id: string; version: number }> {
  const made = await as("manager", `/v1/locations/${LOC}/timesheets`, {
    method: "POST",
    body: { workerId: CARER, kind: "work", startedAt: start, endedAt: end },
  });
  expect(made.status).toBe(201);
  return (await made.json()) as { id: string; version: number };
}

const approveEntry = (entry: { id: string; version: number }) =>
  as("owner", `/v1/timesheet-entries/${entry.id}/approve`, {
    method: "POST",
    body: { version: entry.version },
  });

const calculate = async (who: string, run: Run): Promise<Detail> => {
  const response = await as(who, `/v1/pay-runs/${run.id}/calculate`, {
    method: "POST",
    body: { version: run.version },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Detail;
};

let runId: string;
let entryA: { id: string; version: number };

beforeAll(async () => {
  h = await createHarness();
  // Finance (no location scope) for the quality lead: the second person for pay.
  await sql(
    `INSERT INTO role_assignment (tenant_user_id, role_id)
     SELECT $1, id FROM role WHERE key = 'finance' LIMIT 1`,
    [LODGE.qualityLeadId],
  );
  await sql(
    `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, date_of_birth, starts_on)
     VALUES ($1, $2, 'Care worker', '1990-05-01', '2025-01-06')`,
    [CARER, LOC],
  );
});
afterAll(async () => {
  await h?.close();
});

describe("pay rule sets (rule 1)", () => {
  it("is drafted, refused to its author for approval, and approved by someone else", async () => {
    const made = await as("owner", "/v1/pay-rule-sets", {
      method: "POST",
      body: {
        name: "Standard",
        effectiveFrom: "2026-04-06",
        roleRates: { care_worker: 1_350 },
        enhancements: [{ kind: "weekend", mode: "percent", value: 10 }],
        sleepInFlatPence: 5_000,
      },
    });
    expect(made.status).toBe(201);
    const set = (await made.json()) as { id: string; version: number };
    const own = await as("owner", `/v1/pay-rule-sets/${set.id}/approve`, {
      method: "POST",
      body: { version: set.version },
    });
    expect(own.status).toBe(403);
    const other = await as("quality", `/v1/pay-rule-sets/${set.id}/approve`, {
      method: "POST",
      body: { version: set.version },
    });
    expect(other.status).toBe(200);
  });

  it("hazard HZ-011 shows a location's manager no pay, even holding the pay permissions there", async () => {
    expect((await as("manager", "/v1/pay-rule-sets")).status).toBe(403);
    await sql(
      `INSERT INTO role (key, name, scope_kind, permissions)
       VALUES ('local_pay', 'Local pay', 'location', '{scheduling.pay.manage,scheduling.pay.approve}')`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'local_pay'`,
      [DEMO.users.manager.id, LOC],
    );
    const runs = await as("manager", "/v1/pay-runs");
    expect(runs.status).toBe(403);
    expect(((await runs.json()) as { code: string }).code).toBe("pay_not_organisation_wide");
  });
});

describe("pay profiles (rule 2)", () => {
  it("sets a member's profile, never one's own, and the member reads theirs", async () => {
    const put = await as("owner", `/v1/members/${CARER}/pay-profile`, {
      method: "PUT",
      body: {
        version: null,
        frequency: "weekly",
        roleKey: "care_worker",
        qualifyingWeekdays: [1, 2, 3, 4, 5],
      },
    });
    expect(put.status).toBe(200);
    const own = await as("owner", `/v1/members/${OWNER}/pay-profile`, {
      method: "PUT",
      body: { version: null, frequency: "weekly" },
    });
    expect(own.status).toBe(403);
    const mine = await as("carer", `/v1/members/${CARER}/pay-profile`);
    expect(((await mine.json()) as { roleKey: string }).roleKey).toBe("care_worker");
  });
});

describe("a run: approved time only, checked by a second person and locked (rules 3 to 11)", () => {
  it("counts approved time only and blocks on a draft timesheet in the period", async () => {
    entryA = await enter("2026-10-05T08:00:00Z", "2026-10-05T16:00:00Z");
    expect((await approveEntry(entryA)).status).toBe(200);
    await enter("2026-10-06T08:00:00Z", "2026-10-06T12:00:00Z");
    const made = await as("owner", "/v1/pay-runs", { method: "POST", body: PERIOD });
    expect(made.status).toBe(201);
    const run = (await made.json()) as Run;
    runId = run.id;
    const again = await as("owner", "/v1/pay-runs", { method: "POST", body: PERIOD });
    expect(again.status).toBe(409);
    const detail = await calculate("owner", run);
    const line = detail.lines.find((l) => l.memberId === CARER);
    expect(line?.basicPence).toBe(Math.floor((1_350 * 480) / 60));
    expect(detail.exceptions.map((e) => e.kind)).toEqual(["unapproved_timesheet"]);
    const lock = await as("quality", `/v1/pay-runs/${runId}/lock`, {
      method: "POST",
      body: { version: detail.run.version },
    });
    expect(lock.status).toBe(409);
  });

  it("is locked only by someone who neither created nor calculated it, once nothing is open", async () => {
    const [draft] = await sql<{ id: string; version: number }>(
      "SELECT id, version FROM timesheet_entry WHERE status = 'draft' AND worker_id = $1",
      [CARER],
    );
    expect((await approveEntry(draft as { id: string; version: number })).status).toBe(200);
    const current = (await (await as("owner", `/v1/pay-runs/${runId}`)).json()) as Detail;
    const detail = await calculate("owner", current.run);
    expect(detail.exceptions).toEqual([]);
    expect(detail.lines[0]?.basicPence).toBe(Math.floor((1_350 * 720) / 60));
    const byCalculator = await as("owner", `/v1/pay-runs/${runId}/lock`, {
      method: "POST",
      body: { version: detail.run.version },
    });
    expect(byCalculator.status).toBe(403);
    const locked = await as("quality", `/v1/pay-runs/${runId}/lock`, {
      method: "POST",
      body: { version: detail.run.version },
    });
    expect(locked.status).toBe(200);
    expect(((await locked.json()) as Run).status).toBe("locked");
    const events = await sql(
      "SELECT payload FROM outbox_event WHERE event_type = 'scheduling.pay_run_locked' AND aggregate_id = $1",
      [runId],
    );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toMatch(/Pence|pence/);
    const recalc = await as("owner", `/v1/pay-runs/${runId}/calculate`, {
      method: "POST",
      body: { version: detail.run.version + 1 },
    });
    expect(recalc.status).toBe(409);
  });

  it("reproduces a line from its stored inputs and rate rows (rule 10)", async () => {
    const detail = (await (await as("quality", `/v1/pay-runs/${runId}`)).json()) as Detail;
    const lineId = detail.lines[0]?.id;
    const check = await as("quality", `/v1/pay-runs/${runId}/lines/${lineId}/verify`);
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ reproduced: true, differences: [] });
  });

  it("lets the member read their own locked line", async () => {
    const mine = await as("carer", "/v1/me/pay-lines");
    expect(mine.status).toBe(200);
    const items = ((await mine.json()) as { items: { line: { memberId: string } }[] }).items;
    expect(items.map((i) => i.line.memberId)).toEqual([CARER]);
    expect((await as("carer", `/v1/pay-runs/${runId}`)).status).toBe(403);
    const detail = (await (await as("quality", `/v1/pay-runs/${runId}`)).json()) as Detail;
    expect(
      (await as("carer", `/v1/pay-runs/${runId}/lines/${detail.lines[0]?.id}/verify`)).status,
    ).toBe(403);
  });
});

describe("corrections and overrides (rules 9 and 12)", () => {
  it("corrects a locked run in a later run that shows the difference, one open at a time", async () => {
    const corrected = await as("manager", `/v1/timesheet-entries/${entryA.id}/corrections`, {
      method: "POST",
      body: {
        reason: "Left an hour early",
        kind: "work",
        startedAt: "2026-10-05T08:00:00Z",
        endedAt: "2026-10-05T15:00:00Z",
      },
    });
    expect(corrected.status).toBe(201);
    expect(
      (await approveEntry((await corrected.json()) as { id: string; version: number })).status,
    ).toBe(200);
    const made = await as("owner", `/v1/pay-runs/${runId}/corrections`, { method: "POST" });
    expect(made.status).toBe(201);
    const correction = (await made.json()) as Run;
    expect(
      (await as("owner", `/v1/pay-runs/${runId}/corrections`, { method: "POST" })).status,
    ).toBe(409);
    // A new draft in the period: an exception the approver overrides with a reason.
    await enter("2026-10-07T08:00:00Z", "2026-10-07T09:00:00Z");
    const detail = await calculate("owner", correction);
    expect(detail.lines[0]?.differencePence).toBe(-1_350);
    const exception = detail.exceptions[0];
    expect(exception?.kind).toBe("unapproved_timesheet");
    const byCarer = await as("carer", `/v1/pay-run-exceptions/${exception?.id}/override`, {
      method: "POST",
      body: { version: exception?.version, reason: "Not mine to say" },
    });
    expect(byCarer.status).toBe(403);
    const overridden = await as("quality", `/v1/pay-run-exceptions/${exception?.id}/override`, {
      method: "POST",
      body: { version: exception?.version, reason: "Paid next week once approved" },
    });
    expect(overridden.status).toBe(200);
    const locked = await as("quality", `/v1/pay-runs/${correction.id}/lock`, {
      method: "POST",
      body: { version: detail.run.version },
    });
    expect(locked.status).toBe(200);
  });
});
