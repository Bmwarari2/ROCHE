import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * The quality dashboard and PIR prefill (QUAL-005, QUAL-006; quality.md section 22; HZ-129):
 * quality.audit.manage at the location; every figure with its working; a source not built, an
 * unfinished period, a period before the location used Harbour and a small number are never
 * rated; the location's own target wins over the organisation default; audit with ids and codes.
 */

let h: Harness;
const ROOM = "0194d000-0000-7000-8000-000000000c01";
const SEPTEMBER = { from: "2026-09-01", to: "2026-09-30" };
const as = (who: string) => ({ token: h.tokens[who], tenant: DEMO.tenantId });
const send = (method: string, path: string, who: string, body?: unknown) =>
  h.request(path, { method, ...(body !== undefined ? { body } : {}), ...as(who) });
const get = (path: string, who = "owner") => h.request(path, as(who));
const json = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
const codeOf = async (r: Response) => (await json<{ code: string }>(r)).code;

type Indicator = {
  key: string;
  source: string | null;
  numerator: number | null;
  denominator: number | null;
  period: { from: string; to: string };
  value: number | null;
  status: string;
  reasonCode: string | null;
  reason: string | null;
  method: string;
  target: { green: number; amber: number; level: string } | null;
};
type Dashboard = { minGroupSize: number; indicators: Indicator[] };
type Target = { id: string; version: number; locationId: string | null; indicatorKey: string };
type Pir = {
  asOf: string;
  questionSet: { confirmed: boolean };
  items: { key: string; status: string; value: unknown; reasonCode: string | null }[];
};

const dashboardUrl = (location: string, period = SEPTEMBER) =>
  `/v1/quality/dashboard?locationId=${location}&from=${period.from}&to=${period.to}`;
const dashboard = async (location = LODGE.locationId, who = "owner", period = SEPTEMBER) =>
  json<Dashboard>(await get(dashboardUrl(location, period), who));
const indicator = (d: Dashboard, key: string) => d.indicators.find((i) => i.key === key);

async function ownerIn<T extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await client.query<T>(text, values);
    await client.query("COMMIT");
    return result.rows;
  } finally {
    client.release();
  }
}

const incident = (type: string, day: string) =>
  ownerIn(
    `INSERT INTO incident (location_id, type, occurred_at, recorded_at, description, raised_by, person_ids)
     VALUES ($1, $2, $3, $3, 'Fixture incident', $4, '{}')`,
    [LODGE.locationId, type, `${day}T10:00:00Z`, LODGE.qualityLeadId],
  );

beforeAll(async () => {
  h = await createHarness();
  // Harbour Lodge has used Harbour since 2025 (the harness), so September 2026 is whole.
  await ownerIn("INSERT INTO room (id, location_id, label, beds) VALUES ($1, $2, 'L1', 1)", [
    ROOM,
    LODGE.locationId,
  ]);
  await ownerIn(
    `INSERT INTO bed_occupancy (person_id, room_id, bed, from_date, reason)
     VALUES ($1, $2, 1, '2026-08-01', 'Admission')`,
    [LODGE.personId, ROOM],
  );
  for (const day of ["02", "05", "09", "14", "18", "27"]) await incident("fall", `2026-09-${day}`);
  for (const day of ["03", "21"]) await incident("medication", `2026-09-${day}`);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("QUAL-005 the quality dashboard", () => {
  it("is for holders of quality.audit.manage at the location", async () => {
    expect((await get(dashboardUrl(LODGE.locationId), "owner")).status).toBe(200);
    expect((await get(dashboardUrl(LODGE.locationId), "quality")).status).toBe(200);
    expect((await get(dashboardUrl(DEMO.locationId), "manager")).status).toBe(200);
    // The Registered Manager holds it for Harbour House only.
    expect((await get(dashboardUrl(LODGE.locationId), "manager")).status).toBe(403);
    expect((await get(dashboardUrl(DEMO.locationId), "carer")).status).toBe(403);
  });

  it.each<[string, { from: string; to: string }, string]>([
    [
      "a period that ends before it starts",
      { from: "2026-09-30", to: "2026-09-01" },
      "period_order",
    ],
    ["a period longer than 366 days", { from: "2025-01-01", to: "2026-09-30" }, "period_too_long"],
    [
      "a period that ends after today",
      { from: "2026-09-01", to: "2099-01-01" },
      "period_in_future",
    ],
  ])("refuses %s", async (_name, period, code) => {
    const r = await get(dashboardUrl(LODGE.locationId, period));
    expect(r.status).toBe(422);
    expect(await codeOf(r)).toBe(code);
  });

  it("hazard HZ-129 never rates an indicator Harbour does not record yet", async () => {
    const d = await dashboard();
    for (const key of [
      "missed_visits",
      "training_compliance",
      "agency_hours",
      "complaints",
      "staff_turnover",
    ]) {
      expect(indicator(d, key)).toMatchObject({
        source: null,
        numerator: null,
        denominator: null,
        value: null,
        status: "no_data",
        reasonCode: "source_not_built",
      });
    }
  });

  it("hazard HZ-129 never rates a period before the location used Harbour", async () => {
    // Harbour House was set up today, so September is not a whole period for it.
    const d = await dashboard(DEMO.locationId);
    expect(indicator(d, "falls")).toMatchObject({
      status: "no_data",
      reasonCode: "incomplete_data",
    });
  });

  it("shows every figure with its working, and a value without a target unrated", async () => {
    const d = await dashboard();
    expect(indicator(d, "falls")).toMatchObject({
      source: "Incidents recorded as a fall",
      numerator: 6,
      denominator: 30,
      period: SEPTEMBER,
      value: 200,
      status: "no_data",
      reasonCode: "no_target",
    });
    expect(indicator(d, "falls")?.method).toContain("÷ occupied bed-days");
  });

  it("hazard HZ-129 withholds a small number, its value and its status", async () => {
    const d = await dashboard();
    expect(d.minGroupSize).toBeGreaterThan(2);
    expect(indicator(d, "medication_errors")).toMatchObject({
      numerator: null,
      denominator: 30,
      value: null,
      status: "no_data",
      reasonCode: "small_number",
    });
  });

  it("gives overdue reviews as at today, and no rate without anything to measure", async () => {
    const d = await dashboard();
    const reviews = indicator(d, "overdue_reviews");
    expect(reviews?.period.from).toBe(reviews?.period.to);
    expect(reviews).toMatchObject({
      denominator: 0,
      status: "no_data",
      reasonCode: "no_denominator",
    });
  });
});

describe("QUAL-005 indicator targets", () => {
  const set = (who: string, body: object) =>
    send("PUT", "/v1/quality/indicator-targets", who, body);

  it("rates against the organisation default, then the location's own target", async () => {
    const organisation = await set("owner", {
      locationId: null,
      indicatorKey: "falls",
      green: 100,
      amber: 250,
      expectedVersion: null,
    });
    expect(organisation.status).toBe(200);
    expect(indicator(await dashboard(), "falls")).toMatchObject({
      status: "amber",
      target: { green: 100, amber: 250, level: "organisation" },
    });
    const own = await set("quality", {
      locationId: LODGE.locationId,
      indicatorKey: "falls",
      green: 300,
      amber: 400,
      expectedVersion: null,
    });
    expect(own.status).toBe(200);
    expect(indicator(await dashboard(), "falls")).toMatchObject({
      status: "green",
      target: { level: "location" },
    });
    // Cleared, the organisation default rates it again.
    const target = await json<Target>(own);
    const cleared = await send(
      "POST",
      `/v1/quality/indicator-targets/${target.id}/clear`,
      "owner",
      {
        expectedVersion: target.version,
      },
    );
    expect(cleared.status).toBe(200);
    expect(indicator(await dashboard(), "falls")?.status).toBe("amber");
  });

  it("refuses thresholds in the wrong direction, a second live target and a stale version", async () => {
    const wrong = await set("owner", {
      locationId: null,
      indicatorKey: "training_compliance",
      green: 80,
      amber: 95,
      expectedVersion: null,
    });
    expect(wrong.status).toBe(422);
    expect(await codeOf(wrong)).toBe("wrong_order");
    const again = await set("owner", {
      locationId: null,
      indicatorKey: "falls",
      green: 1,
      amber: 2,
      expectedVersion: null,
    });
    expect(again.status).toBe(409);
    expect(await codeOf(again)).toBe("already_set");
    const stale = await set("owner", {
      locationId: null,
      indicatorKey: "falls",
      green: 1,
      amber: 2,
      expectedVersion: 99,
    });
    expect(stale.status).toBe(409);
  });

  it("lets a home's manager set its own target only", async () => {
    const body = { indicatorKey: "pressure_ulcers", green: 1, amber: 2, expectedVersion: null };
    expect((await set("manager", { ...body, locationId: null })).status).toBe(403);
    expect((await set("manager", { ...body, locationId: LODGE.locationId })).status).toBe(403);
    expect((await set("manager", { ...body, locationId: DEMO.locationId })).status).toBe(200);
    const list = await json<{ items: Target[] }>(
      await get("/v1/quality/indicator-targets", "manager"),
    );
    expect(list.items.some((t) => t.locationId === LODGE.locationId)).toBe(false);
    expect(list.items.some((t) => t.locationId === DEMO.locationId)).toBe(true);
  });

  it("audits views and changes with ids and codes only", async () => {
    const rows = await ownerIn<{ action: string; scope: Record<string, unknown> }>(
      "SELECT action, scope FROM audit_event WHERE action LIKE 'quality.dashboard.%' OR action LIKE 'quality.indicator_target.%' OR action LIKE 'quality.pir.%'",
    );
    const actions = new Set(rows.map((r) => r.action));
    expect(actions).toEqual(
      new Set([
        "quality.dashboard.viewed",
        "quality.indicator_target.set",
        "quality.indicator_target.cleared",
      ]),
    );
    for (const r of rows) {
      expect(Object.keys(r.scope).sort()).toEqual(
        r.action === "quality.dashboard.viewed" ? ["from", "to"] : ["indicatorKey", "locationId"],
      );
    }
  });
});

describe("QUAL-006 the PIR prefill", () => {
  const pir = async (location = LODGE.locationId, who = "owner") =>
    json<Pir>(await get(`/v1/quality/pir?locationId=${location}`, who));

  it("is for holders of quality.audit.manage at the location", async () => {
    expect((await get(`/v1/quality/pir?locationId=${LODGE.locationId}`, "manager")).status).toBe(
      403,
    );
    expect((await get(`/v1/quality/pir?locationId=${DEMO.locationId}`, "carer")).status).toBe(403);
  });

  it("hazard HZ-129 prefills what Harbour records and marks the rest to complete", async () => {
    const result = await pir();
    expect(result.questionSet.confirmed).toBe(false);
    const item = (key: string) => result.items.find((i) => i.key === key);
    expect(item("incidents")).toMatchObject({ status: "prefilled", value: 8, reasonCode: null });
    expect(item("medication_errors")).toMatchObject({
      status: "to_complete",
      value: null,
      reasonCode: "small_number",
    });
    expect(item("complaints")).toMatchObject({ status: "to_complete", reasonCode: "not_built" });
    // No care notes at Lodge: not "no", but no data.
    expect(item("digital_care_records")).toMatchObject({
      status: "to_complete",
      reasonCode: "no_value",
    });
  });

  it("hazard HZ-129 does not prefill a year the location did not use Harbour for", async () => {
    const result = await pir(DEMO.locationId);
    expect(result.items.find((i) => i.key === "incidents")).toMatchObject({
      status: "to_complete",
      reasonCode: "no_value",
    });
  });
});
