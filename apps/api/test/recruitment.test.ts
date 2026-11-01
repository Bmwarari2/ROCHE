import { DEMO } from "@harbour/db/seed";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Applicant tracking through the API (workforce.md section 2c, rules 11 to 13 and section 5;
 * WORK-001; plan slice 23): workforce.recruitment.manage on every route with refusals audited; the
 * path from a job template to an accepted offer that creates the staff profile with the offer's
 * Schedule 3 conditions outstanding; stale versions refused; equality monitoring counted with
 * small numbers suppressed and never read row by row; the applicant's keep-until date; audit
 * events with ids and codes only.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const json = async <T>(response: Response) => (await response.json()) as T;
const today = () => ukIsoDate(new Date());

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

interface Detail {
  application: { id: string; stage: string; stageReason: string | null; version: number };
  applicant: {
    id: string;
    retainUntil: string | null;
    talentPoolUntil: string | null;
    version: number;
  };
  history: { toStage: string }[];
  interviews: { total: number; outOf: number }[];
  offer: {
    id: string;
    conditions: string[];
    status: string;
    version: number;
    staffProfileId: string | null;
  } | null;
}

const template = {
  title: "Care worker",
  pathwayCategory: "care_worker",
  registrationBody: null,
  essentialCriteria: ["Can work weekends", "Right to work in the UK"],
  valuesQuestions: [
    {
      key: "compassion",
      value: "compassion",
      question: "Tell us about a time you comforted someone.",
    },
    { key: "courage", value: "courage", question: "When did you speak up about something wrong?" },
  ],
};
let templateId = "";
let vacancyId = "";

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("workforce.recruitment.manage on every route", () => {
  it("refuses a care worker, and audits the refusal", async () => {
    expect((await as("carer", "/v1/workforce/job-templates")).status).toBe(403);
    expect(
      (await as("carer", "/v1/workforce/job-templates", { method: "POST", body: template })).status,
    ).toBe(403);
    const denied = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE action = 'workforce.recruitment.manage' AND outcome = 'denied'`,
    );
    expect(denied[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("creates a template and an open vacancy", async () => {
    const created = await as("manager", "/v1/workforce/job-templates", {
      method: "POST",
      body: template,
    });
    expect(created.status).toBe(201);
    templateId = (await json<{ id: string }>(created)).id;
    const vac = await as("manager", "/v1/workforce/vacancies", {
      method: "POST",
      body: {
        jobTemplateId: templateId,
        locationId: DEMO.locationId,
        title: "Care worker, days",
        positions: 1,
        opensOn: today(),
        closesOn: null,
        status: "open",
      },
    });
    expect(vac.status).toBe(201);
    vacancyId = (await json<{ id: string }>(vac)).id;
  });
});

describe("rule 11: from application to an accepted offer", () => {
  let detail: Detail;
  const apply = (givenName: string, email: string) =>
    as("manager", `/v1/workforce/vacancies/${vacancyId}/applications`, {
      method: "POST",
      body: { givenName, familyName: "Applicant", email, phone: null },
    });

  it("records the application and its first stage", async () => {
    const created = await apply("Ada", "ada.applicant@example.invalid");
    expect(created.status).toBe(201);
    detail = await json<Detail>(created);
    expect(detail.application.stage).toBe("applied");
    expect(detail.history.map((e) => e.toStage)).toEqual(["applied"]);
    expect((await apply("Ada", "ada.applicant@example.invalid")).status).toBe(409);
  });

  it("refuses to shortlist with a criterion not met, and a stale version", async () => {
    const path = `/v1/workforce/applications/${detail.application.id}/shortlist`;
    const unmet = await as("manager", path, {
      method: "POST",
      body: {
        criteria: [true, false],
        decision: "shortlist",
        expectedVersion: detail.application.version,
      },
    });
    expect(unmet.status).toBe(422);
    const stale = await as("manager", path, {
      method: "POST",
      body: { criteria: [true, true], decision: "shortlist", expectedVersion: 99 },
    });
    expect(stale.status).toBe(409);
    const ok = await as("manager", path, {
      method: "POST",
      body: {
        criteria: [true, true],
        decision: "shortlist",
        expectedVersion: detail.application.version,
      },
    });
    expect(ok.status).toBe(200);
    detail = await json<Detail>(ok);
    expect(detail.application.stage).toBe("shortlisted");
  });

  it("refuses an offer before an interview, then records the interview with its total", async () => {
    const early = await as("manager", `/v1/workforce/applications/${detail.application.id}/offer`, {
      method: "POST",
      body: {
        proposedStartOn: null,
        previousCareWork: false,
        expectedVersion: detail.application.version,
      },
    });
    expect(early.status).toBe(422);
    const path = `/v1/workforce/applications/${detail.application.id}/interviews`;
    const unscored = await as("manager", path, {
      method: "POST",
      body: {
        heldOn: today(),
        panel: [DEMO.users.manager.id],
        scores: { compassion: 3 },
        notes: null,
        recommendation: "proceed",
        expectedVersion: detail.application.version,
      },
    });
    expect(unscored.status).toBe(422);
    const held = await as("manager", path, {
      method: "POST",
      body: {
        heldOn: today(),
        panel: [DEMO.users.manager.id, DEMO.users.nurse.id],
        scores: { compassion: 3, courage: 4 },
        notes: "Spoke warmly about caring for a grandparent.",
        recommendation: "proceed",
        expectedVersion: detail.application.version,
      },
    });
    expect(held.status).toBe(200);
    detail = await json<Detail>(held);
    expect(detail.application.stage).toBe("interviewed");
    expect(detail.interviews[0]).toMatchObject({ total: 7, outOf: 8 });
  });

  it("makes an offer conditional on the role's Schedule 3 items", async () => {
    const made = await as("manager", `/v1/workforce/applications/${detail.application.id}/offer`, {
      method: "POST",
      body: {
        proposedStartOn: "2026-12-01",
        previousCareWork: true,
        expectedVersion: detail.application.version,
      },
    });
    expect(made.status).toBe(200);
    detail = await json<Detail>(made);
    expect(detail.application.stage).toBe("offered");
    expect(detail.offer?.conditions).toEqual(
      expect.arrayContaining(["dbs_certificate", "right_to_work", "conduct_in_care_work"]),
    );
    expect(detail.offer?.conditions).not.toContain("professional_registration");
  });

  it("creates the staff profile on acceptance, with the conditions outstanding", async () => {
    const offer = detail.offer;
    if (!offer) throw new Error("no offer");
    const own = await as("manager", `/v1/workforce/offers/${offer.id}/response`, {
      method: "POST",
      body: {
        response: "accepted",
        tenantUserId: DEMO.users.manager.id,
        expectedVersion: offer.version,
      },
    });
    expect(own.status).toBe(403);
    const accepted = await as("manager", `/v1/workforce/offers/${offer.id}/response`, {
      method: "POST",
      body: {
        response: "accepted",
        tenantUserId: DEMO.users.carer.id,
        expectedVersion: offer.version,
      },
    });
    expect(accepted.status).toBe(200);
    detail = await json<Detail>(accepted);
    expect(detail.application.stage).toBe("accepted");
    expect(detail.offer?.status).toBe("accepted");
    const file = await json<{ jobTitle: string; outstanding: string[]; complete: boolean }>(
      await as("manager", `/v1/workforce/staff-files/${detail.offer?.staffProfileId}`),
    );
    expect(file).toMatchObject({ jobTitle: "Care worker", complete: false });
    expect(file.outstanding).toEqual(
      expect.arrayContaining(["dbs_certificate", "conduct_in_care_work"]),
    );
    // A hired applicant follows the staff file: no keep-until date.
    expect(detail.applicant.retainUntil).toBeNull();
  });

  it("never reopens the accepted application", async () => {
    const reopen = await as(
      "manager",
      `/v1/workforce/applications/${detail.application.id}/close`,
      {
        method: "POST",
        body: {
          to: "withdrawn",
          reason: "applicant_withdrew",
          expectedVersion: detail.application.version,
        },
      },
    );
    expect(reopen.status).toBe(422);
  });
});

describe("rule 13: how long an unsuccessful applicant is kept", () => {
  it("keeps them for the applicant.unsuccessful period, and the talent pool when it is longer", async () => {
    const created = await as("manager", `/v1/workforce/vacancies/${vacancyId}/applications`, {
      method: "POST",
      body: {
        givenName: "Bea",
        familyName: "Applicant",
        email: "bea.applicant@example.invalid",
        phone: null,
      },
    });
    let detail = await json<Detail>(created);
    expect(detail.applicant.retainUntil).toBeNull();
    const rejected = await as(
      "manager",
      `/v1/workforce/applications/${detail.application.id}/shortlist`,
      {
        method: "POST",
        body: {
          criteria: [false, true],
          decision: "reject",
          reason: "criteria_not_met",
          expectedVersion: detail.application.version,
        },
      },
    );
    expect(rejected.status).toBe(200);
    detail = await json<Detail>(rejected);
    expect(detail.application).toMatchObject({
      stage: "rejected",
      stageReason: "criteria_not_met",
    });
    const [period] = await sql<{ period: number; unit: string }>(
      "SELECT period, unit FROM retention_class WHERE record_class = 'applicant.unsuccessful'",
    );
    expect(period).toMatchObject({ unit: "months" });
    expect(detail.applicant.retainUntil).not.toBeNull();
    expect(detail.applicant.retainUntil && detail.applicant.retainUntil > today()).toBe(true);
    const unsuccessfulUntil = detail.applicant.retainUntil;

    const pool = await as(
      "manager",
      `/v1/workforce/applicants/${detail.applicant.id}/talent-pool`,
      {
        method: "PUT",
        body: { consent: true, expectedVersion: detail.applicant.version },
      },
    );
    expect(pool.status).toBe(200);
    const kept = await json<{ talentPoolUntil: string; retainUntil: string }>(pool);
    expect(kept.retainUntil).toBe(kept.talentPoolUntil);
    expect(unsuccessfulUntil && kept.retainUntil > unsuccessfulUntil).toBe(true);

    const [after] = await sql<{ version: number }>("SELECT version FROM applicant WHERE id = $1", [
      detail.applicant.id,
    ]);
    const withdrawn = await as(
      "manager",
      `/v1/workforce/applicants/${detail.applicant.id}/talent-pool`,
      {
        method: "PUT",
        body: { consent: false, expectedVersion: after?.version },
      },
    );
    expect(await json<{ retainUntil: string; talentPoolUntil: null }>(withdrawn)).toEqual({
      talentPoolUntil: null,
      retainUntil: unsuccessfulUntil,
    });
  });
});

describe("rule 12: equality monitoring counted, never read", () => {
  it("adds forms only once the vacancy closes, and releases suppressed counts once", async () => {
    const path = `/v1/workforce/vacancies/${vacancyId}/equality-monitoring`;
    // While applications are open, no form is added and no count is released.
    expect(
      (await as("manager", path, { method: "POST", body: { answers: { sex: "female" } } })).status,
    ).toBe(422);
    expect((await as("manager", path)).status).toBe(422);
    const [vac] = await sql<{ version: number }>("SELECT version FROM vacancy WHERE id = $1", [
      vacancyId,
    ]);
    const closed = await as("manager", `/v1/workforce/vacancies/${vacancyId}`, {
      method: "PATCH",
      body: { status: "closed", expectedVersion: vac?.version },
    });
    expect(closed.status).toBe(200);
    const forms = [
      ...Array.from({ length: 5 }, () => ({ sex: "female", disability: "no" })),
      ...Array.from({ length: 5 }, () => ({ sex: "male" })),
      { sex: "female", disability: "yes" },
    ];
    for (const answers of forms) {
      expect((await as("manager", path, { method: "POST", body: { answers } })).status).toBe(204);
    }
    expect(
      (await as("manager", path, { method: "POST", body: { answers: { name: "Ada" } } })).status,
    ).toBe(422);
    const summary = await json<{
      forms: number | string;
      minimumShown: number;
      questions: { question: string; counts: Record<string, number | string> | null }[];
    }>(await as("manager", path));
    expect(summary.forms).toBe(11);
    expect(summary.questions.find((q) => q.question === "sex")?.counts).toEqual({
      female: 6,
      male: 5,
      prefer_not_to_say: 0,
    });
    // One small disability count (yes, 1): the next smallest (no, 5) is hidden with it.
    expect(summary.questions.find((q) => q.question === "disability")?.counts).toMatchObject({
      yes: "fewer_than_min",
      no: "fewer_than_min",
    });
    // Released once: no form is added after, so counts before and after can never be compared.
    expect(
      (await as("manager", path, { method: "POST", body: { answers: { sex: "female" } } })).status,
    ).toBe(422);
    expect((await as("carer", path)).status).toBe(403);
  });
});

describe("audit events carry ids and codes only", () => {
  it("never records an applicant's name, contact details, scores or notes", async () => {
    const rows = await sql<{ text: string }>(
      `SELECT row_to_json(a)::text AS text FROM audit_event a WHERE action LIKE 'workforce.%'`,
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const secret of ["Ada", "Bea", "example.invalid", "grandparent", "female"]) {
      expect(
        rows.some((r) => r.text.includes(secret)),
        secret,
      ).toBe(false);
    }
  });
});
