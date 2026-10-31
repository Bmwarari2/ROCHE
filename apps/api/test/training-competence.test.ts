import { createDatabase, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, addUkMonths, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remindDevelopmentExpiry } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { competencePort } from "../src/services/competence-port";
import { createHarness, type Harness } from "./support/harness";

/**
 * Training, competence, supervision and revalidation through the API (workforce.md sections 2b,
 * 3 and 5; ADR-0085; hazards HZ-119 and HZ-124; plan slice 17): the matrix by role with Oliver
 * McGowan tiers, never recording for oneself, sign-offs in the observer's name, withdrawal, the
 * competence port on the server whatever the caller can see, the outbox events, revalidation, the
 * member's own record and the reminders raised once each.
 */

let h: Harness;
const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  h.request(path, { ...init, token: h.tokens[who], tenant: DEMO.tenantId });
const CARER = DEMO.users.carer.id;
const NURSE = DEMO.users.nurse.id;
const dev = (member: string) => `/v1/workforce/members/${member}`;
const today = () => ukIsoDate(new Date());
const daysFromToday = (days: number) => ukIsoDate(addUkDays(new Date(), days));

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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

interface Development {
  matrix: { topic: string; status: string; tier: number | null }[];
  trainingRecords: { id: string; topic: string }[];
  competences: { competence: string; allowed: boolean; reason: string | null }[];
  signOffs: { id: string; competence: string; observer: { id: string } | null }[];
  supervisions: { kind: string; heldBy: { id: string } | null }[];
  revalidation: { outstanding: string[]; ready: boolean } | null;
}

/** The port as medicines will call it: on the server, in the care worker's own request context. */
const port = (at = new Date()) =>
  withRequestContext(
    createDatabase(h.db.pool("harbour_app")),
    {
      tenantId: DEMO.tenantId,
      userId: CARER,
      scope: "assigned",
      locationIds: [],
    },
    (tx) => competencePort(tx, CARER, "medicines_administration", at),
  );

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

describe("the training matrix (workforce.md rule 5)", () => {
  it("is set per role by holders of workforce.training.manage", async () => {
    const put = (body: Record<string, unknown>, who = "manager") =>
      as(who, "/v1/workforce/training-requirements", { method: "PUT", body });
    expect(
      (
        await put({
          roleKey: "care_worker",
          topic: "fire_safety",
          refreshYears: null,
          tier: null,
          active: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put({
          roleKey: "care_worker",
          topic: "oliver_mcgowan",
          refreshYears: null,
          tier: 2,
          active: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put({
          roleKey: "care_worker",
          topic: "fire_safety",
          refreshYears: 1,
          tier: null,
          active: true,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await put(
          {
            roleKey: "care_worker",
            topic: "food_hygiene",
            refreshYears: null,
            tier: null,
            active: true,
          },
          "carer",
        )
      ).status,
    ).toBe(403);
  });

  it("shows a tier 1 Oliver McGowan record as not meeting a tier 2 requirement", async () => {
    const record = (body: Record<string, unknown>) =>
      as("manager", `${dev(CARER)}/training-records`, { method: "POST", body });
    expect(
      (
        await record({
          topic: "fire_safety",
          tier: null,
          completedOn: daysFromToday(-30),
          expiresOn: null,
          provider: null,
        })
      ).status,
    ).toBe(200);
    const tierOne = await record({
      topic: "oliver_mcgowan",
      tier: 1,
      completedOn: daysFromToday(-30),
      expiresOn: null,
      provider: "Example Training Ltd",
    });
    const body = (await tierOne.json()) as Development;
    const row = (topic: string) => body.matrix.find((m) => m.topic === topic);
    expect(row("fire_safety")?.status).toBe("valid");
    expect(row("oliver_mcgowan")).toMatchObject({ status: "missing", tier: 2 });
  });

  it("never records training for oneself", async () => {
    const own = await as("manager", `${dev(DEMO.users.manager.id)}/training-records`, {
      method: "POST",
      body: {
        topic: "fire_safety",
        tier: null,
        completedOn: today(),
        expiresOn: null,
        provider: null,
      },
    });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe("own_development_record");
  });

  it("refuses training completed in the future", async () => {
    const future = await as("manager", `${dev(CARER)}/training-records`, {
      method: "POST",
      body: {
        topic: "food_hygiene",
        tier: null,
        completedOn: daysFromToday(3),
        expiresOn: null,
        provider: null,
      },
    });
    expect(future.status).toBe(422);
  });
});

describe("hazard HZ-119 observed competence and the port (ADR-0085)", () => {
  it("hazard HZ-119 the port says missing before any sign-off", async () => {
    expect(await port()).toEqual({ allowed: false, reason: "missing", validUntil: null });
  });

  it("hazard HZ-119 blocks an expired sign-off", async () => {
    const old = ukIsoDate(addUkMonths(new Date(), -13));
    const signed = await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: old },
    });
    expect(signed.status).toBe(200);
    expect(await port()).toMatchObject({ allowed: false, reason: "expired" });
  });

  it("hazard HZ-119 allows a valid sign-off, observed in the observer's name, and publishes the change", async () => {
    const signed = await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    const body = (await signed.json()) as Development;
    expect(body.signOffs[0]?.observer?.id).toBe(NURSE);
    expect(body.competences).toEqual([
      expect.objectContaining({ competence: "medicines_administration", allowed: true }),
    ]);
    expect(await port()).toMatchObject({ allowed: true });
    const events = await sql<{ payload: { memberId: string; change: string } }>(
      "SELECT payload FROM outbox_event WHERE event_type = 'workforce.competence.changed' ORDER BY id",
    );
    expect(events.map((e) => e.payload.change)).toEqual(["signed_off", "signed_off"]);
    expect(events[0]?.payload.memberId).toBe(CARER);
  });

  it("hazard HZ-119 refuses a sign-off for oneself, in the future, or without the permission", async () => {
    const self = await as("nurse", `${dev(NURSE)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    expect(self.status).toBe(403);
    const future = await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: daysFromToday(2) },
    });
    expect(future.status).toBe(422);
    const carer = await as("carer", `${dev(NURSE)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    expect(carer.status).toBe(403);
  });

  it("hazard HZ-119 blocks at once when the valid sign-offs are withdrawn", async () => {
    const record = (await (await as("manager", `${dev(CARER)}/development`)).json()) as Development;
    for (const signOff of record.signOffs) {
      const withdrawn = await as("manager", `${dev(CARER)}/competences/${signOff.id}/withdraw`, {
        method: "POST",
        body: { reason: "Observed an error at the medicines round" },
      });
      expect(withdrawn.status).toBe(200);
    }
    expect(await port()).toMatchObject({ allowed: false, reason: "withdrawn" });
    const short = await as(
      "manager",
      `${dev(CARER)}/competences/${record.signOffs[0]?.id}/withdraw`,
      {
        method: "POST",
        body: { reason: "short" },
      },
    );
    expect(short.status).toBe(422);
  });

  it("hazard HZ-119 allows again after a new observation", async () => {
    await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    expect(await port()).toMatchObject({ allowed: true });
  });
});

describe("supervision and revalidation (workforce.md rules 7 and 8)", () => {
  it("records a supervision in the caller's name", async () => {
    const held = await as("manager", `${dev(CARER)}/supervisions`, {
      method: "POST",
      body: { kind: "supervision", heldOn: today() },
    });
    const body = (await held.json()) as Development;
    expect(body.supervisions).toEqual([
      expect.objectContaining({
        kind: "supervision",
        heldBy: expect.objectContaining({ id: DEMO.users.manager.id }),
      }),
    ]);
  });

  it("plans revalidation against the NMC figures", async () => {
    const saved = await as("manager", `${dev(NURSE)}/revalidation`, {
      method: "PUT",
      body: {
        cycleDueOn: daysFromToday(200),
        practiceHours: 100,
        cpdHours: 35,
        participatoryCpdHours: 20,
        feedbackPieces: 5,
        reflectiveAccounts: 5,
        reflectiveDiscussion: true,
        healthAndCharacter: true,
        professionalIndemnity: true,
        confirmation: false,
      },
    });
    expect(saved.status).toBe(200);
    const plan = ((await saved.json()) as Development).revalidation;
    expect(plan?.ready).toBe(false);
    expect(plan?.outstanding).toEqual(["practice_hours", "confirmation"]);
  });
});

describe("the member's own record", () => {
  it("shows the member their own development, and nobody else's", async () => {
    const own = await as("carer", "/v1/me/development");
    expect(own.status).toBe(200);
    const body = (await own.json()) as Development;
    expect(body.trainingRecords.length).toBe(2);
    expect((await as("carer", `${dev(NURSE)}/development`)).status).toBe(403);
  });
});

describe("training and competence reminders (workforce.md section 5)", () => {
  it("raises a reminder for training due soon once, for HR", async () => {
    await as("manager", `${dev(CARER)}/training-records`, {
      method: "POST",
      body: {
        topic: "oliver_mcgowan",
        tier: 2,
        completedOn: daysFromToday(-30),
        expiresOn: daysFromToday(10),
        provider: null,
      },
    });
    const deps = {
      workerPool: h.db.pool("harbour_worker"),
      appDb: createDatabase(h.db.pool("harbour_app")),
      logger: createLogger("silent"),
    };
    expect(await remindDevelopmentExpiry(deps)).toBe(1);
    expect(await remindDevelopmentExpiry(deps)).toBe(0);
    const [task] = await sql<{
      title: string;
      assignee_role_key: string;
      location_id: string | null;
      details: Record<string, unknown>;
    }>(
      "SELECT title, assignee_role_key, location_id, details FROM task WHERE kind = 'workforce.training_expiry'",
    );
    expect(task).toMatchObject({
      title: "Renew training before it expires",
      assignee_role_key: "hr",
      location_id: null,
      details: {
        memberId: CARER,
        trainingTopic: "oliver_mcgowan",
        reminderDueOn: daysFromToday(10),
      },
    });
  });
});
