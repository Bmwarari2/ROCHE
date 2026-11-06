import { DEMO } from "@harbour/db/seed";
import { withAdminClient } from "@harbour/db/testing";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeEndedSurveysJob } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness } from "./support/harness";

/**
 * Staff wellbeing and voice through the API (scheduling.md section 16; SCHED-011). It covers:
 * - a manager writes and opens a pulse survey;
 * - members answer it once, anonymously: the audit names no one and no response leaves;
 * - results show only once the survey has closed and the minimum group size answered;
 * - thanks between colleagues;
 * - a check-in a manager sees only while the member shares it.
 * The test database's size is set to 2 so the demo's carer and nurse, on staff files at the home,
 * are enough (the home's managers never answer). All the people here are invented.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const post = (who: string, path: string, body: unknown) => as(who, path, { method: "POST", body });
const LOC = DEMO.locationId;
const QUESTIONS = [
  { id: "q1", kind: "scale", text: "How supported do you feel at work?" },
  { id: "q2", kind: "free_text", text: "What one thing would help?" },
];
type Survey = { id: string; version: number; state: string; answered: boolean | null };

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

async function openSurvey(title: string): Promise<Survey> {
  const today = ukIsoDate(new Date());
  const made = (await (
    await post("manager", "/v1/pulse-surveys", {
      locationId: LOC,
      title,
      questions: QUESTIONS,
      opensOn: today,
      closesOn: today,
    })
  ).json()) as Survey;
  return (await (
    await post("manager", `/v1/pulse-surveys/${made.id}/open`, { version: made.version })
  ).json()) as Survey;
}

beforeAll(async () => {
  h = await createHarness();
  await withAdminClient(
    (c) =>
      c.query(
        "UPDATE rate_table SET value = 2 WHERE key = 'wellbeing.survey_min_group_size' AND tenant_id IS NULL",
      ),
    h.db.name,
  );
  for (const who of [DEMO.users.carer.id, DEMO.users.nurse.id]) {
    await sql(
      `INSERT INTO staff_profile (tenant_user_id, location_id, job_title, starts_on)
       VALUES ($1, $2, 'Care worker', '2026-09-01')`,
      [who, LOC],
    );
  }
}, 120_000);

afterAll(async () => {
  await h?.close();
});

describe("SCHED-011 pulse surveys", () => {
  let survey: Survey;

  it("a manager writes a draft, which nobody can answer until it opens", async () => {
    const r = await post("manager", "/v1/pulse-surveys", {
      locationId: LOC,
      title: "Autumn pulse",
      questions: QUESTIONS,
      opensOn: ukIsoDate(new Date()),
      closesOn: ukIsoDate(new Date()),
    });
    expect(r.status).toBe(201);
    survey = (await r.json()) as Survey;
    expect(survey.state).toBe("draft");
    const carerList = (await (await as("carer", "/v1/pulse-surveys")).json()) as {
      items: Survey[];
    };
    expect(carerList.items.map((s) => s.id)).not.toContain(survey.id);
    expect(
      (await post("carer", `/v1/pulse-surveys/${survey.id}/responses`, { answers: { q1: 4 } }))
        .status,
    ).toBe(404);
    // A care worker cannot write one.
    expect(
      (
        await post("carer", "/v1/pulse-surveys", {
          locationId: LOC,
          title: "Mine",
          questions: QUESTIONS,
          opensOn: ukIsoDate(new Date()),
          closesOn: ukIsoDate(new Date()),
        })
      ).status,
    ).toBe(403);
    const opened = await post("manager", `/v1/pulse-surveys/${survey.id}/open`, {
      version: survey.version,
    });
    expect(opened.status).toBe(200);
    survey = (await opened.json()) as Survey;
  });

  it("a member answers once, and nothing names them with the answer", async () => {
    const list = (await (await as("carer", "/v1/pulse-surveys")).json()) as { items: Survey[] };
    expect(list.items.find((s) => s.id === survey.id)?.answered).toBe(false);
    const r = await post("carer", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 4, q2: "Zebra crossing near the car park" },
    });
    expect(r.status).toBe(204);
    expect(await r.text()).toBe("");
    const again = await post("carer", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 2 },
    });
    expect(again.status).toBe(409);
    const bad = await post("nurse", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q9: 2 },
    });
    expect(bad.status).toBe(422);
    // The home's survey manager never answers it.
    const managerAnswer = await post("manager", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 2 },
    });
    expect(managerAnswer.status).toBe(403);
    const after = (await (await as("carer", "/v1/pulse-surveys")).json()) as { items: Survey[] };
    expect(after.items.find((s) => s.id === survey.id)?.answered).toBe(true);

    // Nothing is audited as it arrives; each response is audited, anonymously, at the close.
    const arriving = await sql(
      "SELECT 1 FROM audit_event WHERE action = 'scheduling.pulse_survey.responded'",
    );
    expect(arriving).toEqual([]);
    const anywhere = await sql(
      "SELECT 1 FROM audit_event WHERE scope::text LIKE '%Zebra%' OR reason LIKE '%Zebra%'",
    );
    expect(anywhere).toEqual([]);
  });

  it("shows nothing while open, and everything together once closed at the size", async () => {
    const early = (await (
      await as("manager", `/v1/pulse-surveys/${survey.id}/results`)
    ).json()) as {
      visible: boolean;
      reason: string;
    };
    expect(early).toMatchObject({ visible: false, reason: "still_open" });
    const nurse = await post("nurse", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 4, q2: "Apples in the staff room" },
    });
    expect(nurse.status).toBe(204);
    const closed = await post("manager", `/v1/pulse-surveys/${survey.id}/close`, {
      version: survey.version,
    });
    expect(closed.status).toBe(200);
    const [event] = await sql<Record<string, unknown>>(
      `SELECT actor_tenant_user_id, actor_auth_user_id, actor_role_keys, ip, device_id, request_id,
              scope, resource_id
       FROM audit_event WHERE action = 'scheduling.pulse_survey.responded' LIMIT 1`,
    );
    expect(event).toEqual({
      actor_tenant_user_id: null,
      actor_auth_user_id: null,
      actor_role_keys: null,
      ip: null,
      device_id: null,
      request_id: null,
      scope: { actor: "anonymous" },
      resource_id: survey.id,
    });
    const shown = (await (
      await as("manager", `/v1/pulse-surveys/${survey.id}/results`)
    ).json()) as {
      visible: boolean;
      respondents: number;
      questions: { counts?: (number | null)[]; texts?: string[] }[];
    };
    expect(shown.visible).toBe(true);
    expect(shown.respondents).toBe(2);
    // Both chose 4: unanimous, so the counts would tell the manager each person's answer. Every
    // count is hidden (slice 61 security review L1), though the question's answers are visible.
    expect(shown.questions[0]?.counts).toEqual([null, null, null, null, null]);
    // Alphabetical, never the order they came in.
    expect(shown.questions[1]?.texts).toEqual([
      "Apples in the staff room",
      "Zebra crossing near the car park",
    ]);
    expect((await as("carer", `/v1/pulse-surveys/${survey.id}/results`)).status).toBe(403);
    // Another organisation's manager: refused, or not found, never the results.
    const elsewhere = await h.request(`/v1/pulse-surveys/${survey.id}/results`, {
      token: h.tokens.rae,
      tenant: "0194e000-0000-7000-8000-000000000001",
    });
    expect([403, 404]).toContain(elsewhere.status);
  });

  it("below the size, says so with no count", async () => {
    const small = await openSurvey("Small pulse");
    await post("carer", `/v1/pulse-surveys/${small.id}/responses`, { answers: { q1: 1 } });
    await post("manager", `/v1/pulse-surveys/${small.id}/close`, { version: small.version });
    const hidden = (await (
      await as("manager", `/v1/pulse-surveys/${small.id}/results`)
    ).json()) as Record<string, unknown>;
    expect(hidden).toEqual({
      visible: false,
      reason: "too_few",
      minGroupSize: 2,
      message: "Fewer than 2 people answered, so the results are not shown.",
    });
  });
});

describe("SCHED-011 a survey past its last day closes on its own", () => {
  it("is closed by the worker, which releases its answers, audited with no member", async () => {
    const late = await openSurvey("Closes itself");
    await post("carer", `/v1/pulse-surveys/${late.id}/responses`, { answers: { q1: 3 } });
    await withAdminClient(async (c) => {
      await c.query("SET session_replication_role = replica");
      await c.query(
        "UPDATE pulse_survey SET opens_on = opens_on - 3, closes_on = closes_on - 2 WHERE id = $1",
        [late.id],
      );
    }, h.db.name);
    const closed = await closeEndedSurveysJob({
      workerPool: h.db.pool("harbour_worker"),
      appDb: h.handle.services.db,
      logger: createLogger("silent"),
    });
    expect(closed).toBe(1);
    const [row] = await sql<{ state: string }>("SELECT state FROM pulse_survey WHERE id = $1", [
      late.id,
    ]);
    expect(row?.state).toBe("closed");
    const [audit] = await sql<{ actor: string | null }>(
      "SELECT actor_tenant_user_id AS actor FROM audit_event WHERE action = 'scheduling.pulse_survey.closed' AND resource_id = $1",
      [late.id],
    );
    expect(audit).toEqual({ actor: null });
  });
});

describe("SCHED-011 recognition and check-ins", () => {
  it("thanks a colleague, never oneself", async () => {
    const self = await post("carer", "/v1/recognition", {
      toMemberId: DEMO.users.carer.id,
      locationId: LOC,
      message: "Well done me",
    });
    expect(self.status).toBe(422);
    const r = await post("carer", "/v1/recognition", {
      toMemberId: DEMO.users.manager.id,
      locationId: LOC,
      message: "Thank you for covering on Sunday",
    });
    expect(r.status).toBe(201);
    const received = (await (await as("manager", "/v1/recognition?mine=received")).json()) as {
      items: { message: string; fromName: string | null; toName: string | null }[];
    };
    expect(received.items.map((i) => i.message)).toContain("Thank you for covering on Sunday");
    // Who it is from and to, by name (slice 61).
    const note = received.items.find((i) => i.message === "Thank you for covering on Sunday");
    expect(note?.fromName).toBe(DEMO.users.carer.name);
    expect(note?.toName).toBe(DEMO.users.manager.name);
    const [given] = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'scheduling.recognition.given'",
    );
    expect(JSON.stringify(given)).not.toMatch(/Sunday/);
  });

  it("lists the colleagues one may thank where one works, never oneself, refusing elsewhere (slice 61)", async () => {
    const listed = await as("carer", `/v1/recognition/colleagues?locationId=${LOC}`);
    expect(listed.status).toBe(200);
    const { items } = (await listed.json()) as { items: { id: string; name: string }[] };
    expect(items.map((i) => i.id)).toContain(DEMO.users.manager.id);
    expect(items.map((i) => i.id)).not.toContain(DEMO.users.carer.id);
    expect(items.find((i) => i.id === DEMO.users.manager.id)?.name).toBe(DEMO.users.manager.name);
    const elsewhere = await as(
      "carer",
      `/v1/recognition/colleagues?locationId=${crypto.randomUUID()}`,
    );
    expect(elsewhere.status).toBe(403);
  });

  it("never lists a family member's portal account or a suspended member as a colleague, nor thanks them (slice 61 security review M1)", async () => {
    const family = crypto.randomUUID();
    const away = crypto.randomUUID();
    await sql(
      `INSERT INTO tenant_user (id, display_name, email, status) VALUES
         ($1, 'Fern Family', 'fern.family@example.invalid', 'active'),
         ($2, 'Sol Suspended', 'sol.suspended@example.invalid', 'suspended')`,
      [family, away],
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
       SELECT $1, r.id, $2, 'Relative' FROM role r WHERE r.key = 'family_representative'`,
      [family, LOC],
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
       SELECT $1, r.id, $2, 'Carer' FROM role r WHERE r.key = 'care_worker'`,
      [away, LOC],
    );
    const { items } = (await (
      await as("carer", `/v1/recognition/colleagues?locationId=${LOC}`)
    ).json()) as { items: { id: string }[] };
    expect(items.map((i) => i.id)).not.toContain(family);
    expect(items.map((i) => i.id)).not.toContain(away);
    const thanked = await post("carer", "/v1/recognition", {
      toMemberId: family,
      locationId: LOC,
      message: "Thank you",
    });
    expect(thanked.status).toBe(422);
  });

  it("a manager sees a check-in only while the member shares it", async () => {
    const made = await post("carer", "/v1/wellbeing-check-ins", {
      locationId: LOC,
      mood: 2,
      note: "A hard week",
      share: false,
    });
    expect(made.status).toBe(201);
    const checkIn = (await made.json()) as { id: string; sharedAt: string | null };
    expect(checkIn.sharedAt).toBeNull();
    const managerSees = async () =>
      (
        (await (await as("manager", `/v1/wellbeing-check-ins?locationId=${LOC}`)).json()) as {
          items: { id: string }[];
        }
      ).items.map((i) => i.id);
    expect(await managerSees()).not.toContain(checkIn.id);
    const own = (await (await as("carer", "/v1/wellbeing-check-ins")).json()) as {
      items: { id: string }[];
      support: string;
    };
    expect(own.items.map((i) => i.id)).toContain(checkIn.id);
    expect(own.support).toMatch(/support/);
    expect(
      (await post("carer", `/v1/wellbeing-check-ins/${checkIn.id}/sharing`, { shared: true }))
        .status,
    ).toBe(200);
    expect(await managerSees()).toContain(checkIn.id);
    // The manager sees whose it is, by name (slice 61).
    const shared = (await (
      await as("manager", `/v1/wellbeing-check-ins?locationId=${LOC}`)
    ).json()) as {
      items: { id: string; memberName: string | null }[];
    };
    expect(shared.items.find((i) => i.id === checkIn.id)?.memberName).toBe(DEMO.users.carer.name);
    // Only the member changes whether it is shared.
    expect(
      (await post("manager", `/v1/wellbeing-check-ins/${checkIn.id}/sharing`, { shared: false }))
        .status,
    ).toBe(404);
    await post("carer", `/v1/wellbeing-check-ins/${checkIn.id}/sharing`, { shared: false });
    expect(await managerSees()).not.toContain(checkIn.id);
    const audit = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action LIKE 'scheduling.wellbeing_check_in.%'",
    );
    expect(JSON.stringify(audit)).not.toMatch(/hard week/);
  });
});
