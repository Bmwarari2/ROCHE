import type {
  AuditList,
  BestInterestsItem,
  CapacityAssessmentItem,
  ConsentItem,
  ConsentList,
  DolsItem,
  DolsList,
  LegalChangeReviewItem,
  LegalChangeReviewList,
  ProblemDetails,
  StatutoryNotificationDetail,
} from "@harbour/contracts";
import {
  BestInterestsItemKey,
  ConsentDecisionKind,
  ConsulteeKind,
  MultifactorialFactor,
  ObjectionForm,
  PracticableStep,
  RepresentativeKind,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import {
  BEST_INTERESTS_ITEM_KEYS,
  CONSENT_DECISION_KINDS,
  CONSULTEE_KINDS,
  MULTIFACTORIAL_FACTORS,
  OBJECTION_FORMS,
  PRACTICABLE_STEPS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindDolsExpiry, type TaskDeps } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Slice 6 through the API: consent, capacity assessments, best-interests decisions, the DoLS
 * register with its CQC notification and expiry reminders, and the review of existing
 * authorisations after the June 2026 judgment. Demo residents 1 to 3 are assigned to the care
 * worker; the Registered Manager covers Harbour House.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
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

const consents = (n: number) => `/v1/people/${resident(n)}/consents`;
const detail = async (response: Response) => (await json<ProblemDetails>(response)).detail ?? "";

function lacksCapacity(decisionKind: string, extra: Record<string, unknown> = {}) {
  return {
    decision: `Whether to agree to ${decisionKind.replace("_", " ")}`,
    decisionKind,
    assessedAt: ago(HOUR),
    assessorTenantUserId: DEMO.users.manager.id,
    practicableSteps: [
      { step: "simple_language", detail: "Explained in short sentences with a picture" },
    ],
    stage1: { impairment: true, description: "Advanced dementia" },
    stage2: {
      understand: { able: false, evidence: "Could not say what the decision was about" },
      retain: { able: true },
      useOrWeigh: { able: false, evidence: "Could not weigh the benefits against the risks" },
      communicate: { able: true },
    },
    inabilityBecauseOfImpairment: true,
    outcome: "lacks_capacity",
    reviewOn: "2027-01-11",
    ...extra,
  };
}

const CHECKLIST = Object.fromEntries(
  BEST_INTERESTS_ITEM_KEYS.map((key) => [
    key,
    key === "life_sustaining_treatment"
      ? { answer: "not_applicable", reason: "No life-sustaining treatment is involved" }
      : { answer: "considered", note: "Discussed with the family and the GP" },
  ]),
);

async function assess(n: number, decisionKind: string) {
  const response = await as("manager", `/v1/people/${resident(n)}/capacity-assessments`, {
    method: "POST",
    body: lacksCapacity(decisionKind),
  });
  expect(response.status).toBe(201);
  return json<CapacityAssessmentItem>(response);
}

const lpa = (registered: boolean) => ({
  kind: "lpa_health_welfare",
  name: "Relative Example",
  registered,
  opgReference: "OPG-EXAMPLE-1",
});

describe("contract enumerations stay in step with the domain rules", () => {
  it.each([
    ["ConsentDecisionKind", ConsentDecisionKind.options, CONSENT_DECISION_KINDS],
    ["PracticableStep", PracticableStep.options, PRACTICABLE_STEPS],
    ["BestInterestsItemKey", BestInterestsItemKey.options, BEST_INTERESTS_ITEM_KEYS],
    ["ConsulteeKind", ConsulteeKind.options, CONSULTEE_KINDS],
    [
      "MultifactorialFactor",
      MultifactorialFactor.options,
      MULTIFACTORIAL_FACTORS.map((f) => f.key),
    ],
    ["ObjectionForm", ObjectionForm.options, OBJECTION_FORMS],
  ] as const)("%s", (_name, contract, domain) => {
    expect([...contract]).toEqual([...domain]);
  });

  it("names every representative kind the consent rules know", () => {
    expect([...RepresentativeKind.options]).toEqual([
      "lpa_health_welfare",
      "lpa_property_financial",
      "deputy",
      "appointee",
      "imca",
      "advocate",
      "family_or_friend",
    ]);
  });
});

describe("hazard HZ-026 consent and capacity", () => {
  let photosConsent: ConsentItem;

  it("records the person's own consent with capacity assumed, and shows it as valid", async () => {
    const response = await as("manager", consents(1), {
      method: "POST",
      body: {
        decision: "photos",
        outcome: "given",
        givenBy: "person",
        givenAt: ago(MIN),
        evidence: "Asked in her room; she said yes to photos for her record.",
      },
    });
    expect(response.status).toBe(201);
    photosConsent = await json<ConsentItem>(response);
    expect(photosConsent.capacityStatus).toBe("assumed");
    const list = await json<ConsentList>(await as("manager", consents(1)));
    expect(list.decisions.find((d) => d.decision === "photos")).toMatchObject({
      status: "valid",
      capacity: "assumed",
    });
    expect(list.decisions.find((d) => d.decision === "bed_rails")).toMatchObject({
      status: "none",
      problems: ["no_record"],
    });
  });

  it.each([
    [
      "from a relative with no legal authority",
      { kind: "family_or_friend", name: "Relative Example" },
      /no legal authority to consent/,
    ],
    [
      "from an attorney while the person is assumed to have capacity",
      lpa(true),
      /only when the person lacks capacity/,
    ],
    [
      "from a property and financial attorney",
      { kind: "lpa_property_financial", name: "Relative Example", registered: true },
      /property and financial affairs attorney cannot decide about care/,
    ],
  ])(
    "hazard HZ-026 a consent without authority is refused: %s",
    async (_label, representative, message) => {
      const response = await as("manager", consents(1), {
        method: "POST",
        body: {
          decision: "sharing",
          outcome: "given",
          givenBy: "representative",
          representative,
          givenAt: ago(MIN),
          evidence: "Agreed on the telephone.",
        },
      });
      expect(response.status).toBe(422);
      expect(await detail(response)).toMatch(message);
    },
  );

  it.each([
    ["an assessment of everything", { decision: "everything" }, /one decision at a time/],
    [
      "a 'lacks capacity' outcome the two-stage test does not support",
      { stage1: { impairment: false } },
      /capacity must be assumed/,
    ],
    ["an assessment dated in the future", { assessedAt: ahead(DAY) }, /in the future/],
  ])("refuses %s", async (_label, change, message) => {
    const response = await as("manager", `/v1/people/${resident(1)}/capacity-assessments`, {
      method: "POST",
      body: lacksCapacity("photos", change),
    });
    expect(response.status).toBe(422);
    expect(await detail(response)).toMatch(message);
  });

  it("lets a registered welfare attorney agree to bed rails, with the restraint conditions, once the person lacks capacity", async () => {
    const assessment = await assess(2, "bed_rails");
    expect(assessment.reason).toMatch(/^Lacks capacity for this decision/);
    const consent = (representative: unknown, restraint?: unknown) =>
      as("manager", consents(2), {
        method: "POST",
        body: {
          decision: "bed_rails",
          outcome: "given",
          givenBy: "representative",
          representative,
          givenAt: ago(MIN),
          evidence: "Met the attorney and the nurse at the bedside.",
          ...(restraint ? { restraintConditions: restraint } : {}),
        },
      });
    expect(await detail(await consent(lpa(false)))).toMatch(/until it is registered/);
    expect(await detail(await consent(lpa(true)))).toMatch(/restrict movement/);
    const ok = await consent(lpa(true), { necessaryToPreventHarm: true, proportionate: true });
    expect(ok.status).toBe(201);
    expect(await json<ConsentItem>(ok)).toMatchObject({
      capacityStatus: "lacks_capacity",
      capacityAssessmentId: assessment.id,
    });
    const list = await json<ConsentList>(await as("manager", consents(2)));
    expect(list.decisions.find((d) => d.decision === "bed_rails")).toMatchObject({
      status: "valid",
      capacity: "lacks_capacity",
    });
    // The person's own consent cannot be relied on while they lack capacity for the decision.
    const own = await as("manager", consents(2), {
      method: "POST",
      body: {
        decision: "bed_rails",
        outcome: "given",
        givenBy: "person",
        givenAt: ago(MIN),
        evidence: "Said yes when asked.",
      },
    });
    expect(await detail(own)).toMatch(/lacking capacity/);
  });

  it("needs a complete best-interests decision before covert medicines", async () => {
    const assessment = await assess(3, "covert_medicines");
    const consent = (bestInterestsDecisionId?: string) =>
      as("manager", consents(3), {
        method: "POST",
        body: {
          decision: "covert_medicines",
          outcome: "given",
          givenBy: "representative",
          representative: lpa(true),
          givenAt: ago(MIN),
          evidence: "Best-interests meeting with the GP and the pharmacist.",
          ...(bestInterestsDecisionId ? { bestInterestsDecisionId } : {}),
        },
      });
    expect(await detail(await consent())).toMatch(/best-interests decision/);
    const incomplete = await as("manager", `/v1/people/${resident(3)}/best-interests`, {
      method: "POST",
      body: {
        capacityAssessmentId: assessment.id,
        decision: "Give medicines hidden in food",
        decidedAt: ago(MIN),
        checklist: { participation: { answer: "considered", note: "Asked her views" } },
        reviewOn: "2027-01-11",
      },
    });
    expect(incomplete.status).toBe(422);
    expect(await detail(incomplete)).toMatch(/Best-interests checklist incomplete/);
    const complete = await as("manager", `/v1/people/${resident(3)}/best-interests`, {
      method: "POST",
      body: {
        capacityAssessmentId: assessment.id,
        decision: "Give medicines hidden in food",
        decidedAt: ago(MIN),
        checklist: CHECKLIST,
        consultations: [
          {
            consultee: "family_or_friend",
            name: "Relative Example",
            views: "Agrees, as long as it is reviewed",
            consultedAt: ago(DAY),
          },
        ],
        reviewOn: "2027-01-11",
      },
    });
    expect(complete.status).toBe(201);
    const decision = await json<BestInterestsItem>(complete);
    expect(decision.imcaPrompt).toBeNull();
    expect((await consent(decision.id)).status).toBe(201);
  });

  it("prompts for an IMCA when nobody appropriate can be consulted about a move", async () => {
    const assessment = await assess(1, "care_plan");
    const response = await as("manager", `/v1/people/${resident(1)}/best-interests`, {
      method: "POST",
      body: {
        capacityAssessmentId: assessment.id,
        decision: "Move to a nursing unit",
        decidedAt: ago(MIN),
        checklist: CHECKLIST,
        consultations: [
          {
            consultee: "paid_carer_or_professional",
            views: "The nursing team support the move",
            consultedAt: ago(DAY),
          },
        ],
        accommodationChange: true,
        reviewOn: "2027-01-11",
      },
    });
    expect(response.status).toBe(201);
    expect((await json<BestInterestsItem>(response)).imcaPrompt).toMatch(
      /independent mental capacity advocate/,
    );
  });

  it("records a withdrawal, keeps the record, and answers a stale version with 409", async () => {
    const path = `${consents(1)}/${photosConsent.id}/withdraw`;
    const body = { reason: "Changed her mind about photos.", version: photosConsent.version };
    const response = await as("manager", path, { method: "POST", body });
    expect(response.status).toBe(200);
    expect((await json<ConsentItem>(response)).withdrawnAt).not.toBeNull();
    expect((await as("manager", path, { method: "POST", body })).status).toBe(409);
    const list = await json<ConsentList>(await as("manager", consents(1)));
    expect(list.items.some((i) => i.id === photosConsent.id)).toBe(true);
    expect(list.decisions.find((d) => d.decision === "photos")).toMatchObject({
      status: "none",
      problems: ["withdrawn"],
    });
  });

  it("ignores a replayed capacity assessment with the same id", async () => {
    const id = newId();
    const body = lacksCapacity("photos", { id });
    const path = `/v1/people/${resident(1)}/capacity-assessments`;
    expect((await as("manager", path, { method: "POST", body })).status).toBe(201);
    expect((await as("manager", path, { method: "POST", body })).status).toBe(201);
    const count = await asDemoTenant(async (c) => {
      const { rows } = await c.query("SELECT id FROM capacity_assessment WHERE id = $1", [id]);
      return rows.length;
    });
    expect(count).toBe(1);
  });

  it("lets a care worker read consents and capacity but not record them", async () => {
    expect((await as("carer", consents(1))).status).toBe(200);
    expect((await as("carer", `/v1/people/${resident(1)}/capacity-assessments`)).status).toBe(200);
    expect((await as("carer", `/v1/people/${resident(1)}/best-interests`)).status).toBe(200);
    expect((await as("carer", `/v1/people/${resident(1)}/dols`)).status).toBe(200);
    for (const path of ["consents", "capacity-assessments", "best-interests", "dols"]) {
      const response = await as("carer", `/v1/people/${resident(1)}/${path}`, {
        method: "POST",
        body: {},
      });
      expect([403, 422]).toContain(response.status);
    }
    const write = await as("carer", consents(1), {
      method: "POST",
      body: {
        decision: "photos",
        outcome: "given",
        givenBy: "person",
        givenAt: ago(MIN),
        evidence: "Asked in person.",
      },
    });
    expect(write.status).toBe(403);
    expect((await as("carer", consents(5))).status).toBe(404);
  });
});

describe("hazard HZ-020 the DoLS register", () => {
  const dols = (n: number) => `/v1/people/${resident(n)}/dols`;

  it("checks the dates against Schedule A1", async () => {
    const response = await as("manager", dols(4), {
      method: "POST",
      body: {
        type: "urgent",
        requestedAt: ago(DAY),
        outcome: "granted",
        outcomeAt: ago(DAY),
        grantedFrom: ago(DAY),
        grantedTo: ahead(9 * DAY),
      },
    });
    expect(response.status).toBe(422);
    expect(await detail(response)).toMatch(/Schedule A1 para 78\(2\)/);
  });

  it("a DoLS outcome creates the CQC regulation 18(4A) draft", async () => {
    const requested = await json<DolsItem>(
      await as("manager", dols(4), {
        method: "POST",
        body: { type: "standard", requestedAt: ago(20 * DAY), precededByUrgent: true },
      }),
    );
    expect(requested).toMatchObject({ status: "requested", cqcNotification: { required: false } });
    const outcomeAt = ago(HOUR);
    const response = await as("manager", `${dols(4)}/${requested.id}`, {
      method: "PUT",
      body: {
        type: "standard",
        requestedAt: ago(20 * DAY),
        precededByUrgent: true,
        outcome: "granted",
        outcomeAt,
        grantedFrom: outcomeAt,
        grantedTo: ahead(180 * DAY),
        version: requested.version,
      },
    });
    expect(response.status).toBe(200);
    const granted = await json<DolsItem>(response);
    expect(granted.cqcNotification).toMatchObject({
      required: true,
      status: "draft",
      dueAt: new Date(outcomeAt).toISOString(),
    });
    const draft = await json<StatutoryNotificationDetail>(
      await as("manager", `/v1/notifications/statutory/${granted.cqcNotification.notificationId}`),
    );
    expect(draft).toMatchObject({
      kind: "cqc_reg18_dols_outcome",
      personId: resident(4),
      dolsAuthorisationId: requested.id,
    });
    expect(draft.statement).toMatchObject({ precededByUrgent: true, outcome: "Granted" });
    const events = await asDemoTenant(async (c) => {
      const { rows } = await c.query(
        "SELECT payload FROM outbox_event WHERE event_type = 'care.dols.outcome_known' AND aggregate_id = $1",
        [requested.id],
      );
      return rows;
    });
    expect(events).toHaveLength(1);
  });

  it("does not notify an urgent authorisation on its own", async () => {
    const response = await as("manager", dols(5), {
      method: "POST",
      body: {
        type: "urgent",
        requestedAt: ago(DAY),
        outcome: "granted",
        outcomeAt: ago(DAY),
        grantedFrom: ago(DAY),
        grantedTo: ahead(5 * DAY),
      },
    });
    expect(response.status).toBe(201);
    const urgent = await json<DolsItem>(response);
    expect(urgent.cqcNotification).toMatchObject({ required: false, notificationId: null });
    expect(urgent.cqcNotification.reason).toMatch(/not notified on its own/);
  });

  let expiring: DolsItem;

  it("expiry reminders fire once", async () => {
    const response = await as("manager", dols(6), {
      method: "POST",
      body: {
        type: "standard",
        requestedAt: ago(310 * DAY),
        outcome: "granted",
        outcomeAt: ago(300 * DAY),
        grantedFrom: ago(300 * DAY),
        grantedTo: ahead(5 * DAY),
      },
    });
    expect(response.status).toBe(201);
    expiring = await json<DolsItem>(response);
    expect(expiring.status).toBe("expiring");
    expect(expiring.daysLeft).toBeLessThanOrEqual(5);
    await remindDolsExpiry(deps);
    await remindDolsExpiry(deps);
    const raised = await asDemoTenant(async (c) => {
      const tasks = await c.query<{ priority: string }>(
        "SELECT priority FROM task WHERE kind = 'care.dols_expiry' AND source_id = $1 ORDER BY due_at",
        [expiring.id],
      );
      const events = await c.query(
        "SELECT id FROM outbox_event WHERE event_type = 'care.dols.expiring' AND aggregate_id = $1",
        [expiring.id],
      );
      const alerts = await c.query(
        `SELECT id FROM notification WHERE kind = 'care.dols.expiring'
           AND recipient_tenant_user_id = $1 AND dedupe_key LIKE $2`,
        [DEMO.users.manager.id, `dols_expiry:${expiring.id}:%`],
      );
      return {
        tasks: tasks.rows.map((r) => r.priority),
        events: events.rows.length,
        alerts: alerts.rows.length,
      };
    });
    expect(raised).toEqual({ tasks: ["routine", "urgent"], events: 2, alerts: 2 });
  });

  it("lists authorisations from before the judgment and records their review", async () => {
    const list = await json<LegalChangeReviewList>(
      await as("manager", "/v1/dols/legal-change-review"),
    );
    expect(list.judgment.citation).toBe("[2026] UKSC 16");
    expect(list.awaiting.map((a) => a.authorisationId)).toContain(expiring.id);
    const path = `/v1/dols/legal-change-review/${expiring.id}`;
    const incomplete = await as("manager", path, {
      method: "POST",
      body: { to: "reviewed", version: 0 },
    });
    expect(incomplete.status).toBe(422);
    expect(await detail(incomplete)).toMatch(/Record the type of restrictions/);
    const review = {
      factors: Object.fromEntries(
        MULTIFACTORIAL_FACTORS.map((f) => [f.key, "Recorded at the review meeting"]),
      ),
      objection: "does_not_object",
      objectionForms: [],
      consent: {
        consciousOfEnvironment: true,
        basicUnderstanding: true,
        expressesAcceptance: true,
        seriousDoubt: false,
      },
      decision: "no_longer_deprived",
      decidedAt: ago(MIN),
      referral: null,
    };
    const started = await json<LegalChangeReviewItem>(
      await as("manager", path, { method: "POST", body: { to: "reviewed", review, version: 0 } }),
    );
    expect(started).toMatchObject({
      state: "reviewed",
      referralRequired: true,
      decidedBy: DEMO.users.manager.id,
    });
    const closeEarly = await as("manager", path, {
      method: "POST",
      body: { to: "closed", reason: "No longer deprived", version: started.version },
    });
    expect(await detail(closeEarly)).toMatch(/Ask the local authority/);
    const referred = await json<LegalChangeReviewItem>(
      await as("manager", path, {
        method: "POST",
        body: {
          to: "referred",
          review: { ...review, referral: { sentAt: ago(MIN), reference: "LA-EXAMPLE-1" } },
          version: started.version,
        },
      }),
    );
    expect(referred.state).toBe("referred");
    const closed = await as("manager", path, {
      method: "POST",
      body: {
        to: "closed",
        reason: "The local authority ended the authorisation",
        version: referred.version,
      },
    });
    expect(closed.status).toBe(200);
    const after = await json<LegalChangeReviewList>(
      await as("manager", "/v1/dols/legal-change-review"),
    );
    expect(after.awaiting.map((a) => a.authorisationId)).not.toContain(expiring.id);
    expect(after.reviews.find((r) => r.authorisationId === expiring.id)?.state).toBe("closed");
    const register = await json<DolsList>(await as("manager", dols(6)));
    expect(register.items.find((i) => i.id === expiring.id)?.legalChangeReview).toBe("closed");
  });

  it("refuses a care worker managing the register", async () => {
    expect((await as("carer", "/v1/dols/legal-change-review")).status).toBe(403);
    const response = await as("carer", dols(1), {
      method: "POST",
      body: { type: "standard", requestedAt: ago(DAY) },
    });
    expect(response.status).toBe(403);
  });
});

describe("audit", () => {
  it("audits consent and capacity records by id, never content", async () => {
    const created = await json<ConsentItem>(
      await as("manager", consents(5), {
        method: "POST",
        body: {
          decision: "social_media",
          outcome: "refused",
          givenBy: "person",
          givenAt: ago(MIN),
          evidence: "Elsie said firmly she does not want to be on the internet.",
        },
      }),
    );
    const audit = await json<AuditList>(
      await as("manager", `/v1/audit?resourceType=consent_record&resourceId=${created.id}`),
    );
    expect(audit.items.map((a) => a.action)).toEqual(["care.consent.create"]);
    const text = await asDemoTenant(async (c) => {
      const { rows } = await c.query("SELECT * FROM audit_event WHERE action LIKE 'care.%'");
      return JSON.stringify(rows);
    });
    expect(text).not.toContain("does not want to be on the internet");
    expect(text).not.toContain("Advanced dementia");
    expect(audit.chainIntact).toBe(true);
  });
});
