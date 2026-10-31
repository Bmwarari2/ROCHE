import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Outbreaks and IPC audits through the API (safety.md section 11; SAFE-013; migration 0093):
 * declaring an outbreak links or drafts its UKHSA report so the clock shows (HZ-013); the line list
 * of residents and staff, updated by superseding rows, completes the report's fields; closure waits
 * for the report to be decided (HZ-013); IPC audits read against the Code of Practice criteria;
 * every change, view and refusal audited with ids only.
 */

let h: Harness;

// why: the tests assert the response shapes themselves; the contracts type the API.
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON read in tests
type Json = any;
const json = (response: Response): Promise<Json> => response.json();

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

const today = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(new Date());

const resident = (personId: string, over: Record<string, unknown> = {}) => ({
  caseType: "resident",
  personId,
  tenantUserId: null,
  onsetOn: today(),
  symptoms: ["cough", "fever"],
  testType: "lateral_flow",
  testedOn: today(),
  testResult: "positive",
  fluVaccinated: "yes",
  covidVaccinated: "no",
  outcome: "unwell",
  outcomeOn: null,
  supersedesId: null,
  correctionReason: null,
  ...over,
});

let people: string[];
let outbreak: Json;

beforeAll(async () => {
  h = await createHarness();
  people = (
    await sql<{ id: string }>(
      "SELECT id FROM person WHERE location_id = $1 AND status = 'active' ORDER BY id LIMIT 2",
      [DEMO.locationId],
    )
  ).map((r) => r.id);
});

afterAll(async () => {
  await h?.close();
});

describe("hazard HZ-013 declaring an outbreak puts its report clock in the notification centre", () => {
  it("drafts the UKHSA report, due without delay, and links it", async () => {
    const response = await as("manager", "/v1/safety/outbreaks", {
      method: "POST",
      body: { locationId: DEMO.locationId, syndrome: "acute_respiratory" },
    });
    expect(response.status).toBe(201);
    outbreak = await json(response);
    expect(outbreak).toMatchObject({ state: "declared", declaredBy: DEMO.users.manager.id });
    expect(outbreak.notification).toMatchObject({ kind: "ukhsa_outbreak", status: "draft" });
    expect(outbreak.notificationId).toBe(outbreak.notification.id);
    const tasks = await sql(
      "SELECT 1 FROM workflow_instance WHERE subject_type = 'statutory_notification' AND subject_id = $1",
      [outbreak.notificationId],
    );
    expect(tasks).toHaveLength(1);
  });

  it("links the location's report still being prepared rather than drafting another", async () => {
    const response = await as("manager", "/v1/safety/outbreaks", {
      method: "POST",
      body: { locationId: DEMO.locationId, syndrome: "diarrhoea_vomiting" },
    });
    expect(response.status).toBe(201);
    expect((await json(response)).notificationId).toBe(outbreak.notificationId);
  });

  it("allows one open outbreak per illness at a location, and refuses a care worker", async () => {
    const again = await as("manager", "/v1/safety/outbreaks", {
      method: "POST",
      body: { locationId: DEMO.locationId, syndrome: "acute_respiratory" },
    });
    expect(again.status).toBe(409);
    expect((await as("carer", "/v1/safety/outbreaks")).status).toBe(403);
  });
});

describe("the line list and the report fields", () => {
  let first: string;

  it("adds a resident and a member of staff, and counts them in the report", async () => {
    const one = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident(people[0] as string),
    });
    expect(one.status).toBe(201);
    const staff = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident("", {
        caseType: "staff",
        personId: null,
        tenantUserId: DEMO.users.carer.id,
        testType: null,
        testedOn: null,
        testResult: "not_tested",
        covidVaccinated: "unknown",
      }),
    });
    expect(staff.status).toBe(201);
    const detail = await json(staff);
    first = detail.cases[0].id;
    expect(detail.report).toMatchObject({
      residentCases: 1,
      staffCases: 1,
      firstOnsetOn: today(),
      tested: 1,
      positive: 1,
      covidVaccination: { yes: 0, no: 1, unknown: 1 },
    });
    expect(detail.report.missing.join(" ")).toMatch(/Vaccination status/);
    const [report] = await sql<{ content: Record<string, string> }>(
      "SELECT content FROM statutory_notification WHERE id = $1",
      [outbreak.notificationId],
    );
    expect(report?.content).toMatchObject({ residentsAffected: "1", staffAffected: "1" });
  });

  it.each([
    [
      "symptoms starting tomorrow",
      { onsetOn: "2999-01-01", testedOn: null, testType: null, testResult: "not_tested" },
      422,
    ],
    ["a result without its test", { testType: null }, 422],
    ["the same person again", {}, 409],
  ])("refuses %s", async (_label, over, status) => {
    const response = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident(people[0] as string, over),
    });
    expect(response.status).toBe(status);
  });

  it("updates a case by superseding its current row, and refuses superseding an old one", async () => {
    const update = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident(people[0] as string, {
        supersedesId: first,
        outcome: "recovered",
        outcomeOn: today(),
      }),
    });
    expect(update.status).toBe(201);
    const detail = await json(update);
    expect(detail.cases.find((c: Json) => c.id === first).current).toBe(false);
    expect(detail.stillUnwell).toBe(1);
    const stale = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident(people[0] as string, { supersedesId: first }),
    });
    expect(stale.status).toBe(409);
  });
});

describe("hazard HZ-013 an outbreak closes only once its report is decided", () => {
  const close = (version: number, closedOn = today()) =>
    as("manager", `/v1/safety/outbreaks/${outbreak.id}/close`, {
      method: "POST",
      body: { version, closedOn, reason: "No new cases; agreed with the health protection team" },
    });

  it("refuses to close while the report is a draft", async () => {
    const current = await json(await as("manager", `/v1/safety/outbreaks/${outbreak.id}`));
    const response = await close(current.version);
    expect(response.status).toBe(409);
    expect(JSON.stringify(await json(response))).toMatch(/Submit the outbreak report/);
  });

  it("closes once the report is recorded as not needed, saying who is still unwell, and stays closed", async () => {
    await sql(
      "UPDATE statutory_notification SET status = 'not_required', not_required_reason = 'Reported by phone' WHERE id = $1",
      [outbreak.notificationId],
    );
    const current = await json(await as("manager", `/v1/safety/outbreaks/${outbreak.id}`));
    expect((await close(current.version, "2999-01-01")).status).toBe(422);
    const response = await close(current.version);
    expect(response.status).toBe(200);
    expect(await json(response)).toMatchObject({
      state: "closed",
      closedBy: DEMO.users.manager.id,
      stillUnwell: 1,
    });
    const late = await as("manager", `/v1/safety/outbreaks/${outbreak.id}/cases`, {
      method: "POST",
      body: resident(people[1] as string),
    });
    expect(late.status).toBe(409);
  });
});

describe("IPC audits against the Code of Practice criteria", () => {
  it("lists the ten criteria", async () => {
    const { items } = await json(await as("manager", "/v1/safety/ipc-criteria"));
    expect(items).toHaveLength(10);
  });

  it("reads an IPC audit criterion by criterion, and refuses other kinds", async () => {
    const template = await json(
      await as("quality", "/v1/quality/audit-templates", {
        method: "POST",
        body: { key: "ipc", starterKey: "ipc" },
      }),
    );
    const audit = await json(
      await as("quality", "/v1/quality/audits", {
        method: "POST",
        body: { templateId: template.id, locationId: DEMO.locationId, auditedOn: today() },
      }),
    );
    const answers = Object.fromEntries(template.questions.map((q: Json) => [q.key, "yes"]));
    answers.isolation = "no";
    await as("quality", `/v1/quality/audits/${audit.id}/answers`, {
      method: "PUT",
      body: { version: 1, answers },
    });
    const response = await as("quality", `/v1/safety/ipc-audits/${audit.id}/criteria`);
    expect(response.status).toBe(200);
    const result = await json(response);
    expect(result.criteria).toHaveLength(10);
    expect(result.criteria.every((c: Json) => c.questionKeys.length > 0)).toBe(true);
    expect(result.criteria.find((c: Json) => c.id === "criterion_7")).toMatchObject({
      percent: 0,
      fellShort: ["isolation"],
    });
    const mock = await json(
      await as("quality", "/v1/quality/audit-templates", {
        method: "POST",
        body: { key: "dignity", starterKey: "dignity" },
      }),
    );
    const other = await json(
      await as("quality", "/v1/quality/audits", {
        method: "POST",
        body: { templateId: mock.id, locationId: DEMO.locationId, auditedOn: today() },
      }),
    );
    expect((await as("quality", `/v1/safety/ipc-audits/${other.id}/criteria`)).status).toBe(409);
  });

  it("refuses an IPC template with a question mapped to no criterion", async () => {
    const response = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: {
        key: "ipc-own",
        kind: "ipc",
        title: "Our IPC audit",
        frameworkVersionId: "0192f1a0-0000-7000-8000-000000000001",
        questions: [
          {
            key: "hands",
            text: "Hands are washed",
            weight: 1,
            statementIds: [],
            actionRequired: true,
          },
        ],
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await json(response))).toMatch(/Code of Practice criterion/);
  });
});

describe("audit trail", () => {
  it("records every change, view and refusal with ids only", async () => {
    const rows = await sql<{ action: string; outcome: string; scope: Record<string, unknown> }>(
      "SELECT action, outcome, scope FROM audit_event WHERE action LIKE 'safety.outbreak.%'",
    );
    const seen = new Set(rows.map((r) => `${r.action}:${r.outcome}`));
    for (const expected of [
      "safety.outbreak.declared:success",
      "safety.outbreak.declared:denied",
      "safety.outbreak.case_recorded:success",
      "safety.outbreak.case_recorded:denied",
      "safety.outbreak.view:success",
      "safety.outbreak.closed:success",
      "safety.outbreak.closed:denied",
    ]) {
      expect(seen, expected).toContain(expected);
    }
    expect(JSON.stringify(rows.map((r) => r.scope))).not.toMatch(/cough|fever|positive/);
  });
});
