import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MockThapsusHr } from "../src/integrations/thapsus-hr";
import { payrollExportNotConfigured } from "../src/services/payroll-export";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * Pay through Thapsus-HR (integrations.md section 11.5 rules 11 and 12; INTG-014, SCHED-005,
 * SCHED-008; slice 89; ADR-0131; HZ-133, HZ-140), against the contract-tested mock with its
 * Phase 19 pay capabilities switched on: Thapsus-HR's pay periods are the pay reference periods,
 * its rate is used for the minimum wage check, approved units go out by pay code for each pay
 * period, and Harbour's payroll export is never offered a period paid through Thapsus-HR.
 * Invented people only.
 */

let h: Harness;
let mock: MockThapsusHr;
const T = DEMO.tenantId;
const LOC = DEMO.locationId;
const CARER = DEMO.users.carer.id;
const PROJECT = "harbour-test-89";
const SECRET_REF = `projects/${PROJECT}/locations/europe-west2/secrets/harbour_int_${T}_thapsus-hr-webhook`;
const DOMAIN = "thapsus.example.invalid";
const BASE = `https://api.uk.${DOMAIN}`;
/** Before the route changes, Harbour's export; then Thapsus-HR's weekly pay periods. */
const P0 = { frequency: "weekly", periodStart: "2026-10-05", periodEnd: "2026-10-11" };
const P1 = { frequency: "weekly", periodStart: "2026-10-12", periodEnd: "2026-10-18" };

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: T });
const codeOf = async (r: Response) => ((await r.json()) as { code: string }).code;

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

interface Run {
  id: string;
  version: number;
}
const sync = async () =>
  (await (await as("manager", "/v1/integrations/hr-link/sync", { method: "POST" })).json()) as {
    pay?: {
      read: { periods: number; rates: number; failed: number } | null;
      sent: { sent: number } | null;
    };
  };
const linkVersion = async () =>
  ((await (await as("manager", "/v1/integrations/hr-link")).json()) as { version: number }).version;
const patch = async (body: Record<string, unknown>, who = "manager") =>
  as(who, "/v1/integrations/hr-link", {
    method: "PATCH",
    body: { expectedVersion: await linkVersion(), ...body },
  });
/** One approved eight-hour weekday for the carer. */
async function worked(day: string) {
  const made = await as("manager", `/v1/locations/${LOC}/timesheets`, {
    method: "POST",
    body: {
      workerId: CARER,
      kind: "work",
      startedAt: `${day}T08:00:00Z`,
      endedAt: `${day}T16:00:00Z`,
    },
  });
  expect(made.status).toBe(201);
  const entry = (await made.json()) as Run;
  const ok = await as("owner", `/v1/timesheet-entries/${entry.id}/approve`, {
    method: "POST",
    body: { version: entry.version },
  });
  expect(ok.status).toBe(200);
}
interface Detail {
  run: Run;
  lines: { memberId: string; basicPence: number }[];
  exceptions: { id: string; version: number; kind: string; status: string }[];
}
const calculate = async (run: Run) => {
  const calc = await as("owner", `/v1/pay-runs/${run.id}/calculate`, {
    method: "POST",
    body: { version: run.version },
  });
  expect(calc.status).toBe(200);
  return (await calc.json()) as Detail;
};
async function draftAndCalculate(period: typeof P0) {
  const made = await as("owner", "/v1/pay-runs", { method: "POST", body: period });
  expect(made.status).toBe(201);
  return calculate((await made.json()) as Run);
}
const lock = (run: Run) =>
  as("quality", `/v1/pay-runs/${run.id}/lock`, { method: "POST", body: { version: run.version } });

let offer: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  h = await createHarness({ GCP_PROJECT_ID: PROJECT, THAPSUS_HR_DOMAIN: DOMAIN });
  offer = vi.spyOn(payrollExportNotConfigured, "offer");
  await sql(
    "INSERT INTO feature_flag (flag_key, enabled) VALUES ('integrations.thapsus_hr', true)",
  );
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
  mock = new MockThapsusHr({ slug: "demo-care", homeRegion: "uk", apiBaseUrl: BASE }, BASE);
  h.handle.services.hrLink.mocks.set(T, mock);
  mock.employeesById.set("emp_carer", {
    id: "emp_carer",
    employeeNumber: "E200",
    workEmail: DEMO.users.carer.email,
    dateOfBirth: "1990-05-01",
    givenName: "Ada",
    familyName: "Example",
    leavingDate: null,
  } as never);
  mock.payPeriodsList.push(
    { id: "pp_w1", frequency: "weekly", startsOn: P1.periodStart, endsOn: P1.periodEnd },
    { id: "pp_w2", frequency: "weekly", startsOn: "2026-10-19", endsOn: "2026-10-25" },
  );
  mock.ratesList.push({
    employeeId: "emp_carer",
    hourlyPence: 1_300,
    effectiveFrom: "2026-04-01",
    salary: 27_000,
  });
  const connected = await as("manager", "/v1/integrations/hr-link", {
    method: "POST",
    body: { workspaceSlug: "demo-care", secretRef: SECRET_REF },
  });
  expect(connected.status).toBe(201);
  // The organisation's own rule set and the carer's pay profile.
  const set = await as("owner", "/v1/pay-rule-sets", {
    method: "POST",
    body: { name: "Standard", effectiveFrom: "2026-04-06", roleRates: { care_worker: 1_350 } },
  });
  const made = (await set.json()) as Run;
  expect(
    (
      await as("quality", `/v1/pay-rule-sets/${made.id}/approve`, {
        method: "POST",
        body: { version: made.version },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await as("owner", `/v1/members/${CARER}/pay-profile`, {
        method: "PUT",
        body: {
          version: null,
          frequency: "weekly",
          roleKey: "care_worker",
          qualifyingWeekdays: [1, 2, 3, 4, 5],
        },
      })
    ).status,
  ).toBe(200);
}, 120_000);

afterAll(async () => {
  offer?.mockRestore();
  await h?.close();
});

describe("hazard HZ-140 a period before the route changes pays through Harbour's export (rule 12)", () => {
  it("offers a locked run to the export and sends nothing to Thapsus-HR", async () => {
    await worked("2026-10-05");
    const detail = await draftAndCalculate(P0);
    expect((await lock(detail.run)).status).toBe(200);
    expect(offer).toHaveBeenCalledTimes(1);
    expect(await sql("SELECT 1 FROM hr_pay_unit")).toHaveLength(0);
  });
});

describe("hazard HZ-140 the route moves to Thapsus-HR only when it can take pay (rules 11 and 12)", () => {
  it("refuses while Thapsus-HR's pay items and pay read are planned", async () => {
    const r = await patch({ payRoute: { route: "thapsus_hr", from: P1.periodStart } });
    expect(r.status).toBe(409);
    expect(await codeOf(r)).toBe("hr_link_pay_not_available");
  });

  it("reads pay periods and rates, keeping the rate and dropping anything else", async () => {
    mock.phase19 = true;
    const r = await sync();
    expect(r.pay?.read).toMatchObject({ periods: 2, rates: 1, failed: 0 });
    const rows = await sql("SELECT * FROM hr_pay_rate");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hourly_pence: 1_300 });
    expect(Object.keys(rows[0] as object)).not.toContain("salary");
  });

  it("refuses a start that is not one of Thapsus-HR's periods, or not later than a run", async () => {
    const odd = await patch({ payRoute: { route: "thapsus_hr", from: "2026-10-13" } });
    expect(odd.status).toBe(422);
    expect(await codeOf(odd)).toBe("not_hr_pay_period_start");
    const past = await patch({ payRoute: { route: "thapsus_hr", from: P0.periodStart } });
    expect(past.status).toBe(422);
    expect(await codeOf(past)).toBe("pay_route_not_later");
  });

  it("moves the route from the start of Thapsus-HR's next pay period", async () => {
    const r = await patch({ payRoute: { route: "thapsus_hr", from: P1.periodStart } });
    expect(r.status).toBe(200);
  });
});

describe("hazard HZ-140 a period paid through Thapsus-HR uses its pay period and its rate (rule 11)", () => {
  let run: Run;

  it("refuses a run whose dates are not one of Thapsus-HR's pay periods", async () => {
    const r = await as("owner", "/v1/pay-runs", {
      method: "POST",
      body: { frequency: "weekly", periodStart: "2026-10-13", periodEnd: "2026-10-19" },
    });
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe("not_hr_pay_period");
  });

  it("checks the minimum wage with Thapsus-HR's rate, not the organisation's rule set", async () => {
    await worked("2026-10-12");
    const detail = await draftAndCalculate(P1);
    run = detail.run;
    const line = detail.lines.find((l) => l.memberId === CARER);
    expect(line?.basicPence).toBe(1_300 * 8);
  });

  it("refuses to lock until every unit kind has a pay code, mapped by a pay approver", async () => {
    const refused = await lock(run);
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe("hr_pay_codes_unmapped");
    // The link's manager alone may not decide what payroll pays.
    expect((await patch({ payCodes: { hours: "BASIC" } })).status).toBe(403);
    expect((await patch({ payCodes: { hours: "BASIC" } }, "owner")).status).toBe(200);
  });

  it("refuses to lock while a member with units is not matched to Thapsus-HR", async () => {
    await sql("UPDATE hr_person_link SET state = 'rejected' WHERE hr_employee_id = 'emp_carer'");
    try {
      const r = await lock(run);
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe("hr_pay_member_not_linked");
    } finally {
      await sql("UPDATE hr_person_link SET state = 'linked' WHERE hr_employee_id = 'emp_carer'");
    }
  });

  it("locks with the checked calculation's units and pay codes, never offering the export", async () => {
    // Approved after the calculation: not in what the checker saw, so not sent.
    await worked("2026-10-13");
    const before = offer.mock.calls.length;
    expect((await lock(run)).status).toBe(200);
    expect(offer.mock.calls.length).toBe(before);
    const units = await sql<{ unit_kind: string; quantity: string; pay_code: string }>(
      "SELECT unit_kind, quantity, pay_code FROM hr_pay_unit WHERE run_id = $1",
      [run.id],
    );
    expect(units).toEqual([{ unit_kind: "hours", quantity: "8.00", pay_code: "BASIC" }]);
  });

  it("sends the units by the pay code kept at lock, once, whatever the mapping says later", async () => {
    expect((await patch({ payCodes: { hours: "OVERTIME" } }, "owner")).status).toBe(200);
    await sync();
    expect(mock.payItems.get("pp_w1")).toEqual([
      { employeeId: "emp_carer", payPeriodId: "pp_w1", payCode: "BASIC", units: 8 },
    ]);
    const writes = mock.writes.length;
    await sync();
    expect(mock.writes.length).toBe(writes);
    expect((await patch({ payCodes: { hours: "BASIC" } }, "owner")).status).toBe(200);
  });
});

describe("hazard HZ-140 a correction pays the way its original did, and replaces the period (rule 12)", () => {
  let correction: Run;

  it("keeps the original's route with the flag off, and refuses to lock until the link is back", async () => {
    const [locked] = await sql<{ id: string }>(
      "SELECT id FROM pay_run WHERE period_start = $1 AND kind = 'regular'",
      [P1.periodStart],
    );
    await sql("UPDATE feature_flag SET enabled = false WHERE flag_key = 'integrations.thapsus_hr'");
    try {
      const made = await as("owner", `/v1/pay-runs/${locked?.id}/corrections`, { method: "POST" });
      expect(made.status).toBe(201);
      correction = (await made.json()) as Run;
      const [row] = await sql<{ pay_route: string }>(
        "SELECT pay_route FROM pay_run WHERE id = $1",
        [correction.id],
      );
      expect(row?.pay_route).toBe("thapsus_hr");
      correction = (await calculate(correction)).run;
      const r = await lock(correction);
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe("hr_link_unavailable_for_pay");
    } finally {
      await sql(
        "UPDATE feature_flag SET enabled = true WHERE flag_key = 'integrations.thapsus_hr'",
      );
    }
  });

  it("sends the whole corrected period in place of the original's, never to the export", async () => {
    const before = offer.mock.calls.length;
    expect((await lock(correction)).status).toBe(200);
    expect(offer.mock.calls.length).toBe(before);
    await sync();
    expect(mock.payItems.get("pp_w1")).toEqual([
      { employeeId: "emp_carer", payPeriodId: "pp_w1", payCode: "BASIC", units: 16 },
    ]);
  });
});

describe("hazard HZ-140 the minimum wage check never runs on a missing or stale rate (rule 11)", () => {
  let run: Run;

  it("refuses to calculate with rates not read in the last two days", async () => {
    await worked("2026-10-19");
    const made = await as("owner", "/v1/pay-runs", {
      method: "POST",
      body: { frequency: "weekly", periodStart: "2026-10-19", periodEnd: "2026-10-25" },
    });
    expect(made.status).toBe(201);
    run = (await made.json()) as Run;
    await sql(
      "UPDATE hr_sync_state SET last_good_sync_at = now() - interval '3 days' WHERE kind = 'rates'",
    );
    try {
      const r = await as("owner", `/v1/pay-runs/${run.id}/calculate`, {
        method: "POST",
        body: { version: run.version },
      });
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe("hr_rates_out_of_date");
    } finally {
      await sql("UPDATE hr_sync_state SET last_good_sync_at = now() WHERE kind = 'rates'");
    }
  });

  it("blocks a member with no rate, and never lets that be overridden", async () => {
    await sql("UPDATE hr_pay_rate SET deleted_at = now()");
    try {
      const detail = await calculate(run);
      run = detail.run;
      const missing = detail.exceptions.find((e) => e.kind === "no_role_rate");
      expect(missing?.status).toBe("open");
      const r = await as("quality", `/v1/pay-run-exceptions/${missing?.id}/override`, {
        method: "POST",
        body: { version: missing?.version, reason: "Paid at the usual rate" },
      });
      expect(r.status).toBe(409);
      expect(await codeOf(r)).toBe("hr_rate_not_overridden");
      expect((await lock(run)).status).toBe(409);
    } finally {
      await sql("UPDATE hr_pay_rate SET deleted_at = NULL");
    }
  });

  it("raises a pay period whose dates Thapsus-HR changed, never moving it", async () => {
    const changed = mock.payPeriodsList.find((p) => p.id === "pp_w2") as Record<string, unknown>;
    changed.endsOn = "2026-10-24";
    try {
      const r = await sync();
      expect(r.pay?.read).toMatchObject({ failed: 1 });
      const [period] = await sql<{ ends_on: string }>(
        "SELECT ends_on::text FROM hr_pay_period WHERE hr_id = 'pp_w2'",
      );
      expect(period?.ends_on).toBe("2026-10-25");
      const alert = await sql(
        "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.pay_record_failed' AND required_permission = 'scheduling.pay.approve'",
      );
      expect(alert).toHaveLength(1);
    } finally {
      changed.endsOn = "2026-10-25";
    }
  });
});

describe("hazard HZ-140 a refusal of locked pay goes to pay approvers (rule 11)", () => {
  it("raises Thapsus-HR's refusal for the people who approve pay", async () => {
    const put = mock.putPayUnits.bind(mock);
    mock.putPayUnits = async () => ({ ok: false, error: "refused" }) as never;
    try {
      await sql("UPDATE hr_delivery SET payload_sha256 = NULL WHERE kind = 'pay_units'");
      await sync();
    } finally {
      mock.putPayUnits = put;
    }
    const alert = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.pay_units_refused' AND required_permission = 'scheduling.pay.approve'",
    );
    expect(alert).toHaveLength(1);
  });
});

describe("hazard HZ-140 disconnecting tells pay approvers when locked pay has not reached Thapsus-HR", () => {
  it("counts a period sent before a later correction as not reached, and raises it on disconnecting", async () => {
    // As if the regular run's units were sent and a correction's never were: another digest.
    await sql(
      `UPDATE hr_delivery SET state = 'sent', sent_at = now(), hr_id = 'pp_w1',
         payload_sha256 = repeat('a', 64) WHERE kind = 'pay_units'`,
    );
    expect((await as("manager", "/v1/integrations/hr-link", { method: "DELETE" })).status).toBe(
      204,
    );
    const alert = await sql(
      "SELECT 1 FROM task WHERE kind = 'integrations.hr_link.pay_units_unsent' AND required_permission = 'scheduling.pay.approve' AND status = 'open'",
    );
    expect(alert).toHaveLength(1);
  });
});

describe("hazard HZ-140 pay is changed only with a fresh step-up (rule 12)", () => {
  it("refuses a pay code change from a stale sign-in", async () => {
    const { ageSession } = await import("./support/harness");
    const session = h.tokens.owner?.split(".")[0] ?? "";
    await ageSession(h.db.pool("harbour_auth"), session, 3_600);
    try {
      const r = await patch({ payCodes: { hours: "OTHER" } }, "owner");
      expect(r.status).toBe(403);
    } finally {
      await ageSession(h.db.pool("harbour_auth"), session, 0);
    }
  });
});
