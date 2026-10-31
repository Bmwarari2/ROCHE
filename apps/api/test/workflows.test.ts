import type {
  ClassifierState,
  IncidentDetail,
  ProblemDetails,
  WorkflowInstanceItem,
  WorkflowInstanceList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * The cross-module workflow list for the approvals screen (PLAT-011). The manager raises an
 * incident, so the owner, who also manages incidents, is the one who may approve closing it
 * (separation of duties, safety.md rule 11); the list shows each side that. Steps are taken on the
 * incident's own routes, which this list never replaces.
 */

let h: Harness;
let raised: IncidentDetail;

const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown; tenant?: string } = {},
) => h.request(path, { token: h.tokens[user], tenant: init.tenant ?? DEMO.tenantId, ...init });

async function list(user: keyof Harness["tokens"], view?: "approvals" | "all") {
  const response = await as(user, `/v1/workflows${view ? `?view=${view}` : ""}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return json<WorkflowInstanceList>(response);
}

const forIncident = (items: readonly WorkflowInstanceItem[], id: string) =>
  items.find((i) => i.subjectType === "incident" && i.subjectId === id);

async function asDemoTenant<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await h.db.pool("harbour_owner").connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
      [DEMO.tenantId],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } finally {
    client.release();
  }
}

/** Answers every open classifier question "nothing to report", as a manager would before closing. */
async function answerEverything(incidentId: string) {
  for (let round = 0; round < 6; round++) {
    const state = await json<ClassifierState>(
      await as("owner", `/v1/incidents/${incidentId}/classifier`),
    );
    const open = state.result?.openQuestions ?? [];
    if (open.length === 0) return;
    const answers = open.map((q) => ({
      key: q.key,
      value:
        q.kind === "yes_no_unsure"
          ? "no"
          : q.kind === "days" || q.kind === "hours"
            ? 0
            : q.kind === "choice"
              ? "none"
              : ["none"],
    }));
    const response = await as("owner", `/v1/incidents/${incidentId}/classifier`, {
      method: "POST",
      body: { answers },
    });
    expect(response.status).toBe(200);
  }
  throw new Error("questions kept coming");
}

beforeAll(async () => {
  h = await createHarness();
  const response = await as("manager", "/v1/incidents", {
    method: "POST",
    body: {
      locationId: DEMO.locationId,
      type: "environmental",
      occurredAt: ago(30 * MIN),
      description: "A window catch in the lounge came loose.",
      people: [],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  raised = await json<IncidentDetail>(response);
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("PLAT-011 open workflows and approvals", () => {
  it("shows another manager the incident as waiting for their approval", async () => {
    const { items } = await list("owner");
    const item = forIncident(items, raised.id);
    expect(item).toMatchObject({
      definitionKey: "safety.incident",
      state: "open",
      awaitingYourApproval: true,
      raisedByYou: false,
      slaState: "none",
      createdBy: { id: DEMO.users.manager.id, displayName: "Mo Manager" },
    });
    expect(item?.moves).toEqual([
      { to: "under_review", approval: false, requiresReason: false, requiresStepUp: false },
      { to: "closed", approval: true, requiresReason: true, requiresStepUp: false },
    ]);
  });

  it("hazard HZ-091 never offers the person who raised it the approval, and says so", async () => {
    const { items } = await list("manager");
    const item = forIncident(items, raised.id);
    expect(item).toMatchObject({ awaitingYourApproval: false, raisedByYou: true });
    expect(item?.moves.map((m) => m.to)).toEqual(["under_review"]);
  });

  it("reads the deadline of the state the record is in", async () => {
    await asDemoTenant((c) =>
      c.query(
        "UPDATE workflow_instance SET sla_due_at = now() - interval '1 hour' WHERE subject_id = $1",
        [raised.id],
      ),
    );
    const item = forIncident((await list("owner")).items, raised.id);
    expect(item?.slaState).toBe("overdue");
    expect(item?.slaDueAt).not.toBeNull();
  });

  it("lists every open workflow with view=all, approvals or not", async () => {
    const approvals = await list("owner", "approvals");
    const all = await list("owner", "all");
    expect(all.items.length).toBeGreaterThanOrEqual(approvals.items.length);
    expect(forIncident(all.items, raised.id)).toBeDefined();
  });

  it("drops a record once its workflow is finished", async () => {
    // A second incident, closed by the owner on its own route, leaves the list.
    const second = await json<IncidentDetail>(
      await as("manager", "/v1/incidents", {
        method: "POST",
        body: {
          locationId: DEMO.locationId,
          type: "environmental",
          occurredAt: ago(20 * MIN),
          description: "A door closer in the corridor was slow.",
          people: [],
        },
      }),
    );
    await answerEverything(second.id);
    const current = await json<IncidentDetail>(await as("owner", `/v1/incidents/${second.id}`));
    const closed = await as("owner", `/v1/incidents/${second.id}/close`, {
      method: "POST",
      body: { reason: "The closer was adjusted.", version: current.version },
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect(forIncident((await list("owner", "all")).items, second.id)).toBeUndefined();
  });

  it("refuses someone with no part in any listed workflow", async () => {
    // The care worker reports and reads incidents but takes no workflow step.
    expect((await as("carer", "/v1/workflows")).status).toBe(403);
  });

  it("asks for MFA first, as for the records it lists", async () => {
    const response = await as("nurse", "/v1/workflows");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it("hides an incident at a home the reader's role does not reach", async () => {
    // The owner raises one at the Lodge; the Registered Manager covers Harbour House only.
    const response = await as("owner", "/v1/incidents", {
      method: "POST",
      body: {
        locationId: LODGE.locationId,
        type: "environmental",
        occurredAt: ago(10 * MIN),
        description: "A gate latch at the Lodge stuck.",
        people: [],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const lodge = await json<IncidentDetail>(response);
    expect(forIncident((await list("manager", "all")).items, lodge.id)).toBeUndefined();
    expect(forIncident((await list("owner", "all")).items, lodge.id)).toBeDefined();
  });

  it("never shows another organisation's workflows", async () => {
    // An open incident workflow in the other organisation, written past the API.
    const client = await h.db.pool("harbour_owner").connect();
    const foreign = crypto.randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [OTHER.tenantId]);
      await client.query(
        `INSERT INTO workflow_instance (definition_key, definition_version, subject_type,
                                        subject_id, state)
         VALUES ('safety.incident', 1, 'incident', $1, 'open')`,
        [foreign],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const { items } = await list("owner", "all");
    expect(items.some((i) => i.subjectId === foreign)).toBe(false);
  });

  it("records the view in the audit trail without content", async () => {
    const events = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ scope: Record<string, unknown> }>(
        "SELECT scope FROM audit_event WHERE action = 'platform.workflow.list'",
      );
      return rows;
    });
    expect(events.length).toBeGreaterThan(0);
    expect(Object.keys(events[0]?.scope ?? {})).toEqual(expect.arrayContaining(["view", "count"]));
  });
});
