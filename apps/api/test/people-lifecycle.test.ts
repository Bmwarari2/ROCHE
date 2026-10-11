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

  it("ticks the welcome checklist, refusing 'not applicable' for allergies and a stale version", async () => {
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

  it("hazard HZ-023 previews the pack with every missing safety-critical section flagged", async () => {
    const preview = await as("nurse", `/v1/people/${resident(1)}/transfer-pack`);
    expect(preview.status).toBe(200);
    const pack = await json<TransferPack>(preview);
    // Ada has allergies and communication needs recorded; no photo, medicines list,
    // resuscitation record or About Me.
    expect(pack.missingCritical).toEqual(["photo", "medicines", "resuscitation", "about_me"]);
    expect(pack.sections.find((s) => s.key === "allergies")?.status).toBe("included");
    expect(pack.complete).toBe(false);
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

  it("refuses a pack for someone not receiving care", async () => {
    const refused = await as("manager", `/v1/people/${ENQUIRY}/transfer-pack`);
    expect(refused.status).toBe(422);
    expect(await code(refused)).toBe("transfer_pack_not_receiving_care");
  });

  it("sends the person to hospital with the pack, pausing rounds and keeping the bed", async () => {
    roundTask = await asDemoTenant(async (c) => {
      const series = await c.query<{ id: string }>(
        `INSERT INTO task_series (person_id, location_id, kind, title, required_permission,
           recurrence, starts_on, materialised_until)
         VALUES ($1, $2, 'care.reposition', 'Reposition', 'care.note.write',
           '{"freq":"daily","times":["10:00"]}', '2026-09-01', now() + interval '2 days')
         RETURNING id`,
        [resident(1), DEMO.locationId],
      );
      const t = await c.query<{ id: string }>(
        `INSERT INTO task (series_id, person_id, location_id, kind, title, required_permission, due_at)
         VALUES ($1, $2, $3, 'care.reposition', 'Reposition', 'care.note.write', now() + interval '3 hours')
         RETURNING id`,
        [series.rows[0]?.id, resident(1), DEMO.locationId],
      );
      return t.rows[0]?.id ?? "";
    });
    const id = newId();
    const body = {
      id,
      leftAt: ago(10 * MIN),
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
    expect(transfer.missingCritical).toEqual(["photo", "medicines", "resuscitation", "about_me"]);
    expect(transfer.itemsSent).toEqual(list.toSendWithPerson);
    const person = await summary(resident(1));
    expect(person.status).toBe("in_hospital");
    expect(person.roomLabel).toBe("9");
    const after = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    expect(after.items.find((i) => i.id === list.toSendWithPerson[0])?.status).toBe(
      "sent_with_person",
    );
    const paused = await asDemoTenant((c) =>
      c.query<{ status: string }>("SELECT status FROM task WHERE id = $1", [roundTask]),
    );
    expect(paused.rows[0]?.status).toBe("cancelled");
    // A replay with the same id returns the first copy without a second move.
    const replay = await as("nurse", `/v1/people/${resident(1)}/hospital-transfers`, {
      method: "POST",
      body,
    });
    expect(replay.status).toBe(201);
    expect((await json<HospitalTransferOut>(replay)).id).toBe(transfer.id);
  });

  it("hazard HZ-023 prints not recorded on the first page for each missing critical section", async () => {
    const pdf = await as(
      "nurse",
      `/v1/people/${resident(1)}/hospital-transfers/${transfer.id}/pdf`,
    );
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    const text = Buffer.from(await pdf.arrayBuffer()).toString("latin1");
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    const firstPage = text.slice(0, text.indexOf("page 1 of"));
    expect(firstPage).toContain("NOT RECORDED");
    for (const title of [
      "Photo: not recorded",
      "Current medicines: not recorded",
      "Resuscitation status \\(ReSPECT, DNACPR\\): not recorded",
      "About Me: not recorded",
    ]) {
      expect(firstPage).toContain(title);
    }
    // The person's identity is on every page.
    expect(text).toContain("EXAMPLE, Ada");
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
  });

  it("records the return: rounds resume, the checks come up and the care plan review comes forward", async () => {
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
    expect((await summary(resident(1))).status).toBe("active");
    const reopened = await asDemoTenant((c) =>
      c.query<{ status: string }>("SELECT status FROM task WHERE id = $1", [roundTask]),
    );
    expect(reopened.rows[0]?.status).toBe("open");
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
    const list = await json<PropertyList>(await as("nurse", `/v1/people/${resident(1)}/property`));
    expect(list.items.every((i) => i.status !== "sent_with_person")).toBe(true);
  });
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

  it("refuses a decision without a valid basis", async () => {
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

  it("opens only the sections a decision in force covers", async () => {
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

  it("makes an About Me link that stores only the token's hash and never outlives its decision", async () => {
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

  it("starts the transfer workflow and closes sharing, the bed and future tasks", async () => {
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

describe("people.md rules 11 and 12: a death, its notifications and its correction", () => {
  it("needs to know whether the death was expected", async () => {
    const response = await status(resident(5), { to: "deceased" }, "nurse");
    expect(response.status).toBe(422);
  });

  it("records a death at night: the room is held and the death notifications are drafted", async () => {
    const died = await status(
      resident(5),
      {
        to: "deceased",
        effectiveAt: ago(20 * MIN),
        exit: { deathExpected: true, placeOfDeath: "care_home", verifiedByName: "Night nurse" },
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
    const drafts = await asDemoTenant((c) =>
      c.query<{ kind: string }>(
        "SELECT kind FROM statutory_notification WHERE person_id = $1 ORDER BY kind",
        [resident(5)],
      ),
    );
    expect(drafts.rows.map((r) => r.kind)).toEqual(["cqc_reg16_death", "medical_examiner"]);
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(5)}/exit`))).exit;
    expect(exit?.kind).toBe("death");
    const regulator = exit?.checklist.find((i) => i.key === "regulator_death_notification");
    expect(regulator).toMatchObject({
      derived: true,
      status: "pending",
      evidenceType: "statutory_notification",
    });
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
    const note = await as("nurse", `/v1/people/${resident(5)}/notes`, {
      method: "POST",
      body: { category: "other", body: "Family visited after death.", occurredAt: ago(MIN) },
    });
    expect(note.status).toBe(201);
    expect((await json<CareNoteItem>(note)).recordedAfterExit).toBe(false);
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
    await drainOutbox();
    const flagged = await asDemoTenant((c) =>
      c.query<{ flagged: boolean }>(
        "SELECT no_longer_indicated AS flagged FROM statutory_notification WHERE person_id = $1",
        [resident(5)],
      ),
    );
    expect(flagged.rows.every((r) => r.flagged)).toBe(true);
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
      { to: "deceased", exit: { deathExpected: false, placeOfDeath: "care_home" } },
      "nurse",
    );
    expect(died.status).toBe(200);
    const exit = (await json<ExitView>(await as("manager", `/v1/people/${resident(6)}/exit`))).exit;
    // An unexpected death is referred to the coroner.
    expect(exit?.checklist.map((i) => i.key)).toContain("coroner_referral_recorded");
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

  it("records the review once, as a new row", async () => {
    const list = await json<BreakGlassWeeklyReportList>(
      await as("manager", "/v1/break-glass/weekly-report"),
    );
    const path = `/v1/break-glass/weekly-report/${list.items[0]?.id}/review`;
    const body = { actionsTaken: "Spoke to the manager; scope widened to cover the unit." };
    const first = await as("manager", path, { method: "POST", body });
    expect(first.status).toBe(201);
    expect((await as("manager", path, { method: "POST", body })).status).toBe(409);
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

describe("permissions per route", () => {
  it.each([
    ["carer", "GET", `/v1/people/${resident(1)}/sharing-decisions`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/about-me/links`, 403],
    ["carer", "GET", `/v1/people/${resident(1)}/transfer-pack`, 403],
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
