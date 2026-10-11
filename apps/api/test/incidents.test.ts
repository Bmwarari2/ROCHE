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
import { createDatabase, createPool } from "@harbour/db";
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
  runEscalations,
  type TaskDeps,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, LODGE, OTHER } from "./support/harness";

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
  await h.db
    .pool("harbour_auth")
    .query(
      "UPDATE auth.session SET created_at = now() - make_interval(mins => $2) WHERE token = $1",
      [h.tokens[user]?.split(".")[0], minutes],
    );
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
    const audit = await json<AuditList>(
      await as("manager", `/v1/audit?resourceType=statutory_notification&resourceId=${police?.id}`),
    );
    expect(audit.items.find((a) => a.action === "safety.notification.not_required")?.reason).toBe(
      reason,
    );
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
