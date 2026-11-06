import type {
  ProblemDetails,
  SafeguardingDetail,
  SafeguardingList,
  SafeguardingMeasures,
} from "@harbour/contracts";
import { SafeguardingAbuseType, SafeguardingFinding, SafeguardingState } from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { ABUSE_TYPES, ENQUIRY_FINDINGS, SAFEGUARDING_WORKFLOW } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escalateSafeguardingReferrals,
  escalateTasks,
  type TaskDeps,
  UNROUTED_ACTIONS,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { SAFEGUARDING_UNROUTED_ACTION } from "../src/services/safeguarding";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * The safeguarding log through the API (Phase 2 slice 13; SAFE-006; HZ-126): raising a concern,
 * the log and its steps, scope as incidents, the protective measures for staff caring for the
 * person, and the overdue-referral sweep feeding the notification centre (HZ-013). Demo residents
 * 1 to 3 are assigned to the care worker; the Registered Manager covers Harbour House; the nurse
 * has no MFA.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

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

async function raise(
  user: keyof Harness["tokens"],
  body: Record<string, unknown> = {},
): Promise<Response> {
  return as(user, "/v1/safeguarding/concerns", {
    method: "POST",
    body: {
      personId: resident(1),
      abuseTypes: ["neglect"],
      description: "Bruising found on the upper arm, cause not known",
      ...body,
    },
  });
}

async function concern(id: string): Promise<SafeguardingDetail> {
  return json<SafeguardingDetail>(await as("manager", `/v1/safeguarding/concerns/${id}`));
}

async function update(id: string, body: Record<string, unknown>) {
  const { version } = await concern(id);
  return as("manager", `/v1/safeguarding/concerns/${id}`, {
    method: "PUT",
    body: { version, ...body },
  });
}

async function step(id: string, to: string, reason?: string) {
  const { version } = await concern(id);
  return as("manager", `/v1/safeguarding/concerns/${id}/step`, {
    method: "POST",
    body: { to, version, ...(reason ? { reason } : {}) },
  });
}

describe("the contract keeps the safeguarding code lists in step with the domain", () => {
  it("lists every abuse type, state and finding", () => {
    expect([...SafeguardingAbuseType.options].sort()).toEqual(
      ABUSE_TYPES.map((t) => t.value).sort(),
    );
    expect([...SafeguardingState.options].sort()).toEqual([...SAFEGUARDING_WORKFLOW.states].sort());
    expect([...SafeguardingFinding.options].sort()).toEqual([...ENQUIRY_FINDINGS].sort());
  });
});

describe("hazard HZ-126 anyone who works with the person can raise a concern, and only managers run the log", () => {
  it("lets a care worker raise a concern about their own people only", async () => {
    const mine = await raise("carer");
    expect(mine.status).toBe(201);
    const raised = await json<{ id: string; state: string; referralDueAt: string }>(mine);
    expect(raised.state).toBe("concern");
    expect(new Date(raised.referralDueAt).getTime()).toBeGreaterThan(Date.now());
    expect((await raise("carer", { personId: resident(5) })).status).toBe(404);
  });

  it("asks for MFA before a concern is raised", async () => {
    const response = await raise("nurse");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toMatch(/mfa/);
  });

  it("returns the same concern for a replay of the same client id", async () => {
    const id = crypto.randomUUID();
    const first = await json<{ id: string }>(await raise("carer", { id }));
    const again = await raise("carer", { id });
    expect(again.status).toBe(201);
    expect((await json<{ id: string }>(again)).id).toBe(first.id);
  });

  it("refuses a concern dated in the future", async () => {
    const response = await raise("carer", {
      raisedAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    expect(response.status).toBe(422);
  });

  it("keeps the log itself for those who manage safeguarding", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await as("carer", "/v1/safeguarding/concerns")).status).toBe(403);
    expect((await as("carer", `/v1/safeguarding/concerns/${id}`)).status).toBe(403);
    const list = await json<SafeguardingList>(await as("manager", "/v1/safeguarding/concerns"));
    expect(list.concerns.map((c) => c.id)).toContain(id);
    expect(list.concerns.find((c) => c.id === id)?.clock.status).toBe("due");
  });

  it("audits by record id, never the concern's words", async () => {
    const { id } = await json<{ id: string }>(
      await raise("carer", { description: "A distinctive phrase that must stay out of the audit" }),
    );
    const rows = await asDemoTenant((c) =>
      c.query<{ action: string; text: string }>(
        `SELECT action, coalesce(scope::text, '') || coalesce(reason, '') AS text FROM audit_event
         WHERE resource_type = 'safeguarding_concern' AND resource_id = $1`,
        [id],
      ),
    );
    expect(rows.rows.map((r) => r.action)).toContain("safety.safeguarding.raise");
    for (const r of rows.rows) expect(r.text).not.toContain("distinctive phrase");
  });
});

/** Making Safeguarding Personal, asked at the start, and the staff question answered. */
const asked = {
  personalOutcomes: {
    asked: true,
    notAskedReason: null,
    desiredOutcomes: "To feel safe at night",
    achieved: null,
  },
  staffHarm: "no_staff_involved",
};

const referral = () => ({
  referral: {
    localAuthority: "Example Council",
    method: "phone",
    referredAt: new Date().toISOString(),
    reference: "SG-0001",
  },
});

describe("hazard HZ-126 a concern is never dropped or closed without its records", () => {
  it("refuses not referring without a reason or the person's wishes, then records who decided", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await step(id, "no_referral")).status).toBe(422);
    const reason = "Self-neglect discussed with the person; they decline and have capacity";
    const notAsked = await step(id, "no_referral", reason);
    expect(notAsked.status).toBe(422);
    expect((await json<ProblemDetails>(notAsked)).detail).toContain("Making Safeguarding Personal");
    await update(id, asked);
    const response = await step(id, "no_referral", reason);
    expect(response.status).toBe(200);
    const view = await json<SafeguardingDetail>(response);
    expect(view.state).toBe("no_referral");
    expect(view.clock.status).toBe("not_referred");
    expect(view.noReferralReason).toContain("Self-neglect");
  });

  it("refuses referring before the referral and the person's wishes are recorded", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const refused = await step(id, "referred");
    expect(refused.status).toBe(422);
    const detail = (await json<ProblemDetails>(refused)).detail ?? "";
    expect(detail).toContain("Record the referral");
    expect(detail).toContain("Making Safeguarding Personal");
  });

  it("runs a concern through referral, enquiry and outcome to close, with the measures carried on", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, {
      ...referral(),
      personalOutcomes: asked.personalOutcomes,
      protectiveMeasures: "Two staff for personal care until the enquiry ends",
    });
    expect((await step(id, "referred")).status).toBe(200);
    expect((await step(id, "enquiry")).status).toBe(422);
    await update(id, {
      enquiry: { kind: "s42_local_authority", openedAt: new Date().toISOString() },
    });
    expect((await step(id, "enquiry")).status).toBe(200);
    await update(id, { finding: "partly_substantiated" });
    const noStaffAnswer = await step(id, "outcome");
    expect(noStaffAnswer.status).toBe(422);
    expect((await json<ProblemDetails>(noStaffAnswer)).detail).toContain("member of staff");
    await update(id, { staffHarm: "no_staff_involved" });
    expect((await step(id, "outcome")).status).toBe(200);
    const reason = "Enquiry finished and actions completed";
    const notAchieved = await step(id, "closed", reason);
    expect(notAchieved.status).toBe(422);
    await update(id, {
      personalOutcomes: { ...asked.personalOutcomes, achieved: "partly" },
    });
    const measures = await step(id, "closed", reason);
    expect(measures.status).toBe(422);
    expect((await json<ProblemDetails>(measures)).detail).toContain("protective measures");
    await update(id, { measuresOutcome: "carried_into_care_plan" });
    const closed = await json<SafeguardingDetail>(await step(id, "closed", reason));
    expect(closed.state).toBe("closed");
    expect(closed.closedReason).toContain("Enquiry finished");
    expect(closed.measuresOutcome).toBe("carried_into_care_plan");
    expect((await update(id, { abuseTypes: ["physical"] })).status).toBe(422);
  });

  it("needs the DBS decision when a member of staff was removed, or would have been", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, { ...asked, staffHarm: "would_have_removed" });
    const reason = "Local authority advised that no referral is needed";
    const refused = await step(id, "no_referral", reason);
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toContain("DBS");
    await update(id, {
      dbsReferral: { decision: "referred", reason: null, at: new Date().toISOString() },
    });
    expect((await step(id, "no_referral", reason)).status).toBe(200);
  });

  it("keeps the raiser's words: the description cannot be changed", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const { version } = await concern(id);
    const response = await as("manager", `/v1/safeguarding/concerns/${id}`, {
      method: "PUT",
      body: { version, description: "Rewritten by a manager" },
    });
    expect(response.status).toBe(422);
    expect((await concern(id)).description).not.toContain("Rewritten");
  });

  it("refuses not referring or closing by the manager who raised the concern", async () => {
    const { id } = await json<{ id: string }>(await raise("manager"));
    await update(id, asked);
    const response = await step(id, "no_referral", "No abuse found by the GP review of the bruise");
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toMatch(/separation/);
  });

  it("tells the other managers when a concern is not referred", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, asked);
    expect(
      (await step(id, "no_referral", "No abuse found by the GP review of the bruise")).status,
    ).toBe(200);
    const told = await asDemoTenant((c) =>
      c.query<{ recipient: string }>(
        `SELECT recipient_tenant_user_id AS recipient FROM notification
         WHERE source_id = $1 AND kind = 'safety.safeguarding.not_referred'`,
        [id],
      ),
    );
    const recipients = told.rows.map((r) => r.recipient);
    expect(recipients).toContain(DEMO.users.owner.id);
    expect(recipients).not.toContain(DEMO.users.manager.id);
  });

  it("refuses a stale version", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const response = await as("manager", `/v1/safeguarding/concerns/${id}`, {
      method: "PUT",
      body: { version: 99, abuseTypes: ["physical"] },
    });
    expect(response.status).toBe(409);
  });
});

describe("hazard HZ-126 a concern raised is never left unseen", () => {
  const alerts = (id: string) =>
    asDemoTenant((c) =>
      c.query<{
        recipient: string;
        severity: string;
        channels: string[];
        escalate_at: Date | null;
        acknowledged_at: Date | null;
      }>(
        `SELECT recipient_tenant_user_id AS recipient, severity, channels, escalate_at,
                acknowledged_at
           FROM notification WHERE source_id = $1 AND kind = 'safety.safeguarding.raised'`,
        [id],
      ),
    );
  const referralTask = (id: string) =>
    asDemoTenant((c) =>
      c.query<{ status: string; required_permission: string; due_at: Date; priority: string }>(
        `SELECT status, required_permission, due_at, priority FROM task
          WHERE source_id = $1 AND kind = 'safety.safeguarding_referral'`,
        [id],
      ),
    );

  it("tells the managers at the person's home at once, through the escalation chain, with a task", async () => {
    const raised = await json<{ id: string; referralDueAt: string }>(await raise("carer"));
    const { rows } = await alerts(raised.id);
    const recipients = rows.map((r) => r.recipient);
    expect(recipients).toContain(DEMO.users.manager.id);
    expect(recipients).toContain(DEMO.users.owner.id);
    expect(recipients).not.toContain(DEMO.users.carer.id);
    for (const r of rows) {
      expect(r.severity).toBe("urgent");
      // In the app: push has no destination yet (clinical review, finding 6).
      expect(r.channels).toEqual(["in_app"]);
      // H-598: unacknowledged, it goes to the chain's next step after the escalation minutes.
      expect(r.escalate_at).not.toBeNull();
    }
    const tasks = (await referralTask(raised.id)).rows;
    expect(tasks).toEqual([
      expect.objectContaining({
        status: "open",
        required_permission: "safety.safeguarding.manage",
        priority: "urgent",
      }),
    ]);
    expect(tasks[0]?.due_at.toISOString()).toBe(raised.referralDueAt);
  });

  it("does not tell the manager who raised it, only the others", async () => {
    const { id } = await json<{ id: string }>(await raise("manager"));
    const recipients = (await alerts(id)).rows.map((r) => r.recipient);
    expect(recipients).not.toContain(DEMO.users.manager.id);
    expect(recipients).toContain(DEMO.users.owner.id);
  });

  it("closes the task and stops the chain when the referral is decided", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, asked);
    expect(
      (await step(id, "no_referral", "No abuse found by the GP review of the bruise")).status,
    ).toBe(200);
    expect((await referralTask(id)).rows[0]?.status).toBe("done");
    for (const r of (await alerts(id)).rows) {
      expect(r.acknowledged_at).not.toBeNull();
      expect(r.escalate_at).toBeNull();
    }
  });

  it("closes the task as the manager who referred it, with the concern as its evidence", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, { ...referral(), personalOutcomes: asked.personalOutcomes });
    expect((await step(id, "referred")).status).toBe(200);
    const { rows } = await asDemoTenant((c) =>
      c.query<{ status: string; completed_by: string; evidence_type: string; evidence_id: string }>(
        `SELECT status, completed_by, evidence_type, evidence_id FROM task
          WHERE source_id = $1 AND kind = 'safety.safeguarding_referral'`,
        [id],
      ),
    );
    expect(rows).toEqual([
      {
        status: "done",
        completed_by: DEMO.users.manager.id,
        evidence_type: "safeguarding_concern",
        evidence_id: id,
      },
    ]);
  });

  it("stops the escalation once a manager other than the raiser opens the concern", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await alerts(id)).rows.every((r) => r.escalate_at !== null)).toBe(true);
    expect((await as("manager", `/v1/safeguarding/concerns/${id}`)).status).toBe(200);
    for (const r of (await alerts(id)).rows) {
      expect(r.escalate_at).toBeNull();
      // Still unread for the others: only the chain stops.
      expect(r.acknowledged_at).toBeNull();
    }
  });

  it("leaves an overdue referral task to the safeguarding sweep, never the general task engine", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const taskId = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE task SET due_at = now() - interval '3 hours'
          WHERE source_id = $1 AND kind = 'safety.safeguarding_referral' RETURNING id`,
        [id],
      );
      return rows[0]?.id ?? "";
    });
    await escalateTasks(deps, new Date());
    const { rows } = await asDemoTenant((c) =>
      c.query<{ escalation_level: number; told: string }>(
        `SELECT escalation_level,
                (SELECT count(*) FROM notification WHERE source_id = task.id::text)::text AS told
           FROM task WHERE id = $1`,
        [taskId],
      ),
    );
    expect(rows).toEqual([{ escalation_level: 0, told: "0" }]);
  });

  it("asks again what happens to the measures when they change", async () => {
    const { id } = await json<{ id: string }>(
      await raise("carer", { protectiveMeasures: "Two staff for personal care" }),
    );
    await update(id, { measuresOutcome: "no_longer_needed" });
    expect((await concern(id)).measuresOutcome).toBe("no_longer_needed");
    // The same measures sent again keep the answer.
    await update(id, { protectiveMeasures: "Two staff for personal care" });
    expect((await concern(id)).measuresOutcome).toBe("no_longer_needed");
    await update(id, { protectiveMeasures: "Two staff for personal care and checks every hour" });
    expect((await concern(id)).measuresOutcome).toBeNull();
    // Answered in the same update as the change, the answer stands.
    await update(id, {
      protectiveMeasures: "Checks every hour only",
      measuresOutcome: "carried_into_care_plan",
    });
    expect((await concern(id)).measuresOutcome).toBe("carried_into_care_plan");
  });
});

describe("hazard HZ-126 the log shows only the people the manage permission reaches (ADR-0071)", () => {
  it("leaves out a concern the manager raised about someone outside their homes", async () => {
    const id = crypto.randomUUID();
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO safeguarding_concern (id, location_id, person_id, abuse_types, description,
           raised_at, raised_by, referral_due_at)
         VALUES ($1, $2, $3, '{neglect}', 'Raised while covering the Lodge', now(), $4,
           now() + interval '24 hours')`,
        [id, LODGE.locationId, LODGE.personId, DEMO.users.manager.id],
      ),
    );
    const list = await json<SafeguardingList>(await as("manager", "/v1/safeguarding/concerns"));
    expect(list.concerns.map((c) => c.id)).not.toContain(id);
    expect((await as("manager", `/v1/safeguarding/concerns/${id}`)).status).toBe(403);
  });

  it("answers a replayed id only to the person who raised it, about the same person", async () => {
    const id = crypto.randomUUID();
    expect((await raise("carer", { id })).status).toBe(201);
    expect((await raise("manager", { id })).status).toBe(422);
    expect((await raise("carer", { id, personId: resident(2) })).status).toBe(422);
  });
});

describe("hazard HZ-126 a concern opened from a Phase 1 s.42 draft", () => {
  it("takes the draft's person and warns while the draft is still open after the referral", async () => {
    const draftId = crypto.randomUUID();
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO statutory_notification (id, location_id, person_id, source_key, kind, due_at,
           retention_class)
         VALUES ($1, $2, $3, $4, 'safeguarding_s42', now(), 'serious_incident')`,
        [draftId, DEMO.locationId, resident(1), `test:${draftId}`],
      ),
    );
    const raised = await raise("carer", { notificationId: draftId });
    expect(raised.status).toBe(201);
    const { id } = await json<{ id: string }>(raised);
    expect((await raise("carer", { notificationId: draftId })).status).toBe(409);
    expect((await concern(id)).notification?.status).toBe("draft");
    await update(id, { ...referral(), personalOutcomes: asked.personalOutcomes });
    await step(id, "referred");
    expect((await concern(id)).warnings.join(" ")).toContain(
      "s.42 notification draft is still open",
    );
  });

  it("refuses a draft of another kind", async () => {
    const draftId = crypto.randomUUID();
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO statutory_notification (id, location_id, person_id, source_key, kind, due_at,
           retention_class)
         VALUES ($1, $2, $3, $4, 'cqc_reg16_death', now(), 'serious_incident')`,
        [draftId, DEMO.locationId, resident(1), `test:${draftId}`],
      ),
    );
    expect((await raise("carer", { notificationId: draftId })).status).toBe(422);
  });
});

describe("hazard HZ-126 staff caring for the person see the protective measures, never the allegation", () => {
  it("shows a care worker the measures of their person's open concerns", async () => {
    const { id } = await json<{ id: string }>(
      await raise("carer", {
        personId: resident(2),
        description: "Allegation text not for the measures",
      }),
    );
    let view = await json<SafeguardingMeasures>(
      await as("carer", `/v1/people/${resident(2)}/safeguarding/measures`),
    );
    expect(view.openWithoutMeasures).toBeGreaterThan(0);
    await update(id, {
      protectiveMeasures: "No visits from the named visitor while the enquiry runs",
    });
    view = await json<SafeguardingMeasures>(
      await as("carer", `/v1/people/${resident(2)}/safeguarding/measures`),
    );
    expect(view.measures.map((m) => m.text)).toContain(
      "No visits from the named visitor while the enquiry runs",
    );
    expect(JSON.stringify(view)).not.toContain("Allegation text");
  });

  it("treats blank measures as none recorded", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await update(id, { protectiveMeasures: "   " })).status).toBe(200);
    const view = await concern(id);
    expect(view.protectiveMeasures).toBeNull();
    expect(view.warnings.join(" ")).toContain("No protective measures");
  });

  it("refuses the measures of someone outside the care worker's scope", async () => {
    expect((await as("carer", `/v1/people/${resident(5)}/safeguarding/measures`)).status).toBe(404);
  });
});

describe("hazard HZ-126 an overdue referral reaches the notification centre (HZ-013)", () => {
  const alerts = async (id: string) =>
    asDemoTenant((c) =>
      c.query<{ recipient: string; severity: string; acknowledged: boolean }>(
        `SELECT recipient_tenant_user_id AS recipient, severity,
           acknowledged_at IS NOT NULL AS acknowledged
         FROM notification WHERE source_type = 'safeguarding_concern' AND source_id = $1
           AND kind = 'safety.safeguarding.overdue'`,
        [id],
      ),
    );

  it("alerts the managers, again each day even if acknowledged, until the concern is referred", async () => {
    const { id } = await json<{ id: string }>(await raise("carer", { raisedAt: ago(3 * HOUR) }));
    await asDemoTenant((c) =>
      c.query("UPDATE safeguarding_concern SET referral_due_at = raised_at WHERE id = $1", [id]),
    );
    expect((await concern(id)).clock.status).toBe("overdue");
    expect(await escalateSafeguardingReferrals(deps)).toBeGreaterThan(0);
    const first = await alerts(id);
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.every((r) => r.severity === "urgent")).toBe(true);
    expect(first.rows.map((r) => r.recipient)).toContain(DEMO.users.manager.id);
    // The same day: no second alert.
    await escalateSafeguardingReferrals(deps);
    expect((await alerts(id)).rows.length).toBe(first.rows.length);
    // Acknowledged by hand, then a day passes: it alerts again, because it is still not referred.
    await asDemoTenant((c) =>
      c.query(
        `UPDATE notification SET acknowledged_at = now(), escalate_at = NULL
         WHERE source_id = $1`,
        [id],
      ),
    );
    await asDemoTenant((c) =>
      c.query(
        `UPDATE safeguarding_concern SET overdue_notified_at = now() - interval '25 hours'
         WHERE id = $1`,
        [id],
      ),
    );
    const now = new Date(Date.now() + 25 * HOUR);
    expect(await escalateSafeguardingReferrals(deps, now)).toBeGreaterThan(0);
    const again = await alerts(id);
    expect(again.rows.some((r) => !r.acknowledged)).toBe(true);
    // Referring acknowledges every alert.
    await update(id, { ...referral(), personalOutcomes: asked.personalOutcomes });
    expect((await step(id, "referred")).status).toBe(200);
    expect((await alerts(id)).rows.every((r) => r.acknowledged)).toBe(true);
  });

  it("follows the person to their current home, not where the concern was raised", async () => {
    const { id } = await json<{ id: string }>(await raise("carer", { raisedAt: ago(3 * HOUR) }));
    await asDemoTenant((c) =>
      c.query(
        `UPDATE safeguarding_concern SET referral_due_at = raised_at, location_id = $2
         WHERE id = $1`,
        [id, LODGE.locationId],
      ),
    );
    await escalateSafeguardingReferrals(deps);
    const rows = await asDemoTenant((c) =>
      c.query<{ location: string }>(
        `SELECT location_id AS location FROM notification
         WHERE source_id = $1 AND kind = 'safety.safeguarding.overdue'`,
        [id],
      ),
    );
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(rows.rows.every((r) => r.location === DEMO.locationId)).toBe(true);
  });

  it("counts an unrouted overdue concern in the operator's daily signal", () => {
    expect(UNROUTED_ACTIONS).toContain(SAFEGUARDING_UNROUTED_ACTION);
  });
});
