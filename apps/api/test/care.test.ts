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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    entryId: string,
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
        entryIds: [entryId],
        personIds: [resident(1)],
        count: 1,
        discardedAt: new Date().toISOString(),
      },
    });
  const flags = (entryId: string) =>
    asDemoTenant(async (c) => {
      const audit = await c.query(
        "SELECT 1 FROM audit_event WHERE action = 'sync.entry.after_discard' AND resource_id = $1",
        [entryId],
      );
      const tasks = await c.query<{ assignee_role_key: string; required_permission: string }>(
        "SELECT assignee_role_key, required_permission FROM task WHERE kind = 'sync.entry_reported_deleted' AND source_id = $1",
        [entryId],
      );
      return { audit: audit.rowCount, tasks: tasks.rows };
    });

  it("keeps the entry and flags it for the manager, so care recorded again is not counted twice unseen", async () => {
    const entryId = newId();
    expect((await discard(entryId, "requested", crypto.randomUUID())).status).toBe(200);
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId)).toEqual({
      audit: 1,
      tasks: [
        { assignee_role_key: "registered_manager", required_permission: "safety.incident.manage" },
      ],
    });
    // A replay of the same upload flags nothing more.
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect((await flags(entryId)).tasks).toHaveLength(1);
  });

  it("does not flag an entry whose deletion the device reported as failed", async () => {
    const entryId = newId();
    const record = crypto.randomUUID();
    await discard(entryId, "requested", record);
    await discard(entryId, "failed", record);
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId)).toEqual({ audit: 0, tasks: [] });
  });

  it("flags only a deletion whose owner is the uploader, so no one can mark someone else's entries (round 5, S-M2 and S-L1)", async () => {
    const entryId = newId();
    // The manager records deleting the manager's own entry with that id; the carer then uploads it.
    const manager = { user: "manager" as const, owner: DEMO.users.manager.id };
    expect((await discard(entryId, "requested", crypto.randomUUID(), manager)).status).toBe(200);
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(await flags(entryId)).toEqual({ audit: 0, tasks: [] });
  });

  it("stays fast with many deletion records in the tenant (round 5, S-M2)", async () => {
    // Three thousand deletion records of 20 entry ids each, as a busy tenant might build up.
    await asDemoTenant((c) =>
      c.query(
        `INSERT INTO audit_event (tenant_id, action, resource_type, resource_id, scope)
         SELECT $1, 'sync.entries.discard_requested', 'device_discard', gen_random_uuid()::text,
                jsonb_build_object('ownerTenantUserId', $2::text, 'entryIds',
                  (SELECT jsonb_agg(gen_random_uuid()) FROM generate_series(1, 20 + n % 2)))
         FROM generate_series(1, 3000) AS n`,
        [DEMO.tenantId, DEMO.users.nurse.id],
      ),
    );
    const entryId = newId();
    await discard(entryId, "requested", crypto.randomUUID());
    const started = performance.now();
    expect((await note(1, { id: entryId })).status).toBe(201);
    expect(performance.now() - started).toBeLessThan(1_500);
    expect((await flags(entryId)).audit).toBe(1);
  });

  it("flags an entry a deletion lists that had already reached the server (round 5, C-L2)", async () => {
    const entryId = newId();
    expect((await note(1, { id: entryId })).status).toBe(201);
    const record = crypto.randomUUID();
    expect((await discard(entryId, "requested", record)).status).toBe(200);
    const alreadyFlagged = () =>
      asDemoTenant(async (c) => {
        const audit = await c.query(
          "SELECT 1 FROM audit_event WHERE action = 'sync.entry.before_discard' AND resource_id = $1",
          [entryId],
        );
        const tasks = await c.query<{ kind: string; person_id: string }>(
          "SELECT kind, person_id FROM task WHERE kind = 'sync.entry_deleted_after_upload' AND source_id = $1",
          [entryId],
        );
        return { audit: audit.rowCount, tasks: tasks.rows };
      });
    expect(await alreadyFlagged()).toEqual({
      audit: 1,
      tasks: [{ kind: "sync.entry_deleted_after_upload", person_id: resident(1) }],
    });
    // The deletion's later stage flags nothing more.
    expect((await discard(entryId, "deleted", record)).status).toBe(200);
    expect((await alreadyFlagged()).tasks).toHaveLength(1);
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
    await observe(2, { chart: "fluid_intake", ml: 200 }, { occurredAt: ago(30) });
    await observe(2, { chart: "fluid_intake", ml: 300 }, { occurredAt: ago(20) });
    await observe(2, { chart: "fluid_output", ml: 150, kind: "urine" }, { occurredAt: ago(10) });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(
      new Date(Date.now() - 30 * MIN),
    );
    const day = await json<FluidDay>(
      await as("carer", `/v1/people/${resident(2)}/charts/fluid?date=${today}`),
    );
    expect(day).toMatchObject({ intakeMl: 500, outputMl: 150, targetMl: 1500, shortfallMl: 1000 });
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

  it("keeps a discharged person's charts closed but allows post-event notes", async () => {
    await asDemoTenant((c) =>
      c.query("UPDATE person SET status = 'discharged', discharged_at = now() WHERE id = $1", [
        resident(6),
      ]),
    );
    expect(
      (await observe(6, { chart: "weight", kg: 60, method: "chair" }, {}, "manager")).status,
    ).toBe(422);
    expect(
      (await note(6, { category: "other", body: "Property returned to family." }, "manager"))
        .status,
    ).toBe(201);
  });
});
