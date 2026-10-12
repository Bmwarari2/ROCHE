import type {
  BodyMapMarkItem,
  BodyMapMarkList,
  CareNoteItem,
  CareNoteList,
  FluidDay,
  ObservationItem,
  PersonCareProfile,
  ProblemDetails,
  TaskItem,
  TaskList,
} from "@harbour/contracts";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./support/harness";

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
const newId = () => {
  // A UUIDv7-shaped id as a device would generate it.
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

beforeAll(async () => {
  h = await createHarness();
}, 120_000);

afterAll(async () => {
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

const note = (
  person: number,
  body: Record<string, unknown>,
  user: keyof Harness["tokens"] = "carer",
) =>
  as(user, `/v1/people/${resident(person)}/notes`, {
    method: "POST",
    body: {
      category: "personal_care",
      body: "Assisted with a wash; skin intact.",
      occurredAt: ago(5),
      ...body,
    },
  });
const observe = (
  person: number,
  values: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  user: keyof Harness["tokens"] = "carer",
) =>
  as(user, `/v1/people/${resident(person)}/observations`, {
    method: "POST",
    body: { occurredAt: ago(5), values, ...extra },
  });

describe("daily notes", () => {
  it("lets a care worker write and read notes for an assigned person only (HZ-011)", async () => {
    const created = await note(1, {});
    expect(created.status).toBe(201);
    const list = await json<CareNoteList>(await as("carer", `/v1/people/${resident(1)}/notes`));
    expect(list.items.map((n) => n.body)).toContain("Assisted with a wash; skin intact.");
    expect((await note(5, {})).status).toBe(404);
    expect((await as("carer", `/v1/people/${resident(5)}/notes`)).status).toBe(404);
  });

  it("needs MFA", async () => {
    const response = await as("nurse", `/v1/people/${resident(1)}/notes`);
    expect(response.status).toBe(403);
    expect((await json<ProblemDetails>(response)).code).toBe("mfa_enrolment_required");
  });

  it("hazard HZ-017 flags a note written hours after the event, not one synced late", async () => {
    const late = await json<CareNoteItem>(await note(1, { occurredAt: ago(180) }));
    expect(late.lateEntry).toBe(true);
    // Written on the device five minutes after the event, uploaded three hours later.
    const synced = await json<CareNoteItem>(
      await note(1, { occurredAt: ago(180), deviceTime: ago(175) }),
    );
    expect(synced.lateEntry).toBe(false);
  });

  it("refuses an event in the future", async () => {
    const response = await note(1, { occurredAt: new Date(Date.now() + 60 * MIN).toISOString() });
    expect(response.status).toBe(422);
  });

  it("ignores a replayed upload with the same device id", async () => {
    const id = newId();
    const first = await json<CareNoteItem>(await note(2, { id, body: "Settled well after tea." }));
    const replay = await note(2, { id, body: "Settled well after tea." });
    expect(replay.status).toBe(201);
    expect((await json<CareNoteItem>(replay)).id).toBe(first.id);
    const list = await json<CareNoteList>(await as("carer", `/v1/people/${resident(2)}/notes`));
    expect(list.items.filter((n) => n.id === id)).toHaveLength(1);
  });

  it("hazard HZ-017 corrects by superseding with a reason; the original stays readable", async () => {
    const original = await json<CareNoteItem>(await note(3, { body: "Ate all of lunch." }));
    expect((await note(3, { body: "Ate half of lunch.", supersedesId: original.id })).status).toBe(
      422,
    );
    const corrected = await note(3, {
      body: "Ate half of lunch.",
      supersedesId: original.id,
      correctionReason: "Wrong portion recorded",
    });
    expect(corrected.status).toBe(201);
    const list = await json<CareNoteList>(await as("carer", `/v1/people/${resident(3)}/notes`));
    expect(list.items.find((n) => n.id === original.id)?.superseded).toBe(true);
  });
});

describe("hazard HZ-040 an entry a device reported deleted, uploaded later (round 4, H1)", () => {
  const discard = (
    entryIds: readonly string[],
    stage: string,
    id: string,
    by: { user: keyof Harness["tokens"]; owner: string } = {
      user: "carer",
      owner: DEMO.users.carer.id,
    },
  ) =>
    as(by.user, "/v1/sync/discards", {
      method: "POST",
      body: {
        id,
        kind: "held_deleted",
        stage,
        reasonCode: "recorded_elsewhere",
        ownerTenantUserId: by.owner,
        deletedByTenantUserId: by.owner,
        entryIds,
        personIds: [resident(1)],
        count: entryIds.length,
        discardedAt: new Date().toISOString(),
      },
    });
  /** A deletion recorded as requested, then as done. */
  const deleted = async (
    entryIds: readonly string[],
    by?: { user: keyof Harness["tokens"]; owner: string },
  ) => {
    const id = crypto.randomUUID();
    expect((await discard(entryIds, "requested", id, by)).status).toBe(200);
    expect((await discard(entryIds, "deleted", id, by)).status).toBe(200);
    return id;
  };
  type FlagTask = {
    id: string;
    title: string;
    person_id: string | null;
    location_id: string | null;
    assignee_role_key: string;
    required_permission: string;
    due_at: Date;
    window_start: Date | null;
    window_end: Date | null;
  };
  /** The audit events on an entry, and the review tasks of a deletion record. */
  const flags = (
    entryId: string,
    recordId: string,
    kind = "sync.entry_reported_deleted",
    action = "sync.entry.after_discard",
  ) =>
    asDemoTenant(async (c) => {
      const audit = await c.query(
        "SELECT 1 FROM audit_event WHERE action = $1 AND resource_id = $2",
        [action, entryId],
      );
      const tasks = await c.query<FlagTask>(
        `SELECT id, title, person_id, location_id, assignee_role_key, required_permission, due_at,
                window_start, window_end
         FROM task WHERE kind = $1 AND source_type = 'device_discard' AND source_id = $2`,
        [kind, recordId],
      );
      return { audit: audit.rowCount, tasks: tasks.rows };
    });
  const taskAudit = (taskId: string | undefined) =>
    asDemoTenant(async (c) =>
      (
        await c.query<{ action: string; scope: Record<string, unknown> }>(
          "SELECT action, scope FROM audit_event WHERE resource_type = 'task' AND resource_id = $1 ORDER BY seq",
          [taskId],
        )
      ).rows.map((r) => [r.action, r.scope]),
    );

  // Each test starts with no open flagged-entry tasks, so each owner's cap starts again.
  afterEach(async () => {
    await asDemoTenant((c) =>
      c.query("UPDATE task SET status = 'done' WHERE kind LIKE 'sync.entry_%' AND status = 'open'"),
    );
  });

  it("keeps the entry and flags it for the manager, so care recorded again is not counted twice unseen", async () => {
    const entryId = newId();
    const record = await deleted([entryId]);
    const before = Date.now();
    expect((await note(1, { id: entryId })).status).toBe(201);
    const { audit, tasks } = await flags(entryId, record);
    expect(audit).toBe(1);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: "Check entries uploaded after their device reported deleting them: 1",
      person_id: null,
      location_id: DEMO.locationId,
      assignee_role_key: "registered_manager",
      required_permission: "safety.incident.manage",
    });
    // A record to check within the day, not "due now" (HZ-008).
    const due = new Date(tasks[0]?.due_at ?? 0).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 24 * 60 * MIN - 5_000);
    expect(due).toBeLessThanOrEqual(Date.now() + 24 * 60 * MIN);
    expect(tasks[0]?.window_end).toEqual(tasks[0]?.due_at);
    // A replay of the same upload flags nothing more.
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId, record)).toMatchObject({ audit: 1, tasks: [{ id: tasks[0]?.id }] });
  });

  it("flags nothing until the device records the deletion as done (round 6, N1)", async () => {
    const entryId = newId();
    const record = crypto.randomUUID();
    expect((await discard([entryId], "requested", record)).status).toBe(200);
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId, record)).toEqual({ audit: 0, tasks: [] });
  });

  it("raises one task per deletion record, however many of its entries arrive (round 6, N1)", async () => {
    const entryIds = [newId(), newId(), newId()];
    const record = await deleted(entryIds);
    for (const id of entryIds) expect((await note(1, { id })).status).toBe(201);
    // Uploaded again, under the same ids: nothing more.
    for (const id of entryIds) expect((await note(1, { id })).status).toBe(201);
    const { tasks } = await flags(entryIds[0] ?? "", record);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.title).toBe(
      "Check entries uploaded after their device reported deleting them: 3",
    );
    // Its audit events carry the count and the opaque entry ids.
    expect(await taskAudit(tasks[0]?.id)).toEqual([
      [
        "sync.entry_flag.raised",
        expect.objectContaining({ discardId: record, count: 1, entryIds: [entryIds[0]] }),
      ],
      ["sync.entry_flag.added", expect.objectContaining({ count: 2, entryIds: [entryIds[1]] })],
      ["sync.entry_flag.added", expect.objectContaining({ count: 3, entryIds: [entryIds[2]] })],
    ]);
    for (const id of entryIds) expect((await flags(id, record)).audit).toBe(1);
  });

  it("does not flag an entry whose deletion the device reported as failed", async () => {
    const entryId = newId();
    const record = crypto.randomUUID();
    await discard([entryId], "requested", record);
    await discard([entryId], "failed", record);
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId, record)).toEqual({ audit: 0, tasks: [] });
  });

  it("flags only a deletion whose owner is the uploader, so no one can mark someone else's entries (round 5, S-M2 and S-L1)", async () => {
    const entryId = newId();
    // The manager records deleting the manager's own entry with that id; the carer then uploads it.
    const record = await deleted([entryId], { user: "manager", owner: DEMO.users.manager.id });
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId, record)).toEqual({ audit: 0, tasks: [] });
  });

  it("stays fast with many deletion records in the tenant (round 5, S-M2)", async () => {
    // Three thousand deletion records of 20 entry ids each, as a busy tenant might build up.
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope)
         SELECT $1, CASE WHEN n % 2 = 0 THEN 'sync.entries.discard_requested' ELSE 'sync.entries.discarded' END,
                'device_discard', gen_random_uuid()::text,
                jsonb_build_object('ownerTenantUserId', $2::text, 'entryIds',
                  (SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1, 20 + n % 2)))
         FROM generate_series(1, 3000) AS n`,
        [DEMO.tenantId, DEMO.users.nurse.id],
      ),
    );
    const entryId = newId();
    const record = await deleted([entryId]);
    const started = performance.now();
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect((await flags(entryId, record)).audit).toBe(1);
  });

  it("flags an entry a deletion lists that had already reached the server, once the deletion is done (round 5, C-L2; round 6, N1)", async () => {
    const entryId = newId();
    expect((await note(1, { id: entryId })).status).toBe(201);
    const record = crypto.randomUUID();
    const already = () =>
      flags(entryId, record, "sync.entry_deleted_after_upload", "sync.entry.before_discard");
    expect((await discard([entryId], "requested", record)).status).toBe(200);
    expect(await already()).toEqual({ audit: 0, tasks: [] });
    expect((await discard([entryId], "deleted", record)).status).toBe(200);
    const { audit, tasks } = await already();
    expect(audit).toBe(1);
    expect(tasks).toMatchObject([
      {
        title: "Check entries a device deleted after they reached Harbour: 1",
        person_id: null,
        location_id: DEMO.locationId,
      },
    ]);
    // The deletion's stage sent again flags nothing more.
    expect((await discard([entryId], "deleted", record)).status).toBe(200);
    expect((await already()).tasks).toHaveLength(1);
  });

  it("does not flag again an entry listed under a new deletion record (round 6, N1)", async () => {
    const entryId = newId();
    expect((await note(1, { id: entryId })).status).toBe(201);
    const first = await deleted([entryId]);
    const kind = "sync.entry_deleted_after_upload";
    expect((await flags(entryId, first, kind, "sync.entry.before_discard")).tasks).toHaveLength(1);
    const again = await deleted([entryId]);
    expect(await flags(entryId, again, kind, "sync.entry.before_discard")).toEqual({
      audit: 1,
      tasks: [],
    });
    // Nor one first flagged when it was uploaded after its deletion.
    const later = newId();
    const reported = await deleted([later]);
    expect((await note(1, { id: later })).status).toBe(201);
    expect((await flags(later, reported)).tasks).toHaveLength(1);
    const relisted = await deleted([later]);
    expect((await flags(later, relisted, kind, "sync.entry.before_discard")).tasks).toEqual([]);
  });

  it("hazard HZ-008 merges an owner's flagged entries past the cap into their oldest open task there, so no cap stops a task (round 6, N1; round 7, M2)", async () => {
    const manager = { user: "manager" as const, owner: DEMO.users.manager.id };
    const records: string[] = [];
    const entries: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const entryId = newId();
      expect((await note(1, { id: entryId }, "manager")).status).toBe(201);
      entries.push(entryId);
      records.push(await deleted([entryId], manager));
    }
    const raised = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ id: string; source_id: string; title: string }>(
            "SELECT id, source_id, title FROM task WHERE kind = 'sync.entry_deleted_after_upload' AND source_id = ANY($1::uuid[]) ORDER BY created_at",
            [records],
          )
        ).rows,
    );
    expect(raised.map((r) => r.source_id)).toEqual(records.slice(0, 5));
    // The two past the cap are counted on the oldest task, and their ids listed there.
    expect(raised[0]?.title).toBe("Check entries a device deleted after they reached Harbour: 3");
    expect(
      (await taskAudit(raised[0]?.id)).filter(([action]) => action === "sync.entry_flag.added"),
    ).toEqual([
      [
        "sync.entry_flag.added",
        expect.objectContaining({ discardId: records[5], merged: true, entryIds: [entries[5]] }),
      ],
      [
        "sync.entry_flag.added",
        expect.objectContaining({ discardId: records[6], merged: true, entryIds: [entries[6]] }),
      ],
    ]);
    const capped = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ resource_id: string; outcome: string; into: string }>(
            "SELECT resource_id, outcome, scope ->> 'mergedInto' AS into FROM audit_event WHERE action = 'sync.entry_flag.capped' ORDER BY seq",
          )
        ).rows,
    );
    expect(capped).toEqual([
      { resource_id: records[5], outcome: "denied", into: raised[0]?.id },
      { resource_id: records[6], outcome: "denied", into: raised[0]?.id },
    ]);
    // Each merged entry is on that task, so a later deletion listing it adds nothing.
    for (const entryId of entries.slice(5)) {
      expect((await flags(entryId, records[0] ?? "", "x", "sync.entry.before_discard")).audit).toBe(
        1,
      );
    }
    // In addition, one notice to the Registered Manager a day.
    const notices = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ recipient_tenant_user_id: string; title: string; source_id: string }>(
            "SELECT recipient_tenant_user_id, title, source_id FROM notification WHERE kind = 'sync.reporter_capped'",
          )
        ).rows,
    );
    expect(notices).toEqual([
      {
        recipient_tenant_user_id: DEMO.users.manager.id,
        title: "A member of staff reached the limit on entries to check",
        source_id: DEMO.users.manager.id,
      },
    ]);
  });

  it("hazard HZ-008 makes a flagged task due at once when an entry is an observation, and within the day otherwise (round 7, M3)", async () => {
    const noteId = newId();
    const observationId = newId();
    const record = await deleted([noteId, observationId]);
    const before = Date.now();
    // The note alone: a record to check within the day.
    expect((await note(1, { id: noteId })).status).toBe(201);
    const [task] = (await flags(noteId, record)).tasks;
    expect(new Date(task?.due_at ?? 0).getTime()).toBeGreaterThanOrEqual(
      before + 24 * 60 * MIN - 5_000,
    );
    // A fluid entry (a chart) counts towards the day's total: the task is due now.
    expect(
      (await observe(1, { chart: "fluid_intake", ml: 150 }, { id: observationId })).status,
    ).toBe(201);
    const [after] = (await flags(observationId, record)).tasks;
    expect(after?.id).toBe(task?.id);
    expect(new Date(after?.due_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
    expect(after?.window_end).toEqual(after?.due_at);
    // An observation on its own raises a task due now.
    const alone = newId();
    const second = await deleted([alone]);
    expect((await observe(1, { chart: "fluid_intake", ml: 100 }, { id: alone })).status).toBe(201);
    const [now] = (await flags(alone, second)).tasks;
    expect(new Date(now?.due_at ?? 0).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("hazard HZ-040 gives each location's managers only their own people's flagged entries (round 7, M4)", async () => {
    // The owner works across the organisation: one entry for a person at the home, one at the Lodge.
    const home = newId();
    const lodge = newId();
    const lodgePerson = "0194d000-0000-7000-8000-000000000499";
    const lodgeLocation = "0194d000-0000-7000-8000-000000000102";
    expect((await note(1, { id: home }, "owner")).status).toBe(201);
    expect(
      (
        await as("owner", `/v1/people/${lodgePerson}/notes`, {
          method: "POST",
          body: {
            id: lodge,
            category: "personal_care",
            body: "Assisted with a wash; skin intact.",
            occurredAt: ago(5),
          },
        })
      ).status,
    ).toBe(201);
    const record = await deleted([home, lodge], { user: "owner", owner: DEMO.users.owner.id });
    const tasks = await asDemoTenant(
      async (c) =>
        (
          await c.query<{ id: string; location_id: string; title: string }>(
            "SELECT id, location_id, title FROM task WHERE kind = 'sync.entry_deleted_after_upload' AND source_id = $1 ORDER BY location_id",
            [record],
          )
        ).rows,
    );
    expect(tasks.map((t) => [t.location_id, t.title])).toEqual(
      [
        [DEMO.locationId, "Check entries a device deleted after they reached Harbour: 1"],
        [lodgeLocation, "Check entries a device deleted after they reached Harbour: 1"],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
    // Each entry names its own location's task.
    const entryTask = (entryId: string) =>
      asDemoTenant(
        async (c) =>
          (
            await c.query<{ task: string }>(
              "SELECT scope ->> 'taskId' AS task FROM audit_event WHERE action = 'sync.entry.before_discard' AND resource_id = $1",
              [entryId],
            )
          ).rows[0]?.task,
      );
    const byLocation = new Map(tasks.map((t) => [t.location_id, t.id]));
    expect(await entryTask(home)).toBe(byLocation.get(DEMO.locationId));
    expect(await entryTask(lodge)).toBe(byLocation.get(lodgeLocation));
  });
});

describe("hazard HZ-012 and HZ-014 NEWS2 vital signs", () => {
  const normal = {
    chart: "vitals",
    respirationRate: 16,
    spo2: 97,
    onOxygen: false,
    systolic: 122,
    pulse: 72,
    consciousness: "alert",
    temperature: 36.8,
  };

  it("scores normal observations 0 and raises nothing", async () => {
    const saved = await json<ObservationItem>(await observe(1, normal));
    expect(saved.flags).toMatchObject({ news2: { score: 0, band: "low", spo2Scale: 1 } });
    const tasks = await json<TaskList>(await as("manager", `/v1/tasks?personId=${resident(1)}`));
    // Score 0: no response task and no repeat scheduled outside the care plan (HZ-008).
    expect(
      tasks.items.filter(
        (t) => t.kind === "care.news2_response" || t.kind === "care.repeat_observations",
      ),
    ).toEqual([]);
  });

  it("alerts the nurse in charge and creates the response tasks for a high score", async () => {
    const saved = await json<ObservationItem>(
      await observe(2, {
        ...normal,
        respirationRate: 26,
        spo2: 90,
        systolic: 88,
        pulse: 135,
        consciousness: "new_confusion",
        temperature: 39.5,
      }),
    );
    expect(saved.flags).toMatchObject({ news2: { score: 17, band: "high", redScore: true } });
    const tasks = await json<TaskList>(await as("manager", `/v1/tasks?personId=${resident(2)}`));
    const kinds = tasks.items.map((t) => t.kind);
    expect(kinds).toEqual(
      expect.arrayContaining(["care.news2_response", "care.repeat_observations"]),
    );
    expect(tasks.items.find((t) => t.kind === "care.news2_response")?.priority).toBe("urgent");
    const alerts = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ recipient_tenant_user_id: string; title: string }>(
        "SELECT recipient_tenant_user_id, title FROM notification WHERE source_id = $1",
        [saved.id],
      );
      return rows;
    });
    expect(alerts.map((a) => a.recipient_tenant_user_id)).toContain(DEMO.users.nurse.id);
    expect(alerts.every((a) => a.title === "An observation needs a response now")).toBe(true);
  });

  it("uses SpO2 scale 2 only after a clinician's decision is recorded", async () => {
    const before = await json<ObservationItem>(await observe(3, { ...normal, spo2: 89 }));
    expect(before.flags).toMatchObject({ news2: { spo2Scale: 1 } });
    const refused = await as("manager", `/v1/people/${resident(3)}/care-profile`, {
      method: "PUT",
      body: { spo2Scale2: true, version: 0 },
    });
    expect(refused.status).toBe(422);
    const profile = await as("manager", `/v1/people/${resident(3)}/care-profile`, {
      method: "PUT",
      body: { spo2Scale2: true, spo2Scale2Clinician: "Dr Example, GP", version: 0 },
    });
    expect(profile.status).toBe(200);
    const after = await json<ObservationItem>(await observe(3, { ...normal, spo2: 89 }));
    expect(after.flags).toMatchObject({ news2: { spo2Scale: 2 } });
  });
});

describe("hazard HZ-016 IDDSI levels", () => {
  it("needs a reason and alerts for food at a higher level than prescribed", async () => {
    const noAdviser = await as("manager", `/v1/people/${resident(1)}/care-profile`, {
      method: "PUT",
      body: { iddsiFoodLevel: "4", version: 0 },
    });
    expect(noAdviser.status).toBe(422);
    const set = await json<PersonCareProfile>(
      await as("manager", `/v1/people/${resident(1)}/care-profile`, {
        method: "PUT",
        body: { iddsiFoodLevel: "4", iddsiAdvisedBy: "Speech and language therapist", version: 0 },
      }),
    );
    expect(set).toMatchObject({
      iddsiFoodLevel: "4",
      iddsiAdvisedBy: "Speech and language therapist",
    });

    const food = { chart: "food", meal: "lunch", portion: "half" };
    expect((await observe(1, { ...food, iddsiLevel: "4" })).status).toBe(201);
    expect((await observe(1, { ...food, iddsiLevel: "7" })).status).toBe(422);
    const overridden = await observe(1, {
      ...food,
      iddsiLevel: "7",
      overrideReason: "Family brought a sandwich",
    });
    expect(overridden.status).toBe(201);
    expect((await json<ObservationItem>(overridden)).flags).toMatchObject({ iddsiAlert: true });
  });
});

describe("fluid balance", () => {
  it("totals a UK day and shows the shortfall against the target", async () => {
    await as("manager", `/v1/people/${resident(2)}/care-profile`, {
      method: "PUT",
      body: { fluidTargetMl: 1500, version: 0 },
    });
    // A fixed day two days ago, with times late in the morning UTC: the same London day in summer
    // and winter time, so the test passes at any hour.
    const day = new Date(Date.now() - 2 * 24 * 60 * MIN).toISOString().slice(0, 10);
    const at = (time: string) => `${day}T${time}:00.000Z`;
    await observe(2, { chart: "fluid_intake", ml: 200 }, { occurredAt: at("10:00") });
    await observe(2, { chart: "fluid_intake", ml: 300 }, { occurredAt: at("11:00") });
    await observe(
      2,
      { chart: "fluid_output", ml: 150, kind: "urine" },
      { occurredAt: at("12:00") },
    );
    const totals = await json<FluidDay>(
      await as("carer", `/v1/people/${resident(2)}/charts/fluid?date=${day}`),
    );
    expect(totals).toMatchObject({
      date: day,
      intakeMl: 500,
      outputMl: 150,
      targetMl: 1500,
      shortfallMl: 1000,
    });
  });
});

describe("hazard HZ-019 body map", () => {
  const mark = {
    occurredAt: ago(5),
    view: "back",
    region: "heel",
    drawnSide: "left",
    side: "left",
    markType: "pressure_ulcer",
    pressureCategory: "category_3",
    deviceRelated: false,
    lengthMm: 20,
    widthMm: 15,
  };

  it("refuses a mark whose stated side differs from the drawing", async () => {
    const response = await as("carer", `/v1/people/${resident(1)}/body-map`, {
      method: "POST",
      body: { ...mark, side: "right" },
    });
    expect(response.status).toBe(422);
  });

  it("records a category 3 pressure ulcer and prompts an incident and the safeguarding guide", async () => {
    const saved = await json<BodyMapMarkItem>(
      await as("carer", `/v1/people/${resident(1)}/body-map`, { method: "POST", body: mark }),
    );
    expect(saved).toMatchObject({ region: "heel", side: "left", pressureCategory: "category_3" });
    const tasks = await json<TaskList>(await as("manager", `/v1/tasks?personId=${resident(1)}`));
    expect(tasks.items.map((t) => t.kind)).toEqual(
      expect.arrayContaining(["care.incident_report", "care.safeguarding_decision_guide"]),
    );

    const healed = await as("carer", `/v1/people/${resident(1)}/body-map`, {
      method: "POST",
      body: {
        ...mark,
        status: "healed",
        supersedesId: saved.id,
        correctionReason: "Healed on review",
      },
    });
    expect(healed.status).toBe(201);
    const current = await json<BodyMapMarkList>(
      await as("carer", `/v1/people/${resident(1)}/body-map`),
    );
    expect(current.items.map((m) => m.id)).not.toContain(saved.id);
  });
});

describe("rounds and closed records", () => {
  it("completes the turn a repositioning entry answers, with the entry as evidence", async () => {
    const t = await json<TaskItem>(
      await as("manager", "/v1/tasks", {
        method: "POST",
        body: { title: "Reposition", personId: resident(2), dueAt: new Date().toISOString() },
      }),
    );
    const saved = await json<ObservationItem>(
      await observe(
        2,
        { chart: "repositioning", position: "left", skinChecked: true },
        { taskId: t.id },
      ),
    );
    const tasks = await json<TaskList>(
      await as("carer", `/v1/tasks?personId=${resident(2)}&status=closed`),
    );
    expect(tasks.items.find((x) => x.id === t.id)).toMatchObject({
      status: "done",
      evidenceType: "observation",
      evidenceId: saved.id,
    });
  });

  it("hazard HZ-006 accepts entries from before a discharge, flagged, and refuses later ones except post-event notes", async () => {
    // Discharged an hour ago (people.md rule 3): the trigger keeps status_changed_at in step.
    await asDemoTenant((c) =>
      c.query(
        `UPDATE person SET status = 'discharged', discharged_at = now() - interval '1 hour'
         WHERE id = $1`,
        [resident(6)],
      ),
    );
    const before = await observe(
      6,
      { chart: "weight", kg: 60, method: "chair" },
      { occurredAt: ago(120) },
      "manager",
    );
    expect(before.status).toBe(201);
    expect((await json<ObservationItem>(before)).recordedAfterExit).toBe(true);
    expect(
      (await observe(6, { chart: "weight", kg: 60, method: "chair" }, {}, "manager")).status,
    ).toBe(422);
    const postEvent = await note(
      6,
      { category: "other", body: "Property returned to family." },
      "manager",
    );
    expect(postEvent.status).toBe(201);
    expect((await json<CareNoteItem>(postEvent)).recordedAfterExit).toBe(false);
    const late = await note(
      6,
      { category: "night", body: "Settled well overnight.", occurredAt: ago(180) },
      "manager",
    );
    expect((await json<CareNoteItem>(late)).recordedAfterExit).toBe(true);
  });
});
