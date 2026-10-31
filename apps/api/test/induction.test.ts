import { createDatabase } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sweepLeaverAccess } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Induction, the Care Certificate and leavers through the API (workforce.md section 2d, rules 19
 * to 23 and section 5; WORK-004, WORK-013; plan slice 29): the staff file's permissions on every
 * route with refusals audited; the checklist from offer to probation with read-and-sign counted;
 * Care Certificate standards assessed and observed by an assessor, never the worker; leaving
 * with access ended at once or by the sweep from the day after, the exit interview, references
 * and the staff file's keep-until date; audit events with ids and codes only.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const json = async <T>(response: Response) => (await response.json()) as T;
const today = () => ukIsoDate(new Date());
const inDays = (days: number) => ukIsoDate(addUkDays(new Date(), days));

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
  } finally {
    client.release();
  }
}

interface Induction {
  planVersion: number | null;
  checklist: { kind: string; status: string }[];
  policies: { required: number; signed: number };
  careCertificate: { competent: number; standards: { id: string; status: string }[] };
  probation: { outcome: string | null; reviews: unknown[] };
  shadowShifts: unknown[];
}
interface Leaving {
  version: number;
  accessRemovedAt: string | null;
  exitInterview: string;
  staffFileRetainUntil: string | null;
  checklist: { kind: string; status: string }[];
  references: { id: string; state: string; version: number }[];
}

let profile = "";
let agencyProfile = "";
const status = (detail: Induction | Leaving, kind: string) =>
  detail.checklist.find((i) => i.kind === kind)?.status;

beforeAll(async () => {
  h = await createHarness();
  const started = inDays(-30);
  const [carer] = await sql<{ id: string }>(
    `INSERT INTO staff_profile (tenant_user_id, job_title, starts_on, date_of_birth)
     VALUES ($1, 'Care worker', $2, '1990-05-01') RETURNING id`,
    [DEMO.users.carer.id, started],
  );
  profile = carer?.id ?? "";
  const [agency] = await sql<{ id: string }>(
    `INSERT INTO staff_profile (tenant_user_id, job_title, starts_on)
     SELECT id, 'Bank care worker', $1 FROM tenant_user
      WHERE email = 'agency@example.invalid' AND tenant_id = $2 RETURNING id`,
    [started, DEMO.tenantId],
  );
  agencyProfile = agency?.id ?? "";
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("the staff file's permissions", () => {
  it("refuses a care worker HR's view, and audits it", async () => {
    expect((await as("carer", `/v1/workforce/staff-files/${profile}/induction`)).status).toBe(403);
    const denied = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event WHERE action = 'workforce.staff_file.read' AND outcome = 'denied'`,
    );
    expect(denied[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("shows the worker their own induction", async () => {
    const own = await as("carer", "/v1/me/induction");
    expect(own.status).toBe(200);
    expect((await json<Induction>(own)).careCertificate.standards).toHaveLength(16);
  });
});

describe("induction (rules 19 to 21)", () => {
  it("lists the checklist, overdue before-start items once started", async () => {
    const detail = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction`),
    );
    expect(status(detail, "contract_issued")).toBe("overdue");
    expect(status(detail, "location_induction")).toBe("outstanding");
    expect(detail.planVersion).toBeNull();
  });

  it("sets up the plan, ticks items in the caller's name and records shadowing", async () => {
    let detail = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction`, {
        method: "PUT",
        body: { probationEndsOn: inDays(150), careCertificateHeld: false },
      }),
    );
    expect(detail.planVersion).toBe(1);
    detail = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction/items/contract_issued`, {
        method: "POST",
        body: { doneOn: inDays(-40) },
      }),
    );
    expect(status(detail, "contract_issued")).toBe("done");
    const twice = await as(
      "manager",
      `/v1/workforce/staff-files/${profile}/induction/items/contract_issued`,
      {
        method: "POST",
        body: { doneOn: inDays(-40) },
      },
    );
    expect(twice.status).toBe(409);
    const selfShadow = await as(
      "manager",
      `/v1/workforce/staff-files/${profile}/induction/shadow-shifts`,
      {
        method: "POST",
        body: { shiftOn: inDays(-29), shadowedId: DEMO.users.carer.id },
      },
    );
    expect(selfShadow.status).toBe(422);
    detail = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction/shadow-shifts`, {
        method: "POST",
        body: { shiftOn: inDays(-29), shadowedId: DEMO.users.nurse.id },
      }),
    );
    expect(detail.shadowShifts).toHaveLength(1);
  });

  it("counts read-and-sign: nothing published needs signing yet", async () => {
    const detail = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction`),
    );
    expect(detail.policies).toEqual({ required: 0, signed: 0 });
    expect(status(detail, "policy_read_and_sign")).toBe("done");
  });

  it("reviews and decides probation, never twice once passed", async () => {
    await as("manager", `/v1/workforce/staff-files/${profile}/induction/probation-reviews`, {
      method: "POST",
      body: { reviewOn: inDays(-1), outcome: "on_track", notes: "Settling in well." },
    });
    const plan = await json<Induction>(
      await as("manager", `/v1/workforce/staff-files/${profile}/induction`),
    );
    const decide = (outcome: string, expectedVersion: number | null) =>
      as("manager", `/v1/workforce/staff-files/${profile}/induction/probation-decision`, {
        method: "POST",
        body: { expectedVersion, outcome, decidedOn: today() },
      });
    expect((await decide("passed", (plan.planVersion ?? 0) + 5)).status).toBe(409);
    const passed = await json<Induction>(await decide("passed", plan.planVersion));
    expect(passed.probation.outcome).toBe("passed");
    expect(status(passed, "probation_decided")).toBe("done");
    expect((await decide("not_passed", (plan.planVersion ?? 0) + 1)).status).toBe(422);
  });
});

describe("the Care Certificate (rule 20)", () => {
  const step = (who: string, standard: string, body: unknown) =>
    as(who, `/v1/workforce/staff-files/${profile}/care-certificate/${standard}`, {
      method: "PUT",
      body,
    });

  it("is assessed then observed by an assessor, never the worker", async () => {
    expect((await step("carer", "cc01", { step: "knowledge", on: today() })).status).toBe(403);
    expect((await step("manager", "cc01", { step: "observation", on: today() })).status).toBe(422);
    expect((await step("manager", "cc01", { step: "knowledge", on: inDays(-2) })).status).toBe(200);
    const observed = await step("manager", "cc01", { step: "observation", on: today() });
    expect(observed.status).toBe(200);
    const view = await json<{ careCertificate: { competent: number } }>(observed);
    expect(view.careCertificate.competent).toBe(1);
    expect((await step("manager", "cc01", { step: "observation", on: today() })).status).toBe(422);
  });
});

describe("leaving (rules 22 and 23)", () => {
  it("records the leaving, keeps the file to the 75th birthday and ends access at once", async () => {
    const recorded = await as("manager", `/v1/workforce/staff-files/${profile}/leaving`, {
      method: "POST",
      body: { leavingOn: today(), reason: "resignation" },
    });
    expect(recorded.status).toBe(201);
    let leaving = await json<Leaving>(recorded);
    expect(leaving.staffFileRetainUntil).toBe("2065-05-01");
    expect(leaving.accessRemovedAt).toBeNull();
    const [left] = await sql<{ left_on: string }>(
      "SELECT left_on::text FROM staff_profile WHERE id = $1",
      [profile],
    );
    expect(left?.left_on).toBe(today());
    expect(
      (
        await as("manager", `/v1/workforce/staff-files/${profile}/leaving`, {
          method: "POST",
          body: { leavingOn: today(), reason: "resignation" },
        })
      ).status,
    ).toBe(422);

    leaving = await json<Leaving>(
      await as("manager", `/v1/workforce/staff-files/${profile}/leaving/exit-interview`, {
        method: "PUT",
        body: {
          expectedVersion: leaving.version,
          state: "held",
          heldOn: today(),
          summary: "Moving away.",
        },
      }),
    );
    expect(leaving.exitInterview).toBe("held");
    leaving = await json<Leaving>(
      await as("manager", `/v1/workforce/staff-files/${profile}/references`, {
        method: "POST",
        body: { requestedOn: today(), requester: "Example Care Homes Ltd", kind: "conduct" },
      }),
    );
    const reference = leaving.references[0];
    leaving = await json<Leaving>(
      await as("manager", `/v1/workforce/staff-files/${profile}/references/${reference?.id}`, {
        method: "PATCH",
        body: { expectedVersion: reference?.version, state: "sent", sentOn: today() },
      }),
    );
    expect(leaving.references[0]?.state).toBe("sent");

    const ended = await as("manager", `/v1/workforce/staff-files/${profile}/leaving/end-access`, {
      method: "POST",
    });
    expect(ended.status).toBe(200);
    const afterEnd = await json<Leaving>(ended);
    expect(afterEnd.accessRemovedAt).not.toBeNull();
    expect(status(afterEnd, "access_removed")).toBe("done");
    const again = await as("manager", `/v1/workforce/staff-files/${profile}/leaving/end-access`, {
      method: "POST",
    });
    expect(again.status).toBe(409);
    // The leaver now holds nothing.
    expect((await as("carer", "/v1/me/induction")).status).not.toBe(200);
  });

  it("ends access by the sweep from the day after the leaving date, once", async () => {
    await as("manager", `/v1/workforce/staff-files/${agencyProfile}/leaving`, {
      method: "POST",
      body: { leavingOn: inDays(-1), reason: "end_of_fixed_term" },
    });
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await sweepLeaverAccess(deps)).toBe(1);
    expect(await sweepLeaverAccess(deps)).toBe(0);
    const [member] = await sql<{ status: string }>(
      "SELECT status FROM tenant_user WHERE email = 'agency@example.invalid' AND tenant_id = $1",
      [DEMO.tenantId],
    );
    expect(member?.status).toBe("left");
    const leaving = await json<Leaving>(
      await as("manager", `/v1/workforce/staff-files/${agencyProfile}/leaving`),
    );
    expect(leaving.staffFileRetainUntil).toBeNull();
  });

  it("audits by ids and codes only", async () => {
    const events = await sql<{ action: string; scope: unknown }>(
      `SELECT action, scope FROM audit_event
        WHERE action LIKE 'workforce.induction.%' OR action LIKE 'workforce.leaving.%'
           OR action LIKE 'workforce.reference.%' OR action LIKE 'workforce.care_certificate.%'`,
    );
    const actions = new Set(events.map((e) => e.action));
    for (const action of [
      "workforce.induction.plan_set",
      "workforce.induction.item_ticked",
      "workforce.induction.probation_decided",
      "workforce.care_certificate.recorded",
      "workforce.leaving.recorded",
      "workforce.leaving.access_ended",
      "workforce.reference.answered",
    ]) {
      expect(actions, action).toContain(action);
    }
    const text = JSON.stringify(events);
    for (const secret of ["Moving away", "Settling in", "Example Care Homes"]) {
      expect(text).not.toContain(secret);
    }
  });
});
