import { createHash } from "node:crypto";
import type {
  AboutMeOut,
  AboutMeShareLinkCreated,
  AboutMeShareLinkList,
  AdmissionDecisionItem,
  AdmissionResult,
  AdmissionView,
  BedBoard,
  BedHistory,
  BreakGlassWeeklyReportList,
  CareNoteItem,
  ExitView,
  HospitalTransferOut,
  KeyIssueOut,
  ObservationItem,
  PersonStatusChangeResult,
  PersonSummary,
  PreAdmissionView,
  ProblemDetails,
  PropertyItemOut,
  PropertyList,
  ReviewSchedule,
  SharingDecisionOut,
  SharingVisibility,
  TransferPack,
  WelcomeChecklist,
} from "@harbour/contracts";
import { createDatabase, createPool } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import { PRE_ADMISSION_SECTIONS, previousBreakGlassReportWeek, ukIsoDate } from "@harbour/domain";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  outboxHandlers,
  raiseReviews,
  relayOutbox,
  reportBreakGlass,
  type TaskDeps,
} from "../src/jobs/tasks";
import { createLogger } from "../src/logger";
import { createHarness, type Harness, LODGE } from "./support/harness";
import { pdfPages, pdfText } from "./support/pdf-text";

/**
 * Slice 8 through the API: the residential people lifecycle (people.md sections 4 and 6). Demo
 * residents 1 to 6 live at Harbour House; the care worker is assigned to residents 1 to 3; the
 * Registered Manager covers Harbour House; the nurse is the clinical lead there (MFA is switched on
 * for them here); the quality lead is tenant-wide. Tests are named with the hazard they verify.
 */

let h: Harness;
let appPool: pg.Pool;
let deps: TaskDeps;

const uid = (prefix: string, n: number) =>
  `0194d000-0000-7000-8${prefix}-${n.toString(16).padStart(12, "0")}`;
const resident = (n: number) => uid("600", n);
const roomId = (n: number) => uid("400", n);
const NEWCOMER = uid("600", 0xa1);
const ENQUIRY = uid("600", 0xa2);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const today = () => ukIsoDate(new Date());
/** dd/mm/yyyy, as the printed pack shows a yyyy-mm-dd date. */
const ukDate = (isoDate: string) => isoDate.split("-").reverse().join("/");
const newId = () => {
  const hex = Date.now().toString(16).padStart(12, "0");
  const rand = crypto.randomUUID().replace(/-/g, "");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-8${rand.slice(3, 6)}-${rand.slice(6, 18)}`;
};

beforeAll(async () => {
  h = await createHarness();
  appPool = createPool(h.db.url("harbour_app"));
  deps = {
    workerPool: h.db.pool("harbour_worker"),
    appDb: createDatabase(appPool),
    logger: createLogger("silent"),
  };
  // The clinical lead has finished MFA enrolment in this file (the harness leaves them without).
  await h.db
    .pool("harbour_auth")
    .query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [h.authIds.nurse]);
  await asDemoTenant(async (c) => {
    await c.query(
      `INSERT INTO person (id, location_id, status, given_name, family_name, date_of_birth)
       VALUES ($1, $3, 'enquiry', 'Iris', 'Newcomer', '1940-05-05'),
              ($2, $3, 'enquiry', 'Jude', 'Enquirer', '1939-03-03')`,
      [NEWCOMER, ENQUIRY, DEMO.locationId],
    );
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await h?.close();
});

const json = async <T>(response: Response) => (await response.json()) as T;
const as = (
  user: keyof Harness["tokens"],
  path: string,
  init: { method?: string; body?: unknown } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const code = async (response: Response) => (await json<ProblemDetails>(response)).code;
const detail = async (response: Response) => (await json<ProblemDetails>(response)).detail ?? "";

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
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function setSessionAge(user: keyof Harness["tokens"], minutes: number) {
  await h.db
    .pool("harbour_auth")
    .query(
      "UPDATE auth.session SET created_at = now() - make_interval(mins => $2) WHERE token = $1",
      [h.tokens[user]?.split(".")[0], minutes],
    );
}

async function summary(personId: string, user: keyof Harness["tokens"] = "manager") {
  return json<PersonSummary>(await as(user, `/v1/people/${personId}`));
}

const status = async (
  personId: string,
  body: Record<string, unknown>,
  user: keyof Harness["tokens"] = "manager",
) =>
  as(user, `/v1/people/${personId}/status`, {
    method: "POST",
    body: {
      effectiveAt: new Date().toISOString(),
      version: (await summary(personId, "owner")).version,
      ...body,
    },
  });

async function drainOutbox() {
  const handlers = outboxHandlers(deps);
  while ((await relayOutbox(deps, handlers)) > 0) {
    // Drain every pending event, as the worker does.
  }
}

async function outboxTypes(aggregateId: string): Promise<string[]> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ event_type: string }>(
      "SELECT event_type FROM outbox_event WHERE aggregate_id = $1 ORDER BY occurred_at",
      [aggregateId],
    );
    return rows.map((r) => r.event_type);
  });
}

async function auditCount(action: string, resourceId: string, outcome = "success") {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_event
       WHERE action = $1 AND resource_id = $2 AND outcome = $3`,
      [action, resourceId, outcome],
    );
    return rows[0]?.n ?? 0;
  });
}

interface TaskRow {
  readonly kind: string;
  readonly status: string;
  readonly cancel_code: string | null;
  readonly evidence_id: string | null;
  readonly evidence_after_close: boolean;
  readonly assignee_role_key: string | null;
  readonly priority: string;
  readonly due_at: Date;
}

async function taskRow(id: string): Promise<TaskRow | undefined> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<TaskRow>(
      `SELECT kind, status, cancel_code, evidence_id, evidence_after_close, assignee_role_key,
         priority, due_at FROM task WHERE id = $1`,
      [id],
    );
    return rows[0];
  });
}

/** Inserts a task for a person as the system would (rounds have a series). */
async function insertTask(
  personId: string,
  kind: string,
  dueAt: Date,
  seriesId: string | null = null,
): Promise<string> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO task (series_id, person_id, location_id, kind, title, required_permission, due_at)
       VALUES ($1, $2, $3, $4, 'Task for the test', 'care.note.write', $5) RETURNING id`,
      [seriesId, personId, DEMO.locationId, kind, dueAt],
    );
    return rows[0]?.id ?? "";
  });
}

async function insertRoundSeries(personId: string): Promise<string> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO task_series (person_id, location_id, kind, title, required_permission,
         recurrence, starts_on, materialised_until)
       VALUES ($1, $2, 'care.reposition', 'Reposition', 'care.note.write',
         '{"freq":"daily","times":["10:00"]}', '2026-09-01', now() + interval '2 days')
       RETURNING id`,
      [personId, DEMO.locationId],
    );
    return rows[0]?.id ?? "";
  });
}

/** A document filed against a person (for ownership checks). */
async function insertDocument(personId: string): Promise<string> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO document (category, title, retention_class, storage_key, content_type,
         size_bytes, sha256, person_id)
       VALUES ('person_document', 'Letter', 'care_record', 'fixture/letter', 'application/pdf', 10,
         repeat('0', 64), $1) RETURNING id`,
      [personId],
    );
    return rows[0]?.id ?? "";
  });
}

// ------------------------------------------------------------------------------------------------

describe("people.md rules 1, 2, 4 and 5: from enquiry to admission", () => {
  let assessmentVersion = 0;
  let decision: AdmissionDecisionItem;

  it("refuses a status change without the permission, and audits the refusal", async () => {
    expect((await status(NEWCOMER, { to: "pre_admission" }, "carer")).status).toBe(403);
    // The clinical lead may record movements but cannot start an assessment.
    const nurse = await status(NEWCOMER, { to: "pre_admission" }, "nurse");
    expect(nurse.status).toBe(403);
    const denied = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event
         WHERE action = 'people.person.status.pre_admission' AND outcome = 'denied'
           AND resource_id = $1`,
        [NEWCOMER],
      ),
    );
    expect(denied.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("refuses a stale version with 409", async () => {
    const stale = await as("manager", `/v1/people/${NEWCOMER}/status`, {
      method: "POST",
      body: { to: "pre_admission", effectiveAt: new Date().toISOString(), version: 99 },
    });
    expect(stale.status).toBe(409);
  });

  it("refuses a change dated in the future", async () => {
    const future = await status(NEWCOMER, {
      to: "pre_admission",
      effectiveAt: new Date(Date.now() + 2 * HOUR).toISOString(),
    });
    expect(future.status).toBe(422);
    expect(await detail(future)).toContain("future");
  });

  it("starts the pre-admission assessment and publishes the event", async () => {
    const started = await status(NEWCOMER, {
      to: "pre_admission",
      serviceId: DEMO.residentialServiceId,
      placementTypeSought: "permanent",
    });
    expect(started.status).toBe(200);
    expect(await json<PersonStatusChangeResult>(started)).toMatchObject({
      status: "pre_admission",
      event: "people.person.assessment_started",
      effects: ["start_pre_admission_assessment"],
    });
    expect(await outboxTypes(NEWCOMER)).toContain("people.person.assessment_started");
    const view = await json<PreAdmissionView>(
      await as("manager", `/v1/people/${NEWCOMER}/pre-admission`),
    );
    expect(view.assessment?.status).toBe("in_progress");
    expect(view.assessment?.completeness.outstanding).toHaveLength(18);
    assessmentVersion = view.assessment?.version ?? 0;
  });

  it("hazard HZ-007 refuses 'not applicable' for allergies, and an unexplained one for equipment", async () => {
    for (const [key, extra] of [
      ["allergies", {}],
      ["equipment", {}],
    ] as const) {
      const refused = await as("manager", `/v1/people/${NEWCOMER}/pre-admission`, {
        method: "PUT",
        body: {
          sections: { [key]: { status: "not_applicable", ...extra } },
          version: assessmentVersion,
        },
      });
      expect(refused.status).toBe(422);
    }
  });

  it("refuses a decision before the assessment is complete", async () => {
    const early = await as("manager", `/v1/people/${NEWCOMER}/admission-decisions`, {
      method: "POST",
      body: { canMeetNeeds: "yes", reasons: "We can meet these needs in full at Harbour House." },
    });
    expect(early.status).toBe(422);
    expect(await detail(early)).toContain("Finish the pre-admission assessment");
  });

  it("completes the assessment, with the medicines list the transfer pack will print", async () => {
    const sections = Object.fromEntries(
      PRE_ADMISSION_SECTIONS.filter((s) => s.required).map((s) => [
        s.key,
        s.key === "equipment"
          ? { status: "not_applicable", notApplicableReason: "Walks without aids" }
          : s.key === "medicines"
            ? {
                status: "complete",
                medicines: [
                  {
                    name: "Co-careldopa",
                    dose: "1 tablet",
                    route: "oral",
                    frequency: "08:00, 12:00, 16:00",
                    timeCritical: true,
                  },
                ],
              }
            : { status: "complete", notes: "Discussed with the person and their daughter." },
      ]),
    );
    const saved = await as("nurse", `/v1/people/${NEWCOMER}/pre-admission`, {
      method: "PUT",
      body: {
        sections,
        informationSources: ["person", "family_or_representative"],
        personInvolvement: { involved: true },
        version: assessmentVersion,
      },
    });
    expect(saved.status).toBe(200);
    const view = await json<PreAdmissionView>(saved);
    expect(view.assessment).toMatchObject({ status: "complete" });
    expect(view.assessment?.completeness.complete).toBe(true);
  });

  it("lets only an admissions manager decide, with conditions", async () => {
    const body = {
      canMeetNeeds: "yes_with_conditions",
      reasons: "We can meet these needs once a pressure-relieving mattress is in place.",
      conditions: ["Pressure-relieving mattress in place"],
      plannedAdmissionOn: today(),
      toldWho: "The person and their daughter",
      toldAt: new Date().toISOString(),
    };
    expect(
      (await as("nurse", `/v1/people/${NEWCOMER}/admission-decisions`, { method: "POST", body }))
        .status,
    ).toBe(403);
    const created = await as("manager", `/v1/people/${NEWCOMER}/admission-decisions`, {
      method: "POST",
      body,
    });
    expect(created.status).toBe(201);
    decision = await json<AdmissionDecisionItem>(created);
    expect(decision).toMatchObject({ admit: true, canMeetNeeds: "yes_with_conditions" });
    expect(decision.conditions).toHaveLength(1);
  });

  it("will not admit through the status route", async () => {
    expect((await status(NEWCOMER, { to: "active" })).status).toBe(422);
  });

  it("waits for every condition to be met before admitting", async () => {
    const admit = {
      serviceId: DEMO.residentialServiceId,
      placementType: "permanent",
      startDate: today(),
      roomId: roomId(7),
      bed: 1,
      admittedAt: new Date().toISOString(),
    };
    const early = await as("manager", `/v1/people/${NEWCOMER}/admission`, {
      method: "POST",
      body: { ...admit, version: (await summary(NEWCOMER, "owner")).version },
    });
    expect(early.status).toBe(422);
    expect(await detail(early)).toContain("condition");
    const condition = decision.conditions[0];
    const met = await as(
      "manager",
      `/v1/people/${NEWCOMER}/admission-decisions/${decision.id}/conditions/${condition?.id}/met`,
      { method: "POST", body: { version: condition?.version } },
    );
    expect(met.status).toBe(200);
    const admitted = await as("manager", `/v1/people/${NEWCOMER}/admission`, {
      method: "POST",
      body: { ...admit, version: (await summary(NEWCOMER, "owner")).version },
    });
    expect(admitted.status).toBe(201);
    const result = await json<AdmissionResult>(admitted);
    expect(result.status).toBe("active");
    expect(result.bed).toMatchObject({ roomId: roomId(7), bed: 1, from: today() });
    expect(result.placement.admissionDecisionId).toBe(decision.id);
    // Safety-critical welcome items come first and are outstanding.
    expect(result.welcomeChecklist.safetyCriticalOutstanding).toEqual([
      "photo_taken",
      "allergies_confirmed",
      "medicines_received_and_checked",
      "diet_and_textures_shared_with_kitchen",
      "evacuation_plan_completed",
    ]);
    expect(await outboxTypes(NEWCOMER)).toContain("people.person.admitted");
  });

  it("hazard HZ-001 shows the room from the bed history on the header", async () => {
    expect((await summary(NEWCOMER)).roomLabel).toBe("7");
    const history = await json<BedHistory>(await as("manager", `/v1/people/${NEWCOMER}/bed-moves`));
    expect(history.roomLabel).toBe("7");
  });

  it("hazard HZ-007 ticks the welcome checklist, refusing 'not applicable' for allergies and a stale version", async () => {
    const checklist = await json<WelcomeChecklist>(
      await as("nurse", `/v1/people/${NEWCOMER}/welcome-checklist`),
    );
    const allergies = checklist.items.find((i) => i.key === "allergies_confirmed");
    const path = `/v1/people/${NEWCOMER}/welcome-checklist/allergies_confirmed`;
    const notApplicable = await as("nurse", path, {
      method: "PUT",
      body: { status: "not_applicable", reason: "Not asked", version: allergies?.version },
    });
    expect(notApplicable.status).toBe(422);
    const done = await as("nurse", path, {
      method: "PUT",
      body: { status: "done", version: allergies?.version },
    });
    expect(done.status).toBe(200);
    expect((await json<WelcomeChecklist>(done)).safetyCriticalOutstanding).not.toContain(
      "allergies_confirmed",
    );
    const stale = await as("nurse", path, {
      method: "PUT",
      body: { status: "pending", version: allergies?.version },
    });
    expect(stale.status).toBe(409);
  });

  it("refuses a weakened welcome checklist template", async () => {
    const weakened = await as("owner", "/v1/settings/welcome-checklist", {
      method: "PUT",
      body: {
        items: [
          {
            key: "photo_taken",
            title: "Photo",
            required: true,
            safetyCritical: true,
            allowNotApplicable: true,
          },
        ],
        version: 0,
      },
    });
    expect(weakened.status).toBe(422);
    expect(await detail(weakened)).toContain("allergies_confirmed");
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rule 6: beds, moves and the bed board", () => {
  it("moves a person, closing the old period on the day of the move", async () => {
    const moved = await as("manager", `/v1/people/${resident(1)}/bed-moves`, {
      method: "POST",
      body: {
        roomId: roomId(9),
        bed: 1,
        on: today(),
        reason: "Moved nearer the lounge at their request",
        version: (await summary(resident(1))).version,
      },
    });
    expect(moved.status).toBe(201);
    const history = await json<BedHistory>(moved);
    expect(history.roomLabel).toBe("9");
    expect(history.items.map((i) => [i.roomLabel, i.from, i.to])).toEqual([
      ["1", "2026-09-01", today()],
      ["9", today(), null],
    ]);
    expect((await summary(resident(1))).roomLabel).toBe("9");
  });

  it.each([
    ["into an occupied bed", { roomId: roomId(2), on: undefined }, "Someone else"],
    ["in the future", { roomId: roomId(10), on: "2099-01-01" }, "Record a move on the day"],
    ["without a reason", { roomId: roomId(10), reason: "" }, "reason"],
  ])("refuses a move %s", async (_label, change, words) => {
    const response = await as("manager", `/v1/people/${resident(3)}/bed-moves`, {
      method: "POST",
      body: {
        bed: 1,
        on: today(),
        reason: "Room swap",
        version: (await summary(resident(3))).version,
        ...Object.fromEntries(Object.entries(change).filter(([, v]) => v !== undefined)),
      },
    });
    expect(response.status).toBe(422);
    expect(await detail(response)).toContain(words);
  });

  it("refuses a move to someone without the admissions permission", async () => {
    const response = await as("nurse", `/v1/people/${resident(3)}/bed-moves`, {
      method: "POST",
      body: {
        roomId: roomId(10),
        bed: 1,
        on: today(),
        reason: "Room swap",
        version: (await summary(resident(3))).version,
      },
    });
    expect(response.status).toBe(403);
  });

  it("hazard HZ-011 shows every occupied bed but names only the people in the reader's access", async () => {
    const manager = await json<BedBoard>(
      await as("manager", `/v1/locations/${DEMO.locationId}/beds`),
    );
    const room7 = manager.rooms.find((r) => r.label === "7");
    expect(room7?.beds[0]).toMatchObject({ occupied: true, personId: NEWCOMER });
    const carer = await json<BedBoard>(await as("carer", `/v1/locations/${DEMO.locationId}/beds`));
    const carerRoom7 = carer.rooms.find((r) => r.label === "7");
    expect(carerRoom7?.beds[0]).toMatchObject({ occupied: true, personId: null, name: null });
    const carerRoom2 = carer.rooms.find((r) => r.label === "2");
    expect(carerRoom2?.beds[0]?.personId).toBe(resident(2));
  });

  it("hazard HZ-011 refuses a room, its bed board and its clearance to a caller who works elsewhere", async () => {
    const lodgeRoom = uid("400", 0x99);
    await asDemoTenant((c) =>
      c.query(
        "INSERT INTO room (id, location_id, label, status) VALUES ($1, $2, 'L1', 'awaiting_clearance')",
        [lodgeRoom, LODGE.locationId],
      ),
    );
    // The Registered Manager covers Harbour House only; the room is at Harbour Lodge.
    const move = await as("manager", `/v1/people/${resident(3)}/bed-moves`, {
      method: "POST",
      body: {
        roomId: lodgeRoom,
        bed: 1,
        on: today(),
        reason: "Room swap",
        version: (await summary(resident(3))).version,
      },
    });
    expect(move.status).toBe(422);
    expect(await detail(move)).toContain("The room was not found");
    expect((await as("manager", `/v1/locations/${LODGE.locationId}/beds`)).status).toBe(404);
    const clearance = await as("manager", `/v1/rooms/${lodgeRoom}/clearance`, {
      method: "POST",
      body: { on: today(), version: 1 },
    });
    expect(clearance.status).toBe(404);
    const room = await asDemoTenant((c) =>
      c.query<{ status: string }>("SELECT status FROM room WHERE id = $1", [lodgeRoom]),
    );
    expect(room.rows[0]?.status).toBe("awaiting_clearance");
    // Someone who works at the lodge sees its board.
    expect((await as("quality", `/v1/locations/${LODGE.locationId}/beds`)).status).toBe(200);
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rule 7: property and keys", () => {
  let hearingAid: PropertyItemOut;

  it("records an item once, replaying a device id without a second copy", async () => {
    const id = newId();
    const body = {
      id,
      description: "Hearing aid (left), beige case",
      category: "sensory_aid",
      quantity: 1,
      receivedOn: "2026-09-01",
      acknowledgement: { signer: "person", name: "Signed by the person", signedAt: ago(DAY) },
    };
    const first = await as("nurse", `/v1/people/${resident(1)}/property`, { method: "POST", body });
    expect(first.status).toBe(201);
    hearingAid = await json<PropertyItemOut>(first);
    const replay = await as("nurse", `/v1/people/${resident(1)}/property`, {
      method: "POST",
      body,
    });
    expect(replay.status).toBe(201);
    expect((await json<PropertyItemOut>(replay)).id).toBe(id);
    // The replay returned the stored record, so it is audited as a view of it.
    expect(await auditCount("people.property.view", id)).toBe(1);
    const list = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    expect(list.items.filter((i) => i.id === id)).toHaveLength(1);
    expect(list.toSendWithPerson).toContain(id);
  });

  it.each([
    ["cash", { category: "Cash" }, "residents' money ledger"],
    ["a valuable without a witness", { category: "jewellery" }, "witness"],
    [
      "a witness who is the recorder",
      { category: "watch", witnessedBy: DEMO.users.nurse.id },
      "different member",
    ],
    [
      "nobody signing without a reason",
      { acknowledgement: { signer: "unable_to_sign", signedAt: ago(HOUR) } },
      "nobody could sign",
    ],
  ])("refuses %s", async (_label, change, words) => {
    const response = await as("nurse", `/v1/people/${resident(1)}/property`, {
      method: "POST",
      body: {
        description: "Item for the inventory",
        category: "clothing",
        quantity: 1,
        receivedOn: today(),
        acknowledgement: { signer: "person", name: "Signed", signedAt: ago(HOUR) },
        ...change,
      },
    });
    expect(response.status).toBe(422);
    expect(await detail(response)).toContain(words);
  });

  it("refuses property to a care worker, and hides people outside their scope", async () => {
    const body = {
      description: "Cardigan",
      category: "clothing",
      quantity: 1,
      receivedOn: today(),
      acknowledgement: { signer: "person", name: "Signed", signedAt: ago(HOUR) },
    };
    expect(
      (await as("carer", `/v1/people/${resident(1)}/property`, { method: "POST", body })).status,
    ).toBe(403);
    expect((await as("carer", `/v1/people/${resident(4)}/property`)).status).toBe(404);
  });

  it("issues and returns a key once", async () => {
    const issued = await as("nurse", `/v1/people/${resident(1)}/keys`, {
      method: "POST",
      body: { label: "Room 9 key", issuedOn: today(), issuedTo: "person" },
    });
    expect(issued.status).toBe(201);
    const key = await json<KeyIssueOut>(issued);
    const path = `/v1/people/${resident(1)}/keys/${key.id}/return`;
    const returned = await as("nurse", path, {
      method: "POST",
      body: { on: today(), version: key.version },
    });
    expect(returned.status).toBe(200);
    expect((await json<KeyIssueOut>(returned)).outstanding).toBe(false);
    const again = await as("nurse", path, {
      method: "POST",
      body: { on: today(), version: key.version + 1 },
    });
    expect(again.status).toBe(422);
  });

  it("keeps the hearing aid for the transfer test", () => {
    expect(hearingAid.status).toBe("held");
  });
});

// ------------------------------------------------------------------------------------------------

describe("hazard HZ-023 the hospital transfer pack and the transfer", () => {
  let transfer: HospitalTransferOut;
  let roundTask = "";
  /** A round due as the person left, answered offline just before (HZ-006). */
  let leavingTask = "";
  let left = new Date();

  /** Sends a person to hospital now, with nothing sent with them. */
  const sendToHospital = async (personId: string) => {
    const created = await as("nurse", `/v1/people/${personId}/hospital-transfers`, {
      method: "POST",
      body: {
        leftAt: new Date().toISOString(),
        hospitalName: "Example General Hospital",
        reason: "Short of breath since the morning.",
        sendItemIds: [],
        version: (await summary(personId)).version,
      },
    });
    expect(created.status).toBe(201);
    return json<HospitalTransferOut>(created);
  };

  const printPack = async (personId: string, transferId: string) => {
    const pdf = await as("nurse", `/v1/people/${personId}/hospital-transfers/${transferId}/pdf`);
    expect(pdf.status).toBe(200);
    return new Uint8Array(await pdf.arrayBuffer());
  };

  const recordReturn = async (personId: string, sent: HospitalTransferOut) => {
    const returned = await as(
      "nurse",
      `/v1/people/${personId}/hospital-transfers/${sent.id}/return`,
      { method: "POST", body: { returnedAt: new Date().toISOString(), version: sent.version } },
    );
    expect(returned.status).toBe(200);
  };

  it("hazard HZ-023 previews the pack with every missing safety-critical section flagged", async () => {
    const preview = await as("nurse", `/v1/people/${resident(1)}/transfer-pack`);
    expect(preview.status).toBe(200);
    const pack = await json<TransferPack>(preview);
    // Ada has allergies and communication needs recorded; no photo, medicines list,
    // resuscitation record, About Me or IDDSI levels (safety-critical, HZ-016).
    expect(pack.missingCritical).toEqual([
      "photo",
      "medicines",
      "resuscitation",
      "about_me",
      "eating_and_drinking",
    ]);
    expect(pack.sections.find((s) => s.key === "allergies")?.status).toBe("included");
    expect(pack.complete).toBe(false);
  });

  it("hazard HZ-023 previews with the reason and the items to send in the body, never the URL", async () => {
    const list = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    const preview = await as("nurse", `/v1/people/${resident(1)}/transfer-pack`, {
      method: "POST",
      body: { reason: "Fall at 07:30; hip pain.", sendItemIds: list.toSendWithPerson },
    });
    expect(preview.status).toBe(200);
    const pack = await json<TransferPack>(preview);
    expect(pack.content.reasonForTransfer).toBe("Fall at 07:30; hip pain.");
    expect((pack.content.itemsSent as { id: string }[]).map((i) => i.id)).toEqual(
      list.toSendWithPerson,
    );
    // The preview is audited by person; the reason is not written to the audit trail.
    const audited = await asDemoTenant((c) =>
      c.query<{ scope: unknown }>(
        `SELECT scope FROM audit_event WHERE action = 'people.transfer_pack.preview'
         AND resource_id = $1`,
        [resident(1)],
      ),
    );
    expect(audited.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(audited.rows)).not.toContain("hip pain");
  });

  it.each([
    ["an item that does not exist", () => newId(), "not found in this person's property"],
    ["another person's item", () => "", "not found in this person's property"],
  ])("hazard HZ-001 refuses to send %s with the person (422)", async (_label, make, words) => {
    let itemId = make();
    if (!itemId) {
      const other = await json<PropertyItemOut>(
        await as("nurse", `/v1/people/${resident(2)}/property`, {
          method: "POST",
          body: {
            description: "Glasses in a blue case",
            category: "sensory_aid",
            quantity: 1,
            receivedOn: "2026-09-01",
            acknowledgement: { signer: "person", name: "Signed", signedAt: ago(DAY) },
          },
        }),
      );
      itemId = other.id;
    }
    for (const response of [
      await as("nurse", `/v1/people/${resident(1)}/transfer-pack`, {
        method: "POST",
        body: { sendItemIds: [itemId] },
      }),
      await as("nurse", `/v1/people/${resident(1)}/hospital-transfers`, {
        method: "POST",
        body: {
          leftAt: ago(MIN),
          hospitalName: "Example General Hospital",
          sendItemIds: [itemId],
          version: (await summary(resident(1))).version,
        },
      }),
    ]) {
      expect(response.status).toBe(422);
      expect(await detail(response)).toContain(words);
    }
    expect((await summary(resident(1))).status).toBe("active");
  });

  it("hazard HZ-023 marks a medicines list from the pre-admission assessment as needing checking against the MAR", async () => {
    const pack = await json<TransferPack>(
      await as("nurse", `/v1/people/${NEWCOMER}/transfer-pack`),
    );
    expect(pack.missingCritical).not.toContain("medicines");
    expect(pack.content.medicines).toMatchObject({
      status: "recorded",
      source: "pre_admission_assessment",
      items: [{ name: "Co-careldopa", timeCritical: true }],
    });
    expect(pack.attention?.map((a) => a.code)).toContain("medicines_need_checking");
  });

  it("hazard HZ-001 refuses a pack when a section belongs to someone else", async () => {
    await asDemoTenant(async (c) => {
      const doc = await c.query<{ id: string }>(
        `INSERT INTO document (category, title, retention_class, storage_key, content_type,
           size_bytes, sha256, person_id)
         VALUES ('person_photo', 'Photo', 'care_record', 'fixture/photo', 'image/jpeg', 10,
           repeat('0', 64), $1) RETURNING id`,
        [resident(3)],
      );
      await c.query("UPDATE person SET photo_document_id = $1 WHERE id = $2", [
        doc.rows[0]?.id,
        resident(2),
      ]);
    });
    const refused = await as("manager", `/v1/people/${resident(2)}/transfer-pack`);
    expect(refused.status).toBe(422);
    expect(await code(refused)).toBe("transfer_pack_wrong_person");
    await asDemoTenant((c) =>
      c.query("UPDATE person SET photo_document_id = NULL WHERE id = $1", [resident(2)]),
    );
  });

  it("hazard HZ-023 refuses a pack for someone not receiving care", async () => {
    const refused = await as("manager", `/v1/people/${ENQUIRY}/transfer-pack`);
    expect(refused.status).toBe(422);
    expect(await code(refused)).toBe("transfer_pack_not_receiving_care");
  });

  it("hazard HZ-015 prints the current resuscitation record in the pack", async () => {
    const completedOn = ukIsoDate(new Date(Date.now() - DAY));
    const recorded = await as("manager", `/v1/people/${resident(2)}/advance-care`, {
      method: "POST",
      body: { kind: "dnacpr", clinicianName: "Dr Example", clinicianRole: "GP", completedOn },
    });
    expect(recorded.status).toBe(201);
    const pack = await json<TransferPack>(
      await as("manager", `/v1/people/${resident(2)}/transfer-pack`),
    );
    expect(pack.missingCritical).not.toContain("resuscitation");
    expect(pack.sections.find((s) => s.key === "resuscitation")?.status).toBe("included");
    expect(pack.content.resuscitation).toMatchObject({
      status: "recorded",
      decision: "do_not_attempt_cpr",
      conflicting: false,
      reviewOverdue: false,
      cprRecords: [
        {
          kind: "dnacpr",
          summary: "Not for cardiopulmonary resuscitation",
          clinician: "Dr Example, GP",
          active: true,
        },
      ],
    });
    // What the hospital reads: the decision in force and the record it comes from.
    const sent = await sendToHospital(resident(2));
    const text = pdfText(await printPack(resident(2), sent.id));
    expect(text).toContain("CPR decision: Not for cardiopulmonary resuscitation.");
    expect(text).toContain(
      `DNACPR: Not for cardiopulmonary resuscitation. Dr Example, GP. Completed ${ukDate(completedOn)}.`,
    );
    expect(text).not.toContain("THE RECORDS DISAGREE");
    await recordReturn(resident(2), sent);
  });

  it("hazard HZ-015 prints ReSPECT and DNACPR that disagree, and an overdue review, on the first page", async () => {
    const completedOn = ukIsoDate(new Date(Date.now() - DAY));
    const respect = await as("manager", `/v1/people/${resident(2)}/advance-care`, {
      method: "POST",
      body: {
        kind: "respect",
        cprDecision: "attempt_cpr",
        clinicianName: "Dr Other",
        clinicianRole: "Consultant",
        completedOn,
        reviewDueOn: completedOn,
      },
    });
    expect(respect.status).toBe(201);
    const sent = await sendToHospital(resident(2));
    expect(sent.pack.attention?.filter((a) => a.key === "resuscitation")).toMatchObject([
      { code: "resuscitation_conflict", acknowledge: true },
      { code: "resuscitation_review_overdue", onDate: completedOn },
    ]);
    const pages = pdfPages(await printPack(resident(2), sent.id));
    const first = (pages[0] ?? []).join(" ");
    expect(first).toContain("CHECK BEFORE RELYING ON THIS PACK");
    expect(first).toContain("The resuscitation records disagree.");
    expect(first).toContain(
      `The resuscitation decision is past its review date. (${ukDate(completedOn)})`,
    );
    const text = pages.flat().join("\n");
    expect(text).toContain(
      "CPR decision: THE RECORDS DISAGREE. Check the original documents. Both are listed.",
    );
    expect(text).toContain("ReSPECT: For cardiopulmonary resuscitation.");
    expect(text).toContain("DNACPR: Not for cardiopulmonary resuscitation.");
    // A conflict is handed over only with a named acknowledgement.
    const path = `/v1/people/${resident(2)}/hospital-transfers/${sent.id}/handover`;
    const bare = await as("nurse", path, { method: "POST", body: { version: sent.version } });
    expect(bare.status).toBe(422);
    expect(await detail(bare)).toContain("resuscitation_conflict");
    const acknowledged = await as("nurse", path, {
      method: "POST",
      body: {
        acknowledgementReason: "Told the paramedic both forms are with the person; GP to confirm.",
        version: sent.version,
      },
    });
    expect(acknowledged.status).toBe(200);
    await recordReturn(resident(2), await json<HospitalTransferOut>(acknowledged));
  });

  it("sends the person to hospital with the pack, pausing rounds and keeping the bed", async () => {
    left = new Date(Date.now() - 10 * MIN);
    const series = await insertRoundSeries(resident(1));
    roundTask = await insertTask(
      resident(1),
      "care.reposition",
      new Date(Date.now() + 3 * HOUR),
      series,
    );
    // Due at the minute the person left: still open on a device that recorded it offline.
    leavingTask = await insertTask(resident(1), "care.reposition", left, series);
    const id = newId();
    const body = {
      id,
      leftAt: left.toISOString(),
      hospitalName: "Example General Hospital",
      reason: "Fall at 07:30; hip pain; unable to weight-bear.",
      sendItemIds: [] as string[],
      version: (await summary(resident(1))).version,
    };
    const list = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    body.sendItemIds = list.toSendWithPerson;
    const created = await as("nurse", `/v1/people/${resident(1)}/hospital-transfers`, {
      method: "POST",
      body,
    });
    expect(created.status).toBe(201);
    transfer = await json<HospitalTransferOut>(created);
    expect(transfer.missingCritical).toEqual([
      "photo",
      "medicines",
      "resuscitation",
      "about_me",
      "eating_and_drinking",
    ]);
    expect(transfer.itemsSent).toEqual(list.toSendWithPerson);
    const person = await summary(resident(1));
    expect(person.status).toBe("in_hospital");
    expect(person.roomLabel).toBe("9");
    const after = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    expect(after.items.find((i) => i.id === list.toSendWithPerson[0])?.status).toBe(
      "sent_with_person",
    );
    expect(await taskRow(roundTask)).toMatchObject({
      status: "cancelled",
      cancel_code: "paused_while_away",
    });
    expect((await taskRow(leavingTask))?.status).toBe("cancelled");
    // A replay with the same id returns the first copy without a second move, and is audited.
    const replay = await as("nurse", `/v1/people/${resident(1)}/hospital-transfers`, {
      method: "POST",
      body,
    });
    expect(replay.status).toBe(201);
    expect((await json<HospitalTransferOut>(replay)).id).toBe(transfer.id);
    expect(await auditCount("people.hospital_transfer.view", transfer.id)).toBe(1);
  });

  it("hazard HZ-023 prints not recorded on the first page for each missing critical section", async () => {
    const pdf = await as(
      "nurse",
      `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/pdf`,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    // Nothing in the file may run or load: it is a document, never a page.
    expect(pdf.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(pdf.headers.get("cache-control")).toContain("no-store");
    const bytes = new Uint8Array(await pdf.arrayBuffer());
    expect(Buffer.from(bytes.subarray(0, 8)).toString("latin1")).toBe("%PDF-1.7");
    const pages = pdfPages(bytes);
    const first = pages[0] ?? [];
    expect(first).toContain("NOT RECORDED: safety-critical information missing from the record");
    for (const line of [
      "Photo: not recorded or cannot be printed. Confirm identity another way.",
      "Medicines: not recorded since admission. Check the MAR.",
      "Resuscitation (CPR decision): not recorded.",
      "About Me: not recorded",
      "Eating and drinking (IDDSI levels): not recorded",
    ]) {
      expect(first).toContain(line);
    }
    // The person's identity is on every page.
    for (const lines of pages) expect(lines.join(" ")).toContain("EXAMPLE, Ada");
    // Printing is a disclosure, audited with its recipient; care workers cannot print.
    expect(await auditCount("people.transfer_pack.print", transfer.id)).toBeGreaterThanOrEqual(1);
    const carer = await as(
      "carer",
      `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/pdf`,
    );
    expect(carer.status).toBe(403);
  });

  it("hazard HZ-023 records the hand-over of an incomplete pack only with a named acknowledgement", async () => {
    const path = `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/handover`;
    const bare = await as("nurse", path, { method: "POST", body: { version: transfer.version } });
    expect(bare.status).toBe(422);
    expect(await code(bare)).toBe("transfer_pack_acknowledgement_required");
    const acknowledged = await as("nurse", path, {
      method: "POST",
      body: {
        acknowledgementReason: "Emergency transfer; the GP is sending the medicines list.",
        version: transfer.version,
      },
    });
    expect(acknowledged.status).toBe(200);
    transfer = await json<HospitalTransferOut>(acknowledged);
    expect(transfer.acknowledgement).toMatchObject({ by: DEMO.users.nurse.id });
    expect(await outboxTypes(transfer.id)).toContain("people.transfer_pack.handed_over");
  });

  it("hazard HZ-006 accepts an observation from before the transfer, flagged, and refuses a later one", async () => {
    const path = `/v1/people/${resident(1)}/observations`;
    const before = await as("nurse", path, {
      method: "POST",
      body: { occurredAt: ago(30 * MIN), values: { chart: "weight", kg: 61, method: "chair" } },
    });
    expect(before.status).toBe(201);
    expect((await json<ObservationItem>(before)).recordedAfterExit).toBe(true);
    const after = await as("nurse", path, {
      method: "POST",
      body: { occurredAt: ago(MIN), values: { chart: "weight", kg: 61, method: "chair" } },
    });
    expect(after.status).toBe(422);
    expect(await code(after)).toBe("care_event_after_exit");
  });

  it("hazard HZ-006 accepts an entry within the clock tolerance after the move, flagged, and gives a later one to the nurse in charge to review", async () => {
    const path = `/v1/people/${resident(1)}/observations`;
    // Three minutes after the person left: within sync.clock_drift_flag_minutes (a fast clock).
    const within = await as("nurse", path, {
      method: "POST",
      body: {
        occurredAt: new Date(left.getTime() + 3 * MIN).toISOString(),
        values: { chart: "weight", kg: 61, method: "chair" },
      },
    });
    expect(within.status).toBe(201);
    expect((await json<ObservationItem>(within)).recordedAfterExit).toBe(true);
    const reviews = await asDemoTenant((c) =>
      c.query<{ status: string; assignee_role_key: string; priority: string }>(
        `SELECT status, assignee_role_key, priority FROM task
         WHERE kind = 'people.late_entry_review' AND person_id = $1`,
        [resident(1)],
      ),
    );
    // One open review for the refused entry above, however many entries were refused.
    expect(reviews.rows).toEqual([
      { status: "open", assignee_role_key: "clinical_lead", priority: "urgent" },
    ]);
    const refusals = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event
         WHERE action = 'care.entry.after_exit' AND outcome = 'denied' AND resource_id = $1`,
        [resident(1)],
      ),
    );
    expect(refusals.rows[0]?.n).toBeGreaterThanOrEqual(1);
  });

  it("hazard HZ-006 keeps an entry recorded offline at 10:05 for the 10:10 round when the person left at 10:10 and it uploads at 10:15", async () => {
    // The entry happened five minutes before the person left and names the round it answers; the
    // transfer cancelled that round before the device came back online.
    const uploaded = await as("nurse", `/v1/people/${resident(1)}/observations`, {
      method: "POST",
      body: {
        id: newId(),
        occurredAt: new Date(left.getTime() - 5 * MIN).toISOString(),
        taskId: leavingTask,
        values: { chart: "repositioning", position: "left", skinChecked: true },
      },
    });
    expect(uploaded.status).toBe(201);
    const entry = await json<ObservationItem>(uploaded);
    expect(entry.recordedAfterExit).toBe(true);
    expect(entry.taskOutcome).toBe("task_cancelled");
    // Linked and flagged; the round stays cancelled while the person is away.
    expect(await taskRow(leavingTask)).toMatchObject({
      status: "cancelled",
      evidence_id: entry.id,
      evidence_after_close: true,
    });
  });

  it("hazards HZ-003 and HZ-023 record the return: rounds resume, the checks come up as tasks with an owner and a due time, and the care plan review comes forward", async () => {
    const returned = await as(
      "nurse",
      `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/return`,
      { method: "POST", body: { returnedAt: new Date().toISOString(), version: transfer.version } },
    );
    expect(returned.status).toBe(200);
    transfer = await json<HospitalTransferOut>(returned);
    expect(transfer.returnedAt).not.toBeNull();
    expect(transfer.returnChecks.map((c) => c.key)).toEqual([
      "skin_checked",
      "allergies_rechecked",
      "belongings_returned",
      "medicines_reconciled",
      "discharge_letter_filed",
      "resuscitation_rechecked",
      "eating_and_drinking_rechecked",
    ]);
    // Each check is a task with an owner and a due time, which the task engine escalates.
    for (const check of transfer.returnChecks) {
      expect(check.taskId, check.key).not.toBeNull();
      const row = await taskRow(check.taskId ?? "");
      expect(row).toMatchObject({
        kind: `people.return_check.${check.key}`,
        status: "open",
        assignee_role_key: "clinical_lead",
      });
      expect(row?.due_at.toISOString()).toBe(check.dueAt);
      expect(new Date(check.dueAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
    }
    expect(
      (
        await taskRow(
          transfer.returnChecks.find((c) => c.key === "allergies_rechecked")?.taskId ?? "",
        )
      )?.priority,
    ).toBe("urgent");
    expect((await summary(resident(1))).status).toBe("active");
    expect(await taskRow(roundTask)).toMatchObject({ status: "open", cancel_code: null });
    const reviews = await json<ReviewSchedule>(
      await as("nurse", `/v1/people/${resident(1)}/reviews`),
    );
    expect(reviews.changes.map((c) => c.kind)).toContain("return_from_hospital");
    expect(reviews.items.map((i) => i.kind)).toContain("care_plan_review_on_change");
  });

  it("checks the belongings back in", async () => {
    const done = await as(
      "nurse",
      `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/return-checks/belongings_returned`,
      { method: "POST", body: { version: transfer.version } },
    );
    expect(done.status).toBe(200);
    const out = await json<HospitalTransferOut>(done);
    expect(out.returnChecks.find((c) => c.key === "belongings_returned")?.doneBy).toBe(
      DEMO.users.nurse.id,
    );
    transfer = out;
    const list = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    expect(list.items.every((i) => i.status !== "sent_with_person")).toBe(true);
  });

  it.each(["__proto__", "constructor", "toString"])(
    "answers a return check named %s as not found",
    async (key) => {
      const response = await as(
        "nurse",
        `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/return-checks/${key}`,
        { method: "POST", body: { version: transfer.version } },
      );
      expect(response.status).toBe(404);
    },
  );
});

// ------------------------------------------------------------------------------------------------

describe("hazard HZ-023 communication needs: an empty list is not 'none'", () => {
  it("serves 'not recorded' for an empty list until someone confirms there are none", async () => {
    const ben = await summary(resident(2));
    expect(ben).toMatchObject({ communicationNeeds: [], communicationNeedsStatus: "not_recorded" });
    const refused = await as("manager", `/v1/people/${resident(2)}/communication-needs`, {
      method: "PUT",
      body: { needs: [], status: "recorded", version: ben.version },
    });
    expect(refused.status).toBe(422);
    const confirmed = await as("manager", `/v1/people/${resident(2)}/communication-needs`, {
      method: "PUT",
      body: { needs: [], status: "none_identified", version: ben.version },
    });
    expect(confirmed.status).toBe(200);
    expect(await json<PersonSummary>(confirmed)).toMatchObject({
      communicationNeedsStatus: "none_identified",
      communicationNeedsConfirmedBy: DEMO.users.manager.id,
    });
    const pack = await json<TransferPack>(
      await as("manager", `/v1/people/${resident(2)}/transfer-pack`),
    );
    expect(pack.missingCritical).not.toContain("communication");
  });

  it("serves 'recorded' where the needs are listed", async () => {
    expect((await summary(resident(1))).communicationNeedsStatus).toBe("recorded");
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rule 9: About Me", () => {
  it("needs the supporter's name when the person did not write it alone, and a current version", async () => {
    const path = `/v1/people/${resident(2)}/about-me`;
    const sections = { what_is_most_important_to_me: { text: "My garden and my grandchildren." } };
    const unsupported = await as("nurse", path, {
      method: "PUT",
      body: { sections, authoredByPerson: false, version: 0 },
    });
    expect(unsupported.status).toBe(422);
    const saved = await as("nurse", path, {
      method: "PUT",
      body: {
        sections: { ...sections, supported_to_write_this_by: "Key worker" },
        authoredByPerson: false,
        version: 0,
      },
    });
    expect(saved.status).toBe(200);
    const out = await json<AboutMeOut>(saved);
    expect(out.summary.filled).toEqual(["what_is_most_important_to_me"]);
    expect(out.summary.dateLastUpdated).not.toBeNull();
    const stale = await as("nurse", path, {
      method: "PUT",
      body: { sections, authoredByPerson: true, version: 0 },
    });
    expect(stale.status).toBe(409);
  });
});

// ------------------------------------------------------------------------------------------------

describe("hazard HZ-022 sharing is closed by default", () => {
  let contactId = "";
  let decision: SharingDecisionOut;

  const visibility = async (personId: string, query: string) =>
    json<SharingVisibility>(
      await as("manager", `/v1/people/${personId}/sharing-decisions/visibility?${query}`),
    );

  it("hazard HZ-022 shows a family member nothing without a decision in force", async () => {
    contactId = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM contact WHERE person_id = $1 LIMIT 1",
        [resident(3)],
      );
      return rows[0]?.id ?? "";
    });
    const seen = await visibility(resident(3), `contactId=${contactId}`);
    expect(seen.sections.every((s) => !s.visible && s.reason === "no_decision")).toBe(true);
  });

  it("hazard HZ-022 refuses a decision without a valid basis", async () => {
    const base = {
      recipient: { kind: "family", contactId },
      sections: ["daily_updates"],
      validTo: new Date(Date.now() + 30 * DAY).toISOString(),
    };
    for (const body of [
      { ...base, basis: "direct_care" },
      { ...base, basis: "consent" },
      { ...base, basis: "best_interests" },
    ]) {
      const refused = await as("manager", `/v1/people/${resident(3)}/sharing-decisions`, {
        method: "POST",
        body,
      });
      expect(refused.status).toBe(422);
    }
  });

  it("refuses sharing decisions to anyone without people.sharing.manage", async () => {
    for (const user of ["carer", "nurse", "quality"] as const) {
      expect((await as(user, `/v1/people/${resident(3)}/sharing-decisions`)).status).toBe(403);
    }
  });

  it("hazard HZ-022 treats managing sharing as care-record access: MFA first", async () => {
    const auth = h.db.pool("harbour_auth");
    await auth.query("UPDATE auth.user SET two_factor_enabled = false WHERE id = $1", [
      h.authIds.manager,
    ]);
    try {
      const refused = await as("manager", `/v1/people/${resident(3)}/sharing-decisions`);
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe("mfa_enrolment_required");
    } finally {
      await auth.query("UPDATE auth.user SET two_factor_enabled = true WHERE id = $1", [
        h.authIds.manager,
      ]);
    }
    expect((await as("manager", `/v1/people/${resident(3)}/sharing-decisions`)).status).toBe(200);
  });

  it("hazard HZ-022 opens only the sections a decision in force covers", async () => {
    const created = await as("manager", `/v1/people/${resident(3)}/sharing-decisions`, {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId },
        sections: ["daily_updates", "about_me"],
        basis: "consent",
        consentGivenBy: "person",
        validTo: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    expect(created.status).toBe(201);
    decision = await json<SharingDecisionOut>(created);
    expect(decision.inForce).toBe(true);
    const seen = await visibility(resident(3), `contactId=${contactId}`);
    expect(seen.sections.filter((s) => s.visible).map((s) => s.section)).toEqual([
      "about_me",
      "daily_updates",
    ]);
    expect(seen.sections.find((s) => s.section === "medicines")?.reason).toBe(
      "section_not_covered",
    );
  });

  it("hazard HZ-022 closes the sections once the decision expires", async () => {
    await asDemoTenant((c) =>
      c.query(
        "UPDATE sharing_decision SET valid_from = now() - interval '2 days', valid_to = now() - interval '1 minute' WHERE id = $1",
        [decision.id],
      ),
    );
    const seen = await visibility(resident(3), `contactId=${contactId}`);
    expect(seen.sections.every((s) => !s.visible)).toBe(true);
    expect(seen.sections.find((s) => s.section === "about_me")?.reason).toBe("expired");
  });

  it("hazard HZ-022 withdrawing or suspending a decision closes the section on the next request", async () => {
    const make = async (section: "photos" | "activities_and_visits") =>
      json<SharingDecisionOut>(
        await as("manager", `/v1/people/${resident(3)}/sharing-decisions`, {
          method: "POST",
          body: {
            recipient: { kind: "family", contactId },
            sections: [section],
            basis: "consent",
            consentGivenBy: "person",
            validTo: new Date(Date.now() + 30 * DAY).toISOString(),
          },
        }),
      );
    for (const [how, section] of [
      ["withdraw", "photos"],
      ["suspend", "activities_and_visits"],
    ] as const) {
      const d = await make(section);
      const closed = await as(
        "manager",
        `/v1/people/${resident(3)}/sharing-decisions/${d.id}/${how}`,
        { method: "POST", body: { reason: "Safeguarding enquiry open", version: d.version } },
      );
      expect(closed.status).toBe(200);
      const seen = await visibility(resident(3), `contactId=${contactId}`);
      expect(seen.sections.find((s) => s.section === section)).toMatchObject({
        visible: false,
        reason: how === "withdraw" ? "withdrawn" : "suspended",
      });
    }
  });

  it("hazard HZ-022 makes an About Me link that stores only the token's hash and never outlives its decision", async () => {
    const linkDecision = await json<SharingDecisionOut>(
      await as("manager", `/v1/people/${resident(3)}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "link" },
          sections: ["about_me"],
          basis: "consent",
          consentGivenBy: "person",
          validTo: new Date(Date.now() + 7 * DAY).toISOString(),
        },
      }),
    );
    const path = `/v1/people/${resident(3)}/about-me/links`;
    const tooLong = await as("manager", path, {
      method: "POST",
      body: {
        sharingDecisionId: linkDecision.id,
        expiresAt: new Date(Date.now() + 8 * DAY).toISOString(),
      },
    });
    expect(tooLong.status).toBe(422);
    // A link opens About Me to whoever holds it: making one needs a fresh sign-in (step-up).
    await setSessionAge("manager", 60);
    const stale = await as("manager", path, {
      method: "POST",
      body: {
        sharingDecisionId: linkDecision.id,
        expiresAt: new Date(Date.now() + 2 * DAY).toISOString(),
      },
    });
    await setSessionAge("manager", 0);
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");
    const created = await as("manager", path, {
      method: "POST",
      body: {
        sharingDecisionId: linkDecision.id,
        expiresAt: new Date(Date.now() + 2 * DAY).toISOString(),
      },
    });
    expect(created.status).toBe(201);
    const link = await json<AboutMeShareLinkCreated>(created);
    expect(link.active).toBe(true);
    const stored = await asDemoTenant((c) =>
      c.query<{ token_hash: string }>("SELECT token_hash FROM about_me_share_link WHERE id = $1", [
        link.id,
      ]),
    );
    expect(stored.rows[0]?.token_hash).toBe(createHash("sha256").update(link.token).digest("hex"));
    expect(stored.rows[0]?.token_hash).not.toBe(link.token);
    const listed = await as("manager", path);
    expect(JSON.stringify(await json<AboutMeShareLinkList>(listed))).not.toContain(link.token);
    const revoked = await as("manager", `${path}/${link.id}/revoke`, {
      method: "POST",
      body: { reason: "No longer needed", version: 1 },
    });
    expect(revoked.status).toBe(200);
    expect((await json<AboutMeShareLinkList["items"][number]>(revoked)).active).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rules 11 and 12: a transfer to another provider, to archive", () => {
  let decisionId = "";
  let keyId = "";
  let itemId = "";

  it("hazard HZ-022 has sharing in force and property held before the person leaves", async () => {
    const contact = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        "SELECT id FROM contact WHERE person_id = $1 LIMIT 1",
        [resident(4)],
      );
      return rows[0]?.id ?? "";
    });
    const d = await as("manager", `/v1/people/${resident(4)}/sharing-decisions`, {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId: contact },
        sections: ["daily_updates"],
        basis: "consent",
        consentGivenBy: "person",
        validTo: new Date(Date.now() + 30 * DAY).toISOString(),
      },
    });
    decisionId = (await json<SharingDecisionOut>(d)).id;
    keyId = (
      await json<KeyIssueOut>(
        await as("nurse", `/v1/people/${resident(4)}/keys`, {
          method: "POST",
          body: { label: "Locker key", issuedOn: "2026-09-01", issuedTo: "person" },
        }),
      )
    ).id;
    itemId = (
      await json<PropertyItemOut>(
        await as("nurse", `/v1/people/${resident(4)}/property`, {
          method: "POST",
          body: {
            description: "Radio",
            category: "electronics",
            quantity: 1,
            receivedOn: "2026-09-01",
            acknowledgement: { signer: "person", name: "Signed", signedAt: ago(DAY) },
            witnessedBy: DEMO.users.manager.id,
          },
        }),
      )
    ).id;
    expect(decisionId && keyId && itemId).toBeTruthy();
  });

  it("needs the admissions permission and to say whether it is a transfer", async () => {
    expect(
      (await status(resident(4), { to: "discharged", reason: "Moving" }, "nurse")).status,
    ).toBe(403);
    const noKind = await status(resident(4), {
      to: "discharged",
      reason: "Moving closer to family",
    });
    expect(noKind.status).toBe(422);
    expect(await detail(noKind)).toContain("transfer");
  });

  it("hazard HZ-022 starts the transfer workflow and closes sharing, the bed and future tasks", async () => {
    const left = await status(resident(4), {
      to: "discharged",
      reason: "Moving closer to family",
      exitKind: "transfer",
      exit: { destinationType: "care_home", receivingProviderName: "Example Care Home" },
    });
    expect(left.status).toBe(200);
    const result = await json<PersonStatusChangeResult>(left);
    expect(result).toMatchObject({ status: "discharged", event: "people.person.discharged" });
    expect(result.effects).toEqual([
      "start_exit_workflow",
      "cancel_future_tasks",
      "close_sharing",
      "release_bed",
    ]);
    const view = await json<ExitView>(await as("manager", `/v1/people/${resident(4)}/exit`));
    expect(view.exit).toMatchObject({ kind: "transfer", state: "left" });
    expect(view.exit?.checklist.map((i) => i.key)).toEqual([
      "destination_recorded",
      "person_involved",
      "next_of_kin_informed",
      "care_summary_sent",
      "medicines_sent_with_person",
      "gp_informed",
      "pharmacy_informed",
      "property_returned",
      "keys_returned",
    ]);
    expect(view.exit?.deadlines.moneyAndPropertyBy).not.toBeNull();
    const decisions = await json<{ items: SharingDecisionOut[] }>(
      await as("manager", `/v1/people/${resident(4)}/sharing-decisions`),
    );
    expect(decisions.items.find((d) => d.id === decisionId)).toMatchObject({ inForce: false });
    const person = await summary(resident(4));
    expect(person.roomLabel).toBeNull();
    const beds = await json<BedHistory>(await as("manager", `/v1/people/${resident(4)}/bed-moves`));
    expect(beds.items.at(-1)?.to).not.toBeNull();
  });

  it("refuses to archive before the exit workflow is closed", async () => {
    const early = await status(resident(4), { to: "archived" });
    expect(early.status).toBe(422);
    expect(await detail(early)).toContain("checklist");
  });

  it("hazard HZ-001 refuses evidence from another person's record on the checklist", async () => {
    const exitPath = `/v1/people/${resident(4)}/exit`;
    const item = (await json<ExitView>(await as("manager", exitPath))).exit?.checklist.find(
      (i) => i.key === "care_summary_sent",
    );
    const foreign = await as("manager", `${exitPath}/items/care_summary_sent`, {
      method: "PUT",
      body: {
        status: "done",
        evidenceType: "document",
        evidenceId: await insertDocument(resident(3)),
        version: item?.version,
      },
    });
    expect(foreign.status).toBe(422);
    expect(await detail(foreign)).toContain("not found in this person's record");
    const own = await as("manager", `${exitPath}/items/care_summary_sent`, {
      method: "PUT",
      body: {
        status: "done",
        evidenceType: "document",
        evidenceId: await insertDocument(resident(4)),
        version: item?.version,
      },
    });
    expect(own.status).toBe(200);
  });

  it("gates the moves on the checklist and counts property and keys from their records", async () => {
    const exitPath = `/v1/people/${resident(4)}/exit`;
    const exit = async () => (await json<ExitView>(await as("manager", exitPath))).exit;
    const tooEarly = await as("manager", `${exitPath}/moves`, {
      method: "POST",
      body: { to: "awaiting_return", version: (await exit())?.version },
    });
    expect(tooEarly.status).toBe(422);
    expect(await detail(tooEarly)).toContain("Finish the checklist first");
    const manual = await as("manager", `${exitPath}/items/property_returned`, {
      method: "PUT",
      body: { status: "done", version: 1 },
    });
    expect(manual.status).toBe(422);
    const notRequired = await as("manager", `${exitPath}/items/destination_recorded`, {
      method: "PUT",
      body: { status: "not_required", reason: "Not needed", version: 1 },
    });
    expect(notRequired.status).toBe(422);
    for (const key of [
      "destination_recorded",
      "person_involved",
      "next_of_kin_informed",
      "care_summary_sent",
      "medicines_sent_with_person",
      "gp_informed",
      "pharmacy_informed",
    ]) {
      const item = (await exit())?.checklist.find((i) => i.key === key);
      const saved = await as("nurse", `${exitPath}/items/${key}`, {
        method: "PUT",
        body: { status: "done", version: item?.version },
      });
      expect(saved.status).toBe(200);
    }
    const awaiting = await as("manager", `${exitPath}/moves`, {
      method: "POST",
      body: { to: "awaiting_return", version: (await exit())?.version },
    });
    expect(awaiting.status).toBe(200);
    const stillHeld = await as("manager", `${exitPath}/moves`, {
      method: "POST",
      body: { to: "closed", version: (await exit())?.version },
    });
    expect(stillHeld.status).toBe(422);
    expect(await detail(stillHeld)).toContain("Wait for the returns first");
    expect(
      (
        await as("nurse", `/v1/people/${resident(4)}/keys/${keyId}/return`, {
          method: "POST",
          body: { on: today(), version: 1 },
        })
      ).status,
    ).toBe(200);
    const returned = await as("nurse", `/v1/people/${resident(4)}/property/${itemId}/return`, {
      method: "POST",
      body: {
        returnedOn: today(),
        recipientName: "Example Care Home",
        recipientCapacity: "receiving_provider",
        signature: { signer: "representative", name: "Signed for the home", signedAt: ago(MIN) },
        witnessedBy: DEMO.users.manager.id,
        version: 1,
      },
    });
    expect(returned.status).toBe(200);
    const closed = await as("manager", `${exitPath}/moves`, {
      method: "POST",
      body: { to: "closed", version: (await exit())?.version },
    });
    expect(closed.status).toBe(200);
    expect((await json<ExitView>(closed)).exit?.state).toBe("closed");
  });

  it("archives the record once the exit is closed", async () => {
    const archived = await status(resident(4), { to: "archived" });
    expect(archived.status).toBe(200);
    expect((await json<PersonStatusChangeResult>(archived)).event).toBe("people.person.archived");
    const note = await as("manager", `/v1/people/${resident(4)}/notes`, {
      method: "POST",
      body: { category: "other", body: "A note after archive.", occurredAt: ago(MIN) },
    });
    expect(note.status).toBe(422);
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rule 12: residents' money at exit (separation of duties)", () => {
  const exitPath = `/v1/people/${NEWCOMER}/exit`;
  const moneyItem = async () =>
    (await json<ExitView>(await as("owner", exitPath))).exit?.checklist.find(
      (i) => i.key === "residents_money_returned",
    );
  const tick = async (user: keyof Harness["tokens"]) =>
    as(user, `${exitPath}/items/residents_money_returned`, {
      method: "PUT",
      body: { status: "done", version: (await moneyItem())?.version },
    });

  it("plans a discharge for someone whose money the home holds", async () => {
    const planned = await as("manager", exitPath, {
      method: "POST",
      body: { kind: "discharge", details: { holdsResidentsMoney: true } },
    });
    expect(planned.status).toBe(201);
    expect((await moneyItem())?.owner).toBe("finance");
  });

  it("needs finance.ledger.approve and a fresh sign-in to confirm the money was returned", async () => {
    expect((await tick("nurse")).status).toBe(403);
    await setSessionAge("owner", 60);
    const stale = await tick("owner");
    await setSessionAge("owner", 0);
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");
  });

  it("refuses the confirmation to the person who recorded the exit, and audits the refusal", async () => {
    const own = await tick("manager");
    expect(own.status).toBe(403);
    expect(await code(own)).toBe("separation_of_duties");
    const denied = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event
         WHERE action = 'people.exit.item' AND outcome = 'denied' AND reason = 'separation_of_duties'`,
      ),
    );
    expect(denied.rows[0]?.n).toBe(1);
    const other = await tick("owner");
    expect(other.status).toBe(200);
    expect(await moneyItem()).toMatchObject({ status: "done", doneBy: DEMO.users.owner.id });
  });

  it("cancels the planned discharge with a reason", async () => {
    const exit = (await json<ExitView>(await as("manager", exitPath))).exit;
    const cancelled = await as("manager", `${exitPath}/moves`, {
      method: "POST",
      body: { to: "cancelled", reason: "Staying after the family meeting", version: exit?.version },
    });
    expect(cancelled.status).toBe(200);
    expect((await json<ExitView>(cancelled)).exit?.state).toBe("cancelled");
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rules 11 and 12: a death, its notifications and its correction", () => {
  /** Tasks open for Ada's neighbour before the death, by what the lifecycle must do with them. */
  const tasks = { round: "", pointOfCare: "", incident: "", safety: "", series: "" };
  let firstExitId = "";
  let submittedId = "";

  const notifications = async (sourcePrefix: string) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{
        id: string;
        kind: string;
        status: string;
        flagged: boolean;
        version: number;
      }>(
        `SELECT id, kind, status, no_longer_indicated AS flagged, version
         FROM statutory_notification WHERE person_id = $1 AND source_key LIKE $2 ORDER BY kind`,
        [resident(5), `${sourcePrefix}%`],
      );
      return rows;
    });

  it("hazard HZ-013 needs to know whether the death was expected, and whether LeDeR applies", async () => {
    const response = await status(resident(5), { to: "deceased" }, "nurse");
    expect(response.status).toBe(422);
    expect(await detail(response)).toContain("expected");
    // LeDeR is never assumed: the answer is explicit for every death.
    const noLeder = await status(
      resident(5),
      { to: "deceased", exit: { deathExpected: true, placeOfDeath: "care_home" } },
      "nurse",
    );
    expect(noLeder.status).toBe(422);
    expect(await detail(noLeder)).toContain("LeDeR");
    expect((await summary(resident(5))).status).toBe("active");
  });

  it("has rounds, a point-of-care task and safety follow-ups open before the death", async () => {
    tasks.series = await insertRoundSeries(resident(5));
    const later = new Date(Date.now() + 3 * HOUR);
    tasks.round = await insertTask(resident(5), "care.reposition", later, tasks.series);
    tasks.pointOfCare = await insertTask(resident(5), "care.weight_check", later);
    tasks.incident = await insertTask(resident(5), "care.incident_report", later);
    tasks.safety = await insertTask(resident(5), "safety.investigation_action", later);
    for (const id of Object.values(tasks).slice(0, 4)) {
      expect((await taskRow(id))?.status).toBe("open");
    }
  });

  it("hazard HZ-013 records a death at night: the room is held and the death notifications are drafted, with LeDeR", async () => {
    const died = await status(
      resident(5),
      {
        to: "deceased",
        effectiveAt: ago(20 * MIN),
        exit: {
          deathExpected: true,
          placeOfDeath: "care_home",
          verifiedByName: "Night nurse",
          learningDisabilityOrAutism: true,
        },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    expect((await json<PersonStatusChangeResult>(died)).event).toBe("people.person.died");
    const board = await json<BedBoard>(
      await as("manager", `/v1/locations/${DEMO.locationId}/beds`),
    );
    expect(board.rooms.find((r) => r.label === "5")?.status).toBe("awaiting_clearance");
    await drainOutbox();
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`))).exit;
    expect(exit?.kind).toBe("death");
    firstExitId = exit?.id ?? "";
    const drafts = await notifications(`exit:${firstExitId}:`);
    expect(drafts.map((r) => r.kind)).toEqual(["cqc_reg16_death", "leder", "medical_examiner"]);
    expect(drafts.every((d) => d.status === "draft" && !d.flagged)).toBe(true);
    const regulator = exit?.checklist.find((i) => i.key === "regulator_death_notification");
    expect(regulator).toMatchObject({
      derived: true,
      status: "pending",
      evidenceType: "statutory_notification",
      evidenceId: drafts.find((d) => d.kind === "cqc_reg16_death")?.id,
      notification: { statutory: true },
    });
    // The checklist says what the safety module says about the law (NOTIFICATION_KINDS).
    expect(exit?.checklist.find((i) => i.key === "leder_notification")).toMatchObject({
      derived: true,
      notification: { statutory: false },
    });
    expect(exit?.checklist.find((i) => i.key === "medical_examiner_information")).toMatchObject({
      derived: true,
      notification: { statutory: false },
    });
  });

  it("hazard HZ-013 ends rounds and point-of-care tasks at the death, and keeps the safety follow-ups", async () => {
    for (const id of [tasks.round, tasks.pointOfCare]) {
      expect(await taskRow(id)).toMatchObject({
        status: "cancelled",
        cancel_code: "ended_at_exit",
      });
    }
    for (const id of [tasks.incident, tasks.safety]) {
      expect(await taskRow(id)).toMatchObject({ status: "open", cancel_code: null });
    }
    const series = await asDemoTenant((c) =>
      c.query<{ active: boolean; inactive_code: string | null }>(
        "SELECT active, inactive_code FROM task_series WHERE id = $1",
        [tasks.series],
      ),
    );
    expect(series.rows[0]).toEqual({ active: false, inactive_code: "ended_at_exit" });
    const exitTask = await asDemoTenant((c) =>
      c.query<{ status: string }>(
        "SELECT status FROM task WHERE kind = 'people.exit_checklist' AND source_id = $1",
        [firstExitId],
      ),
    );
    expect(exitTask.rows).toEqual([{ status: "open" }]);
  });

  it("hazard HZ-006 accepts observations from before the death and post-event notes, and refuses later chart entries", async () => {
    const before = await as("nurse", `/v1/people/${resident(5)}/observations`, {
      method: "POST",
      body: {
        occurredAt: ago(40 * MIN),
        values: { chart: "repositioning", position: "left", skinChecked: true },
      },
    });
    expect(before.status).toBe(201);
    expect((await json<ObservationItem>(before)).recordedAfterExit).toBe(true);
    const after = await as("nurse", `/v1/people/${resident(5)}/observations`, {
      method: "POST",
      body: {
        occurredAt: ago(5 * MIN),
        values: { chart: "repositioning", position: "right", skinChecked: true },
      },
    });
    expect(after.status).toBe(422);
    expect(await code(after)).toBe("care_event_after_exit");
    const note = await as("nurse", `/v1/people/${resident(5)}/notes`, {
      method: "POST",
      body: { category: "other", body: "Family visited after death.", occurredAt: ago(MIN) },
    });
    expect(note.status).toBe(201);
    expect((await json<CareNoteItem>(note)).recordedAfterExit).toBe(false);
  });

  it("hazard HZ-013 submits the regulator's death notification", async () => {
    const cqc = (await notifications(`exit:${firstExitId}:`)).find(
      (n) => n.kind === "cqc_reg16_death",
    );
    submittedId = cqc?.id ?? "";
    const path = `/v1/notifications/statutory/${submittedId}`;
    const ready = await as("manager", `${path}/prepare`, {
      method: "POST",
      body: {
        content: { circumstances: "Expected death at night." },
        ready: true,
        version: cqc?.version,
      },
    });
    expect(ready.status).toBe(200);
    const submitted = await as("manager", `${path}/submit`, {
      method: "POST",
      body: {
        submittedAt: new Date().toISOString(),
        externalReference: "CQC-EXAMPLE-0001",
        version: (await json<{ version: number }>(ready)).version,
      },
    });
    expect(submitted.status).toBe(200);
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`))).exit;
    expect(exit?.checklist.find((i) => i.key === "regulator_death_notification")?.status).toBe(
      "done",
    );
  });

  it("hazard HZ-001 corrects a death recorded in error only with a reason and step-up", async () => {
    const body = { to: "active", reason: "Recorded against the wrong person" };
    expect((await status(resident(5), body, "nurse")).status).toBe(403);
    await setSessionAge("manager", 60);
    const stale = await status(resident(5), body);
    expect(stale.status).toBe(403);
    expect(await code(stale)).toBe("step_up_required");
    await setSessionAge("manager", 0);
    const corrected = await status(resident(5), body);
    expect(corrected.status).toBe(200);
    expect(await json<PersonStatusChangeResult>(corrected)).toMatchObject({
      correction: true,
      event: "people.person.status_corrected",
    });
    const view = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`))).exit;
    expect(view?.state).toBe("cancelled");
    const board = await json<BedBoard>(
      await as("manager", `/v1/locations/${DEMO.locationId}/beds`),
    );
    expect(board.rooms.find((r) => r.label === "5")?.status).toBe("available");
    expect((await summary(resident(5))).roomLabel).toBe("5");
    await drainOutbox();
    // The drafts are flagged no longer indicated, never closed; the submitted one stays as sent.
    const after = await notifications(`exit:${firstExitId}:`);
    expect(after.filter((n) => n.status === "draft").every((n) => n.flagged)).toBe(true);
    expect(after.find((n) => n.id === submittedId)).toMatchObject({
      status: "submitted",
      flagged: false,
    });
  });

  it("hazard HZ-013 gives the Registered Manager a task to tell the CQC that a submitted notification was made in error", async () => {
    const correction = await asDemoTenant((c) =>
      c.query<{ status: string; required_permission: string; priority: string }>(
        `SELECT status, required_permission, priority FROM task
         WHERE kind = 'safety.notification_correction' AND source_id = $1`,
        [submittedId],
      ),
    );
    expect(correction.rows).toEqual([
      { status: "open", required_permission: "safety.notification.submit", priority: "urgent" },
    ]);
    // A second relay of the same event does not raise a second task.
    await drainOutbox();
    const again = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task WHERE kind = 'safety.notification_correction' AND source_id = $1",
        [submittedId],
      ),
    );
    expect(again.rows[0]?.n).toBe(1);
  });

  it("hazard HZ-003 brings back the rounds and point-of-care tasks the death ended, and cancels the exit task", async () => {
    for (const id of [tasks.round, tasks.pointOfCare]) {
      expect(await taskRow(id)).toMatchObject({ status: "open", cancel_code: null });
    }
    for (const id of [tasks.incident, tasks.safety]) {
      expect((await taskRow(id))?.status).toBe("open");
    }
    const series = await asDemoTenant((c) =>
      c.query<{ active: boolean; inactive_code: string | null }>(
        "SELECT active, inactive_code FROM task_series WHERE id = $1",
        [tasks.series],
      ),
    );
    expect(series.rows[0]).toEqual({ active: true, inactive_code: null });
    const exitTask = await asDemoTenant((c) =>
      c.query<{ status: string; cancel_code: string | null }>(
        "SELECT status, cancel_code FROM task WHERE kind = 'people.exit_checklist' AND source_id = $1",
        [firstExitId],
      ),
    );
    expect(exitTask.rows).toEqual([{ status: "cancelled", cancel_code: "exit_recorded_in_error" }]);
  });

  it("hazard HZ-013 drafts new notifications for a real death after a corrected one, never reusing the old ones", async () => {
    const died = await status(
      resident(5),
      {
        to: "deceased",
        exit: { deathExpected: true, placeOfDeath: "care_home", learningDisabilityOrAutism: true },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    await drainOutbox();
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`))).exit;
    expect(exit?.id).not.toBe(firstExitId);
    const drafts = await notifications(`exit:${exit?.id}:`);
    expect(drafts.map((d) => d.kind)).toEqual(["cqc_reg16_death", "leder", "medical_examiner"]);
    expect(drafts.every((d) => d.status === "draft" && !d.flagged)).toBe(true);
    // The regulator item follows this death's draft, not the notification submitted in error.
    expect(exit?.checklist.find((i) => i.key === "regulator_death_notification")).toMatchObject({
      status: "pending",
      evidenceId: drafts.find((d) => d.kind === "cqc_reg16_death")?.id,
    });
  });

  it("clears a room held after a death and returns property only to the personal representative", async () => {
    const item = await json<PropertyItemOut>(
      await as("nurse", `/v1/people/${resident(6)}/property`, {
        method: "POST",
        body: {
          description: "Photograph in a frame",
          category: "ornament_or_picture",
          quantity: 1,
          receivedOn: "2026-09-01",
          acknowledgement: { signer: "person", name: "Signed", signedAt: ago(DAY) },
        },
      }),
    );
    const died = await status(
      resident(6),
      {
        to: "deceased",
        exit: {
          deathExpected: false,
          placeOfDeath: "care_home",
          learningDisabilityOrAutism: false,
        },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(6)}/exit`))).exit;
    // An unexpected death is referred to the coroner; LeDeR does not apply.
    expect(exit?.checklist.map((i) => i.key)).toContain("coroner_referral_recorded");
    expect(exit?.checklist.map((i) => i.key)).not.toContain("leder_notification");
    const toFamily = await as("nurse", `/v1/people/${resident(6)}/property/${item.id}/return`, {
      method: "POST",
      body: {
        returnedOn: today(),
        recipientName: "Relative Dummy",
        recipientCapacity: "representative",
        signature: { signer: "representative", name: "Relative Dummy", signedAt: ago(MIN) },
        version: item.version,
      },
    });
    expect(toFamily.status).toBe(422);
    expect(await detail(toFamily)).toContain("personal representative");
    const room = await asDemoTenant((c) =>
      c.query<{ version: number }>("SELECT version FROM room WHERE id = $1", [roomId(6)]),
    );
    const cleared = await as("manager", `/v1/rooms/${roomId(6)}/clearance`, {
      method: "POST",
      body: { on: today(), version: room.rows[0]?.version },
    });
    expect(cleared.status).toBe(200);
    const history = await json<BedHistory>(
      await as("manager", `/v1/people/${resident(6)}/bed-moves`),
    );
    expect(history.items.at(-1)?.to).not.toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------

describe("people.md rule 8: the review scheduler (HZ-008)", () => {
  it("raises one task for a local authority review in its window, once", async () => {
    await asDemoTenant((c) =>
      c.query(
        `UPDATE placement SET local_authority_funded = true,
           start_date = (now() AT TIME ZONE 'Europe/London')::date - 45
         WHERE person_id = $1`,
        [resident(3)],
      ),
    );
    const schedule = await json<ReviewSchedule>(
      await as("manager", `/v1/people/${resident(3)}/reviews`),
    );
    expect(schedule.available).toBe(true);
    const la = schedule.items.find((i) => i.kind === "la_review");
    expect(la).toMatchObject({
      state: "due",
      basis: ["la_review.first_min_weeks", "la_review.first_max_weeks"],
    });
    expect(schedule.items.map((i) => i.kind)).toContain("first_care_plan");
    expect(await raiseReviews(deps)).toBeGreaterThanOrEqual(1);
    await raiseReviews(deps);
    const tasks = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task WHERE kind = 'people.review.la_review' AND person_id = $1",
        [resident(3)],
      ),
    );
    expect(tasks.rows[0]?.n).toBe(1);
    expect(await outboxTypes(resident(3))).toContain("people.review.due");
  });

  it("completes the task when the review is recorded", async () => {
    const recorded = await as("manager", `/v1/people/${resident(3)}/reviews`, {
      method: "POST",
      body: {
        kind: "la_review",
        heldOn: today(),
        laReference: "LA-REVIEW-EXAMPLE",
        outcome: "Stays",
      },
    });
    expect(recorded.status).toBe(201);
    const tasks = await asDemoTenant((c) =>
      c.query<{ status: string }>(
        "SELECT status FROM task WHERE kind = 'people.review.la_review' AND person_id = $1",
        [resident(3)],
      ),
    );
    expect(tasks.rows[0]?.status).toBe("done");
  });

  it("raises one review on change for several changes, and a care plan review covers them", async () => {
    for (const kind of ["fall", "change_in_needs"]) {
      const change = await as("nurse", `/v1/people/${resident(3)}/care-plan-changes`, {
        method: "POST",
        body: { kind, occurredOn: today() },
      });
      expect(change.status).toBe(201);
    }
    let schedule = await json<ReviewSchedule>(
      await as("nurse", `/v1/people/${resident(3)}/reviews`),
    );
    const onChange = schedule.items.filter((i) => i.kind === "care_plan_review_on_change");
    expect(onChange).toHaveLength(1);
    expect(onChange[0]?.changeIds).toHaveLength(2);
    const review = await as("nurse", `/v1/people/${resident(3)}/reviews`, {
      method: "POST",
      body: { kind: "care_plan", heldOn: today(), outcome: "Plan updated" },
    });
    expect(review.status).toBe(201);
    schedule = await json<ReviewSchedule>(await as("nurse", `/v1/people/${resident(3)}/reviews`));
    expect(schedule.items.map((i) => i.kind)).not.toContain("care_plan_review_on_change");
  });

  it("hazard HZ-001 refuses a review document filed against another person", async () => {
    const response = await as("nurse", `/v1/people/${resident(3)}/reviews`, {
      method: "POST",
      body: {
        kind: "care_plan",
        heldOn: today(),
        outcome: "Plan updated",
        documentId: await insertDocument(resident(2)),
      },
    });
    expect(response.status).toBe(422);
    expect(await detail(response)).toContain("not found in this person's documents");
  });

  it("needs the family involvement kind on a family review", async () => {
    const response = await as("nurse", `/v1/people/${resident(3)}/reviews`, {
      method: "POST",
      body: { kind: "family_involvement", heldOn: today() },
    });
    expect(response.status).toBe(422);
  });
});

// ------------------------------------------------------------------------------------------------

describe("PLAT-006 the weekly break-glass report (HZ-011)", () => {
  it("stores one report per location once and alerts the Registered Manager and the data protection lead", async () => {
    const week = previousBreakGlassReportWeek(new Date());
    const at = new Date(week.start.getTime() + 36 * HOUR);
    await asDemoTenant(async (c) => {
      for (let n = 0; n < 3; n++) {
        await c.query(
          `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, opened_at,
             expires_at, reason_code)
           VALUES ($1, $2, 'Covering the unit tonight while the nurse is off sick', $3,
             $3::timestamptz + interval '1 hour', 'covering_another_area')`,
          [DEMO.users.manager.id, resident(2), new Date(at.getTime() + n * HOUR)],
        );
      }
      await c.query(
        `INSERT INTO break_glass_event (tenant_user_id, person_id, justification, opened_at, expires_at)
         VALUES ($1, $2, 'Reviewing a complaint about the lodge', $3, $3::timestamptz + interval '1 hour')`,
        [LODGE.qualityLeadId, LODGE.personId, at],
      );
    });
    expect(await reportBreakGlass(deps)).toBeGreaterThanOrEqual(2);
    expect(await reportBreakGlass(deps)).toBe(0);
    const alerts = await asDemoTenant((c) =>
      c.query<{ recipient: string; title: string; body: string }>(
        `SELECT recipient_tenant_user_id AS recipient, title, body FROM notification
         WHERE kind = 'people.break_glass_report'`,
      ),
    );
    const recipients = new Set(alerts.rows.map((r) => r.recipient));
    expect(recipients.has(DEMO.users.manager.id)).toBe(true);
    expect(recipients.has(LODGE.qualityLeadId)).toBe(true);
    expect(alerts.rows.every((r) => r.title === "The weekly break-glass report is ready")).toBe(
      true,
    );
    expect(JSON.stringify(alerts.rows)).not.toContain("Covering");
  });

  it("shows each reader the locations in their access, with counts and opaque ids only", async () => {
    const manager = await json<BreakGlassWeeklyReportList>(
      await as("manager", "/v1/break-glass/weekly-report"),
    );
    expect(manager.items.map((r) => r.locationId)).toEqual([DEMO.locationId]);
    const report = manager.items[0];
    expect(report?.summary).toMatchObject({ totalEvents: 3, distinctUsers: 1 });
    expect(JSON.stringify(report?.summary)).toContain("repeated_use");
    expect(JSON.stringify(report?.summary)).not.toContain("Covering");
    const quality = await json<BreakGlassWeeklyReportList>(
      await as("quality", "/v1/break-glass/weekly-report"),
    );
    expect(quality.items.map((r) => r.locationId).sort()).toEqual(
      [DEMO.locationId, LODGE.locationId].sort(),
    );
    expect((await as("carer", "/v1/break-glass/weekly-report")).status).toBe(403);
  });

  it("refuses a review by the person whose use the report flags", async () => {
    const list = await json<BreakGlassWeeklyReportList>(
      await as("manager", "/v1/break-glass/weekly-report"),
    );
    const path = `/v1/break-glass/weekly-report/${list.items[0]?.id}/review`;
    const body = { actionsTaken: "Reviewed my own access." };
    const own = await as("manager", path, { method: "POST", body });
    expect(own.status).toBe(403);
    expect(await code(own)).toBe("separation_of_duties");
  });

  it("refuses a review of a location outside the reviewer's access as not found", async () => {
    const all = await json<BreakGlassWeeklyReportList>(
      await as("quality", "/v1/break-glass/weekly-report"),
    );
    const lodge = all.items.find((r) => r.locationId === LODGE.locationId);
    const response = await as("manager", `/v1/break-glass/weekly-report/${lodge?.id}/review`, {
      method: "POST",
      body: { actionsTaken: "Looked at the lodge." },
    });
    expect(response.status).toBe(404);
  });

  it("records the review once, as a new row", async () => {
    const list = await json<BreakGlassWeeklyReportList>(
      await as("quality", "/v1/break-glass/weekly-report"),
    );
    const report = list.items.find((r) => r.locationId === DEMO.locationId);
    const path = `/v1/break-glass/weekly-report/${report?.id}/review`;
    const body = { actionsTaken: "Spoke to the manager; scope widened to cover the unit." };
    const first = await as("quality", path, { method: "POST", body });
    expect(first.status).toBe(201);
    expect((await as("quality", path, { method: "POST", body })).status).toBe(409);
  });

  it("stores the reason code given when a record is opened", async () => {
    const opened = await as("manager", "/v1/people/break-glass", {
      method: "POST",
      body: {
        personId: LODGE.personId,
        justification: "Covering the lodge tonight while its manager is away",
        reasonCode: "covering_another_area",
      },
    });
    expect(opened.status).toBe(201);
    const { id } = (await opened.json()) as { id: string };
    const stored = await asDemoTenant((c) =>
      c.query<{ reason_code: string }>("SELECT reason_code FROM break_glass_event WHERE id = $1", [
        id,
      ]),
    );
    expect(stored.rows[0]?.reason_code).toBe("covering_another_area");
  });
});

// ------------------------------------------------------------------------------------------------

describe("hazard HZ-011 permissions per route", () => {
  it.each([
    ["carer", "GET", `/v1/people/${resident(1)}/sharing-decisions`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/about-me/links`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/transfer-pack`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/hospital-transfers`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/exit`, 200],
    ["carer", "GET", `/v1/people/${resident(4)}/exit`, 404],
    ["carer", "GET", "/v1/settings/welcome-checklist", 403],
    ["carer", "GET", `/v1/people/${LODGE.personId}/exit`, 404],
    ["quality", "GET", `/v1/people/${resident(1)}/admission`, 200],
    ["nurse", "GET", `/v1/people/${resident(1)}/transfer-pack`, 200],
  ] as const)("%s %s %s answers %i", async (user, method, path, expected) => {
    expect((await as(user, path, { method })).status).toBe(expected);
  });

  it("writes an audit event by record id for each view", async () => {
    const audited = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_event
         WHERE action = 'people.exit.view' AND outcome = 'success'`,
      ),
    );
    expect(audited.rows[0]?.n).toBeGreaterThan(0);
  });

  it("records the admission view for a person in another location as not found", async () => {
    const response = await as("carer", `/v1/people/${NEWCOMER}/admission`);
    expect(response.status).toBe(404);
  });

  it("keeps admission views readable", async () => {
    const view = await json<AdmissionView>(await as("manager", `/v1/people/${NEWCOMER}/admission`));
    expect(view.placement?.type).toBe("permanent");
  });
});
