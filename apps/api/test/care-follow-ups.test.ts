import type {
  AdvanceCareItem,
  AssessmentItem,
  BodyMapMarkItem,
  CareNoteItem,
  CarePlanActionItem,
  CarePlanDetail,
  ConsentItem,
  DiscardReasonItem,
  DiscardReasonList,
  DolsItem,
  EscalationPolicyLinkItem,
  EscalationPolicyLinkList,
  ObservationItem,
  ProblemDetails,
  RecordHistory,
  RiskAssessmentItem,
  TaskItem,
} from "@harbour/contracts";
import { createDatabase, createPool, withRequestContext } from "@harbour/db";
import { DEMO } from "@harbour/db/seed";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARE_ALERT_UNROUTED_ACTION, raiseCareTriggers } from "../src/services/care";
import { createHarness, type Harness, LODGE } from "./support/harness";

/**
 * The care API follow-ups from the #15 reviews (care.md sections 5 and 6): the IDDSI drink level
 * when one is prescribed (HZ-016), the side of a body-map mark worked out on the server (HZ-019),
 * the organisation's escalation policy on validated-tool results (HZ-012, HZ-014), coded discard
 * reasons, the deletion replay index and the server's flag on entries a device deleted (HZ-040),
 * staff names on records, and client ids on the care create routes (HZ-029).
 */

let h: Harness;

const resident = (n: number) => `0194d000-0000-7000-8600-${n.toString(16).padStart(12, "0")}`;
const MIN = 60_000;
const ago = (minutes: number) => new Date(Date.now() - minutes * MIN).toISOString();
const DEVICE = "0199d000-0000-4000-8000-0000000000c7";
const newId = () => {
  // A UUIDv7-shaped id as a device or a form would make it.
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
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
) => h.request(path, { token: h.tokens[user], tenant: DEMO.tenantId, ...init });
const fromDevice = { "x-harbour-device": DEVICE };

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

const observe = (
  person: number,
  values: Record<string, unknown>,
  init: { user?: keyof Harness["tokens"]; headers?: Record<string, string>; id?: string } = {},
) =>
  as(init.user ?? "carer", `/v1/people/${resident(person)}/observations`, {
    method: "POST",
    body: { occurredAt: ago(5), values, ...(init.id ? { id: init.id } : {}) },
    ...(init.headers ? { headers: init.headers } : {}),
  });

const urgentAlerts = (sourceId: string) =>
  asDemoTenant((c) =>
    c
      .query<{ n: number }>(
        "SELECT count(*)::int AS n FROM notification WHERE kind = 'care.urgent_result' AND source_id = $1",
        [sourceId],
      )
      .then((r) => r.rows[0]?.n ?? 0),
  );

describe("hazard HZ-016 a drink needs its IDDSI level when a drink level is prescribed", () => {
  beforeAll(async () => {
    const set = await as("manager", `/v1/people/${resident(1)}/care-profile`, {
      method: "PUT",
      body: {
        iddsiFoodLevel: "4",
        iddsiDrinkLevel: "2",
        iddsiAdvisedBy: "Speech and language therapist",
        version: 0,
      },
    });
    expect(set.status).toBe(200);
  });

  it("refuses a drink with no level from the web, saying which level is prescribed", async () => {
    const response = await observe(1, { chart: "fluid_intake", ml: 200 });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe(
      "Level 2 Mildly thick (pink) is prescribed. Choose the IDDSI drink level given.",
    );
    const given = await observe(1, { chart: "fluid_intake", ml: 200, iddsiLevel: "2" });
    expect(given.status).toBe(201);
    expect((await json<ObservationItem>(given)).flags).toMatchObject({
      iddsi: { outcome: "match" },
      iddsiAlert: false,
    });
  });

  it("keeps a drink with no level from a device, flagged, and tells the nurse in charge (C3)", async () => {
    const response = await observe(1, { chart: "fluid_intake", ml: 150 }, { headers: fromDevice });
    expect(response.status).toBe(201);
    const saved = await json<ObservationItem>(response);
    expect(saved.flags).toMatchObject({
      iddsi: { outcome: "level_not_recorded", raisesAlert: true },
      iddsiAlert: true,
      iddsiProblem: "level_not_recorded",
    });
    expect(await urgentAlerts(saved.id)).toBeGreaterThan(0);
  });

  it("keeps an unsafe level with no reason from a device, flagged and alerted, and refuses it from the web", async () => {
    const thin = { chart: "fluid_intake", ml: 100, iddsiLevel: "0" };
    expect((await observe(1, thin)).status).toBe(422);
    const kept = await json<ObservationItem>(await observe(1, thin, { headers: fromDevice }));
    expect(kept.flags).toMatchObject({
      iddsi: { outcome: "unsafe_mismatch" },
      iddsiAlert: true,
      iddsiProblem: "reason_missing",
    });
    expect(await urgentAlerts(kept.id)).toBeGreaterThan(0);
    const food = { chart: "food", meal: "lunch", portion: "half", iddsiLevel: "6" };
    const keptFood = await json<ObservationItem>(await observe(1, food, { headers: fromDevice }));
    expect(keptFood.flags).toMatchObject({ iddsiProblem: "reason_missing", iddsiAlert: true });
  });

  it("takes a drink with no level when none is prescribed, with no flags", async () => {
    const response = await observe(2, { chart: "fluid_intake", ml: 200 });
    expect(response.status).toBe(201);
    expect((await json<ObservationItem>(response)).flags).toEqual({});
  });
});

describe("hazard HZ-019 the server works out the side of a body-map mark from the drawing", () => {
  const mark = (fields: Record<string, unknown>, headers?: Record<string, string>) =>
    as("carer", `/v1/people/${resident(1)}/body-map`, {
      method: "POST",
      body: {
        occurredAt: ago(5),
        region: "knee",
        markType: "bruise",
        bruiseExplained: true,
        ...fields,
      },
      ...(headers ? { headers } : {}),
    });

  it("reads the person's left on the viewer's right of the front view, and stores what was drawn", async () => {
    const response = await mark({ view: "front", drawnAt: { x: 70, y: 170 }, side: "left" });
    expect(response.status).toBe(201);
    const saved = await json<BodyMapMarkItem>(response);
    expect(saved).toMatchObject({ side: "left", drawnSide: "left" });
    const [row] = await asDemoTenant((c) =>
      c
        .query("SELECT drawn_x, drawn_y, drawn_zone, drawn_side FROM body_map_mark WHERE id = $1", [
          saved.id,
        ])
        .then((r) => r.rows),
    );
    expect(row).toEqual({
      drawn_x: 70,
      drawn_y: 170,
      drawn_zone: "viewer_right",
      drawn_side: "left",
    });
  });

  it("refuses a side in words that disagrees with the side the drawing shows, on either view", async () => {
    const front = await mark({ view: "front", drawnAt: { x: 70, y: 170 }, side: "right" });
    expect(front.status).toBe(422);
    expect((await json<ProblemDetails>(front)).detail).toContain(
      "The mark is drawn on the person's left but the person's right was chosen.",
    );
    // The back view faces away: the viewer's right is the person's right.
    const back = await mark({
      view: "back",
      region: "calf",
      drawnAt: { x: 70, y: 170 },
      side: "left",
    });
    expect(back.status).toBe(422);
    const agreed = await mark({
      view: "back",
      region: "calf",
      drawnAt: { x: 70, y: 170 },
      side: "right",
    });
    expect(agreed.status).toBe(201);
  });

  it("never takes the side a device says it drew: one that disagrees with the drawing is refused", async () => {
    const response = await mark(
      { view: "front", drawnAt: { x: 70, y: 170 }, drawnSide: "right", side: "right" },
      fromDevice,
    );
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe(
      "The side the device worked out from the drawing is not the side the drawing shows. Mark the place on the drawing again.",
    );
  });

  it("takes the zone chosen with the buttons, and refuses a point and a zone that disagree", async () => {
    const zone = await mark({
      view: "front",
      region: "chest",
      drawnZone: "centre",
      side: "midline",
      markType: "rash",
      bruiseExplained: undefined,
    });
    expect(zone.status).toBe(201);
    expect((await json<BodyMapMarkItem>(zone)).drawnSide).toBe("midline");
    const both = await mark({
      view: "front",
      drawnAt: { x: 30, y: 170 },
      drawnZone: "viewer_right",
      side: "right",
    });
    expect(both.status).toBe(422);
  });

  it("refuses a mark with no place on the drawing and no side drawn", async () => {
    const response = await mark({ view: "front", side: "left" });
    expect(response.status).toBe(422);
    expect((await json<ProblemDetails>(response)).detail).toBe(
      "Mark the place on the body map drawing, so the side can be checked.",
    );
  });
});

const vitals = {
  chart: "vitals",
  respirationRate: 24,
  spo2: 94,
  onOxygen: false,
  systolic: 105,
  pulse: 115,
  consciousness: "alert",
  temperature: 38.5,
};

describe("hazard HZ-014 a validated tool's result links the organisation's escalation policy", () => {
  const link = (user: keyof Harness["tokens"], body: Record<string, unknown>) =>
    as(user, "/v1/escalation-policies", { method: "POST", body });

  it("says no escalation policy is configured until one is linked", async () => {
    const saved = await json<ObservationItem>(await observe(3, vitals, { user: "manager" }));
    expect(saved.escalationPolicy).toEqual({
      status: "not_configured",
      toolKey: "news2",
      band: expect.any(String),
    });
    const notVitals = await json<ObservationItem>(
      await observe(3, { chart: "fluid_output", ml: 100, kind: "urine" }),
    );
    expect(notVitals.escalationPolicy).toBeNull();
  });

  it("links the organisation's policy, and the location's own for a band wins", async () => {
    const organisation = await link("owner", {
      id: newId(),
      toolKey: "news2",
      title: "Deteriorating resident policy",
      reference: "CP-12 v3",
    });
    expect(organisation.status).toBe(201);
    const org = await json<EscalationPolicyLinkItem>(organisation);
    const saved = await json<ObservationItem>(await observe(3, vitals, { user: "manager" }));
    expect(saved.escalationPolicy).toMatchObject({
      status: "configured",
      toolKey: "news2",
      linkId: org.id,
      title: "Deteriorating resident policy",
      reference: "CP-12 v3",
      documentId: null,
      matchedOn: "tool",
      scope: "organisation",
    });
    const band = (saved.flags.news2 as { band: string }).band;
    const local = await link("manager", {
      toolKey: "news2",
      band,
      locationId: DEMO.locationId,
      title: "Harbour House escalation for a raised NEWS2",
    });
    expect(local.status).toBe(201);
    const reread = await json<{ items: ObservationItem[] }>(
      await as("manager", `/v1/people/${resident(3)}/observations?chart=vitals`),
    );
    expect(reread.items[0]?.escalationPolicy).toMatchObject({
      status: "configured",
      title: "Harbour House escalation for a raised NEWS2",
      matchedOn: "band",
      scope: "location",
    });
  });

  it("links MUST results too, and the list gives each tool's bands", async () => {
    const must = await as("manager", `/v1/people/${resident(3)}/assessments`, {
      method: "POST",
      body: {
        toolKey: "must",
        occurredAt: ago(5),
        answers: {
          bmi: {
            kind: "calculated",
            weightKg: 45,
            heightM: 1.65,
            weightMethod: "measured",
            heightMethod: "measured",
          },
          weightLoss: { kind: "calculated", previousWeightKg: 50, currentWeightKg: 45 },
          acuteDiseaseEffect: false,
        },
      },
    });
    expect(must.status).toBe(201);
    const result = await json<AssessmentItem>(must);
    expect(result.escalationPolicy).toEqual({
      status: "not_configured",
      toolKey: "must",
      band: result.band,
    });
    await link("owner", { toolKey: "must", band: result.band, title: "Nutrition policy" });
    const latest = await json<{ items: AssessmentItem[] }>(
      await as("manager", `/v1/people/${resident(3)}/assessments?latest=true`),
    );
    expect(latest.items.find((i) => i.toolKey === "must")?.escalationPolicy).toMatchObject({
      status: "configured",
      title: "Nutrition policy",
      matchedOn: "band",
    });
    const list = await json<EscalationPolicyLinkList>(await as("carer", "/v1/escalation-policies"));
    expect(list.bands.ng249_falls).toEqual([]);
    expect(list.bands.news2).toEqual(["low", "low_medium", "medium", "high"]);
    expect(list.items.length).toBeGreaterThanOrEqual(3);
  });

  it("refuses another tool's band, a second link for the same place, an organisation link from a location role and a carer", async () => {
    expect(
      (await link("owner", { toolKey: "must", band: "very_high_risk", title: "Wrong band" }))
        .status,
    ).toBe(422);
    expect(
      (await link("owner", { toolKey: "news2", title: "Second organisation policy" })).status,
    ).toBe(409);
    const fromLocation = await link("manager", { toolKey: "braden", title: "Braden policy" });
    expect(fromLocation.status).toBe(403);
    expect((await link("carer", { toolKey: "braden", title: "Braden policy" })).status).toBe(403);
  });

  it("hazard HZ-012 shows only the organisation's own policy, and says none again once removed", async () => {
    const created = await json<EscalationPolicyLinkItem>(
      await link("owner", { toolKey: "waterlow", title: "Pressure care policy" }),
    );
    const removed = await as("owner", `/v1/escalation-policies/${created.id}/remove`, {
      method: "POST",
      body: { version: created.version },
    });
    expect(removed.status).toBe(200);
    const list = await json<EscalationPolicyLinkList>(await as("owner", "/v1/escalation-policies"));
    expect(list.items.map((i) => i.id)).not.toContain(created.id);
    const audit = await asDemoTenant((c) =>
      c
        .query<{ action: string }>(
          "SELECT action FROM audit_event WHERE resource_id = $1 ORDER BY seq",
          [created.id],
        )
        .then((r) => r.rows.map((row) => row.action)),
    );
    expect(audit).toEqual(["care.escalation_policy.link", "care.escalation_policy.remove"]);
  });
});

describe("hazard HZ-040 coded discard reasons, the replay index and the server's flag on entries", () => {
  const discard = (overrides: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    kind: "held_deleted",
    stage: "requested",
    reasonCode: "recorded_elsewhere",
    ownerTenantUserId: DEMO.users.carer.id,
    deletedByTenantUserId: DEMO.users.carer.id,
    entryIds: [] as string[],
    personIds: [resident(2)],
    count: 1,
    discardedAt: new Date().toISOString(),
    ...overrides,
  });
  const send = (body: Record<string, unknown>, user: keyof Harness["tokens"] = "carer") =>
    as(user, "/v1/sync/discards", { method: "POST", body, headers: fromDevice });

  it("lists the organisation's five seeded reasons to any member, and lets only the owner add one", async () => {
    const list = await json<DiscardReasonList>(await as("carer", "/v1/discard-reasons"));
    expect(list.items.map((r) => r.code)).toEqual([
      "recorded_elsewhere",
      "entered_in_error",
      "staff_left",
      "nurse_in_charge_informed",
      "other",
    ]);
    expect(list.items.every((r) => r.seeded && r.retiredAt === null)).toBe(true);
    const reason = { code: "agency_shift_ended", label: "The agency shift ended first" };
    expect(
      (await as("manager", "/v1/discard-reasons", { method: "POST", body: reason })).status,
    ).toBe(403);
    const added = await as("owner", "/v1/discard-reasons", { method: "POST", body: reason });
    expect(added.status).toBe(201);
    expect(
      (await as("owner", "/v1/discard-reasons", { method: "POST", body: reason })).status,
    ).toBe(409);
  });

  it("takes a deletion with one of the organisation's codes, a retired one too, and refuses one it never had", async () => {
    const withOwnCode = discard({
      reasonCode: "other",
      organisationReasonCode: "agency_shift_ended",
    });
    expect((await send(withOwnCode)).status).toBe(200);
    // The hash-chained audit keeps "other" and the reason's id, never the organisation's own
    // words (#26 review round 2, low); the deletion record keeps the code.
    const [event] = await asDemoTenant((c) =>
      c
        .query<{ reason: string; scope: Record<string, unknown> }>(
          "SELECT reason, scope FROM audit_event WHERE resource_type = 'device_discard' AND resource_id = $1",
          [withOwnCode.id],
        )
        .then((r) => r.rows),
    );
    expect(event?.reason).toBe("other");
    expect(event?.scope.reasonCode).toBe("other");
    expect(event?.scope.organisationReasonId).toEqual(expect.any(String));
    expect(JSON.stringify(event)).not.toContain("agency_shift_ended");
    const unknown = await send(
      discard({ reasonCode: "other", organisationReasonCode: "because_i_said" }),
    );
    expect(unknown.status).toBe(422);
    const current = (
      await json<DiscardReasonList>(await as("owner", "/v1/discard-reasons"))
    ).items.find((r) => r.code === "agency_shift_ended") as DiscardReasonItem;
    const retired = await as("owner", "/v1/discard-reasons/agency_shift_ended", {
      method: "PUT",
      body: { retired: true, version: current.version },
    });
    expect((await json<DiscardReasonItem>(retired)).retiredAt).not.toBeNull();
    // A device that recorded the deletion before the code was retired can still send it.
    expect(
      (await send(discard({ reasonCode: "other", organisationReasonCode: "agency_shift_ended" })))
        .status,
    ).toBe(200);
    const list = await json<DiscardReasonList>(await as("carer", "/v1/discard-reasons"));
    expect(list.items.at(-1)?.code).toBe("agency_shift_ended");
  });

  it("records each stage once, by the unique index on the deletion and stage", async () => {
    const requested = discard();
    expect(await json(await send(requested))).toMatchObject({ replay: false });
    expect(await json(await send(requested))).toMatchObject({ replay: true });
    expect(await json(await send({ ...requested, stage: "deleted" }))).toMatchObject({
      replay: false,
    });
    const rows = await asDemoTenant((c) =>
      c
        .query<{ stage: string; reason_code: string; sender_tenant_user_id: string }>(
          "SELECT stage, reason_code, sender_tenant_user_id FROM device_discard_record WHERE discard_id = $1 ORDER BY stage",
          [requested.id],
        )
        .then((r) => r.rows),
    );
    expect(rows).toEqual([
      {
        stage: "deleted",
        reason_code: "recorded_elsewhere",
        sender_tenant_user_id: DEMO.users.carer.id,
      },
      {
        stage: "requested",
        reason_code: "recorded_elsewhere",
        sender_tenant_user_id: DEMO.users.carer.id,
      },
    ]);
    // A later stage for other entries is refused, as before.
    const other = await send({ ...requested, stage: "failed", kind: "refused_removed" });
    expect(other.status).toBe(422);
  });

  it("flags an entry uploaded after its device recorded deleting it, on the entry itself", async () => {
    const entryId = newId();
    const deletion = discard({ entryIds: [entryId] });
    await send(deletion);
    await send({ ...deletion, stage: "deleted" });
    const uploaded = await as("carer", `/v1/people/${resident(2)}/notes`, {
      method: "POST",
      body: {
        id: entryId,
        category: "night",
        body: "Slept through.",
        occurredAt: ago(30),
      },
      headers: fromDevice,
    });
    expect(uploaded.status).toBe(201);
    expect((await json<CareNoteItem>(uploaded)).deviceDeletion).toBe("uploaded_after_deletion");
    const list = await json<{ items: CareNoteItem[] }>(
      await as("manager", `/v1/people/${resident(2)}/notes`),
    );
    expect(list.items.find((n) => n.id === entryId)?.deviceDeletion).toBe(
      "uploaded_after_deletion",
    );
  });

  it("flags an entry a deletion lists after it reached Harbour, once", async () => {
    const entryId = newId();
    const uploaded = await as("carer", `/v1/people/${resident(2)}/notes`, {
      method: "POST",
      body: { id: entryId, category: "night", body: "Turned at 02:00.", occurredAt: ago(40) },
      headers: fromDevice,
    });
    expect((await json<CareNoteItem>(uploaded)).deviceDeletion).toBeNull();
    const deletion = discard({ entryIds: [entryId] });
    await send(deletion);
    await send({ ...deletion, stage: "deleted" });
    const again = discard({ entryIds: [entryId] });
    await send(again);
    await send({ ...again, stage: "deleted" });
    const list = await json<{ items: CareNoteItem[] }>(
      await as("carer", `/v1/people/${resident(2)}/notes`),
    );
    expect(list.items.find((n) => n.id === entryId)?.deviceDeletion).toBe("deleted_after_upload");
    const flags = await asDemoTenant((c) =>
      c
        .query<{ discard_id: string }>(
          "SELECT discard_id FROM entry_device_deletion_flag WHERE entry_id = $1",
          [entryId],
        )
        .then((r) => r.rows),
    );
    expect(flags).toEqual([{ discard_id: deletion.id }]);
  });
});

describe("staff names on records (care.md section 5)", () => {
  it("names who recorded an entry, and who a task is assigned to and completed by", async () => {
    const note = await json<CareNoteItem>(
      await as("carer", `/v1/people/${resident(1)}/notes`, {
        method: "POST",
        body: { category: "mood", body: "Cheerful at breakfast.", occurredAt: ago(5) },
      }),
    );
    expect(note.recordedByStaff).toEqual({
      id: DEMO.users.carer.id,
      displayName: DEMO.users.carer.name,
      jobTitle: null,
    });
    expect(note.handedOverByStaff).toBeNull();
    const created = await as("manager", "/v1/tasks", {
      method: "POST",
      body: {
        title: "Check skin on heels",
        personId: resident(1),
        locationId: DEMO.locationId,
        dueAt: new Date().toISOString(),
        assigneeTenantUserId: DEMO.users.carer.id,
      },
    });
    expect(created.status).toBe(201);
    const task = await json<TaskItem>(created);
    expect(task.assigneeStaff).toMatchObject({ displayName: DEMO.users.carer.name });
    expect(task.completedByStaff).toBeNull();
  });

  it("names who changed a record in its history", async () => {
    const risk = await json<RiskAssessmentItem>(
      await as("manager", `/v1/people/${resident(1)}/risk-assessments`, {
        method: "POST",
        body: riskBody(),
      }),
    );
    await as("manager", `/v1/people/${resident(1)}/risk-assessments/${risk.id}/close`, {
      method: "POST",
      body: { reason: "No longer applies", version: risk.version },
    });
    const history = await json<RecordHistory>(
      await as("manager", `/v1/people/${resident(1)}/care-history/risk_assessment/${risk.id}`),
    );
    expect(history.versions[0]?.changedByStaff).toMatchObject({
      displayName: DEMO.users.manager.name,
    });
  });
});

function riskBody(over: Record<string, unknown> = {}) {
  return {
    templateKey: "moving_and_handling",
    hazard: "Transfers from bed to chair",
    whoAtRisk: "The person and the staff helping",
    answers: {
      bears_weight: false,
      cooperates: true,
      equipment_needed: true,
      equipment_examined: true,
    },
    likelihood: 3,
    severity: 4,
    residualLikelihood: 1,
    residualSeverity: 4,
    controls: ["Full-body hoist", "Two staff for every transfer"],
    assessedOn: new Date().toISOString().slice(0, 10),
    ...over,
  };
}

describe("hazard HZ-029 a save sent twice with the same client id is recorded once", () => {
  it("records an advance care record, a risk assessment and a care plan action once", async () => {
    const respectId = newId();
    const respect = {
      id: respectId,
      kind: "respect",
      cprDecision: "attempt_cpr",
      clinicianName: "Dr Example",
      clinicianRole: "GP",
      completedOn: new Date().toISOString().slice(0, 10),
    };
    const path = `/v1/people/${resident(2)}/advance-care`;
    const first = await json<AdvanceCareItem>(
      await as("manager", path, { method: "POST", body: respect }),
    );
    const second = await as("manager", path, { method: "POST", body: respect });
    expect(second.status).toBe(201);
    expect((await json<AdvanceCareItem>(second)).id).toBe(first.id);
    const active = await json<{ items: AdvanceCareItem[] }>(await as("manager", path));
    // The replay superseded nothing: the record is still the one in force.
    expect(active.items.filter((i) => i.kind === "respect").map((i) => i.id)).toEqual([respectId]);

    const riskId = newId();
    const risks = `/v1/people/${resident(2)}/risk-assessments`;
    const r1 = await json<RiskAssessmentItem>(
      await as("manager", risks, { method: "POST", body: riskBody({ id: riskId }) }),
    );
    const r2 = await json<RiskAssessmentItem>(
      await as("manager", risks, { method: "POST", body: riskBody({ id: riskId }) }),
    );
    expect(r2.id).toBe(r1.id);
    const all = await json<{ items: RiskAssessmentItem[] }>(await as("manager", risks));
    expect(all.items.filter((i) => i.id === riskId)).toHaveLength(1);

    const draftId = newId();
    const plans = `/v1/people/${resident(2)}/care-plans`;
    const draft = await json<CarePlanDetail>(
      await as("manager", plans, { method: "POST", body: { id: draftId, copyFromActive: false } }),
    );
    const replayedDraft = await as("manager", plans, {
      method: "POST",
      body: { id: draftId, copyFromActive: false },
    });
    expect(replayedDraft.status).toBe(201);
    expect((await json<CarePlanDetail>(replayedDraft)).id).toBe(draft.id);
    await as("manager", `${plans}/${draft.id}/sections/nutrition_and_hydration`, {
      method: "PUT",
      body: { need: "Needs encouragement to drink.", version: 0 },
    });
    const actionId = newId();
    const actionPath = `${plans}/${draft.id}/sections/nutrition_and_hydration/actions`;
    const action = { id: actionId, action: "Offer a drink every hour" };
    const first1 = await as("manager", actionPath, { method: "POST", body: action });
    const a1 = await json<CarePlanActionItem & ProblemDetails>(first1);
    expect({ status: first1.status, detail: a1.detail }).toEqual({
      status: 201,
      detail: undefined,
    });
    const a2 = await json<CarePlanActionItem>(
      await as("manager", actionPath, { method: "POST", body: action }),
    );
    expect(a2.id).toBe(a1.id);
    const detail = await json<CarePlanDetail>(await as("manager", `${plans}/${draft.id}`));
    const actions = detail.sections.flatMap((s) => s.actions).filter((a) => a.id === actionId);
    expect(actions).toHaveLength(1);
  });

  it("records a consent and a DoLS entry once, with the id in the Idempotency-Key header", async () => {
    const key = newId();
    const consent = {
      decision: "photos",
      outcome: "given",
      givenBy: "person",
      givenAt: ago(10),
      evidence: "Agreed when asked in the lounge.",
    };
    const path = `/v1/people/${resident(1)}/consents`;
    const c1 = await as("manager", path, {
      method: "POST",
      body: consent,
      headers: { "idempotency-key": key },
    });
    expect(c1.status).toBe(201);
    expect((await json<ConsentItem>(c1)).id).toBe(key);
    const c2 = await as("manager", path, {
      method: "POST",
      body: consent,
      headers: { "idempotency-key": key },
    });
    expect((await json<ConsentItem>(c2)).id).toBe(key);
    // A body id and a header that disagree are refused: one id per save.
    const clash = await as("manager", path, {
      method: "POST",
      body: { ...consent, id: newId() },
      headers: { "idempotency-key": key },
    });
    expect(clash.status).toBe(422);

    const dolsId = newId();
    const dols = { id: dolsId, type: "standard", requestedAt: ago(60) };
    const dolsPath = `/v1/people/${resident(1)}/dols`;
    const d1 = await as("manager", dolsPath, { method: "POST", body: dols });
    expect(d1.status).toBe(201);
    const d2 = await as("manager", dolsPath, { method: "POST", body: dols });
    expect((await json<DolsItem>(d2)).id).toBe(dolsId);
    const listed = await json<{ items: DolsItem[] }>(await as("manager", dolsPath));
    expect(listed.items.filter((i) => i.id === dolsId)).toHaveLength(1);
  });

  it("refuses an id used for another person", async () => {
    const id = newId();
    const respect = {
      id,
      kind: "adrt",
      completedOn: new Date().toISOString().slice(0, 10),
      details: "Refuses ventilation.",
    };
    expect(
      (
        await as("manager", `/v1/people/${resident(1)}/advance-care`, {
          method: "POST",
          body: respect,
        })
      ).status,
    ).toBe(201);
    const other = await as("manager", `/v1/people/${resident(2)}/advance-care`, {
      method: "POST",
      body: respect,
    });
    expect(other.status).toBe(422);
    expect((await json<ProblemDetails>(other)).detail).toBe("That id is already used.");
  });
});

// ------------------------------------------------------------------------------------------------
// #26 review round 2
// ------------------------------------------------------------------------------------------------

describe("hazard HZ-014 hazard HZ-016 an urgent result alert always reaches someone or is audited (#26 review round 2, C2)", () => {
  const veryHigh = {
    chart: "vitals",
    respirationRate: 26,
    spo2: 90,
    onOxygen: false,
    systolic: 90,
    pulse: 135,
    consciousness: "alert",
    temperature: 39.5,
  };

  it("goes to the fallback, the Registered Manager, where the home has no nurse in charge", async () => {
    // Harbour Lodge has no clinical lead, team leader or Registered Manager of its own.
    const response = await as("owner", `/v1/people/${LODGE.personId}/observations`, {
      method: "POST",
      body: { occurredAt: ago(5), values: veryHigh },
    });
    expect(response.status).toBe(201);
    const saved = await json<ObservationItem>(response);
    const recipients = await asDemoTenant((c) =>
      c
        .query<{ recipient: string }>(
          "SELECT recipient_tenant_user_id AS recipient FROM notification WHERE kind = 'care.urgent_result' AND source_id = $1",
          [saved.id],
        )
        .then((r) => r.rows.map((row) => row.recipient)),
    );
    expect(recipients).toEqual([DEMO.users.manager.id]);
  });

  it("is audited as unrouted, and not counted, when the organisation has no one who could act", async () => {
    const tenantId = "0194f000-0000-7000-8000-000000000001";
    const locationId = "0194f000-0000-7000-8000-000000000101";
    const personId = "0194f000-0000-7000-8000-000000000401";
    const sourceId = "0194f000-0000-7000-8000-0000000004a1";
    const inEmptyTenant = async <T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> => {
      const client = await h.db.pool("harbour_owner").connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT set_config('app.tenant_id', $1, true), set_config('app.scope', 'tenant', true)",
          [tenantId],
        );
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } finally {
        client.release();
      }
    };
    await inEmptyTenant(async (c) => {
      await c.query(
        `INSERT INTO tenant (id, name, legal_name, legal_form, status)
         VALUES ($1, 'Empty Provider', 'Empty Provider Ltd', 'limited_company', 'onboarding')`,
        [tenantId],
      );
      await c.query("INSERT INTO location (id, name) VALUES ($1, 'Quiet House')", [locationId]);
      await c.query(
        `INSERT INTO person (id, location_id, status, given_name, family_name, nhs_number)
         VALUES ($1, $2, 'active', 'Ivy', 'Example', '9990000093')`,
        [personId, locationId],
      );
    });
    const pool = createPool(h.db.url("harbour_app"));
    try {
      const raised = await withRequestContext(
        createDatabase(pool),
        { tenantId, userId: null, scope: "tenant", locationIds: [] },
        (tx) =>
          raiseCareTriggers(
            tx,
            { personId, locationId, sourceType: "observation", sourceId },
            [{ kind: "urgent_alert", recipient: "nurse_in_charge", reason: "Test alert" }],
            new Date(),
          ),
      );
      expect(raised).toBe(0);
    } finally {
      await pool.end();
    }
    const audited = await inEmptyTenant((c) =>
      c
        .query<{ action: string; outcome: string; scope: unknown }>(
          "SELECT action, outcome, scope FROM audit_event WHERE resource_id = $1",
          [sourceId],
        )
        .then((r) => r.rows),
    );
    expect(audited).toEqual([
      { action: CARE_ALERT_UNROUTED_ACTION, outcome: "error", scope: { personId, locationId } },
    ]);
  });

  it("hazard HZ-016 asks no IDDSI level of a drink refused, and raises nothing", async () => {
    // Ada (resident 1) has a drink level prescribed; nothing was given, so there is no texture.
    const response = await observe(1, { chart: "fluid_intake", ml: 0, refused: true });
    expect(response.status).toBe(201);
    const saved = await json<ObservationItem>(response);
    expect(saved.flags).toEqual({});
    expect(await urgentAlerts(saved.id)).toBe(0);
  });
});

describe("hazard HZ-040 entries a device recorded deleting are counted beside the fluid total (#26 review round 2, C3)", () => {
  it("keeps them in the totals, says how many and how much, and marks them on the list", async () => {
    const entryId = newId();
    const deletion = {
      id: crypto.randomUUID(),
      kind: "held_deleted",
      stage: "requested",
      reasonCode: "recorded_elsewhere",
      ownerTenantUserId: DEMO.users.carer.id,
      deletedByTenantUserId: DEMO.users.carer.id,
      entryIds: [entryId],
      personIds: [resident(3)],
      count: 1,
      discardedAt: new Date().toISOString(),
    };
    for (const stage of ["requested", "deleted"]) {
      const sent = await as("carer", "/v1/sync/discards", {
        method: "POST",
        body: { ...deletion, stage },
        headers: fromDevice,
      });
      expect(sent.status).toBe(200);
    }
    const plain = await observe(3, { chart: "fluid_intake", ml: 200 }, { headers: fromDevice });
    expect(plain.status).toBe(201);
    const flagged = await observe(
      3,
      { chart: "fluid_intake", ml: 300 },
      { headers: fromDevice, id: entryId },
    );
    expect(flagged.status).toBe(201);
    expect((await json<ObservationItem>(flagged)).deviceDeletion).toBe("uploaded_after_deletion");
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/London" });
    const day = await json<{
      intakeMl: number;
      flaggedEntries: number;
      flaggedIntakeMl: number;
      flaggedOutputMl: number;
    }>(await as("manager", `/v1/people/${resident(3)}/charts/fluid?date=${today}`));
    expect(day).toMatchObject({ flaggedEntries: 1, flaggedIntakeMl: 300, flaggedOutputMl: 0 });
    expect(day.intakeMl).toBeGreaterThanOrEqual(500);
    const list = await json<{ items: ObservationItem[] }>(
      await as("manager", `/v1/people/${resident(3)}/observations`),
    );
    expect(list.items.find((o) => o.id === entryId)?.deviceDeletion).toBe(
      "uploaded_after_deletion",
    );
  });
});

describe("hazard HZ-019 marks from phones not yet updated, and refused marks that may be harm (#26 review round 2, C4)", () => {
  const oldPhoneMark = (side: string) =>
    as("carer", `/v1/people/${resident(2)}/body-map`, {
      method: "POST",
      body: {
        occurredAt: ago(5),
        view: "front",
        region: "knee",
        drawnSide: "left",
        side,
        markType: "bruise",
        bruiseExplained: true,
      },
      headers: fromDevice,
    });

  it("reads a mark sent with only the side the phone worked out as that side's zone, and flags it", async () => {
    const response = await oldPhoneMark("left");
    expect(response.status).toBe(201);
    const saved = await json<BodyMapMarkItem>(response);
    expect(saved).toMatchObject({ drawnSide: "left", drawnFromDeviceSide: true, side: "left" });
    const stored = await asDemoTenant((c) =>
      c
        .query<{ drawn_zone: string; drawn_x: number | null }>(
          "SELECT drawn_zone, drawn_x FROM body_map_mark WHERE id = $1",
          [saved.id],
        )
        .then((r) => r.rows[0]),
    );
    expect(stored).toEqual({ drawn_zone: "viewer_right", drawn_x: null });
    // The side in words is still checked against it.
    expect((await oldPhoneMark("right")).status).toBe(422);
  });

  it("makes the review of a refused bruise urgent at once", async () => {
    const entryId = newId();
    const copy = await as("carer", "/v1/sync/refused-entries", {
      method: "POST",
      body: {
        entryId,
        table: "body_map_mark",
        personId: resident(3),
        payload: {
          id: entryId,
          occurredAt: ago(30),
          view: "front",
          region: "knee",
          drawnZone: "viewer_right",
          side: "right",
          markType: "bruise",
          bruiseExplained: false,
        },
        httpStatus: 422,
        code: "invalid",
        message: "The side chosen in words is not the side of the area marked on the drawing.",
        refusedAt: ago(1),
      },
      headers: fromDevice,
    });
    expect(copy.status).toBe(200);
    const { taskId } = await json<{ taskId: string }>(copy);
    const priority = await asDemoTenant((c) =>
      c
        .query<{ priority: string }>("SELECT priority FROM task WHERE id = $1", [taskId])
        .then((r) => r.rows[0]?.priority),
    );
    expect(priority).toBe("urgent");
  });
});

describe("hazard HZ-029 a save sent again with other details is refused, never shown as saved (#26 review round 2, C5)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  it("refuses a ReSPECT plan sent again with a changed CPR decision, and a DNACPR with a changed clinician", async () => {
    const path = `/v1/people/${resident(3)}/advance-care`;
    const id = newId();
    const respect = {
      id,
      kind: "respect",
      cprDecision: "attempt_cpr",
      clinicianName: "Dr Example",
      clinicianRole: "GP",
      completedOn: today(),
    };
    expect((await as("manager", path, { method: "POST", body: respect })).status).toBe(201);
    const changed = await as("manager", path, {
      method: "POST",
      body: { ...respect, cprDecision: "do_not_attempt_cpr" },
    });
    expect(changed.status).toBe(409);
    expect((await json<ProblemDetails>(changed)).detail).toBe(
      "This was already saved with different details: reload before changing it.",
    );
    const stored = await json<{ items: AdvanceCareItem[] }>(await as("manager", path));
    expect(stored.items.find((i) => i.id === id)?.cprDecision).toBe("attempt_cpr");
    // The same details again return the record.
    expect((await as("manager", path, { method: "POST", body: respect })).status).toBe(201);

    const dnacpr = {
      id: newId(),
      kind: "dnacpr",
      clinicianName: "Dr Example",
      clinicianRole: "GP",
      completedOn: today(),
    };
    expect((await as("manager", path, { method: "POST", body: dnacpr })).status).toBe(201);
    const otherClinician = await as("manager", path, {
      method: "POST",
      body: { ...dnacpr, clinicianName: "Dr Someone Else" },
    });
    expect(otherClinician.status).toBe(409);
  });

  it("refuses a consent and a DoLS entry sent again with changed details", async () => {
    const consentPath = `/v1/people/${resident(3)}/consents`;
    const consent = {
      id: newId(),
      decision: "photos",
      outcome: "given",
      givenBy: "person",
      givenAt: ago(10),
      evidence: "Agreed when asked in the lounge.",
    };
    expect((await as("manager", consentPath, { method: "POST", body: consent })).status).toBe(201);
    const refused = await as("manager", consentPath, {
      method: "POST",
      body: { ...consent, outcome: "refused" },
    });
    expect(refused.status).toBe(409);
    expect((await as("manager", consentPath, { method: "POST", body: consent })).status).toBe(201);

    const dolsPath = `/v1/people/${resident(3)}/dols`;
    const dols = { id: newId(), type: "standard", requestedAt: ago(60) };
    expect((await as("manager", dolsPath, { method: "POST", body: dols })).status).toBe(201);
    const urgent = await as("manager", dolsPath, {
      method: "POST",
      body: { ...dols, type: "urgent" },
    });
    expect(urgent.status).toBe(409);
  });

  it("never returns a removed escalation policy link as live", async () => {
    const id = newId();
    const link = { id, toolKey: "waterlow", title: "Skin integrity policy" };
    const made = await as("owner", "/v1/escalation-policies", { method: "POST", body: link });
    expect(made.status).toBe(201);
    const item = await json<EscalationPolicyLinkItem>(made);
    const removed = await as("owner", `/v1/escalation-policies/${id}/remove`, {
      method: "POST",
      body: { version: item.version },
    });
    expect(removed.status).toBe(200);
    const replay = await as("owner", "/v1/escalation-policies", { method: "POST", body: link });
    expect(replay.status).toBe(409);
  });
});

describe("escalation links and coded reasons follow the roles that carry the permission (#26 review round 2, S1)", () => {
  /** Extra roles for the Registered Manager at Harbour House, removed again after each test. */
  const withExtraRoles = async (
    roles: readonly ("administrator" | "group_executive" | "owner")[],
    atLodge: readonly string[],
    fn: () => Promise<void>,
  ) => {
    const ids = await asDemoTenant((c) =>
      c
        .query<{ id: string }>(
          `INSERT INTO role_assignment (tenant_user_id, role_id, location_id, reason)
           SELECT $1, id, CASE WHEN key = ANY($3) THEN $2::uuid END, 'Test'
           FROM role WHERE key = ANY($4) AND tenant_id = $5
           RETURNING id`,
          [DEMO.users.manager.id, LODGE.locationId, atLodge, roles, DEMO.tenantId],
        )
        .then((r) => r.rows.map((row) => row.id)),
    );
    expect(ids).toHaveLength(roles.length);
    try {
      await fn();
    } finally {
      await asDemoTenant((c) =>
        c.query("UPDATE role_assignment SET deleted_at = now() WHERE id = ANY($1)", [ids]),
      );
    }
  };

  it("refuses a Registered Manager's links where another role gives them scope only, and organisation-wide", async () => {
    // Also an administrator at Harbour Lodge and a group executive: neither role carries
    // quality.policy.manage, though together they widen the manager's scope to the organisation.
    await withExtraRoles(["administrator", "group_executive"], ["administrator"], async () => {
      const atLodge = await as("manager", "/v1/escalation-policies", {
        method: "POST",
        body: { toolKey: "braden", locationId: LODGE.locationId, title: "Lodge skin policy" },
      });
      expect(atLodge.status).toBe(403);
      const organisation = await as("manager", "/v1/escalation-policies", {
        method: "POST",
        body: { toolKey: "braden", title: "Organisation skin policy" },
      });
      expect(organisation.status).toBe(403);
      const atHome = await as("manager", "/v1/escalation-policies", {
        method: "POST",
        body: { toolKey: "braden", locationId: DEMO.locationId, title: "House skin policy" },
      });
      expect(atHome.status).toBe(201);
    });
  });

  it("refuses the organisation's coded reasons to the owner role held at one home only", async () => {
    await withExtraRoles(["owner", "group_executive"], ["owner"], async () => {
      const added = await as("manager", "/v1/discard-reasons", {
        method: "POST",
        body: { code: "lodge_only", label: "A reason for the Lodge" },
      });
      expect(added.status).toBe(403);
    });
  });

  it("lists the coded reasons only to whoever may record a deletion", async () => {
    expect((await as("quality", "/v1/discard-reasons")).status).toBe(403);
    expect((await as("carer", "/v1/discard-reasons")).status).toBe(200);
  });
});
