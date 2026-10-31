import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
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
  RecordHistory,
  ReviewSchedule,
  SharingDecisionOut,
  SharingVisibility,
  TaskList,
  TransferPack,
  WelcomeChecklist,
} from "@harbour/contracts";
import { createDatabase, createPool, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import {
  PRE_ADMISSION_SECTIONS,
  previousBreakGlassReportWeek,
  restoreLookbackStart,
  ukIsoDate,
} from "@harbour/domain";
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
import { assigneeMayComplete } from "../src/services/tasks";
import { ageSession, createHarness, type Harness, LODGE } from "./support/harness";
import { pdfPages } from "./support/pdf-text";

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
  init: {
    method?: string;
    body?: unknown;
    raw?: { bytes: Uint8Array; contentType: string };
    headers?: Record<string, string>;
  } = {},
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
  await ageSession(h.db.pool("harbour_auth"), h.tokens[user]?.split(".")[0] ?? "", minutes * 60);
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
  readonly restore_code: string | null;
  readonly assignee_role_key: string | null;
  readonly priority: string;
  readonly due_at: Date;
}

async function taskRow(id: string): Promise<TaskRow | undefined> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<TaskRow>(
      `SELECT kind, status, cancel_code, evidence_id, evidence_after_close, restore_code,
         assignee_role_key, priority, due_at FROM task WHERE id = $1`,
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
  options: { windowEnd?: Date; permission?: string; status?: string } = {},
): Promise<string> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO task (series_id, person_id, location_id, kind, title, required_permission, due_at,
         window_end, status)
       VALUES ($1, $2, $3, $4, 'Task for the test', $6, $5, $7, $8) RETURNING id`,
      [
        seriesId,
        personId,
        DEMO.locationId,
        kind,
        dueAt,
        options.permission ?? "care.note.write",
        options.windowEnd ?? null,
        options.status ?? "open",
      ],
    );
    return rows[0]?.id ?? "";
  });
}

/** A 2 x 2 PNG; 16-bit when asked (which the pack does not decode). */
function smallPng(depth = 8): Uint8Array {
  const chunk = (type: string, body: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), body, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(2, 0);
  ihdr.writeUInt32BE(2, 4);
  ihdr[8] = depth;
  ihdr[9] = 2;
  const rowBytes = 2 * 3 * (depth / 8) + 1;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr),
      chunk("IDAT", deflateSync(Buffer.alloc(rowBytes * 2, 0))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Someone receiving care at Harbour House for these tests, active for a month. */
async function newResident(given: string): Promise<string> {
  const id = newId();
  await asDemoTenant((c) =>
    c.query(
      `INSERT INTO person (id, location_id, status, given_name, family_name, date_of_birth,
         status_changed_at)
       VALUES ($1, $2, 'active', $3, 'Example', '1941-04-04', now() - interval '30 days')`,
      [id, DEMO.locationId, given],
    ),
  );
  return id;
}

interface TaskDetailsRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly details: {
    entries?: Record<string, unknown>[];
    missedTasks?: { taskId: string; kind: string; dueAt: string; reopened: boolean }[];
    missedTasksOmitted?: number;
    missedTasksNotListedBefore?: string;
  } | null;
}

async function reviewTasks(personId: string, kind: string): Promise<TaskDetailsRow[]> {
  return asDemoTenant(async (c) => {
    const { rows } = await c.query<TaskDetailsRow>(
      "SELECT id, title, status, details FROM task WHERE person_id = $1 AND kind = $2",
      [personId, kind],
    );
    return rows;
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
  /** Due after the person left and before they came back, still in its window on return. */
  let stillDueOnReturn = "";
  /** The client id of an entry refused as after the move. */
  const refusedId = newId();
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
    const pages = pdfPages(await printPack(resident(2), sent.id));
    // The decision in force is in the identity block on page 1, whatever follows it (C-M5).
    expect(pages[0] ?? []).toContain(
      `CPR decision: Not for cardiopulmonary resuscitation (DNACPR, ${ukDate(completedOn)}).`,
    );
    const text = pages.flat().join("\n");
    expect(text).toContain("CPR decision: Not for cardiopulmonary resuscitation.");
    expect(text).toContain(
      `DNACPR: Not for cardiopulmonary resuscitation. Dr Example, GP. Completed ${ukDate(completedOn)}.`,
    );
    expect(text).not.toContain("the records disagree");
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
    expect(pages[0] ?? []).toContain(
      "CPR decision: the records disagree. Check the original documents before acting.",
    );
    expect(first).toContain("CHECK BEFORE RELYING ON THIS PACK");
    expect(first).toContain("The resuscitation records disagree.");
    expect(first).toContain(
      `The resuscitation decision is past its review date. (${ukDate(completedOn)})`,
    );
    const text = pages.flat().join("\n");
    // Said once (page 1), never shouted; the section lists both records.
    expect(text.split("the records disagree").length - 1).toBe(1);
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
    // Due five minutes after they left; its window runs until 25 minutes from now.
    stillDueOnReturn = await insertTask(
      resident(1),
      "care.reposition",
      new Date(left.getTime() + 5 * MIN),
      series,
      { windowEnd: new Date(Date.now() + 25 * MIN) },
    );
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
      body: {
        id: refusedId,
        occurredAt: ago(MIN),
        values: { chart: "weight", kg: 61, method: "chair" },
      },
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
    // It names the entry by kind, client id, device and user; no clinical text (HZ-006, C-M7).
    const [review] = await reviewTasks(resident(1), "people.late_entry_review");
    expect(review?.title).toBe("Review an entry made after the person left or went away");
    expect(review?.details?.entries).toEqual([
      expect.objectContaining({
        kind: "observation",
        clientId: refusedId,
        deviceId: null,
        recordedBy: DEMO.users.nurse.id,
      }),
    ]);
    expect(JSON.stringify(review?.details)).not.toContain("kg");
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
    // Both flags are on the record for every reader, not only in the upload's response (C-M3).
    const tasks = await json<TaskList>(
      await as(
        "nurse",
        `/v1/tasks?personId=${resident(1)}&status=closed&from=${encodeURIComponent(ago(DAY))}`,
      ),
    );
    expect(tasks.items.find((t) => t.id === leavingTask)).toMatchObject({
      status: "cancelled",
      evidenceAfterClose: true,
      evidenceId: entry.id,
    });
    const chart = await json<{ items: ObservationItem[] }>(
      await as("nurse", `/v1/people/${resident(1)}/observations?chart=repositioning`),
    );
    expect(chart.items.find((o) => o.id === entry.id)).toMatchObject({
      recordedAfterExit: true,
      taskId: leavingTask,
      taskOutcome: "task_cancelled",
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
    // Due before the return but still in its window: open again, not left paused (C-M2).
    expect(await taskRow(stillDueOnReturn)).toMatchObject({ status: "open", cancel_code: null });
    const reviews = await json<ReviewSchedule>(
      await as("nurse", `/v1/people/${resident(1)}/reviews`),
    );
    expect(reviews.changes.map((c) => c.kind)).toContain("return_from_hospital");
    expect(reviews.items.map((i) => i.kind)).toContain("care_plan_review_on_change");
  });

  it.each([
    ["a 16-bit PNG", () => smallPng(16)],
    ["a truncated PNG", () => smallPng().subarray(0, 16)],
  ])(
    "hazards HZ-001 and HZ-023 count %s photo as missing, so page 1 names it and the hand-over needs an acknowledgement",
    async (_label, make) => {
      const who = await newResident("Ffion");
      const put = await as("manager", `/v1/people/${who}/photo`, {
        method: "PUT",
        raw: { bytes: make(), contentType: "image/png" },
      });
      expect(put.status).toBe(201);
      const preview = await json<TransferPack>(
        await as("nurse", `/v1/people/${who}/transfer-pack`),
      );
      expect(preview.missingCritical).toContain("photo");
      expect(preview.attention?.map((a) => a.code)).toContain("photo_not_printable");
      const sent = await sendToHospital(who);
      // The PDF still prints (never a 500), with the photo named on page 1.
      const first = pdfPages(await printPack(who, sent.id))[0] ?? [];
      expect(first).toContain(
        "Photo: not recorded or cannot be printed. Confirm identity another way.",
      );
      const bare = await as("nurse", `/v1/people/${who}/hospital-transfers/${sent.id}/handover`, {
        method: "POST",
        body: { version: sent.version },
      });
      expect(bare.status).toBe(422);
      expect(await code(bare)).toBe("transfer_pack_acknowledgement_required");
    },
  );

  it("hazards HZ-005 and HZ-015 let only someone who may complete a return check's task record it", async () => {
    // A team leader records movements but not care plans (people.movement.record only).
    const assignment = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
         SELECT $1, id, $2 FROM role WHERE key = 'team_leader' AND is_builtin
         RETURNING id`,
        [DEMO.users.carer.id, DEMO.locationId],
      );
      return rows[0]?.id ?? "";
    });
    try {
      const path = (key: string) =>
        `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/return-checks/${key}`;
      for (const key of [
        "medicines_reconciled",
        "resuscitation_rechecked",
        "allergies_rechecked",
      ]) {
        const refused = await as("carer", path(key), {
          method: "POST",
          body: { version: transfer.version },
        });
        expect(refused.status, key).toBe(403);
      }
      const denied = await asDemoTenant((c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_event WHERE action = 'people.hospital_transfer.return_check'
           AND outcome = 'denied' AND resource_id = $1`,
          [transfer.id],
        ),
      );
      expect(denied.rows[0]?.n).toBe(3);
      // Checking belongings back in is a movement: the team leader may record it, and the items
      // that went with the person return to the home's keeping.
      const belongings = await as("carer", path("belongings_returned"), {
        method: "POST",
        body: { version: transfer.version },
      });
      expect(belongings.status).toBe(200);
      transfer = await json<HospitalTransferOut>(belongings);
      expect(transfer.returnChecks.find((c) => c.key === "belongings_returned")?.doneBy).toBe(
        DEMO.users.carer.id,
      );
      const list = await json<PropertyList>(
        await as("nurse", `/v1/people/${resident(1)}/property`),
      );
      expect(list.items.every((i) => i.status !== "sent_with_person")).toBe(true);
      // Being a check's assignee is not enough on its own: the assignee records it only while
      // they could still be given it (S1 follow-on), here under an acting-up grant.
      await asDemoTenant((c) =>
        c.query(
          `UPDATE task SET assignee_tenant_user_id = $1 WHERE source_type = 'hospital_transfer'
           AND source_id = $2 AND kind = 'people.return_check.allergies_rechecked'`,
          [DEMO.users.carer.id, transfer.id],
        ),
      );
      const record = () =>
        as("carer", path("allergies_rechecked"), {
          method: "POST",
          body: { version: transfer.version },
        });
      expect((await record()).status).toBe(403);
      const lapsed = await asDemoTenant((c) =>
        c.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM audit_event WHERE action = 'people.hospital_transfer.return_check'
           AND outcome = 'denied' AND resource_id = $1 AND reason = 'assignee_lacks_permission'`,
          [transfer.id],
        ),
      );
      expect(lapsed.rows[0]?.n).toBe(1);
      const grant = await asDemoTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_from, valid_to,
             reason, granted_by)
           VALUES ($1, '{care.plan.write}', $2, now() - interval '1 minute', now() + interval '1 hour',
             'Acting up as senior carer', $3) RETURNING id`,
          [DEMO.users.carer.id, DEMO.locationId, DEMO.users.manager.id],
        );
        return rows[0]?.id ?? "";
      });
      try {
        const assigned = await record();
        expect(assigned.status).toBe(200);
        transfer = await json<HospitalTransferOut>(assigned);
      } finally {
        await asDemoTenant((c) =>
          c.query("UPDATE access_grant SET revoked_at = now() WHERE id = $1", [grant]),
        );
      }
      // The nurse in charge records the clinical check.
      const medicines = await as("nurse", path("medicines_reconciled"), {
        method: "POST",
        body: { version: transfer.version },
      });
      expect(medicines.status).toBe(200);
      transfer = await json<HospitalTransferOut>(medicines);
    } finally {
      await asDemoTenant((c) =>
        c.query("UPDATE role_assignment SET deleted_at = now() WHERE id = $1", [assignment]),
      );
    }
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
    // The person's history marks what this change altered, by key only.
    const history = await json<RecordHistory>(
      await as("manager", `/v1/people/${resident(2)}/history`),
    );
    expect(history.versions.at(-1)?.data).toMatchObject({
      communication_needs_status: "not_recorded",
    });
    expect(history.latestChanged).toContain("communication_needs_status");
    expect(history.latestChanged).not.toContain("given_name");
    expect(history).not.toHaveProperty("current");
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
    expect(link.version).toBe(1);
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
      body: { reason: "No longer needed", version: link.version },
    });
    expect(revoked.status).toBe(200);
    const after = await json<AboutMeShareLinkList["items"][number]>(revoked);
    expect(after).toMatchObject({ active: false, version: link.version + 1 });
  });
});

describe("people.md rule 13 on the slice 12 sharing rules (HZ-022)", () => {
  const sharing = (personId: string) => `/v1/people/${personId}/sharing-decisions`;
  const visibility = async (personId: string, contactId: string) =>
    json<SharingVisibility>(
      await as("manager", `${sharing(personId)}/visibility?contactId=${contactId}`),
    );
  const addContact = (
    personId: string,
    role: string,
    scope: string | null,
    reference: string | null = "OPG-EXAMPLE-1",
  ) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO contact (person_id, role, given_name, family_name, relationship,
           authority_reference, authority_scope)
         VALUES ($1, $2, 'Alex', 'Example', 'Child', $3, $4) RETURNING id`,
        [personId, role, reference, scope],
      );
      return rows[0]?.id ?? "";
    });
  const assessCapacity = (
    personId: string,
    outcome: "has_capacity" | "lacks_capacity",
    ago: number,
  ) =>
    asDemoTenant(async (c) => {
      const lacks = outcome === "lacks_capacity";
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO capacity_assessment (person_id, decision, decision_kind, assessed_at,
           assessor_tenant_user_id, stage1_impairment, stage1_description, stage2,
           inability_because_of_impairment, outcome, unable_to, reason)
         VALUES ($1, 'whether to share information with family', 'sharing',
           now() - make_interval(hours => $2), $3, $4, 'Dementia', '{}', $5, $6, $7,
           'Recorded for the test')
         RETURNING id`,
        [
          personId,
          ago,
          DEMO.users.nurse.id,
          lacks,
          lacks ? true : null,
          outcome,
          lacks ? ["understand"] : [],
        ],
      );
      return rows[0]?.id ?? "";
    });
  const validTo = () => new Date(Date.now() + 30 * DAY).toISOString();

  it("hazard HZ-022 lets a DWP appointee see benefits only, never finance statements", async () => {
    const who = await newResident("Gwen");
    const appointee = await addContact(who, "appointee", null, "DWP-EXAMPLE-1");
    const body = (sections: string[]) => ({
      recipient: { kind: "family", contactId: appointee },
      sections,
      basis: "legal_authority",
      authority: { role: "appointee", contactId: appointee },
      validTo: validTo(),
    });
    const refused = await as("manager", sharing(who), { method: "POST", body: body(["finance"]) });
    expect(refused.status).toBe(422);
    const created = await as("manager", sharing(who), { method: "POST", body: body(["benefits"]) });
    expect(created.status).toBe(201);
    // The reference comes from the contact's authority when the decision leaves it out.
    expect((await json<SharingDecisionOut>(created)).authority?.reference).toBe("DWP-EXAMPLE-1");
    const seen = await visibility(who, appointee);
    expect(seen.sections.filter((s) => s.visible).map((s) => s.section)).toEqual(["benefits"]);
    // An authority held by someone else, or of another kind, is refused.
    const nextOfKin = await addContact(who, "next_of_kin", null);
    const wrongHolder = await as("manager", sharing(who), {
      method: "POST",
      body: {
        ...body(["benefits"]),
        recipient: { kind: "family", contactId: nextOfKin },
        authority: { role: "appointee", contactId: nextOfKin },
      },
    });
    expect(wrongHolder.status).toBe(422);
  });

  it("hazard HZ-022 lets a deputy see only what their order covers, and only while the person lacks capacity now", async () => {
    const who = await newResident("Huw");
    const deputy = await addContact(who, "deputy", "personal_welfare");
    const assessment = await assessCapacity(who, "lacks_capacity", 48);
    const body = (orderSections?: string[], role = "deputy_personal_welfare") => ({
      recipient: { kind: "family", contactId: deputy },
      sections: ["daily_updates"],
      basis: "legal_authority",
      capacity: "assessed_lacks_capacity",
      capacityAssessmentId: assessment,
      authority: {
        role,
        contactId: deputy,
        ...(orderSections ? { orderSections } : {}),
      },
      validTo: validTo(),
    });
    for (const [label, refusal] of [
      ["no order sections", body()],
      ["a section outside the order", body(["care_plan"])],
      [
        "a property and affairs order the deputy does not hold",
        body(["finance"], "deputy_property_affairs"),
      ],
    ] as const) {
      const response = await as("manager", sharing(who), { method: "POST", body: refusal });
      expect(response.status, label).toBe(422);
    }
    const created = await as("manager", sharing(who), {
      method: "POST",
      body: body(["daily_updates", "care_plan"]),
    });
    expect(created.status).toBe(201);
    const decision = await json<SharingDecisionOut>(created);
    expect(decision.authority?.orderSections).toEqual(["daily_updates", "care_plan"]);
    expect(decision.inForce).toBe(true);
    let seen = await visibility(who, deputy);
    expect(seen.capacityForSharing).toBe("assessed_lacks_capacity");
    expect(seen.sections.find((s) => s.section === "daily_updates")?.visible).toBe(true);
    // A later assessment of the sharing decision finds capacity: the deputy's decision closes.
    await assessCapacity(who, "has_capacity", 1);
    seen = await visibility(who, deputy);
    expect(seen.capacityForSharing).toBe("assessed_has_capacity");
    expect(seen.sections.find((s) => s.section === "daily_updates")).toMatchObject({
      visible: false,
      reason: "capacity_regained",
    });
  });

  it("hazard HZ-022 takes capacity only from an assessment of the sharing decision", async () => {
    const who = await newResident("Iolo");
    const deputy = await addContact(who, "deputy", "both");
    const other = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO capacity_assessment (person_id, decision, decision_kind, assessed_at,
           assessor_tenant_user_id, stage1_impairment, stage1_description, stage2,
           inability_because_of_impairment, outcome, unable_to, reason)
         VALUES ($1, 'whether to have bed rails at night', 'bed_rails', now() - interval '1 day',
           $2, true, 'Dementia', '{}', true, 'lacks_capacity', '{understand}', 'Recorded')
         RETURNING id`,
        [who, DEMO.users.nurse.id],
      );
      return rows[0]?.id ?? "";
    });
    const refused = await as("manager", sharing(who), {
      method: "POST",
      body: {
        recipient: { kind: "family", contactId: deputy },
        sections: ["daily_updates"],
        basis: "legal_authority",
        capacity: "assessed_lacks_capacity",
        capacityAssessmentId: other,
        authority: {
          role: "deputy_personal_welfare",
          contactId: deputy,
          orderSections: ["daily_updates"],
        },
        validTo: validTo(),
      },
    });
    expect(refused.status).toBe(422);
  });

  it("hazard HZ-022 keeps each suspension as a period and reopens the sections when it is lifted", async () => {
    const who = await newResident("Jac");
    const family = await addContact(who, "next_of_kin", null, null);
    let decision = await json<SharingDecisionOut>(
      await as("manager", sharing(who), {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId: family },
          sections: ["activities_and_visits"],
          basis: "consent",
          consentGivenBy: "person",
          validTo: validTo(),
        },
      }),
    );
    const move = async (how: string, reason: string) => {
      const response = await as("manager", `${sharing(who)}/${decision.id}/${how}`, {
        method: "POST",
        body: { reason, version: decision.version },
      });
      if (response.status === 200) decision = await json<SharingDecisionOut>(response);
      return response;
    };
    expect((await move("lift-suspension", "Nothing to lift")).status).toBe(422);
    expect((await move("suspend", "Safeguarding enquiry opened")).status).toBe(200);
    expect(decision.inForce).toBe(false);
    expect(
      (await visibility(who, family)).sections.find((s) => s.section === "activities_and_visits"),
    ).toMatchObject({ visible: false, reason: "suspended" });
    expect((await move("lift-suspension", "Enquiry closed with no concerns")).status).toBe(200);
    expect(decision).toMatchObject({ suspendedAt: null, inForce: true });
    expect(decision.suspensions).toEqual([
      expect.objectContaining({
        reason: "Safeguarding enquiry opened",
        liftedReason: "Enquiry closed with no concerns",
        liftedBy: DEMO.users.manager.id,
      }),
    ]);
    const seen = await visibility(who, family);
    expect(seen.sections.find((s) => s.section === "activities_and_visits")?.visible).toBe(true);
    const audits = await asDemoTenant((c) =>
      c.query<{ action: string }>(
        `SELECT action FROM audit_event WHERE resource_id = $1 ORDER BY occurred_at`,
        [decision.id],
      ),
    );
    expect(audits.rows.map((r) => r.action)).toEqual(
      expect.arrayContaining(["people.sharing.suspend", "people.sharing.lift_suspension"]),
    );
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

  it("refuses to drop the money from the plan when the departure is recorded, without a fresh sign-in", async () => {
    await setSessionAge("manager", 60);
    const dropped = await as("manager", `/v1/people/${NEWCOMER}/status`, {
      method: "POST",
      body: {
        to: "discharged",
        exitKind: "discharge",
        effectiveAt: new Date().toISOString(),
        reason: "Going home",
        exit: { holdsResidentsMoney: false },
        version: (await summary(NEWCOMER, "owner")).version,
      },
    });
    await setSessionAge("manager", 0);
    expect(dropped.status).toBe(403);
    expect(await code(dropped)).toBe("finance_flag_change");
    expect(await auditCount("people.person.status.discharged", NEWCOMER, "denied")).toBe(1);
    expect((await moneyItem())?.owner).toBe("finance");
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
    // The board gives the room's version, so its clearance can be recorded from it.
    expect(board.rooms.find((r) => r.label === "5")?.version).toBeGreaterThanOrEqual(1);
    // HZ-013: before the safety module drafts the regulator's notification, nobody ticks it by
    // hand: not the nurse (no notification permission), not a manager (it follows its draft).
    const before = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`)))
      .exit;
    const early = before?.checklist.find((i) => i.key === "regulator_death_notification");
    expect(early).toMatchObject({ status: "pending", derived: false });
    const tick = (user: "nurse" | "manager") =>
      as(user, `/v1/people/${resident(5)}/exit/items/regulator_death_notification`, {
        method: "PUT",
        body: { status: "done", version: early?.version },
      });
    expect((await tick("nurse")).status).toBe(403);
    expect([403, 422]).toContain((await tick("manager")).status);
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

describe("people.md rules 1 and 2: rounds after a correction or a late return (HZ-003)", () => {
  const exitDetails = {
    deathExpected: true,
    placeOfDeath: "care_home",
    learningDisabilityOrAutism: false,
  };

  it("hazard HZ-003 restores a round an offline entry answered as done, never due again, when a death recorded in error is corrected (10:05, 10:08, 10:15, 10:20)", async () => {
    const who = await newResident("Rhys");
    const series = await insertRoundSeries(who);
    // The 10:10 turn, whose window runs to 10:40.
    const turn = await insertTask(who, "care.reposition", new Date(Date.now() - 10 * MIN), series, {
      windowEnd: new Date(Date.now() + 20 * MIN),
    });
    // 10:08: a death is recorded against the wrong person; the 10:10 turn ends with it.
    const died = await status(
      who,
      { to: "deceased", effectiveAt: ago(12 * MIN), exit: exitDetails },
      "nurse",
    );
    expect(died.status).toBe(200);
    expect(await taskRow(turn)).toMatchObject({
      status: "cancelled",
      cancel_code: "ended_at_exit",
    });
    // 10:15: the turn done at 10:05 uploads from a phone that was offline.
    const entry = await as("nurse", `/v1/people/${who}/observations`, {
      method: "POST",
      body: {
        id: newId(),
        occurredAt: ago(15 * MIN),
        taskId: turn,
        values: { chart: "repositioning", position: "left", skinChecked: true },
      },
    });
    expect(entry.status).toBe(201);
    expect((await json<ObservationItem>(entry)).taskOutcome).toBe("task_cancelled");
    // 10:20: the death is corrected. The turn was done: it is not due again (HZ-004).
    await setSessionAge("manager", 0);
    const corrected = await status(who, {
      to: "active",
      reason: "Recorded against the wrong person",
    });
    expect(corrected.status).toBe(200);
    expect(await taskRow(turn)).toMatchObject({ status: "done", cancel_code: null });
    const open = await json<TaskList>(await as("nurse", `/v1/tasks?personId=${who}`));
    expect(open.items.map((t) => t.id)).not.toContain(turn);
  });

  it("hazard HZ-003 codes the rounds missed during a late-recorded return, catches each series up once and lists them for review", async () => {
    const who = await newResident("Nia");
    const series = await insertRoundSeries(who);
    const at = (hoursAgo: number) => new Date(Date.now() - hoursAgo * HOUR);
    const round = (dueHoursAgo: number, windowEndHoursAgo: number) =>
      insertTask(who, "care.reposition", at(dueHoursAgo), series, {
        windowEnd: at(windowEndHoursAgo),
      });
    const closedWhileAway = await round(4, 3.5);
    const missedFirst = await round(2.5, 2);
    const missedLatest = await round(1.5, 1);
    const stillOpen = await round(1 / 3, -1 / 3);
    expect(
      (await status(who, { to: "in_hospital", effectiveAt: at(5).toISOString() }, "nurse")).status,
    ).toBe(200);
    // The return is recorded now, three hours after it happened.
    const back = await status(who, { to: "active", effectiveAt: at(3).toISOString() }, "nurse");
    expect(back.status).toBe(200);
    expect(await taskRow(closedWhileAway)).toMatchObject({
      status: "cancelled",
      cancel_code: "paused_while_away",
    });
    expect(await taskRow(missedFirst)).toMatchObject({
      status: "cancelled",
      cancel_code: "missed_before_return_recorded",
    });
    // A later turn is open again, so the missed one is not caught up as well: two turns never
    // fall due minutes apart (C1).
    expect(await taskRow(missedLatest)).toMatchObject({
      status: "cancelled",
      cancel_code: "missed_before_return_recorded",
    });
    expect(await taskRow(stillOpen)).toMatchObject({ status: "open", cancel_code: null });
    const [review] = await reviewTasks(who, "people.missed_rounds_review");
    // Newest first (M2).
    expect(review?.details?.missedTasks).toEqual([
      expect.objectContaining({ taskId: missedLatest, kind: "care.reposition", reopened: false }),
      expect.objectContaining({ taskId: missedFirst, kind: "care.reposition", reopened: false }),
    ]);
    // Without a transfer record the return still raises the checks, due a day after the return.
    const checks = await asDemoTenant((c) =>
      c.query<{ source_type: string; due_at: Date }>(
        "SELECT source_type, due_at FROM task WHERE person_id = $1 AND kind LIKE 'people.return_check.%'",
        [who],
      ),
    );
    expect(checks.rows.length).toBeGreaterThan(0);
    for (const check of checks.rows) {
      expect(check.source_type).toBe("person");
      expect(Math.abs(check.due_at.getTime() - (at(3).getTime() + DAY))).toBeLessThan(MIN);
    }
  });

  it("hazard HZ-023 never sets a return check due in the past for a return recorded more than a day late", async () => {
    const who = await newResident("Owen");
    expect(
      (await status(who, { to: "in_hospital", effectiveAt: ago(40 * HOUR) }, "nurse")).status,
    ).toBe(200);
    expect((await status(who, { to: "active", effectiveAt: ago(30 * HOUR) }, "nurse")).status).toBe(
      200,
    );
    const checks = await asDemoTenant((c) =>
      c.query<{ due_at: Date }>(
        "SELECT due_at FROM task WHERE person_id = $1 AND kind LIKE 'people.return_check.%'",
        [who],
      ),
    );
    expect(checks.rows.length).toBeGreaterThan(0);
    expect(checks.rows.every((r) => r.due_at.getTime() >= Date.now() - MIN)).toBe(true);
  });

  it("hazards HZ-003 and HZ-008 correct a death recorded in error while the person was in hospital back to in hospital, with rounds still paused", async () => {
    const who = await newResident("Elin");
    const series = await insertRoundSeries(who);
    const paused = await insertTask(
      who,
      "care.reposition",
      new Date(Date.now() + 3 * HOUR),
      series,
    );
    const left = ago(2 * HOUR);
    expect((await status(who, { to: "in_hospital", effectiveAt: left }, "nurse")).status).toBe(200);
    expect(await taskRow(paused)).toMatchObject({
      status: "cancelled",
      cancel_code: "paused_while_away",
    });
    const weight = await insertTask(who, "care.weight_check", new Date(Date.now() + 4 * HOUR));
    const died = await status(
      who,
      {
        to: "deceased",
        exit: { deathExpected: false, placeOfDeath: "hospital", learningDisabilityOrAutism: false },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    expect(await taskRow(weight)).toMatchObject({
      status: "cancelled",
      cancel_code: "ended_at_exit",
    });
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${who}/exit`))).exit;
    expect(exit?.statusBefore).toBe("in_hospital");
    await setSessionAge("manager", 0);
    const toActive = await status(who, {
      to: "active",
      reason: "Recorded against the wrong person",
    });
    expect(toActive.status).toBe(422);
    expect(await detail(toActive)).toContain("status they had");
    const corrected = await status(who, {
      to: "in_hospital",
      reason: "Recorded against the wrong person",
    });
    expect(corrected.status).toBe(200);
    const person = await summary(who);
    expect(person.status).toBe("in_hospital");
    expect(person.statusChangedAt).toBe(left);
    // Still away: what the death ended waits, paused, for the return; nothing restarted.
    expect(await taskRow(weight)).toMatchObject({
      status: "cancelled",
      cancel_code: "paused_while_away",
    });
    expect(await taskRow(paused)).toMatchObject({
      status: "cancelled",
      cancel_code: "paused_while_away",
    });
    const open = await json<TaskList>(await as("nurse", `/v1/tasks?personId=${who}`));
    expect(
      open.items.filter((t) => t.kind === "care.reposition" || t.kind === "care.weight_check"),
    ).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------

describe("care.md rule 13: an entry and the task it names (HZ-004, HZ-006)", () => {
  let round = "";
  const note = (
    user: keyof Harness["tokens"],
    taskId: string,
    body = "Turned onto the left side.",
  ) =>
    as(user, `/v1/people/${resident(3)}/notes`, {
      method: "POST",
      body: { category: "personal_care", body, occurredAt: ago(MIN), taskId },
    });

  it("hazard HZ-004 keeps an entry for a round its author may not complete, unlinked and flagged, with a review for the nurse in charge", async () => {
    round = await insertTask(resident(3), "care.reposition", new Date(Date.now() + HOUR), null, {
      permission: "care.plan.write",
    });
    const saved = await note("carer", round);
    expect(saved.status).toBe(201);
    const entry = await json<CareNoteItem>(saved);
    expect(entry).toMatchObject({ taskId: round, taskOutcome: "not_linked" });
    expect((await taskRow(round))?.status).toBe("open");
    const [review] = await reviewTasks(resident(3), "care.entry_review");
    expect(review).toMatchObject({ status: "open" });
    expect(review?.details?.entries).toEqual([
      expect.objectContaining({
        kind: "care_note",
        entryId: entry.id,
        taskId: round,
        outcome: "not_linked",
        recordedBy: DEMO.users.carer.id,
      }),
    ]);
  });

  it("hazard HZ-004 keeps a second entry for a round already done, flagged, on the same review", async () => {
    const done = await note("nurse", round);
    expect((await json<CareNoteItem>(done)).taskOutcome).toBe("completed");
    expect((await taskRow(round))?.status).toBe("done");
    const again = await note("nurse", round, "Turned again.");
    expect(again.status).toBe(201);
    expect((await json<CareNoteItem>(again)).taskOutcome).toBe("task_already_closed");
    const reviews = await reviewTasks(resident(3), "care.entry_review");
    expect(reviews).toHaveLength(1);
    expect(reviews[0]?.details?.entries?.map((e) => e.outcome)).toEqual([
      "not_linked",
      "task_already_closed",
    ]);
    // Read back, every entry says what it did to its round.
    const notes = await json<{ items: CareNoteItem[] }>(
      await as("nurse", `/v1/people/${resident(3)}/notes`),
    );
    expect(
      notes.items
        .filter((n) => n.taskId === round)
        .map((n) => n.taskOutcome)
        .sort(),
    ).toEqual(["completed", "not_linked", "task_already_closed"]);
  });

  it.each([
    ["a medicines task its author may not complete", "carer", "open"],
    ["a medicines task already done (a second dose?)", "nurse", "done"],
  ] as const)(
    "hazard HZ-004 keeps an entry for %s, never completing it, with an urgent conflict review (C2)",
    async (_label, user, taskStatus) => {
      // The care worker sees only the people they are assigned to.
      const who = user === "carer" ? resident(3) : await newResident("Tomos");
      const medicines = await insertTask(
        who,
        "medicines.round",
        new Date(Date.now() + HOUR),
        null,
        {
          permission: "medicines.cd.administer",
          status: taskStatus,
        },
      );
      const saved = await as(user, `/v1/people/${who}/notes`, {
        method: "POST",
        body: {
          category: "health",
          body: "Medicines round entry",
          occurredAt: ago(MIN),
          taskId: medicines,
        },
      });
      expect(saved.status).toBe(201);
      const entry = await json<CareNoteItem>(saved);
      expect(entry).toMatchObject({ taskId: medicines, taskOutcome: "medicines_conflict" });
      expect((await taskRow(medicines))?.status).toBe(taskStatus);
      const [review] = await reviewTasks(who, "care.entry_conflict_review");
      expect(review).toMatchObject({ status: "open" });
      expect((await taskRow(review?.id ?? ""))?.priority).toBe("urgent");
      expect(review?.details?.entries).toEqual([
        expect.objectContaining({ entryId: entry.id, outcome: "medicines_conflict" }),
      ]);
    },
  );

  it("hazard HZ-004 lets only one of two entries sent at once complete a round; the other is reviewed (C3)", async () => {
    const who = await newResident("Wyn");
    const turn = await insertTask(who, "care.reposition", new Date(Date.now() + HOUR));
    const send = (body: string) =>
      as("nurse", `/v1/people/${who}/notes`, {
        method: "POST",
        body: { category: "personal_care", body, occurredAt: ago(MIN), taskId: turn },
      });
    const [a, b] = await Promise.all([send("Turned left."), send("Turned left, again.")]);
    expect([a.status, b.status]).toEqual([201, 201]);
    const outcomes = [
      (await json<CareNoteItem>(a)).taskOutcome,
      (await json<CareNoteItem>(b)).taskOutcome,
    ].sort();
    expect(outcomes).toEqual(["completed", "task_already_closed"]);
    expect((await taskRow(turn))?.status).toBe("done");
    expect(await reviewTasks(who, "care.entry_review")).toHaveLength(1);
  });

  it("hazard HZ-004 sends a second medicines entry sent at once to the urgent conflict review (C3)", async () => {
    const who = await newResident("Ynyr");
    const dose = await insertTask(who, "medicines.round", new Date(Date.now() + HOUR), null, {
      permission: "care.note.write",
    });
    const send = (body: string) =>
      as("nurse", `/v1/people/${who}/notes`, {
        method: "POST",
        body: { category: "health", body, occurredAt: ago(MIN), taskId: dose },
      });
    const [a, b] = await Promise.all([send("Given."), send("Given (second device).")]);
    const outcomes = [
      (await json<CareNoteItem>(a)).taskOutcome,
      (await json<CareNoteItem>(b)).taskOutcome,
    ].sort();
    expect(outcomes).toEqual(["completed", "medicines_conflict"]);
    expect(await reviewTasks(who, "care.entry_conflict_review")).toHaveLength(1);
  });

  it("hazard HZ-004 reviews a second entry for a cancelled round that an entry already answered (C4)", async () => {
    const who = await newResident("Zac");
    const turn = await insertTask(who, "care.reposition", new Date(Date.now() + HOUR), null, {
      status: "cancelled",
    });
    const send = (body: string) =>
      as("nurse", `/v1/people/${who}/notes`, {
        method: "POST",
        body: { category: "personal_care", body, occurredAt: ago(MIN), taskId: turn },
      });
    expect((await json<CareNoteItem>(await send("Turned."))).taskOutcome).toBe("task_cancelled");
    expect((await json<CareNoteItem>(await send("Turned again."))).taskOutcome).toBe(
      "task_already_closed",
    );
    expect(await reviewTasks(who, "care.entry_review")).toHaveLength(1);
  });

  it("hazard HZ-004 returns a replayed medicines entry as it was stored, raising nothing again (S-L5)", async () => {
    const who = await newResident("Elis");
    const dose = await insertTask(who, "medicines.round", new Date(Date.now() + HOUR), null, {
      permission: "care.note.write",
    });
    const id = newId();
    const send = () =>
      as("nurse", `/v1/people/${who}/observations`, {
        method: "POST",
        body: {
          id,
          occurredAt: ago(MIN),
          taskId: dose,
          values: { chart: "repositioning", position: "left", skinChecked: true },
        },
      });
    const first = await json<ObservationItem>(await send());
    expect(first.taskOutcome).toBe("completed");
    const replay = await send();
    expect(replay.status).toBe(201);
    expect(await json<ObservationItem>(replay)).toMatchObject({ id, taskOutcome: "completed" });
    expect(await reviewTasks(who, "care.entry_conflict_review")).toHaveLength(0);
  });

  it("hazard HZ-004 keeps the urgent conflict review open when a death is recorded after it", async () => {
    const who = await newResident("Gethin");
    const dose = await insertTask(who, "medicines.round", new Date(ago(3 * HOUR)), null, {
      permission: "medicines.cd.administer",
      status: "done",
    });
    // A second dose recorded on a device before the death, uploaded after it but before the death
    // was recorded: its urgent review is due after the time of death.
    const saved = await as("nurse", `/v1/people/${who}/notes`, {
      method: "POST",
      body: { category: "health", body: "Given.", occurredAt: ago(2 * HOUR), taskId: dose },
    });
    expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("medicines_conflict");
    const [raised] = await reviewTasks(who, "care.entry_conflict_review");
    expect(raised).toMatchObject({ status: "open" });
    const died = await status(
      who,
      {
        to: "deceased",
        effectiveAt: ago(HOUR),
        exit: { deathExpected: true, placeOfDeath: "care_home", learningDisabilityOrAutism: false },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    expect(await taskRow(raised?.id ?? "")).toMatchObject({
      status: "open",
      cancel_code: null,
      priority: "urgent",
    });
  });
});

// ------------------------------------------------------------------------------------------------

describe("slice 8 review, round 4: rounds, assignments, exits and return checks", () => {
  const exitDetails = {
    deathExpected: true,
    placeOfDeath: "care_home",
    learningDisabilityOrAutism: false,
  };
  const hourlySeries = (personId: string, kind: string, materialisedHoursAgo: number) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task_series (person_id, location_id, kind, title, required_permission,
           recurrence, starts_on, materialised_until)
         VALUES ($1, $2, $3, 'Round', 'care.note.write',
           '{"freq":"every_hours","hours":1,"anchorTime":"00:00"}', '2026-09-01',
           now() - make_interval(hours => $4))
         RETURNING id`,
        [personId, DEMO.locationId, kind, materialisedHoursAgo],
      );
      return rows[0]?.id ?? "";
    });
  const seriesTasks = (seriesId: string) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{
        id: string;
        status: string;
        cancel_code: string | null;
        restore_code: string | null;
        due_at: Date;
        window_end: Date | null;
      }>(
        `SELECT id, status, cancel_code, restore_code, due_at, window_end FROM task
         WHERE series_id = $1 ORDER BY due_at`,
        [seriesId],
      );
      return rows;
    });

  it("hazard HZ-003 never makes a missed medicines dose due again after a late return: it is listed (C1)", async () => {
    const who = await newResident("Mared");
    const series = await hourlySeries(who, "medicines.round", -48);
    const dose = await insertTask(who, "medicines.round", new Date(ago(2 * HOUR)), series, {
      windowEnd: new Date(ago(1.5 * HOUR)),
    });
    expect(
      (await status(who, { to: "in_hospital", effectiveAt: ago(5 * HOUR) }, "nurse")).status,
    ).toBe(200);
    expect((await status(who, { to: "active", effectiveAt: ago(3 * HOUR) }, "nurse")).status).toBe(
      200,
    );
    expect(await taskRow(dose)).toMatchObject({
      status: "cancelled",
      cancel_code: "missed_before_return_recorded",
    });
    const [review] = await reviewTasks(who, "people.missed_rounds_review");
    expect(review?.details?.missedTasks).toEqual([
      expect.objectContaining({ taskId: dose, kind: "medicines.round", reopened: false }),
    ]);
  });

  it("hazard HZ-003 makes the rounds a stay longer than the 48-hour horizon would have had, from the return, and catches up once (C5)", async () => {
    const who = await newResident("Nest");
    // The series stopped making tasks a day ago (the horizon ran out while the person was away).
    const series = await hourlySeries(who, "care.reposition", 24);
    expect(
      (await status(who, { to: "in_hospital", effectiveAt: ago(72 * HOUR) }, "nurse")).status,
    ).toBe(200);
    const returnedAt = ago(3.5 * HOUR);
    expect((await status(who, { to: "active", effectiveAt: returnedAt }, "nurse")).status).toBe(
      200,
    );
    const tasks = await seriesTasks(series);
    const past = tasks.filter((t) => t.due_at.getTime() < Date.now() - MIN);
    // Every hour since the return has its round (the one caught up is now due now); nothing from
    // before the return was made.
    const caughtUp = tasks.filter((t) => t.restore_code === "caught_up");
    expect(past.length + caughtUp.length).toBeGreaterThanOrEqual(3);
    expect(past.every((t) => t.due_at.getTime() >= new Date(returnedAt).getTime())).toBe(true);
    // One round is caught up, with a fresh window; the others are missed and listed.
    expect(caughtUp).toHaveLength(1);
    expect(caughtUp[0]?.status).toBe("open");
    expect(caughtUp[0]?.due_at.getTime()).toBeGreaterThan(Date.now() - MIN);
    expect(
      past
        .filter((t) => t.restore_code !== "caught_up")
        .every((t) => t.cancel_code === "missed_before_return_recorded"),
    ).toBe(true);
    const [review] = await reviewTasks(who, "people.missed_rounds_review");
    // The review lists every round of the gap: the missed ones and the one caught up.
    expect(review?.details?.missedTasks?.length).toBe(past.length + 1);
    // Nothing else in the past is open: no extra overdue round (C5).
    expect(past.filter((t) => t.status === "open" && t.restore_code !== "caught_up")).toEqual([]);
  });

  it("hazard HZ-003 adds no extra overdue round to a correction made long after the exit (C5)", async () => {
    const who = await newResident("Osian");
    const series = await hourlySeries(who, "care.reposition", -48);
    expect(
      (
        await status(
          who,
          { to: "deceased", effectiveAt: ago(60 * HOUR), exit: exitDetails },
          "nurse",
        )
      ).status,
    ).toBe(200);
    // The horizon had run out 12 hours ago.
    await asDemoTenant((c) =>
      c.query(
        "UPDATE task_series SET materialised_until = now() - interval '12 hours' WHERE id = $1",
        [series],
      ),
    );
    await setSessionAge("manager", 0);
    expect(
      (await status(who, { to: "active", reason: "Recorded against the wrong person" })).status,
    ).toBe(200);
    const tasks = await seriesTasks(series);
    const pastOpen = tasks.filter(
      (t) => t.status === "open" && t.due_at.getTime() < Date.now() - MIN,
    );
    expect(pastOpen).toEqual([]);
    expect(tasks.filter((t) => t.restore_code === "caught_up")).toHaveLength(1);
    const gap = tasks.filter(
      (t) => t.due_at.getTime() >= Date.now() - 12 * HOUR && t.due_at.getTime() < Date.now() - MIN,
    );
    expect(gap.length).toBeGreaterThanOrEqual(10);
    // The catch-up is due now with a fresh window; every other round of the gap is missed.
    expect(gap.every((t) => t.cancel_code === "missed_before_return_recorded")).toBe(true);
  });

  it("hazard HZ-003 restores the status and the rounds when a death is corrected after its exit workflow has closed (C6)", async () => {
    const who = await newResident("Pryderi");
    const series = await insertRoundSeries(who);
    const turn = await insertTask(who, "care.reposition", new Date(Date.now() + 2 * HOUR), series);
    expect(
      (
        await status(
          who,
          { to: "deceased", effectiveAt: ago(30 * MIN), exit: exitDetails },
          "nurse",
        )
      ).status,
    ).toBe(200);
    expect((await taskRow(turn))?.status).toBe("cancelled");
    const exit = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `UPDATE exit_record SET state = 'closed', closed_at = now() WHERE person_id = $1
         RETURNING id`,
        [who],
      );
      return rows[0]?.id ?? "";
    });
    await setSessionAge("manager", 0);
    const corrected = await status(who, {
      to: "active",
      reason: "Recorded against the wrong person",
    });
    expect(corrected.status).toBe(200);
    expect((await summary(who)).status).toBe("active");
    expect(await taskRow(turn)).toMatchObject({ status: "open", cancel_code: null });
    const events = await asDemoTenant((c) =>
      c.query<{ payload: { exitRecordId: string | null } }>(
        `SELECT payload FROM outbox_event WHERE aggregate_id = $1
         AND event_type = 'people.person.status_corrected'`,
        [who],
      ),
    );
    expect(events.rows[0]?.payload.exitRecordId).toBe(exit);
  });

  it("hazards HZ-004 and HZ-005 never gives a task to someone who cannot complete it, through the assign route itself (S1)", async () => {
    const who = resident(1);
    // A clinical return check: being its assignee would let someone record it (M2).
    const dose = await insertTask(
      who,
      "people.return_check.medicines_reconciled",
      new Date(Date.now() + HOUR),
      null,
      { permission: "care.plan.write" },
    );
    const assign = async (user: keyof Harness["tokens"], assignee: string) => {
      const row = await asDemoTenant((c) =>
        c.query<{ version: number }>("SELECT version FROM task WHERE id = $1", [dose]),
      );
      return as(user, `/v1/tasks/${dose}/assign`, {
        method: "POST",
        body: { assigneeTenantUserId: assignee, version: row.rows[0]?.version ?? 1 },
      });
    };
    // A team leader may manage tasks but may not give themselves a check they may not complete.
    const assignment = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO role_assignment (tenant_user_id, role_id, location_id)
         SELECT $1, id, $2 FROM role WHERE key = 'team_leader' AND is_builtin RETURNING id`,
        [DEMO.users.carer.id, DEMO.locationId],
      );
      return rows[0]?.id ?? "";
    });
    try {
      const self = await assign("carer", DEMO.users.carer.id);
      expect(self.status).toBe(422);
      expect(await auditCount("platform.task.assign", dose, "denied")).toBe(1);
    } finally {
      await asDemoTenant((c) =>
        c.query("UPDATE role_assignment SET deleted_at = now() WHERE id = $1", [assignment]),
      );
    }
    // Nor does anyone else give it to them.
    expect((await assign("manager", DEMO.users.carer.id)).status).toBe(422);
    expect(
      (await taskRow(dose)) as unknown as { assignee_tenant_user_id?: string },
    ).not.toMatchObject({
      assignee_tenant_user_id: DEMO.users.carer.id,
    });
    // Someone who holds its permission there may be given it.
    expect((await assign("manager", DEMO.users.nurse.id)).status).toBe(200);
  });

  it.each([
    [
      "has expired",
      `UPDATE access_grant SET valid_from = now() - interval '2 hours',
         valid_to = now() - interval '1 minute' WHERE id = $1`,
    ],
    ["has been revoked", "UPDATE access_grant SET revoked_at = now() WHERE id = $1"],
  ])(
    "hazards HZ-004 and HZ-005 stop an assignee completing a clinical task once their acting-up grant %s, by the task route or by an entry (S1 follow-on)",
    async (_label, endGrant) => {
      const who = resident(3);
      // A falls review needs the care plan, which a care worker does not hold.
      const review = () =>
        insertTask(who, "care.falls_review", new Date(Date.now() + 10 * MIN), null, {
          permission: "care.plan.write",
        });
      const [byRoute, byEntry, control] = [await review(), await review(), await review()];
      const version = async (id: string) =>
        (
          await asDemoTenant((c) =>
            c.query<{ version: number }>("SELECT version FROM task WHERE id = $1", [id]),
          )
        ).rows[0]?.version ?? 1;
      const move = async (id: string, to: string, reason?: string) =>
        as("carer", `/v1/tasks/${id}/transition`, {
          method: "POST",
          body: { to, reason, version: await version(id) },
        });
      // The care worker acts up as a senior for the shift, and is given the reviews.
      const grant = await asDemoTenant(async (c) => {
        const { rows } = await c.query<{ id: string }>(
          `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_from, valid_to,
             reason, granted_by)
           VALUES ($1, '{care.plan.write}', $2, now() - interval '1 hour',
             now() + interval '1 hour', 'Acting up as senior carer', $3) RETURNING id`,
          [DEMO.users.carer.id, DEMO.locationId, DEMO.users.manager.id],
        );
        return rows[0]?.id ?? "";
      });
      try {
        for (const id of [byRoute, byEntry, control]) {
          const assigned = await as("manager", `/v1/tasks/${id}/assign`, {
            method: "POST",
            body: { assigneeTenantUserId: DEMO.users.carer.id, version: await version(id) },
          });
          expect(assigned.status).toBe(200);
        }
        // While the grant holds, the assignee completes the task.
        expect((await move(control, "done")).status).toBe(200);
        await asDemoTenant((c) => c.query(endGrant, [grant]));
        // Then the task route refuses to mark it done or skipped, and audits each refusal.
        expect((await move(byRoute, "done")).status).toBe(403);
        expect((await move(byRoute, "skipped", "Not needed")).status).toBe(403);
        expect(await auditCount("platform.task.done", byRoute, "denied")).toBe(1);
        expect(await auditCount("platform.task.skipped", byRoute, "denied")).toBe(1);
        expect((await taskRow(byRoute))?.status).toBe("open");
        // And an entry recorded now, after the grant ended, is kept but does not complete it: it
        // is reviewed instead.
        const saved = await as("carer", `/v1/people/${who}/notes`, {
          method: "POST",
          body: {
            category: "health",
            body: "Falls reviewed.",
            occurredAt: new Date().toISOString(),
            taskId: byEntry,
          },
        });
        expect(saved.status).toBe(201);
        expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("not_linked");
        expect((await taskRow(byEntry))?.status).toBe("open");
        expect(await auditCount("platform.task.done", byEntry, "denied")).toBe(1);
      } finally {
        await asDemoTenant((c) =>
          c.query(
            "UPDATE access_grant SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
            [grant],
          ),
        );
      }
    },
  );

  /** An acting-up grant for the care worker at the demo location, from and to hours from now. */
  const actingUp = (permission: string, fromHours: number, toHours: number) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO access_grant (tenant_user_id, permissions, location_id, valid_from, valid_to,
           reason, granted_by)
         VALUES ($1, ARRAY[$2], $3, now() + make_interval(secs => $4 * 3600),
           now() + make_interval(secs => $5 * 3600), 'Acting up as senior carer', $6) RETURNING id`,
        [
          DEMO.users.carer.id,
          permission,
          DEMO.locationId,
          fromHours,
          toHours,
          DEMO.users.manager.id,
        ],
      );
      return rows[0]?.id ?? "";
    });
  const endGrant = (grant: string, sql: string) => asDemoTenant((c) => c.query(sql, [grant]));
  const revokeGrant = (grant: string) =>
    endGrant(
      grant,
      "UPDATE access_grant SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    );
  /**
   * A medicines round the series made the day before, so it existed when the care was given
   * (`created_at` never changes after insert).
   */
  const doseMadeYesterday = (who: string) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task (person_id, location_id, kind, title, required_permission, due_at,
           created_at)
         VALUES ($1, $2, 'medicines.round', 'Task for the test', 'medicines.cd.administer',
           now() - interval '40 minutes', now() - interval '1 day') RETURNING id`,
        [who, DEMO.locationId],
      );
      return rows[0]?.id ?? "";
    });
  /** The entries listed on the person's urgent conflict reviews. */
  const conflictEntries = async (who: string) =>
    (await reviewTasks(who, "care.entry_conflict_review")).reduce(
      (n, r) => n + (r.details?.entries?.length ?? 0),
      0,
    );
  const giveDose = (taskId: string, occurredAt: string) =>
    as("carer", `/v1/people/${resident(3)}/notes`, {
      method: "POST",
      body: { category: "health", body: "Dose given.", occurredAt, taskId },
    });

  it("hazard HZ-004 completes a medicines round with an entry recorded under a grant that ended before upload", async () => {
    const who = resident(3);
    const [own, other] = [await doseMadeYesterday(who), await doseMadeYesterday(who)];
    const reviewsBefore = await conflictEntries(who);
    // The care worker acts up for the evening medicines round; one dose is given to them.
    const grant = await actingUp("medicines.cd.administer", -3, 1);
    try {
      const version = (
        await asDemoTenant((c) =>
          c.query<{ version: number }>("SELECT version FROM task WHERE id = $1", [own]),
        )
      ).rows[0]?.version;
      const assigned = await as("manager", `/v1/tasks/${own}/assign`, {
        method: "POST",
        body: { assigneeTenantUserId: DEMO.users.carer.id, version },
      });
      expect(assigned.status).toBe(200);
      // The doses are given offline at the end of the shift; the grant ends before the device
      // uploads.
      await endGrant(
        grant,
        "UPDATE access_grant SET valid_to = now() - interval '5 minutes' WHERE id = $1",
      );
      for (const dose of [own, other]) {
        const saved = await giveDose(dose, ago(30 * MIN));
        expect(saved.status).toBe(201);
        expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("completed");
        expect((await taskRow(dose))?.status).toBe("done");
      }
      // Nothing is left open or raised as a second dose.
      expect(await conflictEntries(who)).toBe(reviewsBefore);
      expect(await auditCount("platform.task.done", own, "denied")).toBe(0);
    } finally {
      await revokeGrant(grant);
    }
  });

  it("hazard HZ-004 refuses an entry recorded before a grant was revoked: a revocation counts from when it is made", async () => {
    const who = resident(3);
    const dose = await doseMadeYesterday(who);
    const reviewsBefore = await conflictEntries(who);
    const grant = await actingUp("medicines.cd.administer", -3, 1);
    await revokeGrant(grant);
    // Recorded half an hour ago, while the grant still stood, and uploaded after its revocation.
    const saved = await giveDose(dose, ago(30 * MIN));
    expect(saved.status).toBe(201);
    expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("medicines_conflict");
    expect((await taskRow(dose))?.status).toBe("open");
    expect(await conflictEntries(who)).toBe(reviewsBefore + 1);
  });

  it("hazard HZ-004 does not let an entry backdated to an earlier grant complete a task made after it ended", async () => {
    const who = resident(3);
    // A grant that ended two days ago, and a dose the series made yesterday.
    const grant = await actingUp("medicines.cd.administer", -72, -48);
    try {
      const dose = await doseMadeYesterday(who);
      const saved = await giveDose(dose, ago(60 * HOUR));
      expect(saved.status).toBe(201);
      expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("medicines_conflict");
      expect((await taskRow(dose))?.status).toBe("open");
    } finally {
      await revokeGrant(grant);
    }
  });

  it("hazards HZ-004 and HZ-005 let a care worker acting up complete a task by the task route and by an entry, reading their own roles and grants under row-level security", async () => {
    const who = resident(3);
    const review = () =>
      insertTask(who, "care.falls_review", new Date(Date.now() + 10 * MIN), null, {
        permission: "care.plan.write",
      });
    const [byRoute, byEntry] = [await review(), await review()];
    const grant = await actingUp("care.plan.write", -1, 1);
    const asCareWorker = (taskId: string) =>
      withRequestContext(
        deps.appDb,
        {
          tenantId: DEMO.tenantId,
          userId: DEMO.users.carer.id,
          scope: "assigned",
          locationIds: [],
        },
        (tx) =>
          assigneeMayComplete(
            tx,
            DEMO.users.carer.id,
            {
              kind: "care.falls_review",
              assigneeTenantUserId: DEMO.users.carer.id,
              requiredPermission: "care.plan.write",
              locationId: DEMO.locationId,
            },
            new Date(),
          ).then((may) => ({ taskId, may })),
      );
    try {
      for (const id of [byRoute, byEntry]) {
        const version = (
          await asDemoTenant((c) =>
            c.query<{ version: number }>("SELECT version FROM task WHERE id = $1", [id]),
          )
        ).rows[0]?.version;
        const assigned = await as("manager", `/v1/tasks/${id}/assign`, {
          method: "POST",
          body: { assigneeTenantUserId: DEMO.users.carer.id, version },
        });
        expect(assigned.status).toBe(200);
      }
      // Read as the care worker, under row-level security, their own grant and roles say yes.
      expect((await asCareWorker(byRoute)).may).toBe(true);
      const version = (
        await asDemoTenant((c) =>
          c.query<{ version: number }>("SELECT version FROM task WHERE id = $1", [byRoute]),
        )
      ).rows[0]?.version;
      const done = await as("carer", `/v1/tasks/${byRoute}/transition`, {
        method: "POST",
        body: { to: "done", version },
      });
      expect(done.status).toBe(200);
      const saved = await as("carer", `/v1/people/${who}/notes`, {
        method: "POST",
        body: {
          category: "health",
          body: "Falls reviewed.",
          occurredAt: ago(MIN),
          taskId: byEntry,
        },
      });
      expect((await json<CareNoteItem>(saved)).taskOutcome).toBe("completed");
      // Once the grant is revoked the same read says no.
      await revokeGrant(grant);
      expect((await asCareWorker(byEntry)).may).toBe(false);
    } finally {
      await revokeGrant(grant);
    }
  });

  it("audits a refused completion once, for the upload that saved the entry, when a duplicate upload races it", async () => {
    const who = resident(3);
    const turn = await insertTask(who, "care.falls_review", new Date(Date.now() + 10 * MIN), null, {
      permission: "care.plan.write",
    });
    // Given to the care worker directly, as before the assignment check, without the permission.
    await asDemoTenant((c) =>
      c.query("UPDATE task SET assignee_tenant_user_id = $1 WHERE id = $2", [
        DEMO.users.carer.id,
        turn,
      ]),
    );
    const id = newId();
    const send = () =>
      as("carer", `/v1/people/${who}/notes`, {
        method: "POST",
        body: {
          id,
          category: "health",
          body: "Falls reviewed.",
          occurredAt: ago(MIN),
          taskId: turn,
        },
      });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(await auditCount("platform.task.done", turn, "denied")).toBe(1);
  });

  it("hazard HZ-005 keeps belongings with whoever records movements when the check has no task (S-L8)", async () => {
    const who = await newResident("Tegid");
    const item = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO property_item (person_id, description, category, received_on, recorded_by,
           ack_signer, ack_name, ack_signed_at)
         VALUES ($1, 'Glasses in a red case', 'sensory_aid', '2026-09-01', $2, 'person',
           'Signed by the person', now() - interval '30 days') RETURNING id`,
        [who, DEMO.users.manager.id],
      );
      return rows[0]?.id ?? "";
    });
    const sentResponse = await as("nurse", `/v1/people/${who}/hospital-transfers`, {
      method: "POST",
      body: {
        leftAt: new Date().toISOString(),
        hospitalName: "Example General Hospital",
        reason: "A fall.",
        sendItemIds: [item],
        version: (await summary(who)).version,
      },
    });
    expect(sentResponse.status).toBe(201);
    let transfer = await json<HospitalTransferOut>(sentResponse);
    const back = await as("nurse", `/v1/people/${who}/hospital-transfers/${transfer.id}/return`, {
      method: "POST",
      body: { returnedAt: new Date().toISOString(), version: transfer.version },
    });
    expect(back.status).toBe(200);
    transfer = await json<HospitalTransferOut>(back);
    // The checks' tasks are gone (a checklist made before the tasks existed, say).
    await asDemoTenant((c) =>
      c.query(
        "UPDATE task SET deleted_at = now() WHERE source_type = 'hospital_transfer' AND source_id = $1",
        [transfer.id],
      ),
    );
    // The quality lead holds the care plan for a day, but does not record movements.
    const grant = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO access_grant (tenant_user_id, permissions, location_id, organisation_wide,
           valid_from, valid_to, reason, granted_by)
         VALUES ($1, '{care.plan.write}', NULL, true, now() - interval '1 minute',
           now() + interval '1 day', 'Covering the nurse in charge', $2) RETURNING id`,
        [LODGE.qualityLeadId, DEMO.users.manager.id],
      );
      return rows[0]?.id ?? "";
    });
    try {
      const check = (key: string) =>
        as("quality", `/v1/people/${who}/hospital-transfers/${transfer.id}/return-checks/${key}`, {
          method: "POST",
          body: { version: transfer.version },
        });
      const belongings = await check("belongings_returned");
      expect(belongings.status).toBe(403);
      expect(await auditCount("people.hospital_transfer.return_check", transfer.id, "denied")).toBe(
        1,
      );
      const medicines = await check("medicines_reconciled");
      expect(medicines.status).toBe(200);
    } finally {
      await asDemoTenant((c) =>
        c.query("UPDATE access_grant SET revoked_at = now() WHERE id = $1", [grant]),
      );
    }
  });

  it("refuses, and audits, an exit item whose stored owner disagrees with its definition (S-L8)", async () => {
    const who = await newResident("Urien");
    expect(
      (
        await status(
          who,
          { to: "deceased", effectiveAt: ago(10 * MIN), exit: exitDetails },
          "nurse",
        )
      ).status,
    ).toBe(200);
    const item = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string; version: number }>(
        `UPDATE exit_checklist_item SET owner = 'finance'
         WHERE person_id = $1 AND item_key = 'gp_informed' RETURNING id, version`,
        [who],
      );
      return rows[0];
    });
    expect(item).toBeDefined();
    const response = await as("manager", `/v1/people/${who}/exit/items/gp_informed`, {
      method: "PUT",
      body: { status: "done", version: item?.version ?? 1 },
    });
    expect(response.status).toBe(403);
    expect(await auditCount("people.exit.item", item?.id ?? "", "denied")).toBe(1);
  });

  it("keeps only an opaque device id from the request header (S-L6)", async () => {
    const who = await newResident("Rhian");
    const send = (device: string) =>
      as("nurse", `/v1/people/${who}/notes`, {
        method: "POST",
        headers: { "x-harbour-device": device },
        body: { category: "other", body: "A note.", occurredAt: ago(MIN) },
      });
    // The device id is the PowerSync client id, a UUID (kept in lower case); nothing else is kept.
    const opaque = await json<CareNoteItem>(await send("0193A000-0000-7000-8000-00000000D007"));
    const token = await json<CareNoteItem>(await send("tablet-7"));
    const prose = await json<CareNoteItem>(await send("Ada Example's phone <script>"));
    const devices = await asDemoTenant((c) =>
      c.query<{ id: string; device_id: string | null }>(
        "SELECT id, device_id FROM care_note WHERE id = ANY ($1)",
        [[opaque.id, token.id, prose.id]],
      ),
    );
    expect(new Map(devices.rows.map((r) => [r.id, r.device_id]))).toEqual(
      new Map([
        [opaque.id, "0193a000-0000-7000-8000-00000000d007"],
        [token.id, null],
        [prose.id, null],
      ]),
    );
  });

  const roundSeries = (
    personId: string,
    kind: string,
    everyHours: number,
    materialisedHoursAgo: number,
  ) =>
    asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO task_series (person_id, location_id, kind, title, required_permission,
           recurrence, starts_on, materialised_until)
         VALUES ($1, $2, $3, 'Round', 'care.note.write',
           jsonb_build_object('freq', 'every_hours', 'hours', $4::int, 'anchorTime', '00:00'),
           '2026-09-01', now() - make_interval(hours => $5))
         RETURNING id`,
        [personId, DEMO.locationId, kind, everyHours, materialisedHoursAgo],
      );
      return rows[0]?.id ?? "";
    });
  const correctDeath = async (who: string, diedHoursAgo: number) => {
    expect(
      (
        await status(
          who,
          { to: "deceased", effectiveAt: ago(diedHoursAgo * HOUR), exit: exitDetails },
          "nurse",
        )
      ).status,
    ).toBe(200);
    await setSessionAge("manager", 0);
    expect(
      (await status(who, { to: "active", reason: "Recorded against the wrong person" })).status,
    ).toBe(200);
  };

  it("hazards HZ-003 and HZ-008 list every missed dose first, then the newest rounds, counting only the rest (M2)", async () => {
    const who = await newResident("Rhodri");
    const doses = await roundSeries(who, "medicines.round", 8, 60);
    const turns = await roundSeries(who, "care.reposition", 1, 60);
    await correctDeath(who, 60);
    const doseRounds = (await seriesTasks(doses)).filter(
      (t) => t.cancel_code === "missed_before_return_recorded",
    );
    const turnRounds = (await seriesTasks(turns)).filter(
      (t) => t.cancel_code === "missed_before_return_recorded" || t.restore_code === "caught_up",
    );
    expect(doseRounds.length).toBeGreaterThanOrEqual(6);
    expect(turnRounds.length).toBeGreaterThan(50);
    const [review] = await reviewTasks(who, "people.missed_rounds_review");
    const listed = review?.details?.missedTasks ?? [];
    const kinds = listed.map((m) => m.kind);
    // Every missed dose is listed, first, newest first.
    expect(kinds.slice(0, doseRounds.length).every((k) => k === "medicines.round")).toBe(true);
    expect(
      new Set(listed.filter((m) => m.kind === "medicines.round").map((m) => m.taskId)),
    ).toEqual(new Set(doseRounds.map((t) => t.id)));
    const newestFirst = (items: typeof listed) =>
      items.every(
        (m, n) => n === 0 || Date.parse(m.dueAt) <= Date.parse(items[n - 1]?.dueAt ?? ""),
      );
    expect(newestFirst(listed.slice(0, doseRounds.length))).toBe(true);
    // Then the newest of the rest (the one caught up first), up to 50 in all; the rest counted.
    const rest = listed.slice(doseRounds.length);
    expect(rest[0]?.reopened).toBe(true);
    expect(newestFirst(rest)).toBe(true);
    expect(listed).toHaveLength(50);
    expect(review?.details?.missedTasksOmitted).toBe(turnRounds.length - rest.length);
    expect(review?.details?.missedTasksNotListedBefore).toBeUndefined();
  });

  it("hazard HZ-003 says from which date rounds are not all listed when a correction comes more than seven days after the exit (M2)", async () => {
    const who = await newResident("Seren");
    const turns = await roundSeries(who, "care.reposition", 4, 10 * 24);
    await correctDeath(who, 10 * 24);
    const start = restoreLookbackStart(new Date(), 7);
    const tasks = await seriesTasks(turns);
    // Nothing before the look back was made, and the rounds after it were.
    expect(tasks.filter((t) => t.due_at.getTime() < start.getTime())).toEqual([]);
    expect(tasks.filter((t) => t.due_at.getTime() < Date.now()).length).toBeGreaterThan(30);
    const [review] = await reviewTasks(who, "people.missed_rounds_review");
    expect(review?.details?.missedTasksNotListedBefore).toBe(ukIsoDate(start));
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
      // Break-glass searches: one that showed someone at the lodge, one that showed no one.
      for (const shown of [[LODGE.locationId], []]) {
        await c.query(
          `INSERT INTO break_glass_event (tenant_user_id, kind, person_id, shown_location_ids,
             justification, opened_at, expires_at, reason_code)
           VALUES ($1, 'search', NULL, $2::uuid[], 'Ambulance crew asking about a resident', $3, $3,
             'emergency_care')`,
          [DEMO.users.owner.id, shown, at],
        );
      }
    });
    expect(await reportBreakGlass(deps)).toBeGreaterThanOrEqual(2);
    expect(await reportBreakGlass(deps)).toBe(0);
    // Searches are reported weekly too: each home's report lists those that showed its people;
    // a search that showed no one at any home is in each report's tenant-level section, never in
    // a home's own searches (review round 1).
    const stored = await asDemoTenant((c) =>
      c.query<{
        location: string;
        searches: { total: number; byUser: { tenantUserId: string }[] };
        unplaced: { total: number; byUser: { tenantUserId: string }[] };
      }>(
        `SELECT location_id AS location, summary->'searches' AS searches,
                summary->'unplacedSearches' AS unplaced
         FROM break_glass_weekly_report WHERE week_start = $1`,
        [week.start],
      ),
    );
    const searchesAt = new Map(stored.rows.map((r) => [r.location, r.searches]));
    expect(searchesAt.get(LODGE.locationId)?.total).toBe(1);
    expect(searchesAt.get(DEMO.locationId)?.total).toBe(0);
    expect(searchesAt.get(LODGE.locationId)?.byUser.map((u) => u.tenantUserId)).toEqual([
      DEMO.users.owner.id,
    ]);
    for (const row of stored.rows) {
      expect(row.unplaced.total).toBe(1);
      expect(row.unplaced.byUser.map((u) => u.tenantUserId)).toEqual([DEMO.users.owner.id]);
    }
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
    // The staff it counts are named for attribution (display name and job title only), so a
    // reader who cannot list the members still sees who used break-glass.
    // The manager's openings only: the owner's search that showed no one at any home is in the
    // tenant-level section, which a location's manager neither reads nor is told the names of.
    expect(report?.staff.map((s) => s.id)).toEqual([DEMO.users.manager.id]);
    expect(report?.summary).not.toHaveProperty("unplacedSearches");
    expect(Object.keys(report?.staff[0] ?? {}).sort()).toEqual(["displayName", "id", "jobTitle"]);
    expect(JSON.stringify(report?.staff)).not.toContain("@");
    const quality = await json<BreakGlassWeeklyReportList>(
      await as("quality", "/v1/break-glass/weekly-report"),
    );
    expect(quality.items.map((r) => r.locationId).sort()).toEqual(
      [DEMO.locationId, LODGE.locationId].sort(),
    );
    // Across the organisation, the tenant-level section and its searcher's name are there.
    const demoForQuality = quality.items.find((r) => r.locationId === DEMO.locationId);
    expect(demoForQuality?.summary).toHaveProperty("unplacedSearches.total", 1);
    expect(demoForQuality?.staff.map((s) => s.id)).toContain(DEMO.users.owner.id);
    // The view is audited with the ids of the reports shown (review round 1).
    const viewed = await asDemoTenant((c) =>
      c.query<{ scope: { reportIds: string[]; organisationWide: boolean } }>(
        `SELECT scope FROM audit_event WHERE action = 'platform.break_glass_report.view'
         ORDER BY chain_position DESC LIMIT 1`,
      ),
    );
    expect([...(viewed.rows[0]?.scope.reportIds ?? [])].sort()).toEqual(
      quality.items.map((r) => r.id).sort(),
    );
    // And whether the organisation-wide section was shown (security re-review I-3).
    expect(viewed.rows[0]?.scope.organisationWide).toBe(true);
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

  /** A report stored for an earlier week with the summary given, for the review rules. */
  async function storedReport(weekStart: string, summary: Record<string, unknown>) {
    const start = new Date(weekStart);
    const rows = await asDemoTenant((c) =>
      c.query<{ id: string }>(
        `INSERT INTO break_glass_weekly_report (tenant_id, location_id, week_start, week_end,
           repeat_threshold, summary)
         VALUES (app.current_tenant_id(), $1, $2, $3, 3, $4) RETURNING id`,
        [
          DEMO.locationId,
          start,
          new Date(start.getTime() + 7 * 24 * HOUR),
          JSON.stringify(summary),
        ],
      ),
    );
    return `/v1/break-glass/weekly-report/${rows.rows[0]?.id}/review`;
  }
  const quiet = {
    totalEvents: 0,
    byUser: [],
    byPerson: [],
    byReason: [],
    flagged: [],
    searches: { total: 0, distinctUsers: 0, byUser: [], byReason: [] },
    unplacedSearches: { total: 0, distinctUsers: 0, byUser: [], byReason: [] },
  };
  const body = { actionsTaken: "Reviewed the week." };

  it.each([
    [
      "flagged only for repeated searching",
      "2026-01-05T00:00:00Z",
      {
        searches: {
          total: 3,
          distinctUsers: 1,
          byUser: [{ tenantUserId: DEMO.users.owner.id, searches: 3, flags: ["repeated_use"] }],
          byReason: [],
        },
      },
    ],
    [
      "counted below the threshold",
      "2026-01-12T00:00:00Z",
      {
        totalEvents: 1,
        byUser: [
          {
            tenantUserId: DEMO.users.owner.id,
            events: 1,
            people: 1,
            unreviewed: 1,
            flags: [],
            eventIds: [],
          },
        ],
      },
    ],
    [
      "counted only in the searches that showed no one at any location",
      "2026-01-19T00:00:00Z",
      {
        unplacedSearches: {
          total: 1,
          distinctUsers: 1,
          byUser: [{ tenantUserId: DEMO.users.owner.id, searches: 1, flags: [] }],
          byReason: [],
        },
      },
    ],
  ])(
    "refuses a review by someone the report counts: %s (review round 1)",
    async (_, week, extra) => {
      const path = await storedReport(week, { ...quiet, ...extra });
      const own = await as("owner", path, { method: "POST", body });
      expect(own.status).toBe(403);
      expect(await code(own)).toBe("separation_of_duties");
      // Someone it does not count may.
      expect((await as("quality", path, { method: "POST", body })).status).toBe(201);
    },
  );

  it("names a report's searchers to a location's reader only when it keeps the searches that showed no one apart (security re-review L-1)", async () => {
    // A report stored before the organisation-wide section: its searches may include some that
    // showed no one at any location, so a location's manager is not told who searched.
    const { unplacedSearches: _none, ...oldShape } = quiet;
    const path = await storedReport("2026-01-26T00:00:00Z", {
      ...oldShape,
      totalEvents: 1,
      byUser: [
        {
          tenantUserId: DEMO.users.nurse.id,
          events: 1,
          people: 1,
          unreviewed: 1,
          flags: [],
          eventIds: [],
        },
      ],
      searches: {
        total: 1,
        distinctUsers: 1,
        byUser: [{ tenantUserId: DEMO.users.owner.id, searches: 1, flags: [], eventIds: [] }],
        byReason: [],
      },
    });
    const read = async (user: "manager" | "quality") =>
      (
        await json<BreakGlassWeeklyReportList>(
          await as(user, "/v1/break-glass/weekly-report?week=2026-01-28"),
        )
      ).items.find((r) => r.locationId === DEMO.locationId && r.supersedesId === null);
    const manager = await read("manager");
    expect(manager?.staff.map((s) => s.id)).toEqual([DEMO.users.nurse.id]);
    // Across the organisation, everyone it counts is named.
    const quality = await read("quality");
    expect(quality?.staff.map((s) => s.id).sort()).toEqual(
      [DEMO.users.nurse.id, DEMO.users.owner.id].sort(),
    );
    // Separation of duties still counts the searcher.
    const own = await as("owner", path, { method: "POST", body });
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
    const reviewed = (await first.json()) as BreakGlassWeeklyReportList["items"][number];
    expect(reviewed.staff.map((s) => s.id)).toContain(LODGE.qualityLeadId);
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

describe("slice 8 review, round 3: refusals and records that belong elsewhere", () => {
  it("hazard HZ-001 refuses a send list holding something that is not an item id", async () => {
    for (const path of [
      `/v1/people/${resident(1)}/transfer-pack`,
      `/v1/people/${resident(1)}/hospital-transfers`,
    ]) {
      const response = await as("nurse", path, {
        method: "POST",
        body: {
          leftAt: new Date().toISOString(),
          hospitalName: "Example General Hospital",
          sendItemIds: ["not-an-item"],
          version: (await summary(resident(1))).version,
        },
      });
      expect([400, 422], path).toContain(response.status);
    }
    expect((await summary(resident(1))).status).toBe("active");
  });

  it("hazard HZ-011 refuses the printed pack to someone who may only read the person", async () => {
    const list = await json<{ items: HospitalTransferOut[] }>(
      await as("nurse", `/v1/people/${resident(1)}/hospital-transfers`),
    );
    const pdf = await as(
      "quality",
      `/v1/people/${resident(1)}/hospital-transfers/${list.items[0]?.id}/pdf`,
    );
    expect(pdf.status).toBe(403);
    expect((await as("quality", `/v1/people/${resident(1)}/hospital-transfers`)).status).toBe(403);
  });

  it("hazard HZ-011 shows an assigned care worker the board of their own home only", async () => {
    expect((await as("carer", `/v1/locations/${DEMO.locationId}/beds`)).status).toBe(200);
    expect((await as("carer", `/v1/locations/${LODGE.locationId}/beds`)).status).toBe(404);
  });

  it("hazard HZ-022 refuses authority evidence filed against another person, or deleted", async () => {
    // The attorney for property and financial affairs, as the contact who holds the authority.
    const contactId = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO contact (person_id, role, given_name, family_name, relationship)
         VALUES ($1, 'lpa_property_finance', 'Bryn', 'Example', 'Son') RETURNING id`,
        [resident(3)],
      );
      return rows[0]?.id ?? "";
    });
    const deleted = await insertDocument(resident(3));
    await asDemoTenant((c) =>
      c.query("UPDATE document SET deleted_at = now() WHERE id = $1", [deleted]),
    );
    for (const evidenceDocumentId of [await insertDocument(resident(2)), deleted]) {
      const response = await as("manager", `/v1/people/${resident(3)}/sharing-decisions`, {
        method: "POST",
        body: {
          recipient: { kind: "family", contactId },
          sections: ["finance"],
          basis: "legal_authority",
          capacity: "presumed",
          authority: {
            role: "lpa_property_finance",
            contactId,
            reference: "OPG-EXAMPLE-1",
            evidenceDocumentId,
          },
          validTo: new Date(Date.now() + 30 * DAY).toISOString(),
        },
      });
      expect(response.status).toBe(422);
      expect(await detail(response)).toContain("not found in this person's documents");
    }
  });

  it("hazard HZ-001 refuses a review document that has been deleted", async () => {
    const deleted = await insertDocument(resident(3));
    await asDemoTenant((c) =>
      c.query("UPDATE document SET deleted_at = now() WHERE id = $1", [deleted]),
    );
    const response = await as("nurse", `/v1/people/${resident(3)}/reviews`, {
      method: "POST",
      body: { kind: "care_plan", heldOn: today(), outcome: "Plan updated", documentId: deleted },
    });
    expect(response.status).toBe(422);
  });

  it("hazard HZ-006 incidents follow rule 3: one about an event after a death is refused and reviewed", async () => {
    const who = await newResident("Idris");
    const died = await status(
      who,
      {
        to: "deceased",
        effectiveAt: ago(HOUR),
        exit: { deathExpected: true, placeOfDeath: "care_home", learningDisabilityOrAutism: false },
      },
      "nurse",
    );
    expect(died.status).toBe(200);
    const report = (occurredAt: string, id = newId()) =>
      as("manager", "/v1/incidents", {
        method: "POST",
        body: {
          id,
          locationId: DEMO.locationId,
          type: "fall",
          occurredAt,
          description: "Found on the floor beside the bed.",
          people: [{ kind: "service_user", role: "affected", personId: who }],
        },
      });
    expect((await report(ago(2 * HOUR))).status).toBe(201);
    const refusedId = newId();
    const late = await report(ago(10 * MIN), refusedId);
    expect(late.status).toBe(422);
    expect(await code(late)).toBe("care_event_after_exit");
    const [review] = await reviewTasks(who, "people.late_entry_review");
    expect(review?.details?.entries).toEqual([
      expect.objectContaining({ kind: "incident", clientId: refusedId }),
    ]);
  });

  it("hazard HZ-013 never counts an incident's draft from a death recorded in error for a later death", async () => {
    const who = await newResident("Gwilym");
    const incident = await as("manager", "/v1/incidents", {
      method: "POST",
      body: {
        locationId: DEMO.locationId,
        type: "fall",
        occurredAt: ago(HOUR),
        description: "Found on the floor beside the bed.",
        people: [{ kind: "service_user", role: "affected", personId: who, died: true }],
      },
    });
    expect(incident.status).toBe(201);
    const fromIncident = await asDemoTenant(async (c) => {
      const { rows } = await c.query<{ id: string; version: number }>(
        `SELECT id, version FROM statutory_notification
         WHERE person_id = $1 AND kind = 'cqc_reg16_death' AND incident_id IS NOT NULL`,
        [who],
      );
      return rows[0];
    });
    expect(fromIncident).toBeDefined();
    // The incident's death notification is submitted.
    const path = `/v1/notifications/statutory/${fromIncident?.id}`;
    const ready = await as("manager", `${path}/prepare`, {
      method: "POST",
      body: { content: {}, ready: true, version: fromIncident?.version },
    });
    expect(ready.status).toBe(200);
    const submitted = await as("manager", `${path}/submit`, {
      method: "POST",
      body: {
        submittedAt: new Date().toISOString(),
        externalReference: "CQC-EXAMPLE-0002",
        version: (await json<{ version: number }>(ready)).version,
      },
    });
    expect(submitted.status).toBe(200);
    // A death recorded against this person, then corrected: it was someone else.
    const exit = {
      deathExpected: true,
      placeOfDeath: "care_home",
      learningDisabilityOrAutism: false,
    };
    expect(
      (await status(who, { to: "deceased", effectiveAt: ago(30 * MIN), exit }, "nurse")).status,
    ).toBe(200);
    await drainOutbox();
    await setSessionAge("manager", 0);
    expect(
      (await status(who, { to: "active", reason: "Recorded against the wrong person" })).status,
    ).toBe(200);
    await drainOutbox();
    const correction = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM task WHERE kind = 'safety.notification_correction' AND source_id = $1",
        [fromIncident?.id],
      ),
    );
    expect(correction.rows[0]?.n).toBe(1);
    // The real death, later the same day, drafts its own notification.
    expect((await status(who, { to: "deceased", exit }, "nurse")).status).toBe(200);
    await drainOutbox();
    const view = (await json<ExitView>(await as("manager", `/v1/people/${who}/exit`))).exit;
    const regulator = view?.checklist.find((i) => i.key === "regulator_death_notification");
    expect(regulator?.status).toBe("pending");
    expect(regulator?.evidenceId).not.toBe(fromIncident?.id);
    const own = await asDemoTenant((c) =>
      c.query<{ id: string }>("SELECT id FROM statutory_notification WHERE source_key = $1", [
        `exit:${view?.id}:cqc_reg16_death`,
      ]),
    );
    expect(regulator?.evidenceId).toBe(own.rows[0]?.id);
  });

  it("hazard HZ-008 tells the Registered Manager once a day when reviews are not scheduled for a home", async () => {
    const welsh = uid("100", 0x77);
    const who = newId();
    await asDemoTenant(async (c) => {
      await c.query(
        "INSERT INTO location (id, name, nation) VALUES ($1, 'Cartref Example', 'wales')",
        [welsh],
      );
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, date_of_birth)
         VALUES ($1, $2, 'active', 'Dafydd', 'Example', '1940-01-01')`,
        [who, welsh],
      );
    });
    const warnings: unknown[] = [];
    const logger = {
      ...createLogger("silent"),
      warn: (...args: unknown[]) => warnings.push(args),
      info: () => {},
    } as unknown as TaskDeps["logger"];
    await raiseReviews({ ...deps, logger });
    await raiseReviews({ ...deps, logger });
    const notices = await asDemoTenant((c) =>
      c.query<{ title: string }>(
        "SELECT title FROM notification WHERE kind = 'people.review.unavailable' AND source_id = $1",
        [welsh],
      ),
    );
    expect(notices.rows.length).toBeGreaterThanOrEqual(1);
    expect(new Set(notices.rows.map((n) => n.title))).toEqual(
      new Set(["Reviews are not being scheduled for this home"]),
    );
    // Once per recipient per day, however often the sweep runs.
    const perRecipient = await asDemoTenant((c) =>
      c.query<{ n: number }>(
        `SELECT max(n)::int AS n FROM (SELECT count(*) AS n FROM notification
         WHERE kind = 'people.review.unavailable' AND source_id = $1 GROUP BY recipient_tenant_user_id) x`,
        [welsh],
      ),
    );
    expect(perRecipient.rows[0]?.n).toBe(1);
    expect(JSON.stringify(warnings)).toContain(welsh);
    expect(JSON.stringify(warnings)).not.toContain("Dafydd");
    await asDemoTenant((c) =>
      c.query("UPDATE person SET status = 'not_admitted' WHERE id = $1", [who]),
    );
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
