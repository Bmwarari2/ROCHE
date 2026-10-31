import type {
  AuditList,
  BodyMapMarkItem,
  CandourView,
  ClassifierState,
  IncidentDetail,
  IncidentList,
  InvestigationView,
  ProblemDetails,
  StatutoryNotificationDetail,
  StatutoryNotificationList,
  TaskList,
} from "@harbour/contracts";
import { ClassifierQuestionKey, IncidentType, StatutoryNotificationKind } from "@harbour/contracts";
import { createDatabase, createPool, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import {
  CLASSIFIER_QUESTION_KEYS,
  CLASSIFIER_QUESTIONS,
  CLASSIFIER_VERSION,
  INCIDENT_TYPES,
  STATUTORY_NOTIFICATION_KINDS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  detectOutbreaks,
  escalateStatutoryNotifications,
  raiseCandourBlocked,
  reportUnroutedDaily,
  runEscalations,
  type TaskDeps,
  UNROUTED_ACTIONS,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { submitHolders } from "../src/services/safety";
import { ageSession, createHarness, type Harness, LODGE, OTHER } from "./support/harness";

/**
 * Slice 7 through the API: incidents, the classifier on the server, statutory notifications with
 * their clocks, step-up submission, separation of duties, candour, investigations, the post-fall
 * checklist and outbreak detection. Demo residents 1 to 3 are assigned to the care worker; the
 * Registered Manager covers Harbour House; the owner is tenant-wide; the nurse has no MFA.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

beforeAll(async () => {
  h = await createHarness();
  appPool = createPool(h.db.url("harbour_app"));
  deps = {
    workerPool: h.db.pool("harbour_worker"),
    appDb: createDatabase(appPool),
    logger: createLogger("silent"),
  };
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });

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

async function setSessionAge(user: keyof Harness["tokens"], minutes: number) {
  await ageSession(h.db.pool("harbour_auth"), h.tokens[user]?.split(".")[0] ?? "", minutes * 60);
}

interface IncidentInput {
  readonly type?: string;
  readonly description?: string;
  readonly occurredAt?: string;
  readonly deviceTime?: string;
  readonly people?: readonly Record<string, unknown>[];
  readonly answers?: readonly { key: string; value: unknown }[];
  readonly id?: string;
  readonly locationId?: string;
  readonly foundAt?: string;
}

const affected = (n: number, extra: Record<string, unknown> = {}) => ({
  kind: "service_user",
  role: "affected",
  personId: resident(n),
  ...extra,
});

async function record(user: keyof Harness["tokens"], input: IncidentInput) {
  const response = await as(user, "/v1/incidents", {
    method: "POST",
    body: {
      locationId: DEMO.locationId,
      type: "fall",
      occurredAt: ago(30 * MIN),
      description: "Found on the floor beside the bed.",
      ...input,
    },
  });
  return response;
}

async function created(user: keyof Harness["tokens"], input: IncidentInput) {
  const response = await record(user, input);
  if (response.status !== 201) throw new Error(`${response.status} ${await response.text()}`);
  return json<IncidentDetail>(response);
}

/** Answers every open question with the "nothing to report" answer until none are left. */
async function answerEverything(incidentId: string, user: keyof Harness["tokens"] = "manager") {
  for (let round = 0; round < 6; round++) {
    const state = await json<ClassifierState>(
      await as(user, `/v1/incidents/${incidentId}/classifier`),
    );
    const open = state.result?.openQuestions ?? [];
    if (open.length === 0) return state;
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
    const response = await as(user, `/v1/incidents/${incidentId}/classifier`, {
      method: "POST",
      body: { answers },
    });
    expect(response.status).toBe(200);
  }
  throw new Error("questions kept coming");
}

const incidentTasks = (incidentId: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{
      kind: string;
      status: string;
      due_at: Date;
      window_end: Date | null;
      person_id: string | null;
      priority: string;
    }>(
      `SELECT kind, status, due_at, window_end, person_id, priority FROM task
       WHERE source_type = 'incident' AND source_id = $1 ORDER BY due_at, kind`,
      [incidentId],
    );
    return rows;
  });

const outboxEvents = (type: string, aggregateId: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{ payload: Record<string, unknown> }>(
      "SELECT payload FROM outbox_event WHERE event_type = $1 AND aggregate_id = $2",
      [type, aggregateId],
    );
    return rows.map((r) => r.payload);
  });

const rate = (key: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{ value: string }>(
      "SELECT value FROM rate_table WHERE key = $1 AND tenant_id IS NULL ORDER BY valid_from DESC LIMIT 1",
      [key],
    );
    return Number(rows[0]?.value);
  });

describe("contract enumerations stay in step with the domain rules", () => {
  it.each([
    ["IncidentType", IncidentType.options, INCIDENT_TYPES],
    ["ClassifierQuestionKey", ClassifierQuestionKey.options, CLASSIFIER_QUESTION_KEYS],
    ["StatutoryNotificationKind", StatutoryNotificationKind.options, STATUTORY_NOTIFICATION_KINDS],
  ] as const)("%s", (_name, contract, domain) => {
    expect([...contract]).toEqual([...domain]);
  });
});

describe("permissions on every incident route", () => {
  it("lets a care worker report about their own people only", async () => {
    expect((await record("carer", { people: [affected(1)] })).status).toBe(201);
    expect((await record("carer", { people: [affected(5)] })).status).toBe(404);
  });

  it("asks for MFA to report about a person, but not to report a person-free incident", async () => {
    const aboutAda = await record("nurse", { people: [affected(1)] });
    expect((await json<ProblemDetails>(aboutAda)).code).toBe("mfa_enrolment_required");
    expect((await record("nurse", { type: "environmental", people: [] })).status).toBe(201);
  });

  it("asks for MFA before anyone reads incidents (a care-record permission)", async () => {
    const response = await as("nurse", "/v1/incidents");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it.each([
    ["GET", "/v1/notifications/statutory"],
    ["POST", "/v1/incidents/{id}/close"],
    ["POST", "/v1/incidents/{id}/review"],
    ["PUT", "/v1/incidents/{id}/candour"],
    ["PUT", "/v1/incidents/{id}/investigation"],
  ])("refuses a care worker %s %s", async (method, path) => {
    const incident = await created("carer", { people: [affected(2)] });
    const response = await as("carer", path.replace("{id}", incident.id), {
      method,
      body: method === "GET" ? undefined : { version: 1, reason: "Done here", to: "under_review" },
    });
    expect(response.status).toBe(403);
  });

  it("lets the quality lead read incidents but not manage them, and needs MFA for every read", async () => {
    const incident = await created("manager", { people: [affected(1)] });
    const reads = [
      `/v1/incidents/${incident.id}`,
      `/v1/incidents/${incident.id}/classifier`,
      `/v1/incidents/${incident.id}/candour`,
      `/v1/incidents/${incident.id}/investigation`,
    ];
    for (const path of reads) {
      expect({ path, status: (await as("quality", path)).status }).toEqual({ path, status: 200 });
      const nurse = await as("nurse", path);
      expect({ path, code: (await json<ProblemDetails>(nurse)).code }).toEqual({
        path,
        code: "mfa_enrolment_required",
      });
    }
    for (const path of ["/v1/notifications/statutory", "/v1/dols/legal-change-review"]) {
      expect({ path, status: (await as("quality", path)).status }).toEqual({ path, status: 403 });
    }
    const write = await as("quality", `/v1/incidents/${incident.id}/candour`, {
      method: "PUT",
      body: { version: 0 },
    });
    expect(write.status).toBe(403);
  });

  it("refuses a care worker answering the manager's questions, but takes the falls answers", async () => {
    const incident = await created("carer", { people: [affected(1)] });
    const managers = await as("carer", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: { answers: [{ key: "safeguarding.concern", value: "no" }] },
    });
    expect(managers.status).toBe(403);
    const falls = await as("carer", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: { answers: [{ key: "falls.head_injury", value: "no" }] },
    });
    expect(falls.status).toBe(200);
  });

  it("hides another tenant's incidents and refuses non-members", async () => {
    const incident = await created("manager", { people: [affected(4)] });
    // The other provider's manager may read incidents there, so only isolation can hide this one.
    const client = await h.db.pool("harbour_owner").connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
        [OTHER.tenantId],
      );
      await client.query(
        "UPDATE role SET permissions = array_append(permissions, 'safety.incident.read') WHERE key = 'registered_manager'",
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(
      (
        await h.request(`/v1/incidents/${incident.id}`, {
          token: h.tokens.rae,
          tenant: OTHER.tenantId,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(`/v1/incidents/${incident.id}`, {
          token: h.tokens.rae,
          tenant: DEMO.tenantId,
        })
      ).status,
    ).toBe(403);
  });
});

describe("hazard HZ-013 the classifier runs on the server", () => {
  it("stores the classifier version and reasoning, and asks the open questions", async () => {
    const incident = await created("manager", { type: "behaviour", people: [affected(3)] });
    expect(incident.classifier?.classifierVersion).toBe(CLASSIFIER_VERSION);
    expect(incident.classifier?.nationSupported).toBe(true);
    expect(incident.classifier?.reasoning.length).toBe(STATUTORY_NOTIFICATION_KINDS.length);
    expect(incident.classifier?.openQuestions.map((q) => q.key)).toEqual(
      expect.arrayContaining(["safeguarding.concern", "police.involved"]),
    );
    expect(incident.classifier?.openQuestions[0]?.text).toBe(
      CLASSIFIER_QUESTIONS[incident.classifier?.openQuestions[0]?.key ?? "police.involved"].text,
    );
    const answer = (await incidentTasks(incident.id)).find(
      (t) => t.kind === "safety.answer_classifier_questions",
    );
    // The task to answer is due when the incident happened.
    expect(answer?.due_at.toISOString()).toBe(incident.occurredAt.replace("+00:00", "Z"));
  });

  it("drafts a provisional notification for 'not sure' and closes the answer task when all are answered", async () => {
    const incident = await created("manager", { type: "behaviour", people: [affected(3)] });
    const unsure = await json<ClassifierState>(
      await as("manager", `/v1/incidents/${incident.id}/classifier`, {
        method: "POST",
        body: { answers: [{ key: "police.involved", value: "unsure" }] },
      }),
    );
    const police = unsure.result?.notifications.find((n) => n.kind === "cqc_reg18_police");
    expect(police).toMatchObject({ provisional: true, status: "draft", clock: "overdue" });
    await answerEverything(incident.id);
    const tasks = await incidentTasks(incident.id);
    expect(tasks.find((t) => t.kind === "safety.answer_classifier_questions")?.status).toBe("done");
    await as("manager", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: { answers: [{ key: "police.involved", value: "no" }] },
    });
    // "No" now: the draft stays until a person marks it not required (never closed by the rules).
    const detail = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incident.id}`));
    expect(
      detail.classifier?.notifications.find((n) => n.kind === "cqc_reg18_police"),
    ).toMatchObject({ status: "draft", noLongerIndicated: true });
  });

  it("hazard HZ-013 an incident recorded offline that syncs late runs its clocks from occurred_at", async () => {
    const occurredAt = ago(6 * HOUR);
    const incident = await created("carer", {
      occurredAt,
      deviceTime: occurredAt,
      people: [affected(2, { died: true })],
    });
    expect(incident.lateEntry).toBe(false);
    const death = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg16_death");
    expect(death?.dueAt).toBe(new Date(occurredAt).toISOString());
    expect(death?.clock).toBe("overdue");
    expect(incident.classifier?.notifications.map((n) => n.kind)).toEqual(
      expect.arrayContaining(["cqc_reg16_death", "medical_examiner"]),
    );
    const recorded = await outboxEvents("safety.incident.recorded", incident.id);
    expect(recorded).toEqual([expect.objectContaining({ incidentId: incident.id })]);
    expect(await outboxEvents("safety.notification.due", death?.id ?? "")).toHaveLength(1);
  });

  it("hazard HZ-013 ignores an offline incident replayed with the same device id", async () => {
    const id = newId();
    const first = await created("carer", { id, people: [affected(1)] });
    const again = await created("carer", { id, people: [affected(1)], type: "skin" });
    expect(again.id).toBe(first.id);
    expect(again.type).toBe("fall");
    expect(await outboxEvents("safety.incident.recorded", id)).toHaveLength(1);
    const count = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM incident_person WHERE incident_id = $1",
        [id],
      );
      return rows[0]?.n;
    });
    expect(count).toBe(1);
  });

  it("hazard HZ-013 returns nationSupported false outside England and does not guess", async () => {
    const wales = "0194d000-0000-7000-8000-000000000177";
    await asDemoTenant((c) =>
      c.query(
        "INSERT INTO location (id, name, nation, regulator) VALUES ($1, 'Harbour Cymru', 'wales', 'ciw')",
        [wales],
      ),
    );
    const incident = await created("owner", {
      locationId: wales,
      type: "environmental",
      people: [],
    });
    expect(incident.classifier?.nationSupported).toBe(false);
    expect(incident.classifier?.outputs).toEqual([]);
    expect(incident.classifier?.notifications).toEqual([]);
    expect(incident.classifier?.reasoning[0]).toMatch(/not checked/);
  });
});

describe("hazard HZ-027 the post-fall checklist", () => {
  it("hazard HZ-027 a fall creates the post-fall tasks with the observation schedule, shortened for a head injury", async () => {
    const occurredAt = ago(10 * MIN);
    const incident = await created("carer", {
      occurredAt,
      people: [affected(1)],
      answers: [
        { key: "falls.head_injury", value: "yes" },
        { key: "falls.anticoagulant", value: "no" },
      ],
    });
    const tasks = await incidentTasks(incident.id);
    const observations = tasks.filter((t) => t.kind === "safety.post_fall_observation");
    const firstInterval = await rate("falls.head_injury_obs.phase_1_interval_minutes");
    const monitoringHours = await rate("falls.monitoring_hours");
    expect(observations.length).toBeGreaterThan(monitoringHours / 2);
    expect(observations[0]?.due_at.getTime()).toBe(Date.parse(occurredAt) + firstInterval * MIN);
    expect(observations.at(-1)?.due_at.getTime()).toBe(
      Date.parse(occurredAt) + monitoringHours * HOUR,
    );
    expect(observations.every((t) => t.person_id === resident(1) && t.priority === "urgent")).toBe(
      true,
    );
    expect(tasks.map((t) => t.kind)).toEqual(
      expect.arrayContaining([
        "safety.post_fall_injury_check",
        "safety.urgent_medical_advice",
        "safety.gp_contact",
        "safety.ng249_falls_pathway",
        "safety.bone_health_review",
      ]),
    );
    expect(tasks.map((t) => t.kind)).not.toContain("safety.post_fall_monitoring");
  });

  it("hazard HZ-027 ruling out both risks replaces the timed observations with general monitoring", async () => {
    const incident = await created("carer", { people: [affected(2)] });
    // Unanswered counts as a head injury, so the timed schedule starts straight away.
    expect(
      (await incidentTasks(incident.id)).some((t) => t.kind === "safety.post_fall_observation"),
    ).toBe(true);
    await as("carer", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: {
        answers: [
          { key: "falls.head_injury", value: "no" },
          { key: "falls.anticoagulant", value: "no" },
        ],
      },
    });
    const tasks = await incidentTasks(incident.id);
    expect(
      tasks
        .filter((t) => t.kind === "safety.post_fall_observation")
        .every((t) => t.status === "cancelled"),
    ).toBe(true);
    expect(tasks.find((t) => t.kind === "safety.post_fall_monitoring")?.status).toBe("open");
    expect(tasks.find((t) => t.kind === "safety.urgent_medical_advice")?.status).toBe("cancelled");
  });

  it("hazard HZ-027 counts the observations from when an unwitnessed fall was found", async () => {
    const occurredAt = ago(3 * HOUR);
    const foundAt = ago(1 * HOUR);
    const incident = await created("carer", {
      occurredAt,
      foundAt,
      people: [affected(3)],
      answers: [{ key: "falls.head_injury", value: "yes" }],
    });
    const firstInterval = await rate("falls.head_injury_obs.phase_1_interval_minutes");
    const first = (await incidentTasks(incident.id)).find(
      (t) => t.kind === "safety.post_fall_observation",
    );
    expect(first?.due_at.getTime()).toBe(Date.parse(foundAt) + firstInterval * MIN);
  });

  it("shows the post-fall tasks to the care worker on their task list", async () => {
    const incident = await created("carer", { people: [affected(1)] });
    const list = await json<TaskList>(await as("carer", `/v1/tasks?personId=${resident(1)}`));
    expect(list.items.some((t) => t.kind === "safety.post_fall_injury_check")).toBe(true);
    expect(incident.id).toBeTruthy();
  });
});

describe("hazard HZ-011 incident scope across people (ADR-0033)", () => {
  it("hazard HZ-011 shows a care worker the header and their own person only", async () => {
    const incident = await created("owner", {
      type: "behaviour",
      description: "Disagreement in the lounge.",
      people: [affected(1), affected(5, { role: "involved" })],
    });
    const seen = await json<IncidentDetail>(await as("carer", `/v1/incidents/${incident.id}`));
    expect(seen).toMatchObject({ restricted: true, description: null, classifier: null });
    expect(seen.people.map((p) => p.personId)).toEqual([resident(1)]);
    const list = await json<IncidentList>(await as("carer", "/v1/incidents"));
    expect(list.items.find((i) => i.id === incident.id)?.restricted).toBe(true);
    const full = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incident.id}`));
    expect(full.restricted).toBe(false);
    expect(full.people).toHaveLength(2);
    // A care worker cannot change or answer for an incident they cannot see in full.
    expect(
      (
        await as("carer", `/v1/incidents/${incident.id}/classifier`, {
          method: "POST",
          body: { answers: [{ key: "falls.head_injury", value: "no" }] },
        })
      ).status,
    ).toBe(403);
  });

  it("hides an incident about someone outside the Registered Manager's location", async () => {
    const incident = await created("owner", {
      type: "injury",
      people: [{ kind: "service_user", role: "affected", personId: LODGE.personId }],
    });
    expect((await as("manager", `/v1/incidents/${incident.id}`)).status).toBe(404);
    expect((await as("quality", `/v1/incidents/${incident.id}`)).status).toBe(200);
  });

  it("lets the Registered Manager see a person-free incident at their location", async () => {
    const incident = await created("owner", { type: "environmental", people: [] });
    expect((await as("manager", `/v1/incidents/${incident.id}`)).status).toBe(200);
    expect((await as("carer", `/v1/incidents/${incident.id}`)).status).toBe(404);
  });
});

describe("hazard HZ-019 body-map marks on an incident", () => {
  const mark = (incidentId: string) => ({
    occurredAt: ago(5 * MIN),
    view: "front",
    region: "forearm",
    // The person's left forearm on the front view: the right of the drawing as seen.
    drawnAt: { x: 95, y: 100 },
    drawnSide: "left",
    side: "left",
    markType: "bruise",
    bruiseExplained: true,
    incidentId,
  });

  it("hazard HZ-019 links a mark recorded for the incident and refuses one for someone not on it", async () => {
    const incident = await created("carer", { people: [affected(1)] });
    const ok = await as("carer", `/v1/people/${resident(1)}/body-map`, {
      method: "POST",
      body: mark(incident.id),
    });
    expect(ok.status).toBe(201);
    expect((await json<BodyMapMarkItem>(ok)).incidentId).toBe(incident.id);
    const wrong = await as("carer", `/v1/people/${resident(2)}/body-map`, {
      method: "POST",
      body: mark(incident.id),
    });
    expect(wrong.status).toBe(422);
  });

  it("feeds pressure ulcers from linked marks into the classifier", async () => {
    const ulcer = await json<BodyMapMarkItem>(
      await as("manager", `/v1/people/${resident(4)}/body-map`, {
        method: "POST",
        body: {
          occurredAt: ago(5 * MIN),
          view: "back",
          region: "sacrum",
          drawnZone: "centre",
          drawnSide: "midline",
          side: "midline",
          markType: "pressure_ulcer",
          pressureCategory: "category_3",
          deviceRelated: false,
        },
      }),
    );
    const incident = await created("manager", {
      type: "skin",
      people: [affected(4, { bodyMapMarkIds: [ulcer.id] })],
    });
    const guide = (await incidentTasks(incident.id)).find(
      (t) => t.kind === "safety.safeguarding_decision_guide",
    );
    expect(guide?.person_id).toBe(resident(4));
  });
});

describe("statutory notifications: clocks, step-up and escalation", () => {
  let notificationId = "";
  let version = 0;

  it("lists drafts with their clocks for the Registered Manager", async () => {
    const incident = await created("manager", {
      people: [affected(6, { died: true })],
      occurredAt: ago(2 * HOUR),
    });
    const list = await json<StatutoryNotificationList>(
      await as("manager", `/v1/notifications/statutory?incidentId=${incident.id}`),
    );
    const death = list.items.find((n) => n.kind === "cqc_reg16_death");
    expect(death).toMatchObject({
      status: "draft",
      clock: "overdue",
      statutory: true,
      recipient: "Care Quality Commission",
    });
    notificationId = death?.id ?? "";
    version = death?.version ?? 0;
    const overdue = await json<StatutoryNotificationList>(
      await as("manager", "/v1/notifications/statutory?clock=overdue"),
    );
    expect(overdue.items.some((n) => n.id === notificationId)).toBe(true);
  });

  it("hazard HZ-013 an overdue notification escalates through the chain until it is submitted", async () => {
    expect(await escalateStatutoryNotifications(deps)).toBeGreaterThan(0);
    expect(await escalateStatutoryNotifications(deps)).toBe(0);
    const alerts = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ recipient: string; chain: string | null; ack: Date | null }>(
        `SELECT recipient_tenant_user_id AS recipient, escalation_chain_id AS chain, acknowledged_at AS ack
         FROM notification WHERE source_type = 'statutory_notification' AND source_id = $1`,
        [notificationId],
      );
      return rows;
    });
    expect(alerts.map((a) => a.recipient).sort()).toEqual(
      [DEMO.users.manager.id, DEMO.users.owner.id].sort(),
    );
    expect(alerts.every((a) => a.chain !== null)).toBe(true);
    expect(await outboxEvents("safety.notification.overdue", notificationId)).toHaveLength(1);
    // The chain's first step tells the Nominated Individual (owner) after the rate table's minutes.
    const minutes = await rate("statutory_notification.escalation_minutes");
    expect(await runEscalations(deps, new Date(Date.now() + (minutes + 1) * MIN))).toBeGreaterThan(
      0,
    );
    const escalated = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ title: string }>(
        `SELECT title FROM notification WHERE source_type = 'notification' AND recipient_tenant_user_id = $1
           AND kind = 'safety.notification.overdue'`,
        [DEMO.users.owner.id],
      );
      return rows;
    });
    expect(escalated.length).toBeGreaterThan(0);
  });

  it("prepares the draft and makes it ready", async () => {
    // The overdue alert moved the record on: prepare from the current version.
    version = (
      await json<StatutoryNotificationDetail>(
        await as("manager", `/v1/notifications/statutory/${notificationId}`),
      )
    ).version;
    const response = await as("manager", `/v1/notifications/statutory/${notificationId}/prepare`, {
      method: "POST",
      body: { content: { circumstances: "Died peacefully in her sleep." }, ready: true, version },
    });
    expect(response.status).toBe(200);
    const ready = await json<StatutoryNotificationDetail>(response);
    expect(ready.status).toBe("ready");
    version = ready.version;
  });

  it("hazard HZ-013 only a holder of safety.notification.submit with step-up can submit", async () => {
    const body = {
      submittedAt: new Date().toISOString(),
      externalReference: "CQC-0001-EXAMPLE",
      version,
    };
    const path = `/v1/notifications/statutory/${notificationId}/submit`;
    expect((await as("nurse", path, { method: "POST", body })).status).toBe(403);
    await setSessionAge("manager", 60);
    const stale = await as("manager", path, { method: "POST", body });
    expect(stale.status).toBe(403);
    expect((await json<ProblemDetails>(stale)).code).toBe("step_up_required");
    await setSessionAge("manager", 0);
    const noEvidence = await as("manager", path, {
      method: "POST",
      body: { submittedAt: new Date().toISOString(), version },
    });
    expect(noEvidence.status).toBe(422);
    const submitted = await as("manager", path, { method: "POST", body });
    expect(submitted.status).toBe(200);
    expect(await json<StatutoryNotificationDetail>(submitted)).toMatchObject({
      status: "submitted",
      clock: "done",
      externalReference: "CQC-0001-EXAMPLE",
      submittedBy: DEMO.users.manager.id,
    });
    expect(await outboxEvents("safety.notification.submitted", notificationId)).toHaveLength(1);
    const open = await asDemoTenant(async (c) => {
      const { rows } = await c.query(
        `SELECT id FROM notification WHERE source_type = 'statutory_notification' AND source_id = $1
           AND acknowledged_at IS NULL`,
        [notificationId],
      );
      return rows.length;
    });
    expect(open).toBe(0);
  });

  it("hazard HZ-013 marking not required needs step-up and a reason, and is audited with it", async () => {
    const incident = await created("manager", { type: "behaviour", people: [affected(5)] });
    await as("manager", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: { answers: [{ key: "police.involved", value: "unsure" }] },
    });
    const list = await json<StatutoryNotificationList>(
      await as("manager", `/v1/notifications/statutory?incidentId=${incident.id}`),
    );
    const police = list.items.find((n) => n.kind === "cqc_reg18_police");
    const path = `/v1/notifications/statutory/${police?.id}/not-required`;
    const reason = "The police were not called; the family chose not to report it.";
    await setSessionAge("manager", 60);
    const stale = await as("manager", path, {
      method: "POST",
      body: { reason, version: police?.version },
    });
    expect((await json<ProblemDetails>(stale)).code).toBe("step_up_required");
    await setSessionAge("manager", 0);
    expect(
      (
        await as("manager", path, {
          method: "POST",
          body: { reason: "", version: police?.version },
        })
      ).status,
    ).toBe(422);
    const done = await as("manager", path, {
      method: "POST",
      body: { reason, version: police?.version },
    });
    expect(done.status).toBe(200);
    expect(await json<StatutoryNotificationDetail>(done)).toMatchObject({
      status: "not_required",
      notRequiredReason: reason,
    });
    const trail = (user: "manager" | "quality") =>
      as(user, `/v1/audit?resourceType=statutory_notification&resourceId=${police?.id}`).then((r) =>
        json<AuditList>(r),
      );
    // The reason is audited; only the organisation's view of the trail shows it (ADR-0071 review
    // round 1, S-M3): the manager, who holds platform.audit.read at one home, sees their own event
    // without it.
    const notRequired = (list: AuditList) =>
      list.items.find((a) => a.action === "safety.notification.not_required");
    expect(notRequired(await trail("quality"))?.reason).toBe(reason);
    expect(notRequired(await trail("manager"))).toMatchObject({ reason: null });
  });
});

describe("closing an incident", () => {
  it("hazard HZ-013 refuses to close while questions or drafts are open, and refuses the person who raised it", async () => {
    const incident = await created("manager", { type: "environmental", people: [] });
    const close = (user: keyof Harness["tokens"], v: number) =>
      as(user, `/v1/incidents/${incident.id}/close`, {
        method: "POST",
        body: { reason: "Supply restored and checked.", version: v },
      });
    const early = await close("owner", incident.version);
    expect(early.status).toBe(422);
    expect((await json<ProblemDetails>(early)).detail).toMatch(/Answer the notification questions/);
    await answerEverything(incident.id);
    const current = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incident.id}`));
    const own = await close("manager", current.version);
    expect(own.status).toBe(403);
    expect((await json<ProblemDetails>(own)).code).toBe("separation_of_duties");
    const closed = await close("owner", current.version);
    expect(closed.status).toBe(200);
    expect(await json<IncidentDetail>(closed)).toMatchObject({
      status: "closed",
      closedBy: DEMO.users.owner.id,
    });
    const denied = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ reason: string }>(
        "SELECT reason FROM audit_event WHERE action = 'safety.incident.closed' AND outcome = 'denied' AND resource_id = $1",
        [incident.id],
      );
      return rows.map((r) => r.reason);
    });
    expect(denied).toEqual(["separation_of_duties"]);
  });

  it("answers a stale version with 409", async () => {
    const incident = await created("manager", { type: "near_miss", people: [] });
    const response = await as("manager", `/v1/incidents/${incident.id}`, {
      method: "PUT",
      body: { description: "A hoist sling nearly gave way.", version: 1 },
    });
    expect(response.status).toBe(409);
  });
});

describe("duty of candour and investigations", () => {
  it("hazard HZ-013 records the candour threshold decision, which the classifier follows, and the candour steps", async () => {
    const incident = await created("manager", {
      type: "medication",
      people: [affected(4)],
      answers: [],
    });
    const put = await as("manager", `/v1/incidents/${incident.id}/candour`, {
      method: "PUT",
      body: {
        personId: resident(4),
        threshold: {
          notifiable: true,
          decidedAt: new Date().toISOString(),
          decidedBy: "Dr Example, GP",
        },
        version: 0,
      },
    });
    expect(put.status).toBe(200);
    const view = await json<CandourView>(put);
    expect(view.record?.clocks.provisional).toBe(false);
    const detail = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incident.id}`));
    expect(detail.classifier?.outputs.map((o) => o.kind)).toContain("candour");
    const step = await as("manager", `/v1/incidents/${incident.id}/candour/step`, {
      method: "POST",
      body: { to: "verbal_due", version: view.record?.version },
    });
    expect(step.status).toBe(200);
    const skip = await as("manager", `/v1/incidents/${incident.id}/candour/step`, {
      method: "POST",
      body: {
        to: "closed",
        reason: "All done",
        version: (await json<CandourView>(step)).record?.version,
      },
    });
    expect(skip.status).toBe(422);
  });

  it("records an investigation and turns an owned action into a task", async () => {
    const incident = await created("manager", { type: "near_miss", people: [] });
    const response = await as("manager", `/v1/incidents/${incident.id}/investigation`, {
      method: "PUT",
      body: {
        leadTenantUserId: DEMO.users.manager.id,
        method: "five_whys",
        actions: [
          {
            action: "Check every hoist sling for wear.",
            ownerTenantUserId: DEMO.users.nurse.id,
            dueOn: "2026-12-01",
          },
        ],
        version: 0,
      },
    });
    expect(response.status).toBe(200);
    const view = await json<InvestigationView>(response);
    expect(view.record?.actions[0]?.taskId).toBeTruthy();
    const complete = await as("manager", `/v1/incidents/${incident.id}/investigation`, {
      method: "PUT",
      body: { status: "completed", version: view.record?.version },
    });
    expect(complete.status).toBe(422);
  });

  /** A PDF about a resident, as if added to their record. */
  async function documentAbout(n: number): Promise<string> {
    const query = new URLSearchParams({
      category: "person_document",
      title: "Note of the conversation",
      personId: resident(n),
    });
    const response = await h.request(`/v1/documents?${query}`, {
      token: h.tokens.manager,
      tenant: DEMO.tenantId,
      method: "POST",
      raw: {
        bytes: new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n"),
        contentType: "application/pdf",
      },
    });
    expect(response.status).toBe(201);
    return (await json<{ id: string }>(response)).id;
  }

  const candour = (incidentId: string, body: Record<string, unknown>, method = "PUT") =>
    as("manager", `/v1/incidents/${incidentId}/candour${method === "POST" ? "/step" : ""}`, {
      method,
      body,
    });
  const closeDetail = async (incidentId: string) => {
    const current = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incidentId}`));
    const response = await as("manager", `/v1/incidents/${incidentId}/close`, {
      method: "POST",
      body: { reason: "Everything is done.", version: current.version },
    });
    expect(response.status).toBe(422);
    return (await json<{ detail: string }>(response)).detail;
  };
  /** Records the decision, then finishes the record as no contact (no documents needed). */
  async function finishWithoutContact(incidentId: string, personId: string) {
    let view = await json<CandourView>(
      await candour(incidentId, {
        personId,
        threshold: { notifiable: true, decidedAt: new Date().toISOString(), decidedBy: "A GP" },
        version: 0,
      }),
    );
    view = await json<CandourView>(
      await candour(incidentId, { to: "verbal_due", version: view.record?.version }, "POST"),
    );
    view = await json<CandourView>(
      await candour(incidentId, {
        contactAttempts: [{ at: new Date().toISOString(), note: "Phoned twice, no answer." }],
        version: view.record?.version,
      }),
    );
    const done = await candour(
      incidentId,
      { to: "no_contact", reason: "No answer after two calls.", version: view.record?.version },
      "POST",
    );
    expect(done.status).toBe(200);
  }

  it("hazard HZ-013 refuses to close a notifiable incident with no candour record (review H2)", async () => {
    const incident = await created("manager", {
      type: "medication",
      people: [affected(4)],
      answers: [
        { key: "candour.unintended_or_unexpected", value: "yes" },
        { key: "harm.body_structure_changed", value: "yes" },
      ],
    });
    expect(incident.classifier?.outputs.map((o) => o.kind)).toContain("candour");
    expect(await closeDetail(incident.id)).toContain(
      "Record the duty of candour threshold decision before closing.",
    );
    await finishWithoutContact(incident.id, resident(4));
    expect(await closeDetail(incident.id)).not.toContain("duty of candour");
  });

  it("hazard HZ-013 refuses to close until each person affected is told (review H1)", async () => {
    const incident = await created("manager", {
      type: "medication",
      people: [affected(4), affected(5)],
      answers: [
        { key: "candour.unintended_or_unexpected", value: "yes" },
        { key: "harm.body_structure_changed", value: "yes" },
      ],
    });
    await finishWithoutContact(incident.id, resident(4));
    expect(await closeDetail(incident.id)).toContain(
      "Someone affected has no finished duty of candour record of their own",
    );
  });

  it("hazard HZ-091 refuses candour times later than now, a decision before the incident and another person's document (review L5)", async () => {
    const incident = await created("manager", {
      type: "medication",
      people: [affected(4)],
      answers: [],
      occurredAt: ago(2 * HOUR),
    });
    const early = await candour(incident.id, {
      personId: resident(4),
      threshold: { notifiable: true, decidedAt: ago(3 * HOUR), decidedBy: "A GP" },
      version: 0,
    });
    expect(early.status).toBe(422);
    expect((await json<{ detail: string }>(early)).detail).toBe(
      "The decision cannot be dated before the incident happened.",
    );
    const view = await json<CandourView>(
      await candour(incident.id, {
        personId: resident(4),
        threshold: { notifiable: true, decidedAt: ago(HOUR), decidedBy: "A GP" },
        version: 0,
      }),
    );
    const version = view.record?.version;
    const verbal = (at: string, writtenRecordId: string | null) => ({
      at,
      byRepresentatives: ["The Registered Manager"],
      inPerson: true,
      accountGiven: true,
      enquiriesAdvised: true,
      apologyGiven: true,
      writtenRecordId,
    });
    const refused = async (body: Record<string, unknown>, detail: string) => {
      const response = await candour(incident.id, { ...body, version });
      expect(response.status).toBe(422);
      expect((await json<{ detail: string }>(response)).detail).toBe(detail);
    };
    const later = new Date(Date.now() + HOUR).toISOString();
    await refused(
      { verbal: verbal(later, null) },
      "The time they were told cannot be in the future.",
    );
    await refused(
      {
        written: {
          sentAt: later,
          documentId: null,
          includesAccount: true,
          includesEnquiries: true,
          includesApology: true,
        },
      },
      "The time the written notification was sent cannot be in the future.",
    );
    await refused(
      { contactAttempts: [{ at: later, note: "Phoned, no answer." }] },
      "The time of an attempt to contact them cannot be in the future.",
    );
    await refused(
      { enquiryResultsSharedAt: later },
      "The time the results were shared cannot be in the future.",
    );
    const someoneElses = await documentAbout(5);
    await refused(
      { verbal: verbal(ago(MIN), someoneElses) },
      "A document cited must be on the relevant person's record.",
    );
    await refused(
      { correspondenceDocumentIds: [newId()] },
      "A document cited must be on the relevant person's record.",
    );
    const theirs = await documentAbout(4);
    const saved = await candour(incident.id, {
      verbal: verbal(ago(MIN), theirs),
      correspondenceDocumentIds: [theirs],
      version,
    });
    expect(saved.status).toBe(200);
  });

  const harmed = (people: readonly Record<string, unknown>[], occurredAt = ago(30 * MIN)) =>
    created("manager", {
      type: "medication",
      occurredAt,
      people,
      answers: [
        { key: "candour.unintended_or_unexpected", value: "yes" },
        { key: "harm.body_structure_changed", value: "yes" },
      ],
    });
  const reason = "The GP reviewed it and found no lasting harm.";

  it("hazard HZ-013 a not-notifiable decision covers only the person it names (round 2 M1)", async () => {
    const incident = await harmed([affected(4), affected(5)]);
    let view = await json<CandourView>(
      await candour(incident.id, {
        personId: resident(4),
        threshold: { notifiable: false, decidedAt: new Date().toISOString(), decidedBy: "A GP" },
        thresholdReason: reason,
        thresholdConfirmed: true,
        version: 0,
      }),
    );
    view = await json<CandourView>(
      await candour(
        incident.id,
        { to: "not_notifiable", reason, confirmed: true, version: view.record?.version },
        "POST",
      ),
    );
    expect(view.record?.state).toBe("not_notifiable");
    expect(await closeDetail(incident.id)).toContain(
      "Someone affected has no finished duty of candour record of their own",
    );
  });

  it("hazard HZ-013 the relevant person is one of the people affected (round 2 M2)", async () => {
    const incident = await harmed([
      affected(4),
      { kind: "service_user", role: "involved", personId: resident(5) },
    ]);
    const other = await candour(incident.id, {
      personId: resident(5),
      threshold: { notifiable: true, decidedAt: new Date().toISOString(), decidedBy: "A GP" },
      version: 0,
    });
    expect(other.status).toBe(422);
    expect((await json<{ detail: string }>(other)).detail).toBe(
      "The relevant person must be one of the people affected.",
    );
    // With nobody named, the record does not move on.
    const unnamed = await json<CandourView>(
      await candour(incident.id, {
        threshold: { notifiable: true, decidedAt: new Date().toISOString(), decidedBy: "A GP" },
        version: 0,
      }),
    );
    const step = await candour(
      incident.id,
      { to: "verbal_due", version: unnamed.record?.version },
      "POST",
    );
    expect(step.status).toBe(422);
    expect((await json<{ detail: string }>(step)).detail).toBe(
      "Choose who it happened to, from the people affected, before moving the record on.",
    );
  });

  it("hazard HZ-091 a decision against Harbour's finding, or a changed one, needs a reason and a tick in the API (round 2 M3)", async () => {
    const incident = await harmed([affected(4)]);
    const decision = (notifiable: boolean) => ({
      notifiable,
      decidedAt: new Date().toISOString(),
      decidedBy: "A GP",
    });
    const bare = await candour(incident.id, {
      personId: resident(4),
      threshold: decision(false),
      thresholdReason: "No harm.",
      version: 0,
    });
    expect(bare.status).toBe(422);
    expect((await json<{ detail: string }>(bare)).detail).toBe(
      "Say why in at least 20 characters: the decision differs from Harbour's finding or changes the one recorded. Confirm the decision.",
    );
    // Agreeing with Harbour needs no reason.
    const agreed = await json<CandourView>(
      await candour(incident.id, {
        personId: resident(4),
        threshold: decision(true),
        version: 0,
      }),
    );
    // Changing a recorded decision does, and the reason is audited.
    const changed = await candour(incident.id, {
      threshold: decision(false),
      version: agreed.record?.version,
    });
    expect(changed.status).toBe(422);
    const done = await candour(incident.id, {
      threshold: decision(false),
      thresholdReason: reason,
      thresholdConfirmed: true,
      version: agreed.record?.version,
    });
    expect(done.status).toBe(200);
    const audited = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ reason: string | null }>(
        "SELECT reason FROM audit_event WHERE action = 'safety.candour.update' AND resource_id = $1 ORDER BY seq DESC LIMIT 1",
        [agreed.record?.id],
      );
      return rows[0]?.reason;
    });
    expect(audited).toBe(reason);
    // "Not notifiable" after Harbour drafted a candour notification needs the same.
    const saved = await json<CandourView>(done);
    const short = await candour(
      incident.id,
      { to: "not_notifiable", reason: "No harm.", confirmed: true, version: saved.record?.version },
      "POST",
    );
    expect(short.status).toBe(422);
  });

  it("hazard HZ-013 refuses to drop someone affected from candour without a reason, and audits it (round 2 M4)", async () => {
    const incident = await harmed([affected(4)]);
    await candour(incident.id, {
      personId: resident(4),
      threshold: { notifiable: true, decidedAt: new Date().toISOString(), decidedBy: "A GP" },
      version: 0,
    });
    const current = await json<IncidentDetail>(await as("manager", `/v1/incidents/${incident.id}`));
    const row = current.people.find((p) => p.personId === resident(4));
    const change = {
      id: row?.id,
      kind: "service_user",
      role: "involved",
      personId: resident(4),
      died: false,
      bodyMapMarkIds: [],
    };
    const refused = await as("manager", `/v1/incidents/${incident.id}`, {
      method: "PUT",
      body: { people: [change], version: current.version },
    });
    expect(refused.status).toBe(422);
    const kept = await as("manager", `/v1/incidents/${incident.id}`, {
      method: "PUT",
      body: { people: [change], candourReason: reason, version: current.version },
    });
    expect(kept.status).toBe(200);
    const audited = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ resource_id: string; reason: string | null }>(
        "SELECT resource_id, reason FROM audit_event WHERE action = 'safety.incident.candour_person_dropped' AND resource_id = $1 ORDER BY seq DESC LIMIT 1",
        [resident(4)],
      );
      return rows[0];
    });
    expect(audited).toEqual({ resource_id: resident(4), reason });
  });

  it("hazard HZ-013 an incident the duty of candour holds open too long gets a task for the Registered Manager (round 2 M4)", async () => {
    const incident = await harmed([affected(6)], ago(30 * 24 * HOUR));
    const tasks = () =>
      asDemoTenant(async (c) => {
        const { rows } = await c.query<{ status: string; assignee_role_key: string | null }>(
          "SELECT status, assignee_role_key FROM task WHERE kind = 'safety.candour_close_blocked' AND source_id = $1",
          [incident.id],
        );
        return rows;
      });
    expect(await raiseCandourBlocked(deps)).toBeGreaterThanOrEqual(1);
    expect(await tasks()).toEqual([{ status: "open", assignee_role_key: "registered_manager" }]);
    // Raised once, however often the job runs.
    await raiseCandourBlocked(deps);
    expect(await tasks()).toHaveLength(1);
  });

  it("hazard HZ-091 gives a reopened action a new task (review L1)", async () => {
    const incident = await created("manager", { type: "near_miss", people: [] });
    const action = {
      action: "Inspect every sling on the unit.",
      ownerTenantUserId: DEMO.users.nurse.id,
      dueOn: "2026-12-01",
    };
    const first = await json<InvestigationView>(
      await as("manager", `/v1/incidents/${incident.id}/investigation`, {
        method: "PUT",
        body: { actions: [action], version: 0 },
      }),
    );
    const made = first.record?.actions[0];
    const done = await json<InvestigationView>(
      await as("manager", `/v1/incidents/${incident.id}/investigation`, {
        method: "PUT",
        body: {
          actions: [{ ...action, id: made?.id, status: "done" }],
          version: first.record?.version,
        },
      }),
    );
    const reopened = await json<InvestigationView>(
      await as("manager", `/v1/incidents/${incident.id}/investigation`, {
        method: "PUT",
        body: {
          actions: [{ ...action, id: made?.id, status: "open" }],
          version: done.record?.version,
        },
      }),
    );
    const again = reopened.record?.actions[0];
    expect(again?.taskId).toBeTruthy();
    expect(again?.taskId).not.toBe(made?.taskId);
    const statuses = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string; status: string }>(
        "SELECT id, status FROM task WHERE id = ANY($1::uuid[])",
        [[made?.taskId, again?.taskId]],
      );
      return Object.fromEntries(rows.map((r) => [r.id, r.status]));
    });
    expect(statuses[made?.taskId ?? ""]).toBe("done");
    expect(statuses[again?.taskId ?? ""]).toBe("open");
  });

  it("hazard HZ-091 refuses an action's task for an owner who could never complete it", async () => {
    const incident = await created("manager", { type: "near_miss", people: [] });
    const action = (ownerTenantUserId: string) => ({
      action: "Replace the frayed sling.",
      ownerTenantUserId,
      dueOn: "2026-12-01",
    });
    // A care worker does not manage incidents, so the task would sit open where they cannot act.
    const refused = await as("manager", `/v1/incidents/${incident.id}/investigation`, {
      method: "PUT",
      body: { actions: [action(DEMO.users.carer.id)], version: 0 },
    });
    expect(refused.status).toBe(422);
    expect((await json<{ detail: string }>(refused)).detail).toBe(
      "The action's owner cannot be given its task: they do not manage incidents at this location.",
    );
    const none = await as("manager", `/v1/incidents/${incident.id}/investigation`);
    expect((await json<InvestigationView>(none)).record).toBeNull();
    // Without a date it is no task, so anyone may own it; the nurse in charge may be given it.
    const owned = await as("manager", `/v1/incidents/${incident.id}/investigation`, {
      method: "PUT",
      body: {
        actions: [{ ...action(DEMO.users.carer.id), dueOn: null }, action(DEMO.users.nurse.id)],
        version: 0,
      },
    });
    expect(owned.status).toBe(200);
    const view = await json<InvestigationView>(owned);
    expect(view.record?.actions.map((a) => Boolean(a.taskId))).toEqual([false, true]);
  });
});

describe("UKHSA outbreak detection", () => {
  const ari = (n: number, onsetHoursAgo: number) =>
    affected(n, {
      infection: {
        syndrome: "acute_respiratory",
        onsetAt: ago(onsetHoursAgo * HOUR),
        couldBeLinkedWithinSetting: true,
      },
    });

  it("hazard HZ-013 drafts the UKHSA report once two linked respiratory cases start within the window", async () => {
    await created("manager", { type: "ipc", people: [ari(1, 48)] });
    const second = await created("manager", { type: "ipc", people: [ari(2, 24)] });
    const ukhsa = second.classifier?.notifications.filter((n) => n.kind === "ukhsa_outbreak") ?? [];
    expect(ukhsa).toHaveLength(1);
    expect(ukhsa[0]?.statutory).toBe(false);
    // The worker's sweep finds the same threshold, drafts nothing new and changes nothing.
    const versions = () =>
      asDemoTenant(async (c) => {
        const { rows } = await c.query<{ incident: number; draft: number }>(
          `SELECT i.version AS incident, n.version AS draft FROM incident i
           JOIN statutory_notification n ON n.kind = 'ukhsa_outbreak' WHERE i.id = $1`,
          [second.id],
        );
        return rows[0];
      });
    const before = await versions();
    expect(await detectOutbreaks(deps)).toBe(0);
    expect(await versions()).toEqual(before);
    const count = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM statutory_notification WHERE kind = 'ukhsa_outbreak'",
      );
      return rows[0]?.n;
    });
    expect(count).toBe(1);
  });

  it("hazard HZ-013 leaves a draft's version alone when a classification changes nothing in it", async () => {
    const incident = await created("manager", {
      people: [affected(6, { died: true })],
      occurredAt: ago(HOUR),
    });
    const death = incident.classifier?.notifications.find((n) => n.kind === "cqc_reg16_death");
    await as("manager", `/v1/incidents/${incident.id}/classifier`, {
      method: "POST",
      body: { answers: [{ key: "police.involved", value: "no" }] },
    });
    const after = await json<StatutoryNotificationDetail>(
      await as("manager", `/v1/notifications/statutory/${death?.id}`),
    );
    expect(after.version).toBe(death?.version);
  });
});

describe("audit", () => {
  it("audits incident reads and writes by record id, never content", async () => {
    const incident = await created("manager", {
      type: "behaviour",
      description: "Shouting at Eve Example in the garden.",
      people: [affected(3)],
    });
    await as("manager", `/v1/incidents/${incident.id}`);
    const audit = await json<AuditList>(
      await as("manager", `/v1/audit?resourceType=incident&resourceId=${incident.id}`),
    );
    expect(audit.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(["safety.incident.create", "safety.incident.view"]),
    );
    const text = await asDemoTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM audit_event WHERE action LIKE 'safety.%'");
      return JSON.stringify(rows);
    });
    expect(text).not.toContain("Eve Example");
    expect(text).not.toContain("Found on the floor");
    expect(audit.chainIntact).toBe(true);
  });
});

describe("hazard HZ-013 hazard HZ-073 an overdue statutory notification no active member of staff can submit (ADR-0071 review round 5, C5-M3)", () => {
  // An invented home, Harbour Quay, whose only Registered Manager, Uma, has been invited but has
  // not signed in; the owner, who holds the permission across the organisation, is suspended.
  const UMA = "0194d000-0000-7000-8000-0000000003fb";
  const QUAY = "0194d000-0000-7000-8000-0000000001f7";
  const context = {
    tenantId: DEMO.tenantId,
    userId: null,
    scope: "tenant" as const,
    locationIds: [],
  };
  const holdersAtQuay = () =>
    withRequestContext(deps.appDb, context, (tx) => submitHolders(tx, QUAY, new Date()));
  const setStatus = (id: string, status: string) =>
    asDemoTenant((c) => c.query("UPDATE tenant_user SET status = $2 WHERE id = $1", [id, status]));

  it("tells only active staff, audits the gap once a day with a coded reason, and counts it in the daily signal", async () => {
    const notificationId = await asDemoTenant(async (c) => {
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Harbour Quay')", [QUAY]);
      await c.query(
        `INSERT INTO tenant_user (id, display_name, email, status)
         VALUES ($1, 'Uma Quay', 'uma.quay@example.invalid', 'invited')`,
        [UMA],
      );
      await c.query(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, valid_from)
         SELECT $1, id, $2, now() - interval '30 days' FROM role WHERE key = 'registered_manager'`,
        [UMA, QUAY],
      );
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO statutory_notification (location_id, source_key, kind, status, due_at,
           retention_class)
         VALUES ($1, 'test:quay-service-disruption', 'cqc_reg18_service_disruption', 'draft',
                 now() - interval '1 hour', 'serious_incident')
         RETURNING id`,
        [QUAY],
      );
      return rows[0]?.id ?? "";
    });
    const state = () =>
      asDemoTenant(async (c) => {
        const told = await c.query<{ recipient: string }>(
          `SELECT recipient_tenant_user_id AS recipient FROM notification
           WHERE source_type = 'statutory_notification' AND source_id = $1`,
          [notificationId],
        );
        const audited = await c.query<{ reason: string; scope: Record<string, unknown> }>(
          `SELECT reason, scope FROM audit_event
           WHERE action = 'safety.notification.unrouted' AND resource_id = $1`,
          [notificationId],
        );
        return { told: told.rows.map((r) => r.recipient), audited: audited.rows };
      });

    await setStatus(DEMO.users.owner.id, "suspended");
    try {
      // Uma holds the permission at the home but is only invited: she is not told.
      expect(await holdersAtQuay()).toEqual([]);
      await escalateStatutoryNotifications(deps);
      await escalateStatutoryNotifications(deps, new Date(Date.now() + HOUR));
      const unrouted = await state();
      expect(unrouted.told).toEqual([]);
      // Audited once in the day, as the system, with a coded reason and opaque ids only.
      expect(unrouted.audited).toEqual([
        {
          reason: "no_active_submitter",
          scope: expect.objectContaining({ locationId: QUAY, reasonCode: "no_active_submitter" }),
        },
      ]);
      expect(UNROUTED_ACTIONS).toContain("safety.notification.unrouted");
      const reported = await reportUnroutedDaily(deps);
      expect(reported.get(DEMO.tenantId)?.["safety.notification.unrouted"]).toBeGreaterThanOrEqual(
        1,
      );
      // Uma signs in: she alone is told, and the gap is not audited again.
      await setStatus(UMA, "active");
      expect(await holdersAtQuay()).toEqual([UMA]);
      await escalateStatutoryNotifications(deps);
      const routed = await state();
      expect(routed.told).toEqual([UMA]);
      expect(routed.audited).toHaveLength(1);
    } finally {
      await setStatus(DEMO.users.owner.id, "active");
    }
  });
});
