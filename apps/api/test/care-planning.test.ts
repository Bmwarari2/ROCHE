import type {
  ActivityRecordItem,
  ActivityRecordList,
  AdvanceCareItem,
  AdvanceCareList,
  AssessmentItem,
  AssessmentList,
  AuditList,
  CarePlanActionItem,
  CarePlanDetail,
  CarePlanList,
  CarePlanSectionItem,
  CarePlanSummary,
  PersonSummary,
  ProblemDetails,
  RecordHistory,
  RiskAssessmentItem,
  RiskTemplateList,
  VisitItem,
  VisitList,
} from "@harbour/contracts";
import {
  ActivityEngagement,
  AdvanceCareKind,
  AssessmentToolKey,
  PcspDomain,
  RiskTemplateKey,
  VisitKind,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import {
  ACTIVITY_ENGAGEMENT,
  ADVANCE_CARE_KINDS,
  ASSESSMENT_TOOL_KEYS,
  addWorkingDays,
  firstCarePlanDue,
  PCSP_DOMAINS,
  RISK_TEMPLATE_KEYS,
  VISIT_KINDS,
} from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { raiseCareReviews, type TaskDeps, TENANT_SWEEP_FAILED_ACTION } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Slice 4b through the API: care plans, risk assessments, stored validated tools, activities,
 * visits and advance care records. Demo residents 1 to 3 are assigned to the care worker; the
 * Registered Manager covers the whole of Harbour House. The nurse has no MFA in the harness.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
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

const tasksFor = (personId: string) =>
  asDemoTenant(async (c) => {
    const { rows } = await c.query<{
      kind: string;
      status: string;
      due_on: string;
      source_id: string | null;
      evidence_id: string | null;
    }>(
      `SELECT kind, status, to_char(due_at AT TIME ZONE 'Europe/London', 'YYYY-MM-DD') AS due_on,
              source_id, evidence_id
       FROM task WHERE person_id = $1 ORDER BY created_at`,
      [personId],
    );
    return rows;
  });

const plansPath = (n: number) => `/v1/people/${resident(n)}/care-plans`;

async function draftWithSection(n: number, user: keyof Harness["tokens"] = "manager") {
  const draft = await json<CarePlanDetail>(
    await as(user, plansPath(n), { method: "POST", body: {} }),
  );
  const section = await json<CarePlanSectionItem>(
    await as(user, `${plansPath(n)}/${draft.id}/sections/mobility`, {
      method: "PUT",
      body: {
        need: "Needs help to stand from a chair.",
        outcome: "I want to walk to the garden every day.",
        version: 0,
      },
    }),
  );
  return { draft, section };
}

const mustHigh = {
  toolKey: "must",
  occurredAt: ago(10),
  answers: {
    bmi: {
      kind: "calculated",
      weightKg: 45,
      heightM: 1.6,
      weightMethod: "measured",
      heightMethod: "measured",
    },
    weightLoss: { kind: "calculated", previousWeightKg: 50, currentWeightKg: 45 },
    acuteDiseaseEffect: false,
  },
};

const braden = {
  toolKey: "braden",
  occurredAt: ago(10),
  answers: {
    sensoryPerception: 3,
    moisture: 3,
    activity: 2,
    mobility: 2,
    nutrition: 3,
    frictionAndShear: 2,
  },
};

describe("contract enumerations stay in step with the domain rules", () => {
  it.each([
    ["PCSP domains", PcspDomain.options, PCSP_DOMAINS],
    ["risk templates", RiskTemplateKey.options, RISK_TEMPLATE_KEYS],
    ["assessment tools", AssessmentToolKey.options, ASSESSMENT_TOOL_KEYS],
    ["advance care kinds", AdvanceCareKind.options, ADVANCE_CARE_KINDS],
    ["visit kinds", VisitKind.options, VISIT_KINDS],
    ["engagement", ActivityEngagement.options, ACTIVITY_ENGAGEMENT],
  ])("%s", (_label, contract, domain) => {
    expect([...contract]).toEqual([...domain]);
  });
});

describe("rule 1: when the first plan and the reviews are due", () => {
  it("skips bank holidays when the first plan falls due after admission", async () => {
    const admittedOn = "2026-12-21";
    const { days, holidays } = await asDemoTenant(async (c) => {
      await c.query("UPDATE placement SET start_date = $2 WHERE person_id = $1", [
        resident(4),
        admittedOn,
      ]);
      const rate = await c.query<{ value: string }>(
        "SELECT value FROM rate_table WHERE key = 'care_plan.initial_working_days' AND nation = 'england'",
      );
      const dates = await c.query<{ d: string }>(
        "SELECT to_char(date, 'YYYY-MM-DD') AS d FROM bank_holiday WHERE nation = 'england'",
      );
      return { days: Number(rate.rows[0]?.value), holidays: new Set(dates.rows.map((r) => r.d)) };
    });
    const list = await json<CarePlanList>(await as("manager", plansPath(4)));
    const expected = firstCarePlanDue(admittedOn, days, holidays).dueOn;
    expect(list.due).toEqual({ kind: "first_plan", dueOn: expected, overdue: false });
    // The same admission without bank holidays would be due earlier.
    expect(expected > addWorkingDays(admittedOn, days, new Set())).toBe(true);
  });

  it("hazard HZ-024 raises one review task to the nurse in charge for an overdue first plan or review", async () => {
    const { draft } = await draftWithSection(5);
    const published = await json<CarePlanDetail>(
      await as("manager", `${plansPath(5)}/${draft.id}/publish`, {
        method: "POST",
        body: { version: draft.version },
      }),
    );
    await asDemoTenant((c) =>
      c.query("UPDATE care_plan SET review_due_on = current_date - 2 WHERE id = $1", [
        published.id,
      ]),
    );
    const raised = await raiseCareReviews(deps, new Date());
    expect(raised).toBeGreaterThan(0);
    expect(await raiseCareReviews(deps, new Date())).toBe(0);
    // The sweep catches one organisation's failure and carries on (`eachTenant`): none failed.
    const failed = await asDemoTenant((c) =>
      c.query("SELECT 1 FROM audit_event WHERE action = $1 AND scope->>'job' = 'care-reviews'", [
        TENANT_SWEEP_FAILED_ACTION,
      ]),
    );
    expect(failed.rowCount).toBe(0);
    const tasks = await tasksFor(resident(5));
    expect(tasks.filter((t) => t.kind === "care.care_plan_review")).toHaveLength(1);
    const alerts = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ recipient_tenant_user_id: string }>(
        "SELECT recipient_tenant_user_id FROM notification WHERE kind = 'care.care_plan_review'",
      );
      return rows.map((r) => r.recipient_tenant_user_id);
    });
    expect(alerts).toContain(DEMO.users.nurse.id);
    // Residents admitted on 1 September with no plan are past the first-plan deadline.
    expect((await tasksFor(resident(6))).map((t) => t.kind)).toContain("care.care_plan_first");
  });
});

describe("rule 2: drafting, publishing and signing off a care plan", () => {
  it("refuses a care worker publishing or writing a plan", async () => {
    const { draft } = await draftWithSection(1);
    const publish = await as("carer", `${plansPath(1)}/${draft.id}/publish`, {
      method: "POST",
      body: { version: draft.version },
    });
    expect(publish.status).toBe(403);
    expect((await json<ProblemDetails>(publish)).code).toBe("missing_permission");
    expect((await as("carer", plansPath(1), { method: "POST", body: {} })).status).toBe(403);
    // A care worker still reads the plan of a person they are assigned to.
    expect((await as("carer", `${plansPath(1)}/${draft.id}`)).status).toBe(200);
  });

  it("hazard HZ-024 publishes a draft, supersedes it with the next version and keeps both", async () => {
    const { draft, section } = await draftWithSection(2);
    const action = await as("manager", `${plansPath(2)}/${draft.id}/sections/mobility/actions`, {
      method: "POST",
      body: {
        action: "Walk with a frame to the garden",
        roleKey: "care_worker",
        recurrence: { freq: "daily", times: ["10:30"] },
        generatesTasks: true,
      },
    });
    expect(action.status).toBe(201);
    expect((await json<CarePlanActionItem>(action)).sectionId).toBe(section.id);

    const first = await json<CarePlanDetail>(
      await as("manager", `${plansPath(2)}/${draft.id}/publish`, {
        method: "POST",
        body: { version: draft.version },
      }),
    );
    expect(first).toMatchObject({ status: "active", publishedVersion: 1 });
    expect(first.reviewDueOn).not.toBeNull();
    expect(first.sections[0]?.actions[0]?.generatesTasks).toBe(true);

    // A published plan is not edited; a new draft starts from it.
    const edit = await as("manager", `${plansPath(2)}/${first.id}/sections/skin`, {
      method: "PUT",
      body: { need: "Fragile skin.", outcome: "Keep my skin healthy.", version: 0 },
    });
    expect(edit.status).toBe(422);
    const second = await json<CarePlanDetail>(
      await as("manager", plansPath(2), { method: "POST", body: { copyFromActive: true } }),
    );
    expect(second.basedOnPlanId).toBe(first.id);
    expect(second.sections.map((s) => s.domain)).toEqual(["mobility"]);
    const again = await as("manager", plansPath(2), { method: "POST", body: {} });
    expect(again.status).toBe(409);
    const published = await json<CarePlanDetail>(
      await as("manager", `${plansPath(2)}/${second.id}/publish`, {
        method: "POST",
        body: { version: second.version },
      }),
    );
    expect(published.publishedVersion).toBe(2);
    const list = await json<CarePlanList>(await as("manager", plansPath(2)));
    expect(list.items.map((p) => [p.publishedVersion, p.status])).toEqual([
      [2, "active"],
      [1, "superseded"],
    ]);
    expect(list.due).toMatchObject({ kind: "review", dueOn: published.reviewDueOn });

    const outbox = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ payload: { planId: string; supersededPlanId: string } }>(
        "SELECT payload FROM outbox_event WHERE event_type = 'care.plan.published' AND aggregate_id = $1",
        [resident(2)],
      );
      return rows.map((r) => r.payload);
    });
    expect(outbox).toContainEqual(
      expect.objectContaining({ planId: published.id, supersededPlanId: first.id }),
    );
  });

  it("refuses to publish a draft whose sections lack the outcome", async () => {
    const draft = await json<CarePlanDetail>(
      await as("manager", plansPath(3), { method: "POST", body: {} }),
    );
    await as("manager", `${plansPath(3)}/${draft.id}/sections/skin`, {
      method: "PUT",
      body: { need: "Fragile skin.", version: 0 },
    });
    const response = await as("manager", `${plansPath(3)}/${draft.id}/publish`, {
      method: "POST",
      body: { version: draft.version },
    });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toContain("Skin");
  });

  it("answers a stale version with 409", async () => {
    const list = await json<CarePlanList>(await as("manager", plansPath(3)));
    const draftId = list.items.find((p) => p.status === "draft")?.id;
    const draft = await json<CarePlanDetail>(await as("manager", `${plansPath(3)}/${draftId}`));
    const skin = draft.sections.find((s) => s.domain === "skin");
    const path = `${plansPath(3)}/${draft.id}/sections/skin`;
    const body = { outcome: "Keep my skin healthy.", version: skin?.version ?? 0 };
    expect((await as("manager", path, { method: "PUT", body })).status).toBe(200);
    // The same version again is now stale.
    const stale = await as("manager", path, { method: "PUT", body });
    expect(stale.status).toBe(409);
    expect((await json<ProblemDetails>(stale)).code).toBe("version_conflict");
    const publish = await as("manager", `${plansPath(3)}/${draft.id}/publish`, {
      method: "POST",
      body: { version: draft.version + 5 },
    });
    expect(publish.status).toBe(409);
  });

  it("records sign-off by the person, a representative with authority, or why not", async () => {
    const list = await json<CarePlanList>(await as("manager", plansPath(2)));
    const active = list.items.find((p) => p.status === "active") as CarePlanSummary;
    const path = `${plansPath(2)}/${active.id}/sign-off`;
    const noAuthority = await as("manager", path, {
      method: "POST",
      body: {
        agreedBy: "representative",
        representativeName: "Eve Example",
        version: active.version,
      },
    });
    expect(noAuthority.status).toBe(422);
    const contactId = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM contact WHERE person_id = $1 LIMIT 1",
        [resident(2)],
      );
      return rows[0]?.id;
    });
    const signed = await json<CarePlanSummary>(
      await as("manager", path, {
        method: "POST",
        body: {
          agreedBy: "representative",
          authority: "lpa_health_welfare",
          contactId,
          version: active.version,
        },
      }),
    );
    expect(signed.signOff).toMatchObject({
      agreedBy: "representative",
      authority: "lpa_health_welfare",
      representativeName: "Relative Sample",
    });
    const unable = await as("manager", path, {
      method: "POST",
      body: { agreedBy: "unable", unableReason: "n/a", version: signed.version },
    });
    expect(unable.status).toBe(422);
  });

  it("shows the history of a care plan record", async () => {
    const list = await json<CarePlanList>(await as("manager", plansPath(2)));
    const first = list.items.find((p) => p.publishedVersion === 1) as CarePlanSummary;
    const history = await json<RecordHistory>(
      await as("manager", `/v1/people/${resident(2)}/care-history/care_plan/${first.id}`),
    );
    expect(history.versions.map((v) => v.data.status)).toEqual(["draft", "active"]);
  });
});

describe("risk assessments (CARE-002)", () => {
  it("hazard HZ-025 lists the templates with the MHRA figures from the rate table", async () => {
    const list = await json<RiskTemplateList>(await as("carer", "/v1/care/risk-templates"));
    const bedRails = list.items.find((t) => t.key === "bed_rails");
    const gap = bedRails?.questions.find((q) => q.key === "gap_between_bars_mm");
    const figure = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ value: string }>(
        "SELECT value FROM rate_table WHERE key = 'bed_rail.gap_max_mm.between_bars'",
      );
      return Number(rows[0]?.value);
    });
    expect(gap?.limit).toMatchObject({ rule: "under", valueMm: figure });
    expect(list.items.find((t) => t.key === "falls")?.rated).toBe(false);
  });

  it("records, reviews and closes a positive risk assessment; falls are never rated", async () => {
    const base = {
      templateKey: "moving_and_handling",
      hazard: "Transfers from bed to chair",
      whoAtRisk: "The person and the staff helping",
      answers: {
        bears_weight: false,
        cooperates: true,
        equipment_needed: true,
        equipment_examined: true,
      },
      likelihood: 3,
      severity: 4,
      residualLikelihood: 1,
      residualSeverity: 4,
      controls: ["Full-body hoist", "Two staff for every transfer"],
      assessedOn: new Date().toISOString().slice(0, 10),
    };
    const path = `/v1/people/${resident(1)}/risk-assessments`;
    expect((await as("carer", path, { method: "POST", body: base })).status).toBe(403);
    const created = await json<RiskAssessmentItem>(
      await as("manager", path, { method: "POST", body: base }),
    );
    expect(created).toMatchObject({ riskRating: 12, riskBand: "high", residualBand: "moderate" });
    const falls = await as("manager", path, {
      method: "POST",
      body: { ...base, templateKey: "falls", answers: {} },
    });
    expect(falls.status).toBe(422);

    const { templateKey: _t, ...review } = base;
    const reviewed = await json<RiskAssessmentItem>(
      await as("manager", `${path}/${created.id}`, {
        method: "PUT",
        body: { ...review, residualLikelihood: 2, residualSeverity: 3, version: created.version },
      }),
    );
    expect(reviewed).toMatchObject({ residualRating: 6, version: created.version + 1 });
    const stale = await as("manager", `${path}/${created.id}`, {
      method: "PUT",
      body: { ...review, version: created.version },
    });
    expect(stale.status).toBe(409);
    const closed = await json<RiskAssessmentItem>(
      await as("manager", `${path}/${created.id}/close`, {
        method: "POST",
        body: { reason: "Now walks independently", version: reviewed.version },
      }),
    );
    expect(closed.status).toBe("closed");
  });
});

describe("validated tools (CARE-003, CARE-006)", () => {
  it("hazard HZ-014 MUST high raises the dietitian referral and sets next_due_on", async () => {
    const response = await as("carer", `/v1/people/${resident(3)}/assessments`, {
      method: "POST",
      body: mustHigh,
    });
    expect(response.status).toBe(201);
    const saved = await json<AssessmentItem>(response);
    expect(saved).toMatchObject({ toolKey: "must", band: "high", score: 3 });
    expect(saved.nextDueOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(saved.workings.map((w) => w.points)).toEqual([2, 1, 0]);
    const tasks = await tasksFor(resident(3));
    expect(tasks.map((t) => t.kind)).toEqual(
      expect.arrayContaining([
        "care.dietitian_referral",
        "care.rescreen.must",
        "care.weight_check",
      ]),
    );
    expect(tasks.find((t) => t.kind === "care.rescreen.must")?.due_on).toBe(saved.nextDueOn);

    // The next MUST answers the scheduled rescreen and schedules a new one, once.
    const next = await json<AssessmentItem>(
      await as("carer", `/v1/people/${resident(3)}/assessments`, {
        method: "POST",
        body: { ...mustHigh, occurredAt: ago(5) },
      }),
    );
    const after = await tasksFor(resident(3));
    const rescreens = after.filter((t) => t.kind === "care.rescreen.must");
    expect(rescreens.filter((t) => t.status === "open")).toHaveLength(1);
    expect(rescreens.find((t) => t.status === "done")?.evidence_id).toBe(next.id);
    const outbox = await asDemoTenant(async (c) => {
      const { rows } = await c.query(
        "SELECT 1 FROM outbox_event WHERE event_type = 'care.assessment.completed' AND aggregate_id = $1",
        [resident(3)],
      );
      return rows.length;
    });
    expect(outbox).toBe(2);
  });

  it("a weight answers the weight check and schedules the next at the MUST interval", async () => {
    // Resident 3's latest MUST is high: weights are weekly (weight.at_risk_interval_weeks).
    const weeks = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ value: string }>(
        "SELECT value FROM rate_table WHERE key = 'weight.at_risk_interval_weeks'",
      );
      return Number(rows[0]?.value);
    });
    const response = await as("carer", `/v1/people/${resident(3)}/observations`, {
      method: "POST",
      body: { occurredAt: ago(5), values: { chart: "weight", kg: 45.2, method: "chair" } },
    });
    expect(response.status).toBe(201);
    const weight = await json<{ id: string }>(response);
    const checks = (await tasksFor(resident(3))).filter((t) => t.kind === "care.weight_check");
    expect(checks.find((t) => t.evidence_id === weight.id)?.status).toBe("done");
    const open = checks.filter((t) => t.status === "open");
    expect(open).toHaveLength(1);
    const weighedOn = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(
      new Date(Date.now() - 5 * MIN),
    );
    const expected = new Date(`${weighedOn}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + weeks * 7);
    expect(open[0]?.due_on).toBe(expected.toISOString().slice(0, 10));
  });

  it("hazard HZ-017 ignores a replayed upload with the same device id", async () => {
    const id = newId();
    const body = { ...braden, id };
    const first = await as("carer", `/v1/people/${resident(1)}/assessments`, {
      method: "POST",
      body,
    });
    const replay = await as("carer", `/v1/people/${resident(1)}/assessments`, {
      method: "POST",
      body,
    });
    expect([first.status, replay.status]).toEqual([201, 201]);
    expect((await json<AssessmentItem>(replay)).id).toBe(id);
    const list = await json<AssessmentList>(
      await as("carer", `/v1/people/${resident(1)}/assessments?toolKey=braden`),
    );
    expect(list.items.filter((a) => a.id === id)).toHaveLength(1);
  });

  it("hazard HZ-017 corrects a result by superseding it with a reason, and reads the latest per tool", async () => {
    const original = await json<AssessmentItem>(
      await as("carer", `/v1/people/${resident(2)}/assessments`, { method: "POST", body: braden }),
    );
    const noReason = await as("carer", `/v1/people/${resident(2)}/assessments`, {
      method: "POST",
      body: { ...braden, supersedesId: original.id },
    });
    expect(noReason.status).toBe(422);
    const corrected = await json<AssessmentItem>(
      await as("carer", `/v1/people/${resident(2)}/assessments`, {
        method: "POST",
        body: {
          ...braden,
          answers: { ...braden.answers, moisture: 2 },
          supersedesId: original.id,
          correctionReason: "Moisture scored wrongly",
        },
      }),
    );
    expect(corrected.score).toBe((original.score ?? 0) - 1);
    const latest = await json<AssessmentList>(
      await as("carer", `/v1/people/${resident(2)}/assessments?latest=true`),
    );
    expect(latest.items.map((a) => a.id)).toEqual([corrected.id]);
    const all = await json<AssessmentList>(
      await as("carer", `/v1/people/${resident(2)}/assessments`),
    );
    expect(all.items.find((a) => a.id === original.id)?.superseded).toBe(true);
  });

  it("hazard HZ-012 refuses Braden where its licence flag is off (H-25), and allows it in the demo tenant", async () => {
    await asDemoTenant((c) =>
      c.query(
        "INSERT INTO feature_flag (location_id, flag_key, enabled) VALUES ($1, 'care.tool.braden', false)",
        [DEMO.locationId],
      ),
    );
    const refused = await as("carer", `/v1/people/${resident(1)}/assessments`, {
      method: "POST",
      body: braden,
    });
    expect(refused.status).toBe(403);
    expect((await json<ProblemDetails>(refused)).code).toBe("feature_disabled");
    await asDemoTenant((c) =>
      c.query("DELETE FROM feature_flag WHERE location_id = $1 AND flag_key = 'care.tool.braden'", [
        DEMO.locationId,
      ]),
    );
    const allowed = await as("carer", `/v1/people/${resident(1)}/assessments`, {
      method: "POST",
      body: braden,
    });
    expect(allowed.status).toBe(201);
  });

  it("records the NG249 falls pathway with no score and brings the plan review forward", async () => {
    const saved = await json<AssessmentItem>(
      await as("carer", `/v1/people/${resident(2)}/assessments`, {
        method: "POST",
        body: {
          toolKey: "ng249_falls",
          occurredAt: ago(5),
          answers: { setting: "residential", occasion: "after_fall", presentingAfterFall: true },
        },
      }),
    );
    expect(saved).toMatchObject({ score: null, band: null });
    const after = await json<CarePlanList>(await as("manager", plansPath(2)));
    const active = after.items.find((p) => p.status === "active");
    expect(active?.reviewReason).toBe("A fall was reported");
    // A fall brings the review forward to today (UK date).
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(
      new Date(),
    );
    expect(active?.reviewDueOn).toBe(today);
    expect((await tasksFor(resident(2))).map((t) => t.kind)).toEqual(
      expect.arrayContaining(["care.comprehensive_falls_assessment", "care.care_plan_review"]),
    );
  });
});

describe("activities and visits (CARE-014)", () => {
  it("records a group activity per person, idempotently", async () => {
    const session = newId();
    const id = newId();
    const body = {
      id,
      occurredAt: ago(30),
      activity: "Music for health",
      format: "group",
      groupSessionId: session,
      attendance: "attended",
      engagement: "engaged_throughout",
    };
    const path = `/v1/people/${resident(1)}/activities`;
    expect((await as("carer", path, { method: "POST", body })).status).toBe(201);
    const replay = await as("carer", path, { method: "POST", body });
    expect((await json<ActivityRecordItem>(replay)).id).toBe(id);
    const noEngagement = await as("carer", path, {
      method: "POST",
      body: { ...body, id: undefined, engagement: undefined },
    });
    expect(noEngagement.status).toBe(422);
    const list = await json<ActivityRecordList>(await as("carer", path));
    expect(list.items.filter((a) => a.id === id)).toHaveLength(1);
  });

  it("records a Regulation 9A visit, needing the reason for any restriction", async () => {
    const path = `/v1/people/${resident(1)}/visits`;
    const base = {
      occurredAt: ago(120),
      endedAt: ago(30),
      kind: "facilitated_visit",
      visitorName: "Neighbour, Sam Example",
    };
    const restricted = await as("carer", path, {
      method: "POST",
      body: { ...base, restrictionsApplied: true },
    });
    expect(restricted.status).toBe(422);
    const id = newId();
    const saved = await json<VisitItem>(
      await as("carer", path, {
        method: "POST",
        body: {
          ...base,
          id,
          restrictionsApplied: true,
          restrictionReason: "Norovirus outbreak on the unit; visit held in the garden room.",
        },
      }),
    );
    expect(saved).toMatchObject({ restrictionsApplied: true, lateEntry: false });
    expect(
      (await json<VisitItem>(await as("carer", path, { method: "POST", body: { ...base, id } })))
        .id,
    ).toBe(id);
    const otherPersonsContact = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM contact WHERE person_id = $1 LIMIT 1",
        [resident(2)],
      );
      return rows[0]?.id;
    });
    const wrongContact = await as("carer", path, {
      method: "POST",
      body: { ...base, visitorName: undefined, contactId: otherPersonsContact },
    });
    expect(wrongContact.status).toBe(422);
    const list = await json<VisitList>(await as("carer", path));
    expect(list.items.map((v) => v.id)).toContain(id);
  });
});

describe("hazard HZ-015 advance care records and the resuscitation status", () => {
  it("shows a DNACPR decision on the person's point-of-care summary", async () => {
    const before = await json<PersonSummary>(await as("carer", `/v1/people/${resident(1)}`));
    expect(before.resuscitation.status).toBe("not_recorded");

    const body = {
      kind: "dnacpr",
      clinicianName: "Dr Example",
      clinicianRole: "GP",
      completedOn: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
    };
    const refused = await as("carer", `/v1/people/${resident(1)}/advance-care`, {
      method: "POST",
      body,
    });
    expect(refused.status).toBe(403);
    const recorded = await json<AdvanceCareItem>(
      await as("manager", `/v1/people/${resident(1)}/advance-care`, { method: "POST", body }),
    );
    expect(recorded).toMatchObject({ status: "active", cprDecision: "do_not_attempt_cpr" });

    const after = await json<PersonSummary>(await as("carer", `/v1/people/${resident(1)}`));
    expect(after.resuscitation).toMatchObject({
      status: "do_not_attempt_cpr",
      recordId: recorded.id,
      kind: "dnacpr",
      clinicianName: "Dr Example",
    });
    const list = await json<{ items: PersonSummary[] }>(await as("carer", "/v1/people"));
    expect(list.items.find((p) => p.id === resident(1))?.resuscitation.status).toBe(
      "do_not_attempt_cpr",
    );
  });

  it("supersedes the active record of the same kind and withdraws with a reason", async () => {
    const path = `/v1/people/${resident(1)}/advance-care`;
    const current = await json<AdvanceCareList>(await as("manager", path));
    const old = current.items.find((r) => r.kind === "dnacpr") as AdvanceCareItem;
    const replacement = await json<AdvanceCareItem>(
      await as("manager", path, {
        method: "POST",
        body: {
          kind: "respect",
          cprDecision: "attempt_cpr",
          clinicianName: "Dr Example",
          clinicianRole: "Consultant geriatrician",
          completedOn: new Date().toISOString().slice(0, 10),
        },
      }),
    );
    // Two records in force disagree: shown as a conflict until the DNACPR is withdrawn.
    const conflicted = await json<AdvanceCareList>(await as("manager", path));
    expect(conflicted.resuscitation).toMatchObject({
      status: "attempt_cpr",
      recordId: replacement.id,
      conflicting: true,
    });
    const noReason = await as("manager", `${path}/${old.id}`, {
      method: "PUT",
      body: { withdrawnReason: " ", version: old.version },
    });
    expect(noReason.status).toBe(422);
    const withdrawn = await json<AdvanceCareItem>(
      await as("manager", `${path}/${old.id}`, {
        method: "PUT",
        body: {
          withdrawnReason: "Replaced by the ReSPECT plan after review",
          version: old.version,
        },
      }),
    );
    expect(withdrawn.status).toBe("withdrawn");
    const resolved = await json<AdvanceCareList>(await as("manager", path));
    expect(resolved.resuscitation).toMatchObject({ status: "attempt_cpr", conflicting: false });

    const newer = await json<AdvanceCareItem>(
      await as("manager", path, {
        method: "POST",
        body: {
          kind: "respect",
          cprDecision: "do_not_attempt_cpr",
          clinicianName: "Dr Example",
          clinicianRole: "Consultant geriatrician",
          completedOn: new Date().toISOString().slice(0, 10),
        },
      }),
    );
    const all = await json<AdvanceCareList>(await as("manager", `${path}?includeInactive=true`));
    expect(all.items.find((r) => r.id === replacement.id)).toMatchObject({
      status: "superseded",
      supersededByRecordId: newer.id,
    });
    expect(all.resuscitation).toMatchObject({ status: "do_not_attempt_cpr", recordId: newer.id });
  });
});

describe("rule 12: closed records are read-only", () => {
  it("refuses new care planning records for a discharged person but still shows them", async () => {
    // Discharged an hour ago: the activity and visit below happened after it (care.md rule 3).
    await asDemoTenant((c) =>
      c.query(
        "UPDATE person SET status = 'discharged', discharged_at = now() - interval '1 hour' WHERE id = $1",
        [resident(6)],
      ),
    );
    const writes = [
      as("manager", plansPath(6), { method: "POST", body: {} }),
      as("manager", `/v1/people/${resident(6)}/assessments`, { method: "POST", body: mustHigh }),
      as("manager", `/v1/people/${resident(6)}/activities`, {
        method: "POST",
        body: {
          occurredAt: ago(10),
          activity: "Quiz",
          format: "one_to_one",
          attendance: "declined",
        },
      }),
      as("manager", `/v1/people/${resident(6)}/visits`, {
        method: "POST",
        body: { occurredAt: ago(10), kind: "visit_out", visitorName: "Visitor Example" },
      }),
      as("manager", `/v1/people/${resident(6)}/advance-care`, {
        method: "POST",
        body: { kind: "advance_care_plan", completedOn: "2026-10-01" },
      }),
    ];
    for (const response of await Promise.all(writes)) expect(response.status).toBe(422);
    const plans = await json<CarePlanList>(await as("manager", plansPath(6)));
    expect(plans.due).toBeNull();
    expect((await as("manager", `/v1/people/${resident(6)}/advance-care`)).status).toBe(200);
  });
});

describe("hazard HZ-011 scope and audit", () => {
  it("hides people outside a care worker's assignments", async () => {
    for (const path of [
      "care-plans",
      "assessments",
      "advance-care",
      "risk-assessments",
      "visits",
    ]) {
      expect((await as("carer", `/v1/people/${resident(5)}/${path}`)).status).toBe(404);
    }
  });

  it("audits reads and writes by record id, never content", async () => {
    const list = await json<CarePlanList>(await as("manager", plansPath(2)));
    const active = list.items.find((p) => p.status === "active") as CarePlanSummary;
    const planAudit = await json<AuditList>(
      await as("manager", `/v1/audit?resourceType=care_plan&resourceId=${active.id}`),
    );
    expect(planAudit.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(["care.plan.create", "care.plan.publish"]),
    );
    const reads = await json<AuditList>(
      await as("manager", `/v1/audit?resourceType=person&resourceId=${resident(2)}`),
    );
    expect(reads.items.map((a) => a.action)).toEqual(
      expect.arrayContaining(["care.plan.list", "care.assessment.list"]),
    );
    const rows = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ action: string; reason: string | null; scope: unknown }>(
        "SELECT action, reason, scope FROM audit_event WHERE action LIKE 'care.%' AND action NOT LIKE '%.correct'",
      );
      return rows;
    });
    const text = JSON.stringify(rows);
    for (const content of [
      "Needs help to stand",
      "Sam Example",
      "Dr Example",
      "Music for health",
    ]) {
      expect(text).not.toContain(content);
    }
    expect(planAudit.chainIntact).toBe(true);
  });
});
