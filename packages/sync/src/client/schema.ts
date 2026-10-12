import { column, Schema, Table } from "@powersync/common";

/**
 * Local (on-device) SQLite schema for the offline-first apps.
 *
 * Only the columns a care worker needs at the point of care are synced. Every table carries
 * tenant_id so the client can assert it never holds another tenant's rows, and the server-side
 * sync streams (../streams/sync-config.yaml) are the authority for what reaches a device. Column
 * names here must match the stream queries' output columns.
 *
 * PowerSync adds the `id` column (text UUID) to every table automatically.
 */

/** People the signed-in user is allowed to see offline (assigned people or their locations). */
const person = new Table(
  {
    tenant_id: column.text,
    location_id: column.text,
    status: column.text,
    given_name: column.text,
    family_name: column.text,
    preferred_name: column.text,
    date_of_birth: column.text,
    nhs_number: column.text,
    room_label: column.text,
    /** Fetch the image through the API (`GET /v1/people/{id}/photo`); never a pre-signed URL. */
    photo_document_id: column.text,
    /** JSON array of { code, display, preferredFormat } (Accessible Information Standard). */
    communication_needs: column.text,
    /** 'unknown' | 'no_known_allergies' | 'has_allergies' (HZ-007: unknown is not "none"). */
    allergy_status: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_location: ["location_id"], by_family_name: ["family_name"] } },
);

/** Allergies are reference data that must never be evicted while an assignment stands. */
const allergy = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    substance: column.text,
    reaction: column.text,
    severity: column.text,
    status: column.text,
    recorded_at: column.text,
  },
  { indexes: { by_person: ["person_id"] } },
);

/** Locations the user can work at, for the location switcher. */
const location = new Table({
  tenant_id: column.text,
  name: column.text,
  cqc_location_id: column.text,
  nation: column.text,
});

/** Local-only bookkeeping: last successful sync, queued writes, clock drift (hazard HZ-002, HZ-006). */
const sync_meta = new Table(
  {
    key: column.text,
    value: column.text,
  },
  { localOnly: true },
);

// ------------------------------------------------------------------------------------------------
// Care record (docs/specs/care.md sections 2 and 6). Reference tables are read-only on the device;
// the five entry tables are append-only and written offline, then uploaded through the API's own
// endpoints with the device's UUIDv7, so a replay is ignored. Booleans arrive as 0 or 1, JSON
// columns as text. Timestamps are ISO 8601 text in UTC.
// ------------------------------------------------------------------------------------------------

/** IDDSI levels (HZ-016), fluid target, the NEWS2 SpO2 scale decision and skin risk. */
const person_care_profile = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    iddsi_food_level: column.text,
    iddsi_drink_level: column.text,
    iddsi_advised_by: column.text,
    iddsi_changed_at: column.text,
    fluid_target_ml: column.integer,
    /** 1 only when a clinician recorded the decision to use SpO2 scale 2 for NEWS2. */
    spo2_scale2: column.integer,
    skin_risk: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_person: ["person_id"] } },
);

/** The active care plan only; drafts and superseded versions never reach a device (HZ-024). */
const care_plan = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    location_id: column.text,
    status: column.text,
    published_version: column.integer,
    summary: column.text,
    review_due_on: column.text,
    published_at: column.text,
    sign_off_kind: column.text,
    signed_off_at: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_person: ["person_id"] } },
);

const care_plan_section = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    plan_id: column.text,
    /** One of the 16 PCSP need domains. */
    domain: column.text,
    need: column.text,
    /** In the person's own words. */
    outcome: column.text,
    strengths: column.text,
    contingency: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_plan: ["plan_id"] } },
);

const care_plan_action = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    plan_id: column.text,
    section_id: column.text,
    action: column.text,
    role_key: column.text,
    when_text: column.text,
    /** JSON Recurrence in the location's time zone, or null for actions done as needed. */
    recurrence: column.text,
    risk_assessment_id: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_section: ["section_id"] } },
);

/** Active risk assessments only. */
const risk_assessment = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    template_key: column.text,
    template_version: column.text,
    hazard: column.text,
    who_at_risk: column.text,
    risk_rating: column.integer,
    risk_band: column.text,
    residual_rating: column.integer,
    residual_band: column.text,
    /** JSON array of control measures. */
    controls: column.text,
    positive_risk_statement: column.text,
    person_views: column.text,
    assessed_on: column.text,
    review_due_on: column.text,
    status: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_person: ["person_id"] } },
);

/** Validated-tool results (summary columns only); the device shows the latest per tool. */
const assessment = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    location_id: column.text,
    tool_key: column.text,
    tool_version: column.text,
    score: column.integer,
    band: column.text,
    occurred_at: column.text,
    next_due_on: column.text,
    supersedes_id: column.text,
    correction_reason: column.text,
    late_entry: column.integer,
  },
  { indexes: { by_person_tool: ["person_id", "tool_key"] } },
);

/** Active ReSPECT, DNACPR, ADRT and advance care plan records (HZ-015). */
const advance_care_record = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    kind: column.text,
    status: column.text,
    cpr_decision: column.text,
    clinician_name: column.text,
    clinician_role: column.text,
    completed_on: column.text,
    review_due_on: column.text,
    details: column.text,
    updated_at: column.text,
    version: column.integer,
  },
  { indexes: { by_person: ["person_id"] } },
);

/**
 * Columns every append-only point-of-care entry shares. `recorded_at` (server-received) is empty
 * until the server's copy replaces the one written on the device, which is how screens tell a
 * queued entry from a saved one. `device_time` is the device clock when the entry was written.
 */
const entryColumns = {
  tenant_id: column.text,
  person_id: column.text,
  location_id: column.text,
  occurred_at: column.text,
  recorded_at: column.text,
  device_time: column.text,
  late_entry: column.integer,
  clock_drift: column.integer,
  supersedes_id: column.text,
  correction_reason: column.text,
  created_by: column.text,
};

const entryIndexes = { by_person_time: ["person_id", "occurred_at"] };

const care_note = new Table(
  {
    ...entryColumns,
    category: column.text,
    body: column.text,
    /** JSON array of tags from the fixed vocabulary. */
    tags: column.text,
  },
  { indexes: entryIndexes },
);

const observation = new Table(
  {
    ...entryColumns,
    chart: column.text,
    /** The typed chart values as JSON (`values` on the server, a reserved word in SQLite). */
    chart_values: column.text,
    /** JSON flags: the server's NEWS2 result and IDDSI comparison, or the device's until then. */
    flags: column.text,
  },
  { indexes: { ...entryIndexes, by_person_chart: ["person_id", "chart", "occurred_at"] } },
);

const body_map_mark = new Table(
  {
    ...entryColumns,
    view: column.text,
    region: column.text,
    /** The person's side, chosen in words (HZ-019). */
    side: column.text,
    /**
     * Device only: the side where the mark was drawn, sent with the upload so the API repeats the
     * HZ-019 check. Never sent by the server, so it is empty on synced rows.
     */
    drawn_side: column.text,
    /**
     * Device only: where the mark was placed on the drawing, sent so the API works the side out
     * itself (HZ-019): the zone of the drawing (`viewer_left`, `centre` or `viewer_right`), and
     * the point tapped in the drawing's own units (120 by 240), empty when the zone was chosen
     * with the buttons. Never sent by the server.
     */
    drawn_zone: column.text,
    drawn_x: column.real,
    drawn_y: column.real,
    mark_type: column.text,
    pressure_category: column.text,
    device_related: column.integer,
    bruise_explained: column.integer,
    length_mm: column.real,
    width_mm: column.real,
    depth_mm: column.real,
    description: column.text,
    status: column.text,
  },
  { indexes: entryIndexes },
);

const activity_record = new Table(
  {
    ...entryColumns,
    activity: column.text,
    format: column.text,
    group_session_id: column.text,
    attendance: column.text,
    engagement: column.text,
    duration_minutes: column.integer,
    notes: column.text,
  },
  { indexes: entryIndexes },
);

const visit_log = new Table(
  {
    ...entryColumns,
    kind: column.text,
    contact_id: column.text,
    visitor_name: column.text,
    visitor_relationship: column.text,
    ended_at: column.text,
    restrictions_applied: column.integer,
    restriction_reason: column.text,
    notes: column.text,
  },
  { indexes: entryIndexes },
);

// ------------------------------------------------------------------------------------------------
// The round and the shift handover (care.md rule 8 and section 6). Read on the device, scoped as
// the API's round and handover views are; a task leaves the device once it is no longer open, and
// a handover once its shift ended before the offline window.
// ------------------------------------------------------------------------------------------------

/** Open tasks due on a day of the offline window. Titles are generic; the person is a reference. */
const task = new Table(
  {
    tenant_id: column.text,
    series_id: column.text,
    location_id: column.text,
    person_id: column.text,
    /** `module.what`, for example `care.reposition`. */
    kind: column.text,
    title: column.text,
    required_permission: column.text,
    /** A care plan round's action (`care_plan_action`), when the plan generated it. */
    source_type: column.text,
    source_id: column.text,
    assignee_tenant_user_id: column.text,
    assignee_role_key: column.text,
    due_at: column.text,
    window_start: column.text,
    window_end: column.text,
    priority: column.text,
    evidence_required: column.integer,
    /** `open` or `in_progress` (anything else has left the device). */
    status: column.text,
    /** `caught_up` when a return or correction brought a missed round back once (people.md rule 2). */
    restore_code: column.text,
    escalation_level: column.integer,
    updated_at: column.text,
    /** Sent back as `version` when the task is moved, so a stale move is refused. */
    version: column.integer,
  },
  {
    indexes: {
      by_location_due: ["location_id", "due_at"],
      by_person_due: ["person_id", "due_at"],
    },
  },
);

/** One handover per location and shift; no refresh time or version (whole readers' only). */
const handover = new Table(
  {
    tenant_id: column.text,
    location_id: column.text,
    shift_name: column.text,
    shift_start: column.text,
    shift_end: column.text,
    compiled_at: column.text,
    locked_at: column.text,
  },
  { indexes: { by_location_shift: ["location_id", "shift_end"] } },
);

/**
 * The compiled items the reader may see, by reference only (`key` on the server, a keyword on the
 * device). Their keys in `position` order make the seen token the API asks for when acknowledging.
 */
const handover_item = new Table(
  {
    tenant_id: column.text,
    handover_id: column.text,
    item_key: column.text,
    position: column.integer,
    kind: column.text,
    person_id: column.text,
    source_type: column.text,
    source_id: column.text,
    /** When it happened, or when the task fell due. */
    at: column.text,
    late_addition: column.integer,
    added_at: column.text,
  },
  { indexes: { by_handover: ["handover_id", "position"] } },
);

/** Notes by the outgoing staff on the handover (no item) or on one of its items. */
const handover_note = new Table(
  {
    tenant_id: column.text,
    handover_id: column.text,
    item_key: column.text,
    person_id: column.text,
    body: column.text,
    created_at: column.text,
    created_by: column.text,
  },
  { indexes: { by_handover: ["handover_id", "created_at"] } },
);

/**
 * Acknowledgements: the reader's own, and everyone's where they see the handover whole. The item
 * keys are those the acknowledger could see (JSON array), recorded by the server.
 */
const handover_acknowledgement = new Table(
  {
    tenant_id: column.text,
    handover_id: column.text,
    tenant_user_id: column.text,
    item_keys: column.text,
    acknowledged_at: column.text,
  },
  { indexes: { by_handover: ["handover_id", "tenant_user_id"] } },
);

/**
 * Local-only: an upload the API refused for good (for example the person's record closed while
 * the device was offline). The entry's content stays here, encrypted on the device, until someone
 * deals with it, so a refusal is never silent (HZ-006). `id` is the refused record's id.
 */
const upload_issue = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    record_table: column.text,
    http_status: column.integer,
    code: column.text,
    message: column.text,
    /** The operation's data as JSON. */
    payload: column.text,
    rejected_at: column.text,
    /**
     * Whether the server has its copy (care.md section 6, Device integrity part 5): empty until
     * sent, `copied` once the server has it, `refused` when the server will not take it, and
     * `not_copied` for what is never sent (entries a recorded deletion left).
     */
    server_copy: column.text,
  },
  { localOnly: true, indexes: { by_person: ["person_id"] } },
);

/**
 * Local-only: entries written on the device that had not uploaded when the session ended
 * (HZ-006, security review S2). They are copied here from PowerSync's upload queue, and then
 * everything else synced is cleared from the device, so only the unsent work stays, encrypted,
 * until its owner signs in again (it goes back into the queue) or it is deleted. `id` is the
 * entry's id; `payload` is the entry's columns as JSON; `position` keeps the queue order.
 */
const held_entry = new Table(
  {
    tenant_id: column.text,
    person_id: column.text,
    record_table: column.text,
    op: column.text,
    payload: column.text,
    position: column.integer,
    held_at: column.text,
    /** Why the server did not take it in a hand-over, kept with it (#25 review round 3, M1). */
    handover_refusal: column.text,
  },
  { localOnly: true },
);

export const AppSchema = new Schema({
  person,
  allergy,
  location,
  sync_meta,
  person_care_profile,
  care_plan,
  care_plan_section,
  care_plan_action,
  risk_assessment,
  assessment,
  advance_care_record,
  care_note,
  observation,
  body_map_mark,
  activity_record,
  visit_log,
  task,
  handover,
  handover_item,
  handover_note,
  handover_acknowledgement,
  upload_issue,
  held_entry,
});

export type Database = (typeof AppSchema)["types"];
export type PersonRecord = Database["person"];
export type AllergyRecord = Database["allergy"];
export type LocationRecord = Database["location"];
export type PersonCareProfileRecord = Database["person_care_profile"];
export type CarePlanRecord = Database["care_plan"];
export type CarePlanSectionRecord = Database["care_plan_section"];
export type CarePlanActionRecord = Database["care_plan_action"];
export type RiskAssessmentRecord = Database["risk_assessment"];
export type AssessmentRecord = Database["assessment"];
export type AdvanceCareRecordRecord = Database["advance_care_record"];
export type CareNoteRecord = Database["care_note"];
export type ObservationRecord = Database["observation"];
export type BodyMapMarkRecord = Database["body_map_mark"];
export type ActivityRecordRecord = Database["activity_record"];
export type VisitLogRecord = Database["visit_log"];
export type TaskRecord = Database["task"];
export type HandoverRecord = Database["handover"];
export type HandoverItemRecord = Database["handover_item"];
export type HandoverNoteRecord = Database["handover_note"];
export type HandoverAcknowledgementRecord = Database["handover_acknowledgement"];
export type UploadIssueRecord = Database["upload_issue"];
export type HeldEntryRecord = Database["held_entry"];

/**
 * Reference data for people in scope, never evicted while the assignment (or the location scope)
 * stands (section 17.2, ADR-0011): only the stream's own scope removes these rows.
 */
export const NEVER_EVICT_TABLES = [
  "person",
  "allergy",
  "location",
  "person_care_profile",
  "care_plan",
  "care_plan_section",
  "care_plan_action",
  "risk_assessment",
  "assessment",
  "advance_care_record",
] as const;

/** Point-of-care entries kept for the offline window only (`mobile.offline_window_days`). */
export const OFFLINE_WINDOW_TABLES = [
  "care_note",
  "observation",
  "body_map_mark",
  "activity_record",
  "visit_log",
] as const;
export type OfflineWindowTable = (typeof OFFLINE_WINDOW_TABLES)[number];

/**
 * The round and the handover (`*_open_tasks`, `*_handovers`): open tasks due in the offline window
 * and the handovers of shifts ending in it. Read only on the device until the offline completion
 * and acknowledgement land.
 */
export const ROUND_AND_HANDOVER_TABLES = [
  "task",
  "handover",
  "handover_item",
  "handover_note",
  "handover_acknowledgement",
] as const;

/** The only synced tables a device writes to: append-only entries, inserts only. */
export const DEVICE_WRITABLE_TABLES: readonly OfflineWindowTable[] = OFFLINE_WINDOW_TABLES;
