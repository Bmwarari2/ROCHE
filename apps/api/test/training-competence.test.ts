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
const port = (claimedAt: Date | null = null) =>
  withRequestContext(
    createDatabase(h.db.pool("harbour_app")),
    {
      tenantId: DEMO.tenantId,
      userId: CARER,
      scope: "assigned",
      locationIds: [],
    },
    (tx) => competencePort(tx, CARER, "medicines_administration", claimedAt),
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

  it("hazard HZ-119 blocks at once when the newest sign-off is withdrawn, whatever older ones say", async () => {
    const record = (await (await as("manager", `${dev(CARER)}/development`)).json()) as Development;
    const newest = record.signOffs[0];
    const withdrawn = await as("manager", `${dev(CARER)}/competences/${newest?.id}/withdraw`, {
      method: "POST",
      body: { reason: "Observed an error at the medicines round" },
    });
    expect(withdrawn.status).toBe(200);
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

  it("hazard HZ-119 never reinstates a withdrawn competence with a backdated sign-off", async () => {
    const backdated = await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: daysFromToday(-5) },
    });
    expect(backdated.status).toBe(422);
    expect(await port()).toMatchObject({ allowed: false, reason: "withdrawn" });
  });

  it("hazard HZ-119 allows again after a new observation", async () => {
    await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    expect(await port()).toMatchObject({ allowed: true });
  });

  it("hazard HZ-119 lets a device's earlier time block, never allow", async () => {
    // The only sign-off in force was observed today: an administration the device dates last
    // week is blocked, whatever the server's own answer is.
    expect(await port(new Date(Date.now() - 7 * 86_400_000))).toMatchObject({ allowed: false });
  });

  it("hazard HZ-119 answers about another member whatever the caller can read", async () => {
    // The care worker cannot read the nurse's training; the port still answers, with dates only.
    await as("manager", `${dev(NURSE)}/competences`, {
      method: "POST",
      body: { competence: "controlled_drugs", observedOn: today() },
    });
    const ask = () =>
      withRequestContext(
        createDatabase(h.db.pool("harbour_app")),
        { tenantId: DEMO.tenantId, userId: CARER, scope: "assigned", locationIds: [] },
        (tx) => competencePort(tx, NURSE, "controlled_drugs"),
      );
    expect(await ask()).toMatchObject({ allowed: true });
    const record = (await (await as("manager", `${dev(NURSE)}/development`)).json()) as Development;
    const id = record.signOffs.find((o) => o.competence === "controlled_drugs")?.id;
    await as("manager", `${dev(NURSE)}/competences/${id}/withdraw`, {
      method: "POST",
      body: { reason: "Controlled drug count error on the night round" },
    });
    expect(await ask()).toMatchObject({ allowed: false, reason: "withdrawn" });
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

describe("the training record correction", () => {
  it("corrects a record against the version loaded, keeping the earlier one", async () => {
    const record = (await (await as("manager", `${dev(CARER)}/development`)).json()) as {
      trainingRecords: { id: string; version: number; topic: string }[];
    };
    const fire = record.trainingRecords.find((t) => t.topic === "fire_safety");
    const body = (provider: string | null) => ({
      expectedVersion: fire?.version,
      topic: "fire_safety",
      tier: null,
      completedOn: daysFromToday(-31),
      expiresOn: null,
      provider,
    });
    const url = `${dev(CARER)}/training-records/${fire?.id}`;
    expect(
      (await as("manager", url, { method: "PATCH", body: body("Example Training Ltd") })).status,
    ).toBe(200);
    expect((await as("manager", url, { method: "PATCH", body: body(null) })).status).toBe(409);
  });
});

describe("hazard HZ-124 training and competence reminders (workforce.md section 5)", () => {
  it("hazard HZ-124 raises a reminder for training and for a competence due soon, once each, for HR", async () => {
    await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "catheter_care", observedOn: ukIsoDate(addUkMonths(new Date(), -11)) },
    });
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
    expect(await remindDevelopmentExpiry(deps)).toBe(2);
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

describe("hazard HZ-124 reminders end with a renewal, and readers come from the database's rule", () => {
  it("hazard HZ-124 cancels the competence reminder when it is observed again", async () => {
    await as("nurse", `${dev(CARER)}/competences`, {
      method: "POST",
      body: { competence: "catheter_care", observedOn: today() },
    });
    const rows = await sql<{ status: string }>(
      "SELECT status FROM task WHERE kind = 'workforce.competence_expiry'",
    );
    expect(rows.map((r) => r.status)).toEqual(["cancelled"]);
  });

  it("refuses a reader whose permission comes only from a role scoped to assigned people", async () => {
    await sql(
      `INSERT INTO role (key, name, scope_kind, permissions)
       VALUES ('senior_carer_clone', 'Senior carer', 'assigned', '{workforce.competence.observe}')`,
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
       SELECT $1, id, $2 FROM role WHERE key = 'senior_carer_clone'`,
      [CARER, DEMO.locationId],
    );
    expect((await as("carer", `${dev(NURSE)}/development`)).status).toBe(404);
  });
});

describe("H-692 supervision notes are for the supervisor, the supervisee and HR only", () => {
  it("keeps the notes with the supervision and shows them only to those three", async () => {
    // The owner holds the appraisal; the Registered Manager also manages supervisions but did not
    // hold it and holds no workforce.hr_document.read (roles.ts), so sees it without its notes.
    const held = await as("owner", `${dev(CARER)}/supervisions`, {
      method: "POST",
      body: {
        kind: "appraisal",
        heldOn: today(),
        notes: {
          topics: ["Moving and handling refresher", "Night shift pattern"],
          actionsAgreed: "Book the refresher course before December",
          nextDueOn: daysFromToday(180),
          note: "Keen to mentor new starters",
        },
      },
    });
    expect(held.status).toBe(200);
    type WithNotes = { supervisions: { kind: string; notes: { topics: string[] } | null }[] };
    const appraisalOf = (body: WithNotes) => body.supervisions.find((s) => s.kind === "appraisal");
    expect(appraisalOf((await held.json()) as WithNotes)?.notes?.topics).toEqual([
      "Moving and handling refresher",
      "Night shift pattern",
    ]);
    const own = (await (await as("carer", "/v1/me/development")).json()) as WithNotes;
    expect(appraisalOf(own)?.notes?.topics).toHaveLength(2);
    const other = (await (await as("manager", `${dev(CARER)}/development`)).json()) as WithNotes;
    expect(appraisalOf(other)).toBeDefined();
    expect(appraisalOf(other)?.notes).toBeNull();
    const [audit] = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'workforce.supervision.recorded' ORDER BY seq DESC LIMIT 1",
    );
    expect(JSON.stringify(audit)).not.toMatch(/mentor|refresher/);
  });
});

describe("H-693 a nurse enters their own revalidation; HR reviews; only a confirmer confirms", () => {
  const cycle = daysFromToday(400);
  const counts = {
    cycleDueOn: cycle,
    practiceHours: 450,
    cpdHours: 35,
    participatoryCpdHours: 20,
    feedbackPieces: 5,
    reflectiveAccounts: 5,
    reflectiveDiscussion: true,
    healthAndCharacter: true,
    professionalIndemnity: true,
  };
  type Plan = { version: number; reviewState: string; confirmation: boolean; ready: boolean };
  const planOf = async (r: Response) => ((await r.json()) as { revalidation: Plan }).revalidation;

  it("lets the nurse write and submit their own evidence, never confirm it", async () => {
    const saved = await as("nurse", "/v1/me/revalidation", {
      method: "PUT",
      body: { ...counts, submit: true },
    });
    expect(saved.status).toBe(200);
    const plan = await planOf(saved);
    expect(plan.reviewState).toBe("submitted");
    expect(plan.confirmation).toBe(false);
    // The confirmation is never the nurse's, even straight to the database.
    await expect(
      sql(
        `UPDATE revalidation_evidence SET confirmation = true, confirmed_by = worker_id,
           confirmed_on = $2 WHERE worker_id = $1 AND cycle_due_on = $3`,
        [NURSE, today(), cycle],
      ),
    ).rejects.toThrow(
      /revalidation_evidence_confirmed|revalidation_confirmer_not_you|revalidation_needs_a_member/,
    );
  });

  it("HR reviews it, then the counts are fixed", async () => {
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    // No confirmation before the review.
    const early = await as("manager", `${dev(NURSE)}/revalidation/confirmation`, {
      method: "POST",
      body: { expectedVersion: row?.version, cycleDueOn: cycle, confirmedOn: today() },
    });
    expect(early.status).toBe(409);
    const reviewed = await as("owner", `${dev(NURSE)}/revalidation/review`, {
      method: "POST",
      body: { expectedVersion: row?.version, cycleDueOn: cycle },
    });
    expect(reviewed.status).toBe(200);
    expect((await planOf(reviewed)).reviewState).toBe("reviewed");
    const late = await as("nurse", "/v1/me/revalidation", {
      method: "PUT",
      body: { ...counts, practiceHours: 460, expectedVersion: (row?.version ?? 0) + 1 },
    });
    expect(late.status).toBe(409);
  });

  it("the confirmer confirms in their own name; the nurse cannot", async () => {
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    const own = await as("nurse", `${dev(NURSE)}/revalidation/confirmation`, {
      method: "POST",
      body: { expectedVersion: row?.version, cycleDueOn: cycle, confirmedOn: today() },
    });
    expect(own.status).toBe(403);
    const confirmed = await as("manager", `${dev(NURSE)}/revalidation/confirmation`, {
      method: "POST",
      body: { expectedVersion: row?.version, cycleDueOn: cycle, confirmedOn: today() },
    });
    expect(confirmed.status).toBe(200);
    const [stored] = await sql<{ confirmed_by: string; confirmation: boolean }>(
      "SELECT confirmed_by, confirmation FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    expect(stored).toEqual({ confirmed_by: DEMO.users.manager.id, confirmation: true });
  });
});
