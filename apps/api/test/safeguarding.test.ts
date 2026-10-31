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
import { escalateSafeguardingReferrals, type TaskDeps, UNROUTED_ACTIONS } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { SAFEGUARDING_UNROUTED_ACTION } from "../src/services/safeguarding";
import { createHarness, type Harness } from "./support/harness";

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

describe("hazard HZ-126 a concern is never dropped or closed without its records", () => {
  it("refuses not referring without a reason, then records who decided and why", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await step(id, "no_referral")).status).toBe(422);
    const response = await step(
      id,
      "no_referral",
      "Self-neglect discussed with the person; they decline and have capacity",
    );
    expect(response.status).toBe(200);
    const view = await json<SafeguardingDetail>(response);
    expect(view.state).toBe("no_referral");
    expect(view.clock.status).toBe("not_referred");
    expect(view.noReferralReason).toContain("Self-neglect");
  });

  it("refuses referring before the referral is recorded", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const refused = await step(id, "referred");
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toContain("Record the referral");
  });

  it("runs a concern through referral, enquiry and outcome to close with Making Safeguarding Personal", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect(
      (
        await update(id, {
          referral: {
            localAuthority: "Example Council",
            method: "phone",
            referredAt: new Date().toISOString(),
            reference: "SG-0001",
          },
          protectiveMeasures: "Two staff for personal care until the enquiry ends",
        })
      ).status,
    ).toBe(200);
    expect((await step(id, "referred")).status).toBe(200);
    expect((await step(id, "enquiry")).status).toBe(422);
    await update(id, {
      enquiry: { kind: "s42_local_authority", openedAt: new Date().toISOString() },
    });
    expect((await step(id, "enquiry")).status).toBe(200);
    expect((await step(id, "outcome")).status).toBe(422);
    await update(id, { finding: "partly_substantiated" });
    expect((await step(id, "outcome")).status).toBe(200);
    const notYet = await step(id, "closed", "Enquiry finished and actions completed");
    expect(notYet.status).toBe(422);
    expect((await json<ProblemDetails>(notYet)).detail).toContain("Making Safeguarding Personal");
    await update(id, {
      personalOutcomes: {
        asked: true,
        notAskedReason: null,
        desiredOutcomes: "To feel safe at night",
        achieved: "partly",
      },
    });
    const closed = await json<SafeguardingDetail>(
      await step(id, "closed", "Enquiry finished and actions completed"),
    );
    expect(closed.state).toBe("closed");
    expect(closed.closedReason).toContain("Enquiry finished");
    expect((await update(id, { description: "Changed after closing" })).status).toBe(422);
  });

  it("needs the DBS decision when a member of staff was removed for harm", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    await update(id, { staffRemovedForHarm: true });
    const refused = await step(
      id,
      "no_referral",
      "Local authority advised that no referral is needed",
    );
    expect(refused.status).toBe(422);
    expect((await json<ProblemDetails>(refused)).detail).toContain("DBS");
    await update(id, {
      dbsReferral: { decision: "referred", reason: null, at: new Date().toISOString() },
    });
    expect(
      (await step(id, "no_referral", "Local authority advised that no referral is needed")).status,
    ).toBe(200);
  });

  it("refuses a stale version", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    const response = await as("manager", `/v1/safeguarding/concerns/${id}`, {
      method: "PUT",
      body: { version: 99, description: "Stale" },
    });
    expect(response.status).toBe(409);
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

  it("refuses the measures of someone outside the care worker's scope", async () => {
    expect((await as("carer", `/v1/people/${resident(5)}/safeguarding/measures`)).status).toBe(404);
  });

  it("warns the manager when an open concern has no protective measures", async () => {
    const { id } = await json<{ id: string }>(await raise("carer"));
    expect((await concern(id)).warnings.join(" ")).toContain("No protective measures");
  });
});

describe("hazard HZ-126 an overdue referral reaches the notification centre (HZ-013)", () => {
  it("alerts the managers once, then stops when the concern is referred", async () => {
    const { id } = await json<{ id: string }>(await raise("carer", { raisedAt: ago(3 * HOUR) }));
    await asDemoTenant((c) =>
      c.query("UPDATE safeguarding_concern SET referral_due_at = raised_at WHERE id = $1", [id]),
    );
    expect((await concern(id)).clock.status).toBe("overdue");
    expect(await escalateSafeguardingReferrals(deps)).toBeGreaterThan(0);
    const alerts = async () =>
      asDemoTenant((c) =>
        c.query<{ recipient: string; severity: string; acknowledged: boolean }>(
          `SELECT recipient_tenant_user_id AS recipient, severity,
             acknowledged_at IS NOT NULL AS acknowledged
           FROM notification WHERE source_type = 'safeguarding_concern' AND source_id = $1`,
          [id],
        ),
      );
    const first = await alerts();
    expect(first.rows.length).toBeGreaterThan(0);
    expect(first.rows.every((r) => r.severity === "urgent")).toBe(true);
    expect(first.rows.map((r) => r.recipient)).toContain(DEMO.users.manager.id);
    await escalateSafeguardingReferrals(deps);
    expect((await alerts()).rows.length).toBe(first.rows.length);
    await update(id, {
      referral: {
        localAuthority: "Example Council",
        method: "online_form",
        referredAt: new Date().toISOString(),
        reference: null,
      },
    });
    expect((await step(id, "referred")).status).toBe(200);
    expect((await alerts()).rows.every((r) => r.acknowledged)).toBe(true);
  });

  it("counts an unrouted overdue concern in the operator's daily signal", () => {
    expect(UNROUTED_ACTIONS).toContain(SAFEGUARDING_UNROUTED_ACTION);
  });
});
