import type {
  DeathView,
  HerbertProfileView,
  IncidentDetail,
  MissingEpisodeView,
  ProblemDetails,
  StatutoryNotificationList,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  escalateTasks,
  outboxHandlers,
  raiseHerbertProfileReviews,
  type TaskDeps,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { ageSession, createHarness, type Harness } from "./support/harness";

/**
 * Deaths and missing persons through the API (Phase 2 slice 37; SAFE-014, SAFE-015; hazards
 * HZ-013 and HZ-127). Demo residents 1 to 3 are assigned to the care worker.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const newId = () => crypto.randomUUID();
const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const reason = "The person died in hospital: the hospital's medical examiner has it.";

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

/** A death recorded on a person's exit, as the people lifecycle records it. */
async function deathExit(personN: number, expected: boolean | null) {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO exit_record (person_id, location_id, kind, state, regulator, left_at,
         learning_disability_or_autism, death_expected, place_of_death)
       VALUES ($1, $2, 'death', 'recorded', 'cqc', now() - interval '3 hours', false, $3, 'care_home')
       RETURNING id`,
      [resident(personN), DEMO.locationId, expected],
    );
    return rows[0]?.id ?? "";
  });
}

const event = (type: string, payload: Record<string, unknown>) => ({
  id: newId(),
  tenantId: DEMO.tenantId,
  eventType: type,
  aggregateId: newId(),
  payload,
});

describe("hazard HZ-013 the death record (slice 37)", () => {
  it("hazard HZ-013 a death opens one death record, from the exit's event or on request, and a correction withdraws it", async () => {
    const exitId = await deathExit(4, true);
    await outboxHandlers(deps).get("people.person.died")?.(
      event("people.person.died", { personId: resident(4), exitRecordId: exitId }),
    );
    const opened = await as("manager", "/v1/deaths", {
      method: "POST",
      body: { exitRecordId: exitId },
    });
    expect(opened.status, await opened.clone().text()).toBe(200);
    const view = await json<DeathView>(opened);
    expect(view).toMatchObject({ exitRecordId: exitId, status: "open", expected: true });
    // The same death again is the same record.
    const again = await json<DeathView>(
      await as("manager", "/v1/deaths", { method: "POST", body: { exitRecordId: exitId } }),
    );
    expect(again.id).toBe(view.id);
    // The regulator's death notification drafted by the same event is waiting on the record.
    expect(view.steps.find((s) => s.step === "cqc_reg16_notification")).toMatchObject({
      state: "waiting",
      notificationStatus: "draft",
    });
    // The death corrected as recorded in error: the record is withdrawn, never deleted.
    await outboxHandlers(deps).get("people.person.status_corrected")?.(
      event("people.person.status_corrected", {
        personId: resident(4),
        exitRecordId: exitId,
        from: "deceased",
      }),
    );
    const withdrawn = await json<DeathView>(await as("manager", `/v1/deaths/${view.id}`));
    expect(withdrawn).toMatchObject({ status: "withdrawn", closeProblems: [] });
    const refused = await as("manager", `/v1/deaths/${view.id}/review`, {
      method: "PUT",
      body: { findings: reason, lessons: reason, version: withdrawn.version },
    });
    expect(refused.status).toBe(422);
  });

  it("hazard HZ-013 assumes the safer answer until the clinician's judgement is recorded, and closes only when every step is done", async () => {
    const exitId = await deathExit(5, null);
    await outboxHandlers(deps).get("people.person.died")?.(
      event("people.person.died", { personId: resident(5), exitRecordId: exitId }),
    );
    let view = await json<DeathView>(
      await as("manager", "/v1/deaths", { method: "POST", body: { exitRecordId: exitId } }),
    );
    expect(view.missingFacts).toEqual(["expected", "possiblyUnnatural"]);
    expect(view.steps.map((s) => s.step)).toEqual(
      expect.arrayContaining(["police_informed", "preserve_room_and_equipment"]),
    );
    const judged = await as("manager", `/v1/deaths/${view.id}`, {
      method: "PUT",
      body: {
        expected: true,
        possiblyUnnatural: false,
        judgedBy: "Dr Example, GP",
        version: view.version,
      },
    });
    expect(judged.status, await judged.clone().text()).toBe(200);
    view = await json<DeathView>(judged);
    expect(view.missingFacts).toEqual([]);
    expect(view.steps.map((s) => s.step)).not.toContain("police_informed");
    const step = (body: Record<string, unknown>) =>
      as("manager", `/v1/deaths/${view.id}/steps`, { method: "POST", body });
    // A notification step is done only in the notification centre.
    const ticked = await step({
      id: newId(),
      step: "medical_examiner_pack",
      outcome: "done",
      at: ago(MIN),
    });
    expect(ticked.status).toBe(422);
    // Not needed takes a reason of at least 20 characters.
    const short = await step({
      id: newId(),
      step: "family_informed",
      outcome: "not_needed",
      at: ago(MIN),
      note: "No family.",
    });
    expect(short.status).toBe(422);
    const verification = {
      id: newId(),
      step: "verification_of_death",
      outcome: "done",
      at: ago(2 * HOUR),
    };
    expect((await step(verification)).status).toBe(200);
    // Sent again with its id, it is a no-op; with other details, it is refused in words.
    expect((await step(verification)).status).toBe(200);
    const changed = await step({ ...verification, at: ago(HOUR) });
    expect((await json<ProblemDetails>(changed)).code).toBe("already_saved_differently");
    expect(
      (await step({ id: newId(), step: "family_informed", outcome: "done", at: ago(HOUR) })).status,
    ).toBe(200);
    // Not yet: the notifications and the mortality review are still to do.
    view = await json<DeathView>(await as("manager", `/v1/deaths/${view.id}`));
    const early = await as("manager", `/v1/deaths/${view.id}/close`, {
      method: "POST",
      body: { version: view.version },
    });
    expect(early.status).toBe(422);
    expect((await json<ProblemDetails>(early)).detail).toContain(
      "Record the mortality review: its findings and lessons.",
    );
    // The notifications decided in the notification centre (step-up, a reason).
    await ageSession(h.db.pool("harbour_auth"), h.tokens.manager?.split(".")[0] ?? "", 0);
    const drafts = (
      await json<StatutoryNotificationList>(
        await as("manager", `/v1/notifications/statutory?personId=${resident(5)}`),
      )
    ).items.filter((n) => n.status === "draft" || n.status === "ready");
    expect(drafts.length).toBeGreaterThanOrEqual(1);
    for (const n of drafts) {
      const decided = await as("manager", `/v1/notifications/statutory/${n.id}/not-required`, {
        method: "POST",
        body: { reason: "Recorded for this test only.", version: n.version },
      });
      expect(decided.status, await decided.clone().text()).toBe(200);
    }
    const reviewed = await as("manager", `/v1/deaths/${view.id}/review`, {
      method: "PUT",
      body: {
        findings: "Care was as planned; the end of life plan was followed.",
        lessons: "No lessons beyond the plan being kept up to date.",
        version: view.version,
      },
    });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);
    view = await json<DeathView>(reviewed);
    expect(view.closeProblems).toEqual([]);
    const closed = await as("manager", `/v1/deaths/${view.id}/close`, {
      method: "POST",
      body: { version: view.version },
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect((await json<DeathView>(closed)).status).toBe("closed");
    const after = await step({
      id: newId(),
      step: "family_informed",
      outcome: "done",
      at: ago(MIN),
    });
    expect(after.status).toBe(422);
    // Audited by id, never content.
    const audited = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ action: string; scope: unknown }>(
        "SELECT action, scope FROM audit_event WHERE resource_type = 'death_record' AND resource_id = $1",
        [view.id],
      );
      return rows;
    });
    expect(audited.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "safety.death.open",
        "safety.death.judgement",
        "safety.death.step",
        "safety.death.review",
        "safety.death.close",
      ]),
    );
    expect(JSON.stringify(audited)).not.toContain("end of life plan");
  });

  it("refuses a care worker the death record, and a person outside the reader's scope", async () => {
    const exitId = await deathExit(6, true);
    const view = await json<DeathView>(
      await as("manager", "/v1/deaths", { method: "POST", body: { exitRecordId: exitId } }),
    );
    const put = await as("carer", `/v1/deaths/${view.id}`, {
      method: "PUT",
      body: { expected: true, possiblyUnnatural: false, judgedBy: "Dr Example", version: 1 },
    });
    expect(put.status).toBe(403);
    // Resident 6 is not one of the care worker's people.
    const read = await as("carer", `/v1/deaths/${view.id}`);
    expect([403, 404]).toContain(read.status);
  });
});

describe("hazard HZ-127 the missing person episode (slice 37)", () => {
  let incidentId = "";
  let episodeId = "";

  it("hazard HZ-127 opening an episode starts the police call clock as an urgent task the task engine escalates", async () => {
    const created = await as("carer", "/v1/incidents", {
      method: "POST",
      body: {
        locationId: DEMO.locationId,
        type: "missing_person",
        occurredAt: ago(40 * MIN),
        description: "Not in her room at the evening check.",
        people: [{ kind: "service_user", role: "affected", personId: resident(1) }],
      },
    });
    expect(created.status, await created.clone().text()).toBe(201);
    incidentId = (await json<IncidentDetail>(created)).id;
    episodeId = newId();
    const body = {
      id: episodeId,
      incidentId,
      personId: resident(1),
      immediateRisk: false,
      noticedMissingAt: ago(40 * MIN),
      lastSeenAt: ago(60 * MIN),
    };
    const opened = await as("carer", "/v1/missing-episodes", { method: "POST", body });
    expect(opened.status, await opened.clone().text()).toBe(201);
    const view = await json<MissingEpisodeView>(opened);
    const due = new Date(Date.parse(body.noticedMissingAt) + 30 * MIN).toISOString();
    expect(view).toMatchObject({ status: "open", policeCallLate: true });
    expect(view.policeCallDueAt).toBe(due);
    expect(view.timeline.map((e) => e.kind)).toEqual(["last_seen", "noticed_missing"]);
    // Sent again with its id: the same episode. A second episode for the person: refused.
    expect((await as("carer", "/v1/missing-episodes", { method: "POST", body })).status).toBe(200);
    const second = await as("carer", "/v1/missing-episodes", {
      method: "POST",
      body: { ...body, id: newId() },
    });
    expect(second.status).toBe(409);
    const task = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{
        id: string;
        status: string;
        priority: string;
        assignee_role_key: string;
        due_at: Date;
      }>(
        "SELECT id, status, priority, assignee_role_key, due_at FROM task WHERE kind = 'safety.missing_police_call' AND source_id = $1",
        [episodeId],
      );
      return rows;
    });
    expect(task).toHaveLength(1);
    expect(task[0]).toMatchObject({
      status: "open",
      priority: "urgent",
      assignee_role_key: "registered_manager",
    });
    expect(task[0]?.due_at.toISOString()).toBe(due);
    // Overdue: the task engine tells someone other than its assignee.
    await escalateTasks(deps, new Date(Date.now() + 2 * HOUR));
    const told = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ recipient: string }>(
        "SELECT recipient_tenant_user_id AS recipient FROM notification WHERE source_type = 'task' AND source_id = $1",
        [task[0]?.id],
      );
      return rows;
    });
    expect(told.length).toBeGreaterThanOrEqual(1);
  });

  it("hazard HZ-127 the police call needs its reference, prompts the CQC notification and ends the police call task", async () => {
    const add = (body: Record<string, unknown>, user: "carer" | "manager" = "carer") =>
      as(user, `/v1/missing-episodes/${episodeId}/events`, {
        method: "POST",
        body: { id: newId(), at: ago(20 * MIN), ...body },
      });
    expect((await add({ kind: "search", area: "The garden and the car park" })).status).toBe(200);
    const bare = await add({ kind: "police_called" });
    expect(bare.status).toBe(422);
    expect((await json<ProblemDetails>(bare)).detail).toBe("Record the police reference.");
    const called = await add({ kind: "police_called", reference: "CAD 1234" });
    expect(called.status, await called.clone().text()).toBe(200);
    const view = await json<MissingEpisodeView>(called);
    expect(view).toMatchObject({ policeReference: "CAD 1234", cqcNotificationPrompt: true });
    expect(view.notifications.map((n) => n.kind)).toContain("cqc_reg18_police");
    const status = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ status: string }>(
        "SELECT status FROM task WHERE kind = 'safety.missing_police_call' AND source_id = $1",
        [episodeId],
      );
      return rows.map((r) => r.status);
    });
    expect(status).toEqual(["done"]);
  });

  it("hazard HZ-127 closes only once found, checked and debriefed; the welfare check and debrief need a manager", async () => {
    const add = (body: Record<string, unknown>, user: "carer" | "manager" = "carer") =>
      as(user, `/v1/missing-episodes/${episodeId}/events`, {
        method: "POST",
        body: { id: newId(), at: ago(5 * MIN), ...body },
      });
    expect((await add({ kind: "found", note: "Found in the next street, cold." })).status).toBe(
      200,
    );
    expect(
      (await add({ kind: "welfare_check", note: "Warmed up, no injuries found." })).status,
    ).toBe(403);
    let view = await json<MissingEpisodeView>(
      await as("manager", `/v1/missing-episodes/${episodeId}`),
    );
    expect(view.status).toBe("found");
    const early = await as("manager", `/v1/missing-episodes/${episodeId}/close`, {
      method: "POST",
      body: { version: view.version },
    });
    expect(early.status).toBe(422);
    expect((await json<ProblemDetails>(early)).detail).toContain("Check the person's welfare");
    expect(
      (await add({ kind: "welfare_check", note: "Warmed up, no injuries found." }, "manager"))
        .status,
    ).toBe(200);
    expect(
      (await add({ kind: "debrief", note: "The side gate is now kept locked." }, "manager")).status,
    ).toBe(200);
    view = await json<MissingEpisodeView>(await as("manager", `/v1/missing-episodes/${episodeId}`));
    expect(view.canClose).toBe(true);
    const closed = await as("manager", `/v1/missing-episodes/${episodeId}/close`, {
      method: "POST",
      body: { version: view.version },
    });
    expect(closed.status, await closed.clone().text()).toBe(200);
    expect((await add({ kind: "note", note: "A note after closing." })).status).toBe(422);
  });
});

describe("hazard HZ-127 the Herbert Protocol profile (slice 37)", () => {
  const path = `/v1/people/${resident(2)}/herbert-profile`;
  const fields = {
    photoDocumentId: null,
    physicalDescription: "Short, slim, white hair, glasses",
    distinguishingFeatures: null,
    usualClothing: null,
    medicalNeeds: null,
    mobility: null,
    communication: null,
    placesLikely: "His old home and the bowls club",
    peopleLikely: null,
    routines: null,
    phoneOrTracker: null,
    previousEpisodes: null,
    approach: null,
    reviewedWith: "His son, by phone",
  };
  const monthsAgo = (n: number) => {
    const d = new Date();
    d.setUTCMonth(d.getUTCMonth() - n);
    return d.toISOString().slice(0, 10);
  };

  it("hazard HZ-127 is prefilled from the record, saved with what the police need first, and its review raised when out of date", async () => {
    const empty = await json<HerbertProfileView>(await as("manager", path));
    expect(empty).toMatchObject({ profile: null, state: "none", reviewDueOn: null });
    expect(empty.prefill.physicalDescription).toBeNull();
    // A care worker reads it for their own people but never writes it.
    expect((await as("carer", path)).status).toBe(200);
    expect(
      (
        await as("carer", path, {
          method: "PUT",
          body: { ...fields, reviewedOn: monthsAgo(0), version: 0 },
        })
      ).status,
    ).toBe(403);
    const short = await as("manager", path, {
      method: "PUT",
      body: { ...fields, physicalDescription: "Short", reviewedOn: monthsAgo(0), version: 0 },
    });
    expect(short.status).toBe(422);
    const stale = await as("manager", path, {
      method: "PUT",
      body: { ...fields, reviewedOn: monthsAgo(7), version: 0 },
    });
    expect(stale.status, await stale.clone().text()).toBe(200);
    expect((await json<HerbertProfileView>(stale)).state).toBe("out_of_date");
    // The daily job raises one review task, however often it runs.
    await raiseHerbertProfileReviews(deps);
    await raiseHerbertProfileReviews(deps);
    const tasks = () =>
      asDemoTenant(async (c) => {
        const { rows } = await c.query<{ status: string; assignee_role_key: string }>(
          "SELECT status, assignee_role_key FROM task WHERE kind = 'safety.herbert_profile_review' AND person_id = $1",
          [resident(2)],
        );
        return rows;
      });
    expect(await tasks()).toEqual([{ status: "open", assignee_role_key: "clinical_lead" }]);
    // Reviewed today: current again, and the task is done.
    const reviewed = await as("manager", path, {
      method: "PUT",
      body: { ...fields, reviewedOn: monthsAgo(0), version: 1 },
    });
    expect(reviewed.status, await reviewed.clone().text()).toBe(200);
    expect((await json<HerbertProfileView>(reviewed)).state).toBe("current");
    expect(await tasks()).toEqual([{ status: "done", assignee_role_key: "clinical_lead" }]);
    // A future review date is refused.
    const future = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
    const ahead = await as("manager", path, {
      method: "PUT",
      body: { ...fields, reviewedOn: future, version: 2 },
    });
    expect(ahead.status).toBe(422);
  });
});
