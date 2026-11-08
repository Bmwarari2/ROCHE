import { createDatabase, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { addUkDays, addUkMonths, ukIsoDate } from "@harbour/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workforceCompetence } from "../src/integrations/medicines-ports";
import { remindDevelopmentExpiry } from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { competencePort } from "../src/services/competence-port";
import { createHarness, type Harness, OTHER } from "./support/harness";

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

describe("supervision notes (slice 57; H-692's default, ADR-0114)", () => {
  const NOTE = "Talked through night shifts and a refresher on moving and handling.";
  it("keeps the note with the supervision, for the member and supervisors only", async () => {
    const held = await as("manager", `${dev(CARER)}/supervisions`, {
      method: "POST",
      body: {
        kind: "appraisal",
        heldOn: today(),
        note: { discussion: NOTE, actions: "Book the moving and handling refresher" },
      },
    });
    expect(held.status, await held.clone().text()).toBe(200);
    type WithNotes = { supervisions: { kind: string; note: { discussion: string } | null }[] };
    const mine = (await (await as("carer", "/v1/me/development")).json()) as WithNotes;
    expect(mine.supervisions.find((s) => s.kind === "appraisal")?.note?.discussion).toBe(NOTE);

    // A training lead without the supervision permission sees the appraisal, never the note.
    await sql(
      `INSERT INTO role (key, name, permissions, scope_kind)
       VALUES ('s57_training_lead', 'Training lead', ARRAY['workforce.training.manage'], 'none')`,
    );
    const [agency] = await sql<{ id: string }>(
      "SELECT id FROM tenant_user WHERE email = 'agency@example.invalid'",
    );
    await sql(
      `INSERT INTO role_assignment (tenant_user_id, role_id)
       SELECT $1::uuid, id FROM role WHERE key = 's57_training_lead'`,
      [agency?.id],
    );
    const seen = await as("agency", `${dev(CARER)}/development`);
    expect(seen.status, await seen.clone().text()).toBe(200);
    const theirs = (await seen.json()) as WithNotes;
    const appraisal = theirs.supervisions.find((s) => s.kind === "appraisal");
    expect(appraisal).toBeDefined();
    expect(appraisal?.note).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain("night shifts");

    // The audit records that a note was written, never what it says.
    const events = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'workforce.supervision.recorded'",
    );
    expect(JSON.stringify(events)).not.toContain("night shifts");
    expect(JSON.stringify(events)).toContain('"note":true');
  });
});

describe("correcting a supervision note (slice 57, security review round 1)", () => {
  type WithNotes = {
    supervisions: {
      id: string;
      kind: string;
      note: { discussion: string } | null;
      earlierNotes: { discussion: string }[];
    }[];
  };
  it("adds a correction that supersedes the note, keeping the earlier one", async () => {
    const before = (await (await as("manager", `${dev(CARER)}/development`)).json()) as WithNotes;
    const appraisal = before.supervisions.find((s) => s.kind === "appraisal");
    expect(appraisal?.note).not.toBeNull();
    const corrected = await as("manager", `${dev(CARER)}/supervisions/${appraisal?.id}/notes`, {
      method: "POST",
      body: { discussion: "Talked through night shifts; the refresher is booked.", actions: null },
    });
    expect(corrected.status, await corrected.clone().text()).toBe(200);
    const after = ((await corrected.json()) as WithNotes).supervisions.find(
      (s) => s.id === appraisal?.id,
    );
    expect(after?.note?.discussion).toBe("Talked through night shifts; the refresher is booked.");
    expect(after?.earlierNotes.map((n) => n.discussion)).toEqual([appraisal?.note?.discussion]);
  });

  it("is refused to someone who did not hold the supervision, and to the member", async () => {
    const record = (await (await as("manager", `${dev(CARER)}/development`)).json()) as WithNotes;
    const id = record.supervisions[0]?.id;
    const body = { discussion: "Someone else's account of the meeting.", actions: null };
    expect(
      (await as("owner", `${dev(CARER)}/supervisions/${id}/notes`, { method: "POST", body }))
        .status,
    ).toBe(403);
    expect(
      (await as("carer", `${dev(CARER)}/supervisions/${id}/notes`, { method: "POST", body }))
        .status,
    ).toBe(403);
  });
});

describe("the organisation's training matrix (slice 57)", () => {
  type Matrix = {
    topics: string[];
    members: {
      member: { id: string; displayName: string };
      cells: { topic: string; status: string }[];
    }[];
    truncated: boolean;
  };
  it("shows each member's required topics with their state, to workforce readers only", async () => {
    const response = await as("manager", "/v1/workforce/training-matrix");
    expect(response.status, await response.clone().text()).toBe(200);
    const matrix = (await response.json()) as Matrix;
    expect(matrix.topics).toContain("fire_safety");
    const carer = matrix.members.find((m) => m.member.id === CARER);
    expect(carer?.cells.map((c) => c.topic)).toContain("fire_safety");
    expect(Object.keys(carer?.member ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
    expect(matrix.truncated).toBe(false);
    expect((await as("carer", "/v1/workforce/training-matrix")).status).toBe(403);
  });

  it("filters by role and to the members needing attention", async () => {
    const byRole = (await (
      await as("manager", "/v1/workforce/training-matrix?roleKey=care_worker")
    ).json()) as Matrix;
    expect(byRole.members.map((m) => m.member.id)).toContain(CARER);
    const none = (await (
      await as("manager", "/v1/workforce/training-matrix?roleKey=no_such_role")
    ).json()) as Matrix;
    expect(none.members).toEqual([]);
    const attention = (await (
      await as("manager", "/v1/workforce/training-matrix?attention=true")
    ).json()) as Matrix;
    for (const m of attention.members) {
      expect(m.cells.some((c) => c.status !== "valid")).toBe(true);
    }
  });

  it("filters by location, and shows no portal account", async () => {
    const everyone = (await (
      await as("manager", "/v1/workforce/training-matrix")
    ).json()) as Matrix;
    const elsewhere = (await (
      await as(
        "manager",
        "/v1/workforce/training-matrix?locationId=0194d000-0000-7000-8000-00000000ffff",
      )
    ).json()) as Matrix;
    expect(elsewhere.members).toEqual([]);
    const portal = await sql<{ id: string }>(
      `SELECT DISTINCT ra.tenant_user_id AS id FROM role_assignment ra JOIN role r ON r.id = ra.role_id
        WHERE r.permissions && ARRAY['comms.portal.family', 'comms.portal.self']::text[]`,
    );
    const shown = new Set(everyone.members.map((m) => m.member.id));
    for (const p of portal) expect(shown.has(p.id)).toBe(false);
  });

  it("is audited without names", async () => {
    const events = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'workforce.training_matrix.viewed'",
    );
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(DEMO.users.carer.name);
  });
});

describe("WORK-009 supervisions and appraisals due across staff", () => {
  type Due = {
    dueWindowDays: number;
    members: {
      member: { id: string; displayName: string };
      meetings: { kind: string; lastHeldOn: string | null; dueOn: string | null; state: string }[];
      lastSpotCheckOn: string | null;
    }[];
    truncated: boolean;
  };
  const read = async (who: string, query = "") => {
    const response = await as(who, `/v1/workforce/supervisions-due${query}`);
    expect(response.status, await response.clone().text()).toBe(200);
    return (await response.json()) as Due;
  };

  it("shows each member's next supervision and appraisal by the record's rules, to workforce readers only", async () => {
    const due = await read("manager");
    expect(due.dueWindowDays).toBeGreaterThan(0);
    const carer = due.members.find((m) => m.member.id === CARER);
    // The same next meetings as each member's own record shows; none held is never a guessed date.
    for (const id of [CARER, NURSE]) {
      const shown = due.members.find((m) => m.member.id === id);
      const record = (await (await as("manager", `${dev(id)}/development`)).json()) as {
        nextSupervision: { dueOn: string; state: string } | null;
        nextAppraisal: { dueOn: string; state: string } | null;
      };
      for (const [i, next] of [record.nextSupervision, record.nextAppraisal].entries()) {
        const meeting = shown?.meetings[i];
        if (next) expect(meeting).toMatchObject({ dueOn: next.dueOn, state: next.state });
        else
          expect(meeting).toMatchObject({ lastHeldOn: null, dueOn: null, state: "none_recorded" });
      }
    }
    // The carer's supervision was recorded today above: the next is a whole interval away.
    expect(carer?.meetings[0]).toMatchObject({
      kind: "supervision",
      lastHeldOn: today(),
      state: "upcoming",
    });
    expect((carer?.meetings[0]?.dueOn ?? "") > today()).toBe(true);
    expect(Object.keys(carer?.member ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
    expect((await as("carer", "/v1/workforce/supervisions-due")).status).toBe(403);
  });

  it("filters by location and to those needing attention", async () => {
    const elsewhere = await read("manager", "?locationId=0194d000-0000-7000-8000-00000000ffff");
    expect(elsewhere.members).toEqual([]);
    const attention = await read("manager", "?attention=true");
    for (const m of attention.members) {
      expect(m.meetings.some((x) => x.state !== "upcoming")).toBe(true);
    }
  });

  it("never shows another organisation's staff, and is refused for an organisation the caller is not in", async () => {
    const response = await h.request("/v1/workforce/supervisions-due", {
      token: h.tokens.rae,
      tenant: OTHER.tenantId,
    });
    if (response.status === 200) {
      const theirs = (await response.json()) as Due;
      const ids = theirs.members.map((m) => m.member.id);
      for (const id of [CARER, NURSE, DEMO.users.manager.id]) expect(ids).not.toContain(id);
    } else {
      expect(response.status).toBe(403);
    }
    const crossed = await h.request("/v1/workforce/supervisions-due", {
      token: h.tokens.manager,
      tenant: OTHER.tenantId,
    });
    expect(crossed.status).not.toBe(200);
  });

  it("is audited without names", async () => {
    const events = await sql<{ scope: unknown }>(
      "SELECT scope FROM audit_event WHERE action = 'workforce.supervisions_due.viewed'",
    );
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain(DEMO.users.carer.name);
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

  // HR never writes or reviews their own revalidation: 403, audited, never a 500.
  it.each([
    [
      "recording evidence",
      "PUT",
      "revalidation",
      "workforce.revalidation.recorded",
      () => ({ ...counts }),
    ],
    [
      "reviewing it",
      "POST",
      "revalidation/review",
      "workforce.revalidation.reviewed",
      () => ({ expectedVersion: 1, cycleDueOn: cycle }),
    ],
  ] as const)("refuses HR %s on their own record", async (_name, method, path, action, body) => {
    const own = await as("manager", `${dev(DEMO.users.manager.id)}/${path}`, {
      method,
      body: body(),
    });
    expect(own.status).toBe(403);
    expect(((await own.json()) as { code: string }).code).toBe("own_development_record");
    const [denied] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = $1 AND outcome = 'denied' AND reason = 'own_record'
          AND actor_tenant_user_id = $2`,
      [action, DEMO.users.manager.id],
    );
    expect(denied?.n).toBeGreaterThanOrEqual(1);
  });

  it("HR reviews it, then the counts are fixed", async () => {
    const [row] = await sql<{ version: number }>(
      "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    // No confirmation before a confirmer is named (nor before the review).
    const early = await as("manager", `${dev(NURSE)}/revalidation/confirmation`, {
      method: "POST",
      body: { expectedVersion: row?.version, cycleDueOn: cycle, confirmedOn: today() },
    });
    expect(early.status).toBe(403);
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

  const version = async () =>
    (
      await sql<{ version: number }>(
        "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
        [NURSE, cycle],
      )
    )[0]?.version;
  const nameConfirmer = async (who: string, confirmerId: string) =>
    as(who, `${dev(NURSE)}/revalidation/confirmer`, {
      method: "PUT",
      body: { expectedVersion: await version(), cycleDueOn: cycle, confirmerId },
    });
  const confirm = async (who: string) =>
    as(who, `${dev(NURSE)}/revalidation/confirmation`, {
      method: "POST",
      body: { expectedVersion: await version(), cycleDueOn: cycle, confirmedOn: today() },
    });

  // The owner holds HR's workforce.training.manage; the Registered Manager is the line manager.
  it.each([
    ["HR names themselves", "owner", DEMO.users.owner.id, 422],
    ["HR names the nurse", "owner", NURSE, 422],
    ["the nurse names their own confirmer", "nurse", DEMO.users.manager.id, 403],
    ["a care worker names one", "carer", DEMO.users.manager.id, 403],
    // Advisory b: only someone holding training.manage or supervision.manage is named.
    ["HR names a care worker, who may not confirm", "owner", CARER, 422],
  ] as const)("refuses naming the confirmer: %s", async (_name, who, confirmerId, expected) => {
    expect((await nameConfirmer(who, confirmerId)).status).toBe(expected);
  });

  it("HR names the line manager as confirmer, and is then refused the confirmation", async () => {
    const named = await nameConfirmer("owner", DEMO.users.manager.id);
    expect(named.status).toBe(200);
    const plan = (await named.json()) as { revalidation: { confirmer: { id: string } | null } };
    expect(plan.revalidation.confirmer?.id).toBe(DEMO.users.manager.id);
    const hr = await confirm("owner");
    expect(hr.status).toBe(403);
    expect(((await hr.json()) as { code: string }).code).toBe("not_the_confirmer");
    const [denied] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = 'workforce.revalidation.confirmed' AND outcome = 'denied'
          AND reason = 'not_the_confirmer'`,
    );
    expect(denied?.n).toBeGreaterThanOrEqual(1);
  });

  it("refuses naming whoever reviewed the cycle, with a plain code (advisory a)", async () => {
    // The owner reviewed; the manager (also HR) may not name them.
    const named = await nameConfirmer("manager", DEMO.users.owner.id);
    expect(named.status).toBe(422);
    expect(((await named.json()) as { code: string }).code).toBe("names_reviewer");
    const refusedCarer = await nameConfirmer("owner", CARER);
    expect(((await refusedCarer.json()) as { code: string }).code).toBe("confirmer_not_permitted");
    const [denied] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
        WHERE action = 'workforce.revalidation.confirmer_named' AND outcome = 'denied'
          AND reason IN ('names_reviewer', 'confirmer_not_permitted')`,
    );
    expect(denied?.n).toBeGreaterThanOrEqual(2);
  });

  it("offers HR only members who may confirm, never the nurse, themselves or the reviewer", async () => {
    const list = async (who: string) =>
      (
        (await (
          await as(who, `${dev(NURSE)}/revalidation/confirmers?cycleDueOn=${cycle}`)
        ).json()) as { items: { id: string }[] }
      ).items.map((i) => i.id);
    const forOwner = await list("owner");
    expect(forOwner).toContain(DEMO.users.manager.id);
    for (const id of [NURSE, CARER, DEMO.users.owner.id]) expect(forOwner).not.toContain(id);
    // The owner reviewed this cycle, so the manager is not offered them.
    expect(await list("manager")).not.toContain(DEMO.users.owner.id);
    expect((await as("carer", `${dev(NURSE)}/revalidation/confirmers`)).status).toBe(403);
  });

  it.each([
    ["the nurse", "nurse", 403],
    ["HR, not named", "owner", 403],
    ["a care worker", "carer", 403],
  ] as const)("refuses the confirmation by %s", async (_name, who, expected) => {
    expect((await confirm(who)).status).toBe(expected);
    const [stored] = await sql<{ confirmation: boolean }>(
      "SELECT confirmation FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    expect(stored?.confirmation).toBe(false);
  });

  it("refuses the review by the confirmer named before it (advisory a)", async () => {
    const second = daysFromToday(800);
    const saved = await as("owner", `${dev(NURSE)}/revalidation`, {
      method: "PUT",
      body: { ...counts, cycleDueOn: second },
    });
    expect(saved.status).toBe(200);
    const versionOf = async () =>
      (
        await sql<{ version: number }>(
          "SELECT version FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
          [NURSE, second],
        )
      )[0]?.version;
    const named = await as("owner", `${dev(NURSE)}/revalidation/confirmer`, {
      method: "PUT",
      body: {
        expectedVersion: await versionOf(),
        cycleDueOn: second,
        confirmerId: DEMO.users.manager.id,
      },
    });
    expect(named.status).toBe(200);
    const review = await as("manager", `${dev(NURSE)}/revalidation/review`, {
      method: "POST",
      body: { expectedVersion: await versionOf(), cycleDueOn: second },
    });
    expect(review.status).toBe(403);
    expect(((await review.json()) as { code: string }).code).toBe("confirmer_reviews");
  });

  it("the named confirmer confirms in their own name; then the confirmer is fixed", async () => {
    const confirmed = await confirm("manager");
    expect(confirmed.status).toBe(200);
    const [stored] = await sql<{ confirmed_by: string; confirmation: boolean }>(
      "SELECT confirmed_by, confirmation FROM revalidation_evidence WHERE worker_id = $1 AND cycle_due_on = $2",
      [NURSE, cycle],
    );
    expect(stored).toEqual({ confirmed_by: DEMO.users.manager.id, confirmation: true });
    expect((await nameConfirmer("owner", DEMO.users.manager.id)).status).toBe(409);
  });
});

describe("hazard HZ-119 medicines reads competence from the workforce sign-offs (H-1532)", () => {
  const medicines = () => workforceCompetence(createDatabase(h.db.pool("harbour_app")));
  const OWNER = DEMO.users.owner.id;
  const MANAGER = DEMO.users.manager.id;

  it("answers not held for a member with no sign-off", async () => {
    expect(await medicines().forMember(DEMO.tenantId, OWNER, new Date())).toBe("not_held");
  });

  it("answers current for a sign-off in date, and expired for one past it", async () => {
    const signed = await as("nurse", `${dev(MANAGER)}/competences`, {
      method: "POST",
      body: { competence: "medicines_administration", observedOn: today() },
    });
    expect(signed.status, await signed.clone().text()).toBe(200);
    expect(await medicines().forMember(DEMO.tenantId, MANAGER, new Date())).toBe("current");
    const old = await as("manager", `${dev(OWNER)}/competences`, {
      method: "POST",
      body: {
        competence: "medicines_administration",
        observedOn: ukIsoDate(addUkMonths(new Date(), -13)),
      },
    });
    expect(old.status, await old.clone().text()).toBe(200);
    expect(await medicines().forMember(DEMO.tenantId, OWNER, new Date())).toBe("expired");
  });

  it("answers not held once withdrawn, which no override clears, and has no override yet", async () => {
    const record = (await (await as("owner", `${dev(MANAGER)}/development`)).json()) as Development;
    const withdrawn = await as(
      "owner",
      `${dev(MANAGER)}/competences/${record.signOffs[0]?.id}/withdraw`,
      {
        method: "POST",
        body: { reason: "Observed an error at the medicines round" },
      },
    );
    expect(withdrawn.status, await withdrawn.clone().text()).toBe(200);
    expect(await medicines().forMember(DEMO.tenantId, MANAGER, new Date())).toBe("not_held");
    expect(await medicines().overrideFor(DEMO.tenantId, MANAGER, new Date())).toBeNull();
  });

  it("judges a record on the day of the event it records, never later than today (clinical review H1)", async () => {
    // The owner's sign-off, 13 months old, was in date a year ago: a dose given then and synced
    // now is not refused because it lapsed since.
    const aYearAgo = addUkMonths(new Date(), -12);
    expect(await medicines().forMember(DEMO.tenantId, OWNER, aYearAgo)).toBe("current");
    expect(await medicines().forMember(DEMO.tenantId, OWNER, new Date())).toBe("expired");
    // A time in the future is held to today, so it can never stretch a sign-off.
    const later = addUkMonths(new Date(), 6);
    expect(await medicines().forMember(DEMO.tenantId, OWNER, later)).toBe("expired");
  });
});
