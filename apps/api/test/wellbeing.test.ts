import { DEMO } from "@harbour/db/seed";
import { withAdminClient } from "@harbour/db/testing";
import { ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

/**
 * Staff wellbeing and voice through the API (scheduling.md section 16; SCHED-011). It covers:
 * - a manager writes and opens a pulse survey;
 * - members answer it once, anonymously: the audit names no one and no response leaves;
 * - results show only once the survey has closed and the minimum group size answered;
 * - thanks between colleagues;
 * - a check-in a manager sees only while the member shares it.
 * The test database's size is set to 3 so the demo's members are enough. All the people here are
 * invented.
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
        "UPDATE rate_table SET value = 3 WHERE key = 'wellbeing.survey_min_group_size' AND tenant_id IS NULL",
      ),
    h.db.name,
  );
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
    const bad = await post("manager", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q9: 2 },
    });
    expect(bad.status).toBe(422);
    const after = (await (await as("carer", "/v1/pulse-surveys")).json()) as { items: Survey[] };
    expect(after.items.find((s) => s.id === survey.id)?.answered).toBe(true);

    const [event] = await sql<Record<string, unknown>>(
      `SELECT actor_tenant_user_id, actor_auth_user_id, actor_role_keys, ip, device_id, request_id,
              scope, resource_id
       FROM audit_event WHERE action = 'scheduling.pulse_survey.responded'`,
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
      message: string;
    };
    expect(early).toMatchObject({ visible: false, reason: "still_open" });
    await post("manager", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 2, q2: "Apples in the staff room" },
    });
    await post("owner", `/v1/pulse-surveys/${survey.id}/responses`, {
      answers: { q1: 5, q2: "More training days" },
    });
    const closed = await post("manager", `/v1/pulse-surveys/${survey.id}/close`, {
      version: survey.version,
    });
    expect(closed.status).toBe(200);
    const shown = (await (
      await as("manager", `/v1/pulse-surveys/${survey.id}/results`)
    ).json()) as {
      visible: boolean;
      respondents: number;
      questions: { counts?: number[]; texts?: string[] }[];
    };
    expect(shown.visible).toBe(true);
    expect(shown.respondents).toBe(3);
    expect(shown.questions[0]?.counts).toEqual([0, 1, 0, 1, 1]);
    // Alphabetical, never the order they came in.
    expect(shown.questions[1]?.texts).toEqual([
      "Apples in the staff room",
      "More training days",
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
      minGroupSize: 3,
      message: "Fewer than 3 people answered, so the results are not shown.",
    });
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
      items: { message: string }[];
    };
    expect(received.items.map((i) => i.message)).toContain("Thank you for covering on Sunday");
    const [given] = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'scheduling.recognition.given'",
    );
    expect(JSON.stringify(given)).not.toMatch(/Sunday/);
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
