import { DEMO } from "@harbour/db/seed";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * The audit programme and mock inspections through the API (quality.md section 19; QUAL-004;
 * HZ-011; migration 0081): templates from the starters checked against the framework, schedules
 * with their next due date, audits scored against the questions they started with, completion
 * with a self-rating from the rate table's scale and actions raised as tasks with the default due
 * date, mock inspections only against the framework in force, completed audits tagged as evidence,
 * and every change and refusal audited.
 */

let h: Harness;
const FW = "0192f1a0-0000-7000-8000-000000000001";
const LEAD = "0194d000-0000-7000-8000-000000000305";

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });

// why: the tests assert the response shapes themselves; the contracts type the API.
// biome-ignore lint/suspicious/noExplicitAny: loosely typed JSON read in tests
type Json = any;
const json = (response: Response): Promise<Json> => response.json();

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

let medication: {
  id: string;
  version: number;
  questions: { key: string; actionRequired: boolean }[];
};

beforeAll(async () => {
  h = await createHarness();
});

afterAll(async () => {
  await h?.close();
});

describe("templates (rule 8)", () => {
  it("lists the seven starters, IPC included, to a quality lead and refuses a care worker", async () => {
    const response = await as("quality", "/v1/quality/audit-starters");
    expect(response.status).toBe(200);
    const { items } = (await json(response)) as {
      items: { key: string; frameworkVersionId: string }[];
    };
    expect(items.map((i) => i.key)).toContain("ipc");
    expect(items).toHaveLength(7);
    expect(items.every((i) => i.frameworkVersionId === FW)).toBe(true);
    expect((await as("carer", "/v1/quality/audit-starters")).status).toBe(403);
  });

  it("copies a starter into the organisation's own template, once per key", async () => {
    const response = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: { key: "medication", starterKey: "medication" },
    });
    expect(response.status).toBe(201);
    medication = await json(response);
    expect(medication).toMatchObject({ key: "medication", version: 1, state: "active" });
    const again = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: { key: "medication", starterKey: "medication" },
    });
    expect(again.status).toBe(409);
  });

  it.each([
    ["an unknown statement", { statementIds: ["safe.made_up"] }, /quality statements/],
    ["duplicate question keys", { key: "same", dup: true }, /its own key/],
  ])("refuses a template with %s", async (_label, change, message) => {
    const base = {
      key: "q1",
      text: "Is it done?",
      weight: 1,
      statementIds: ["safe.safeguarding"],
      actionRequired: true,
    };
    const questions =
      "dup" in change
        ? [
            { ...base, key: "same" },
            { ...base, key: "same" },
          ]
        : [{ ...base, ...change }];
    const response = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: {
        key: "custom",
        kind: "other",
        title: "Custom audit",
        frameworkVersionId: FW,
        questions,
      },
    });
    expect(response.status).toBe(422);
    expect(JSON.stringify(await json(response))).toMatch(message);
  });

  it("asks for the fields when there is no starter", async () => {
    const response = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: { key: "bare" },
    });
    expect(response.status).toBe(422);
  });
});

describe("schedules (rule 13)", () => {
  it("schedules a template at a location and says when it is next due", async () => {
    const response = await as("quality", "/v1/quality/audit-schedules", {
      method: "POST",
      body: {
        templateId: medication.id,
        locationId: DEMO.locationId,
        frequencyMonths: 3,
        firstDueOn: "2026-01-15",
      },
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toMatchObject({ nextDueOn: "2026-01-15", lastCompletedOn: null });
    const list = await json(await as("quality", "/v1/quality/audit-schedules"));
    expect(list.items).toHaveLength(1);
  });
});

describe("audits (rules 4, 9 to 12)", () => {
  let auditId: string;

  it("starts an audit that keeps the template's questions after the template changes", async () => {
    const started = await as("quality", "/v1/quality/audits", {
      method: "POST",
      body: { templateId: medication.id, locationId: DEMO.locationId, auditedOn: today() },
    });
    expect(started.status).toBe(201);
    const audit = await json(started);
    auditId = audit.id;
    expect(audit).toMatchObject({
      state: "in_progress",
      frameworkVersionId: FW,
      frameworkInForce: true,
    });
    const changed = await as("quality", `/v1/quality/audit-templates/${medication.id}`, {
      method: "PUT",
      body: {
        version: medication.version,
        title: "Medication audit (local)",
        frameworkVersionId: FW,
        questions: [
          {
            key: "only_one",
            text: "Is the fridge in range?",
            weight: 1,
            statementIds: [],
            actionRequired: false,
          },
        ],
      },
    });
    expect(changed.status).toBe(200);
    const read = await json(await as("quality", `/v1/quality/audits/${auditId}`));
    expect(read.questions.map((q: { key: string }) => q.key)).toEqual(
      medication.questions.map((q) => q.key),
    );
  });

  it("refuses a future audit date", async () => {
    const response = await as("quality", "/v1/quality/audits", {
      method: "POST",
      body: { templateId: medication.id, locationId: DEMO.locationId, auditedOn: "2999-01-01" },
    });
    expect(response.status).toBe(422);
  });

  it("scores the saved answers with the method shown and findings by statement", async () => {
    const answers = Object.fromEntries(medication.questions.map((q) => [q.key, "yes"]));
    const [first, second] = medication.questions;
    answers[first?.key as string] = "no";
    answers[second?.key as string] = "not_applicable";
    const saved = await as("quality", `/v1/quality/audits/${auditId}/answers`, {
      method: "PUT",
      body: { version: 1, answers },
    });
    expect(saved.status).toBe(200);
    const audit = await json(saved);
    expect(audit.score.complete).toBe(true);
    expect(audit.score.percent).toBeLessThan(100);
    expect(audit.score.method).toMatch(/weighted points/);
    expect(audit.findings.length).toBeGreaterThan(0);
    const stale = await as("quality", `/v1/quality/audits/${auditId}/answers`, {
      method: "PUT",
      body: { version: 1, answers: {} },
    });
    expect(stale.status).toBe(409);
    const unknown = await as("quality", `/v1/quality/audits/${auditId}/answers`, {
      method: "PUT",
      body: { version: 2, answers: { not_a_question: "yes" } },
    });
    expect(unknown.status).toBe(422);
  });

  it("will not complete without an action for what fell short, or with a rating off the scale", async () => {
    const missing = await as("quality", `/v1/quality/audits/${auditId}/complete`, {
      method: "POST",
      body: { version: 2, selfRating: 3, actions: [] },
    });
    const first = medication.questions[0];
    expect(missing.status).toBe(first?.actionRequired ? 422 : 200);
    if (missing.status === 200)
      throw new Error("the first medication question should need an action");
    expect(JSON.stringify(await json(missing))).toMatch(/Add an action/);
    const offScale = await as("quality", `/v1/quality/audits/${auditId}/complete`, {
      method: "POST",
      body: {
        version: 2,
        selfRating: 5,
        actions: [{ questionKey: first?.key, description: "Retrain on MAR", ownerId: LEAD }],
      },
    });
    expect(offScale.status).toBe(422);
    expect(JSON.stringify(await json(offScale))).toMatch(/self-rating/);
  });

  it("completes with the self-rating and an action due by the tenant default, raising the owner's task", async () => {
    const first = medication.questions[0];
    const response = await as("quality", `/v1/quality/audits/${auditId}/complete`, {
      method: "POST",
      body: {
        version: 2,
        selfRating: 3,
        actions: [{ questionKey: first?.key, description: "Retrain on MAR", ownerId: LEAD }],
      },
    });
    expect(response.status).toBe(200);
    const audit = await json(response);
    expect(audit).toMatchObject({ state: "completed", selfRating: 3, selfRatingWords: "Good" });
    expect(audit.scorePercent).toBeCloseTo(audit.score.percent, 3);
    const [rate] = await sql<{ value: string }>(
      "SELECT value::text FROM rate_table WHERE key = 'quality.audit.action_due_days' AND tenant_id IS NULL ORDER BY valid_from DESC LIMIT 1",
    );
    const due = new Date(`${today()}T12:00:00Z`);
    due.setUTCDate(due.getUTCDate() + Number(rate?.value));
    expect(audit.actions).toEqual([
      expect.objectContaining({ ownerId: LEAD, dueOn: due.toISOString().slice(0, 10) }),
    ]);
    const tasks = await sql<{ kind: string; assignee_tenant_user_id: string }>(
      "SELECT kind, assignee_tenant_user_id FROM task WHERE source_id = $1",
      [auditId],
    );
    expect(tasks).toEqual([{ kind: "quality.audit_action", assignee_tenant_user_id: LEAD }]);
    const again = await as("quality", `/v1/quality/audits/${auditId}/answers`, {
      method: "PUT",
      body: { version: 3, answers: {} },
    });
    expect(again.status).toBe(409);
  });

  it("counts the completed audit on its schedule", async () => {
    const list = await json(await as("quality", "/v1/quality/audit-schedules"));
    expect(list.items[0]).toMatchObject({ lastCompletedOn: today() });
  });

  it("can be tagged as evidence once completed", async () => {
    const response = await as("quality", "/v1/evidence-links", {
      method: "POST",
      body: {
        recordType: "audit",
        recordId: auditId,
        frameworkVersionId: FW,
        statementIds: ["safe.medicines_optimisation"],
      },
    });
    expect(response.status).toBe(201);
  });

  it("audits every change and refusal", async () => {
    const rows = await sql<{ action: string; outcome: string }>(
      "SELECT action, outcome FROM audit_event WHERE action LIKE 'quality.audit.%'",
    );
    const seen = new Set(rows.map((r) => `${r.action}:${r.outcome}`));
    for (const expected of [
      "quality.audit.template_saved:success",
      "quality.audit.template_saved:denied",
      "quality.audit.scheduled:success",
      "quality.audit.started:success",
      "quality.audit.answered:success",
      "quality.audit.completed:success",
      "quality.audit.completed:denied",
    ]) {
      expect(seen, expected).toContain(expected);
    }
  });
});

describe("mock inspections (rule 14)", () => {
  it("start only against the framework version in force", async () => {
    const created = await as("quality", "/v1/quality/audit-templates", {
      method: "POST",
      body: { key: "mock", starterKey: "mock_inspection" },
    });
    expect(created.status).toBe(201);
    const template = await json(created);
    const started = await as("quality", "/v1/quality/audits", {
      method: "POST",
      body: { templateId: template.id, locationId: DEMO.locationId, auditedOn: today() },
    });
    expect(started.status).toBe(201);
    expect(await json(started)).toMatchObject({ kind: "mock_inspection", frameworkInForce: true });
  });

  it("are refused once a later framework version is in force, while past audits keep theirs", async () => {
    await sql(
      `INSERT INTO framework_version (id, framework_key, regulator, version_number, state, published_on,
         source_name, source_provision, source_url)
       SELECT '0192f1a0-0000-7000-8000-0000000000f2', framework_key, regulator, version_number + 1,
              'published', $1::date, source_name, source_provision, source_url
         FROM framework_version WHERE id = $2`,
      [today(), FW],
    );
    const list = await json(await as("quality", "/v1/quality/audit-templates"));
    const mock = list.items.find((t: { key: string }) => t.key === "mock");
    const started = await as("quality", "/v1/quality/audits", {
      method: "POST",
      body: { templateId: mock.id, locationId: DEMO.locationId, auditedOn: today() },
    });
    expect(started.status).toBe(409);
    expect(JSON.stringify(await json(started))).toMatch(/framework version in force/);
    const audits = await json(await as("quality", "/v1/quality/audits?state=completed"));
    const past = await json(await as("quality", `/v1/quality/audits/${audits.items[0].id}`));
    expect(past).toMatchObject({ frameworkVersionId: FW, frameworkInForce: false });
  });
});
