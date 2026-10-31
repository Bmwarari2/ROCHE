import type {
  ClassifierState,
  IncidentDetail,
  ProblemDetails,
  WorkflowInstanceItem,
  WorkflowInstanceList,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOBILE_APP_ORIGIN } from "../src/auth/token-exposure";
import { eachTenant } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { backfillWorkflowDeadlines } from "../src/services/safety";
import {
  createHarness,
  type Harness,
  LODGE,
  markSessionsVerified,
  OTHER,
  PASSWORD,
} from "./support/harness";

/**
 * The cross-module workflow list for the approvals screen (PLAT-011). The manager raises an
 * incident, so the owner, who also manages incidents, is the one who may approve closing it
 * (separation of duties, safety.md rule 11); the list shows each side that. Steps are taken on the
 * incident's own routes, which this list never replaces.
 */

let h: Harness;
let raised: IncidentDetail;

/**
 * Two invented members whose permissions reach different homes (ADR-0071):
 * - Dee Deputy manages incidents at Harbour House and has an acting-up grant at Harbour Lodge
 *   carrying only safety.notification.submit.
 * - Ned Nightnurse is a team leader (reads incidents) at Harbour House and a clinical lead (manages
 *   them) at Harbour Lodge.
 */
const DEE = "0194d000-0000-7000-8000-0000000003b1";
const NED = "0194d000-0000-7000-8000-0000000003b2";
/**
 * Dina Submitter (#130 review round 2, M1) submits notifications at Harbour House only; under an
 * acting-up grant at the Lodge, since ended, she raised a police incident there.
 */
const DINA = "0194d000-0000-7000-8000-0000000003b3";
const SUBMITTER_ROLE = "0194d000-0000-7000-8000-0000000005b3";
const extra: Record<"dee" | "ned" | "dina", string> = { dee: "", ned: "", dina: "" };
const DAY = 86_400_000;

const MIN = 60_000;
const DEMO_RESIDENT = "0194d000-0000-7000-8600-000000000003";
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

async function asOwner(query: string, params: unknown[] = []) {
  return asDemoTenant(async (c) => (await c.query(query, params)).rows);
}

/** Signs up and in as the mobile app does, links the member and records TOTP enrolment. */
async function member(id: string, name: string, email: string): Promise<string> {
  const signUp = await h.request("/api/auth/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name },
  });
  if (signUp.status !== 200) throw new Error(`sign-up failed: ${signUp.status}`);
  const authId = ((await signUp.json()) as { user: { id: string } }).user.id;
  const signIn = await h.request("/api/auth/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    origin: MOBILE_APP_ORIGIN,
  });
  const token = signIn.headers.get("set-auth-token");
  if (!token) throw new Error("no bearer token returned");
  await asOwner(
    `INSERT INTO tenant_user (id, display_name, email, status, auth_user_id)
     VALUES ($1, $2, $3, 'active', $4)`,
    [id, name, email, authId],
  );
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [authId]);
  await markSessionsVerified(h.db.pool("harbour_auth"));
  return token;
}

async function listAs(token: string, view: "approvals" | "all") {
  const response = await h.request(`/v1/workflows?view=${view}`, { token, tenant: DEMO.tenantId });
  expect(response.status, await response.clone().text()).toBe(200);
  return json<WorkflowInstanceList>(response);
}

async function raiseAt(user: keyof Harness["tokens"], locationId: string, description: string) {
  const response = await as(user, "/v1/incidents", {
    method: "POST",
    body: {
      locationId,
      type: "environmental",
      occurredAt: ago(10 * MIN),
      description,
      people: [],
    },
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return json<IncidentDetail>(response);
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
  extra.dee = await member(DEE, "Dee Deputy", "dee.deputy@example.invalid");
  extra.ned = await member(NED, "Ned Nightnurse", "ned.nightnurse.wf@example.invalid");
  await asOwner(
    `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
     SELECT $1::uuid, id, $3::uuid FROM role WHERE key = 'deputy_manager'
     UNION ALL SELECT $2::uuid, id, $3::uuid FROM role WHERE key = 'team_leader'
     UNION ALL SELECT $2::uuid, id, $4::uuid FROM role WHERE key = 'clinical_lead'`,
    [DEE, NED, DEMO.locationId, LODGE.locationId],
  );
  await asOwner(
    `INSERT INTO access_grant
       (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
     VALUES ($1, '{safety.notification.submit}', $2, $3, $4, 'Acting up at Harbour Lodge', $5)`,
    [
      DEE,
      LODGE.locationId,
      new Date(Date.now() - DAY),
      new Date(Date.now() + DAY),
      DEMO.users.owner.id,
    ],
  );
}, 180_000);

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

  it("hazard HZ-011 never lets a permission held at another home show an incident here", async () => {
    // Dee manages incidents at Harbour House; her Lodge grant carries only notification submission.
    const lodge = await raiseAt("owner", LODGE.locationId, "A Lodge shed door stuck.");
    const house = await raiseAt("owner", DEMO.locationId, "A House gate hinge squeaked.");
    const dee = await listAs(extra.dee, "all");
    expect(forIncident(dee.items, lodge.id)).toBeUndefined();
    expect(forIncident(dee.items, house.id)).toMatchObject({
      awaitingYourApproval: true,
      permissions: ["safety.incident.manage"],
    });
  });

  it("hazard HZ-011 offers closing only where the reader manages incidents", async () => {
    // Ned only reads incidents at Harbour House and manages them at the Lodge.
    const house = await raiseAt("manager", DEMO.locationId, "A House kettle tripped the fuse.");
    const lodge = await raiseAt("owner", LODGE.locationId, "A Lodge tap dripped.");
    const ned = await listAs(extra.ned, "all");
    expect(forIncident(ned.items, house.id)).toBeUndefined();
    const there = forIncident(ned.items, lodge.id);
    expect(there?.moves.map((m) => m.to)).toContain("closed");
    expect(forIncident((await listAs(extra.ned, "approvals")).items, house.id)).toBeUndefined();
  });

  it("hazard HZ-013 carries a statutory notification's own deadline, and warns when it has none", async () => {
    const response = await as("manager", "/v1/incidents", {
      method: "POST",
      body: {
        locationId: DEMO.locationId,
        type: "behaviour",
        occurredAt: ago(2 * DAY),
        description: "Shouted at a visitor in the garden.",
        people: [{ kind: "service_user", role: "affected", personId: DEMO_RESIDENT }],
        answers: [{ key: "police.involved", value: "unsure" }],
      },
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const detail = await json<IncidentDetail>(response);
    const draft = detail.classifier?.notifications.find((n) => n.kind === "cqc_reg18_police");
    expect(draft, "a police notification draft").toBeDefined();
    const notification = await json<{ dueAt: string }>(
      await as("owner", `/v1/notifications/statutory/${draft?.id}`),
    );
    const listed = (await list("owner", "all")).items.find((i) => i.subjectId === draft?.id);
    expect(listed?.slaDueAt).toBe(new Date(notification.dueAt).toISOString());
    expect(listed?.slaState).toBe(
      Date.parse(notification.dueAt) <= Date.now() ? "overdue" : listed?.slaState,
    );
    expect(listed?.slaState).not.toBe("none");

    // An instance started before the module wrote the deadline warns and comes first.
    await asOwner("UPDATE workflow_instance SET sla_due_at = NULL WHERE subject_id = $1", [
      draft?.id,
    ]);
    const all = (await list("owner", "all")).items;
    expect(all[0]).toMatchObject({ subjectId: draft?.id, slaState: "on_record" });

    // The backfill fills it from the notification's own clock, and running it again changes nothing.
    const appPool = createPool(h.db.url("harbour_app"));
    try {
      const deps = {
        workerPool: h.db.pool("harbour_worker"),
        appDb: createDatabase(appPool),
        logger: createLogger("silent"),
      };
      expect(await eachTenant(deps, "test", backfillWorkflowDeadlines)).toBeGreaterThanOrEqual(1);
      expect(await eachTenant(deps, "test", backfillWorkflowDeadlines)).toBe(0);
    } finally {
      await appPool.end();
    }
    const filled = (await list("owner", "all")).items.find((i) => i.subjectId === draft?.id);
    expect(filled?.slaDueAt).toBe(new Date(notification.dueAt).toISOString());
  });

  it("hazard HZ-013 never lets the raiser of an incident at another home submit or decline its notification", async () => {
    extra.dina = await member(DINA, "Dina Submitter", "dina.submitter@example.invalid");
    await asOwner(
      `INSERT INTO role (id, key, name, scope_kind, permissions)
       VALUES ($1, 'test_submitter', 'Notification submitter', 'location',
               '{safety.notification.submit,safety.incident.read,safety.incident.report}')`,
      [SUBMITTER_ROLE],
    );
    await asOwner(
      "INSERT INTO role_assignment (tenant_user_id, role_id, location_id) VALUES ($1, $2, $3)",
      [DINA, SUBMITTER_ROLE, DEMO.locationId],
    );
    const [grant] = await asOwner(
      `INSERT INTO access_grant
         (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
       VALUES ($1, '{safety.incident.report,safety.incident.read,safety.incident.manage}', $2, $3, $4,
               'Acting up at Harbour Lodge', $5)
       RETURNING id`,
      [
        DINA,
        LODGE.locationId,
        new Date(Date.now() - DAY),
        new Date(Date.now() + DAY),
        DEMO.users.owner.id,
      ],
    );
    const raisedThere = await h.request("/v1/incidents", {
      token: extra.dina,
      tenant: DEMO.tenantId,
      method: "POST",
      body: {
        locationId: LODGE.locationId,
        type: "environmental",
        occurredAt: ago(30 * MIN),
        description: "Someone tried the Lodge back door at night.",
        people: [],
        answers: [{ key: "police.involved", value: "yes" }],
      },
    });
    expect(raisedThere.status, await raisedThere.clone().text()).toBe(201);
    const lodgeIncident = await json<IncidentDetail>(raisedThere);
    const police = lodgeIncident.classifier?.notifications.find(
      (n) => n.kind === "cqc_reg18_police",
    );
    expect(police, "a police notification draft about nobody").toBeDefined();
    // The grant ends; she still holds notification submission, at Harbour House only.
    await asOwner("UPDATE access_grant SET revoked_at = now() WHERE id = $1", [grant?.id]);

    const listed = await listAs(extra.dina, "all");
    expect(listed.items.some((i) => i.subjectId === police?.id)).toBe(false);
    const detail = await json<{ version: number }>(
      await as("owner", `/v1/notifications/statutory/${police?.id}`),
    );
    const notRequired = await h.request(`/v1/notifications/statutory/${police?.id}/not-required`, {
      token: extra.dina,
      tenant: DEMO.tenantId,
      method: "POST",
      body: { reason: "Not a notifiable event here.", version: detail.version },
    });
    expect(notRequired.status, await notRequired.clone().text()).toBe(403);
    const submit = await h.request(`/v1/notifications/statutory/${police?.id}/submit`, {
      token: extra.dina,
      tenant: DEMO.tenantId,
      method: "POST",
      body: {
        submittedAt: ago(MIN),
        externalReference: "CQC-EXAMPLE-1",
        version: detail.version,
      },
    });
    expect(submit.status, await submit.clone().text()).toBe(403);
  });

  it("hazard HZ-091 never lets a manager move an incident they raised at another home", async () => {
    // Dee manages incidents at Harbour House; under a grant at the Lodge, since ended, she raised
    // an incident about nobody there.
    const [grant] = await asOwner(
      `INSERT INTO access_grant
         (tenant_user_id, permissions, location_id, valid_from, valid_to, reason, granted_by)
       VALUES ($1, '{safety.incident.report,safety.incident.read,safety.incident.manage}', $2, $3,
               $4, 'Acting up at Harbour Lodge', $5)
       RETURNING id`,
      [
        DEE,
        LODGE.locationId,
        new Date(Date.now() - DAY),
        new Date(Date.now() + DAY),
        DEMO.users.owner.id,
      ],
    );
    const raisedThere = await h.request("/v1/incidents", {
      token: extra.dee,
      tenant: DEMO.tenantId,
      method: "POST",
      body: {
        locationId: LODGE.locationId,
        type: "environmental",
        occurredAt: ago(30 * MIN),
        description: "A Lodge radiator leaked.",
        people: [],
      },
    });
    expect(raisedThere.status, await raisedThere.clone().text()).toBe(201);
    const lodgeIncident = await json<IncidentDetail>(raisedThere);
    await asOwner("UPDATE access_grant SET revoked_at = now() WHERE id = $1", [grant?.id]);
    expect(forIncident((await listAs(extra.dee, "all")).items, lodgeIncident.id)).toBeUndefined();
    const review = await h.request(`/v1/incidents/${lodgeIncident.id}/review`, {
      token: extra.dee,
      tenant: DEMO.tenantId,
      method: "POST",
      body: { to: "under_review", version: lodgeIncident.version },
    });
    expect(review.status, await review.clone().text()).toBe(403);
  });

  it("hazard HZ-013 writes the candour clocks onto the workflow on the record and each step", async () => {
    const decidedAt = new Date(Date.now() - 2 * 60 * MIN);
    const raisedCandour = await json<IncidentDetail>(
      await as("manager", "/v1/incidents", {
        method: "POST",
        body: {
          locationId: DEMO.locationId,
          type: "medication",
          occurredAt: ago(3 * 60 * MIN),
          description: "A dose was given an hour late.",
          people: [
            {
              kind: "service_user",
              role: "affected",
              personId: "0194d000-0000-7000-8600-000000000004",
            },
          ],
          answers: [],
        },
      }),
    );
    const put = await as("manager", `/v1/incidents/${raisedCandour.id}/candour`, {
      method: "PUT",
      body: {
        personId: "0194d000-0000-7000-8600-000000000004",
        threshold: {
          notifiable: true,
          decidedAt: decidedAt.toISOString(),
          decidedBy: "Dr Example, GP",
        },
        version: 0,
      },
    });
    expect(put.status, await put.clone().text()).toBe(200);
    const record = (await json<{ record: { id: string; version: number } }>(put)).record;
    const deadline = async () =>
      (
        await asOwner("SELECT sla_due_at, state FROM workflow_instance WHERE subject_id = $1", [
          record.id,
        ])
      )[0] as { sla_due_at: Date | null; state: string };
    // Telling the person is due from the threshold decision.
    expect((await deadline()).sla_due_at?.toISOString()).toBe(decidedAt.toISOString());
    const step = await as("manager", `/v1/incidents/${raisedCandour.id}/candour/step`, {
      method: "POST",
      body: { to: "verbal_due", version: record.version },
    });
    expect(step.status, await step.clone().text()).toBe(200);
    expect(await deadline()).toMatchObject({ state: "verbal_due" });
    expect((await deadline()).sla_due_at?.toISOString()).toBe(decidedAt.toISOString());
    const listed = (await list("owner", "all")).items.find((i) => i.subjectId === record.id);
    expect(listed).toMatchObject({ slaState: "overdue", slaDueAt: decidedAt.toISOString() });

    // Enquiries open carry no deadline: "none", not the warning, and not listed first.
    await asOwner(
      "UPDATE workflow_instance SET state = 'enquiries_open', sla_due_at = NULL WHERE subject_id = $1",
      [record.id],
    );
    const all = (await list("owner", "all")).items;
    expect(all.find((i) => i.subjectId === record.id)?.slaState).toBe("none");
    expect(all[0]?.subjectId).not.toBe(record.id);
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
