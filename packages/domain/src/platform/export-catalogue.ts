import type { BoundedContext } from "./permissions";

/**
 * The export catalogue (platform-completions.md rules 10, 11 and 16; data-standards.md; hazards
 * HZ-070 and HZ-071): every table in the `public` schema, keyed by `schema.table`, with its
 * purpose and retention, and every column classified as exported, internal or secret, with a
 * description and, for numbers, a unit. `schema.json` in every export is generated from it.
 *
 * Generated once from the Drizzle schema and maintained by hand: a table or column added to the
 * schema fails `packages/db/src/export-catalogue.test.ts` until it is classified here, so nothing
 * reaches an export by default. A string entry ("exported") takes its description and unit from the
 * naming conventions below; tables that hold care records describe every column explicitly.
 */

/** `exported`: in the files. `internal`: Harbour's own plumbing. `secret`: never leaves Harbour. */
export type ColumnClass = "exported" | "internal" | "secret";

export interface ColumnDoc {
  /** Defaults to `exported`. */
  readonly class?: ColumnClass;
  readonly description: string;
  readonly unit?: string;
  /** Meaning of each stored code, for codes a receiving system must read correctly. */
  readonly codes?: Readonly<Record<string, string>>;
  /** An instant whose meaning is a date (a date of death): the export adds `<column>_uk_date`. */
  readonly ukDate?: boolean;
  /** A JSON column with its own schema in `schema.json`. */
  readonly schema?: "observation_values";
}

export type ColumnSpec = ColumnClass | ColumnDoc;

/**
 * `tenant_rows`: every row of the tenant. `tenant_overrides_only`: global reference tables, where
 * only the tenant's own rows are its data. `not_exported`: not tenant data, with the reason; such a
 * table lists no columns because nothing from it leaves.
 */
export type ExportTreatment = "tenant_rows" | "tenant_overrides_only" | "not_exported";

/**
 * A record class from retention.md, or `tenant_configuration` (kept while the tenant is a
 * customer), `as_subject` (the class of the record it concerns), `by_category` (documents),
 * `permanent` (proof of records management) or `operational`.
 */
export type ExportRetention =
  | "care_record"
  | "audit_event"
  | "dpia"
  | "serious_incident"
  | "downtime_pack"
  | "downtime_record"
  | "evidence_pack"
  | "organisation_document"
  | "invitation"
  | "tenant_configuration"
  | "as_subject"
  | "by_category"
  | "permanent"
  | "operational";

export interface ExportTableDefinition {
  readonly context: BoundedContext;
  readonly description: string;
  readonly treatment: ExportTreatment;
  readonly retention: ExportRetention;
  /** Holds personal data (records of processing). */
  readonly personal: boolean;
  readonly reasonNotExported?: string;
  readonly columns: Readonly<Record<string, ColumnSpec>>;
}

/** The only schema exported; any other (auth, pg-boss, drizzle) never is. */
export const EXPORT_SCHEMA_NAME = "public";

/** Tables holding care records: every column needs an explicit description or a common one. */
export const CLINICAL_EXPORT_TABLES: readonly string[] = [
  "public.person",
  "public.allergy",
  "public.contact",
  "public.placement",
  "public.about_me",
  "public.advance_care_record",
  "public.person_care_profile",
  "public.observation",
  "public.care_note",
  "public.body_map_mark",
  "public.assessment",
  "public.risk_assessment",
  "public.care_plan",
  "public.care_plan_section",
  "public.care_plan_action",
  "public.activity_record",
  "public.visit_log",
  "public.capacity_assessment",
  "public.best_interests_decision",
  "public.consent_record",
  "public.dols_authorisation",
  "public.dols_legal_change_review",
  "public.incident",
  "public.incident_person",
  "public.classifier_answer",
  "public.statutory_notification",
  "public.candour_record",
  "public.investigation",
  "public.pre_admission_assessment",
  "public.admission_decision",
  "public.admission_condition",
  "public.bed_occupancy",
  "public.welcome_checklist_item",
  "public.property_item",
  "public.key_issue",
  "public.review_record",
  "public.care_plan_change",
  "public.hospital_transfer",
  "public.exit_record",
  "public.exit_checklist_item",
  "public.sharing_decision",
  "public.sharing_decision_suspension",
  "public.about_me_share_link",
  "public.handover",
  "public.handover_item",
  "public.handover_note",
  "public.handover_acknowledgement",
  "public.refused_entry",
  "public.entry_device_deletion_flag",
  "public.downtime_pack",
];

interface ConventionalDoc {
  readonly description: string;
  readonly unit?: string;
  readonly source: "common" | "suffix";
}

const COMMON_COLUMNS: Readonly<Record<string, readonly [string, string?]>> = {
  id: ["Opaque id of this row (UUIDv7)."],
  tenant_id: ["The organisation the row belongs to; always the exporting organisation."],
  created_at: ["When the row was created (instant, UTC)."],
  created_by: ["Tenant user who created the row (tenant_user.id)."],
  updated_at: ["When the row last changed (instant, UTC)."],
  updated_by: ["Tenant user who last changed the row (tenant_user.id)."],
  version: [
    "Optimistic-concurrency version; starts at 1 and rises with each change.",
    "version number",
  ],
  deleted_at: [
    "When the row was soft-deleted; empty for live rows (soft-deleted rows are not exported).",
  ],
  occurred_at: ["When the event happened, as recorded (instant, UTC)."],
  recorded_at: ["When the server received the entry (instant, UTC)."],
  device_time: ["The device's clock when the entry was made (instant, UTC), kept to detect drift."],
  device_offset_minutes: ["The device's UTC offset when the entry was made.", "minutes"],
  late_entry: ["True when the entry was recorded well after the event (a retrospective entry)."],
  clock_drift: ["True when the device clock differed from the server beyond the tolerance."],
  supersedes_id: ["The entry this one corrects; see the corrections convention."],
  correction_reason: ["Why an earlier entry was corrected by this one."],
  person_id: ["The person receiving care the row is about (person.id)."],
  location_id: ["The location (location.id)."],
  device_id: ["Opaque id of the device the entry came from."],
  tenant_user_id: ["The member of staff or other user (tenant_user.id)."],
  valid_from: ["Start of the period the row applies to (instant, UTC), inclusive."],
  valid_to: ["End of the period the row applies to (instant, UTC), exclusive; empty while open."],
  subject_type: ["Kind of record the row is about (table name)."],
  subject_id: ["Id of the record the row is about, in the table named by subject_type."],
  source_type: ["Kind of record that caused this row (table name)."],
  source_id: ["Id of the record that caused this row."],
  notes: ["Free-text notes."],
  name: ["Display name."],
  title: ["Title shown on screen (generic for notifications and tasks)."],
};

const SUFFIXES: readonly (readonly [string, string, string?])[] = [
  ["_minutes", "A duration.", "minutes"],
  ["_days", "A duration.", "days"],
  ["_ml", "A volume.", "ml"],
  ["_mm", "A length.", "mm"],
  ["_bytes", "A size.", "bytes"],
  ["_hash", "SHA-256 in lower-case hexadecimal."],
  ["_at", "When this happened (instant, UTC)."],
  ["_on", "A UK calendar date (YYYY-MM-DD)."],
  ["_by", "Tenant user who did this (tenant_user.id)."],
  ["_id", "Opaque id of the related row."],
];

/** The description and unit the naming conventions give a column, or null when none applies. */
export function conventionalColumnDoc(name: string): ConventionalDoc | null {
  const common = COMMON_COLUMNS[name];
  if (common) {
    return { description: common[0], ...(common[1] ? { unit: common[1] } : {}), source: "common" };
  }
  for (const [suffix, description, unit] of SUFFIXES) {
    if (name.endsWith(suffix)) return { description, ...(unit ? { unit } : {}), source: "suffix" };
  }
  return null;
}

export interface ResolvedColumnDoc {
  readonly class: ColumnClass;
  readonly description: string;
  readonly unit: string | null;
  readonly codes: Readonly<Record<string, string>> | null;
  readonly ukDate: boolean;
  readonly schema: "observation_values" | null;
  readonly source: "explicit" | "common" | "suffix";
}

/** A column's classification and documentation, or null when the catalogue does not classify it. */
export function resolveColumnDoc(
  table: ExportTableDefinition,
  column: string,
): ResolvedColumnDoc | null {
  if (!Object.hasOwn(table.columns, column)) return null;
  const spec = table.columns[column] as ColumnSpec;
  if (typeof spec === "string") {
    const conventional = conventionalColumnDoc(column);
    return {
      class: spec,
      description: conventional?.description ?? "",
      unit: conventional?.unit ?? null,
      codes: null,
      ukDate: false,
      schema: null,
      source: conventional?.source ?? "suffix",
    };
  }
  return {
    class: spec.class ?? "exported",
    description: spec.description,
    unit: spec.unit ?? null,
    codes: spec.codes ?? null,
    ukDate: spec.ukDate === true,
    schema: spec.schema ?? null,
    source: "explicit",
  };
}

/**
 * The back-entry columns on the five entries a device or the web writes (operations.md rules 11 to
 * 13; migration 0053): empty on every entry written at the time.
 */
const BACK_ENTRY_COLUMN_DOCS: Readonly<Record<string, ColumnSpec>> = {
  late_entry_reason: {
    description: "Why the entry was made late; empty for an entry written at the time.",
    codes: { downtime: "Entered from a paper record written during an outage (outage_id)." },
  },
  outage_id: {
    description:
      "The outage a paper record was written in, or that an entry written later for a time inside it was not from paper (outage.id).",
  },
  paper_date: { description: "The date written on the paper record (UK calendar date)." },
  paper_time: { description: "The time written on the paper record (UK wall clock, HH:MM)." },
  paper_occurrence: {
    description: "Which time a paper time in the hour the clocks went back was.",
    codes: {
      only: "The time happened once.",
      earlier: "The first of the two (British Summer Time).",
      later: "The second of the two (Greenwich Mean Time).",
    },
  },
  outside_outage_reason: {
    description: "Why a paper record has a time outside its outage, in the writer's words.",
  },
  paper_reference: { description: "The reference on the paper form, when it had one." },
  not_from_paper_reason: {
    description:
      "Why an entry written later for a time inside an outage was not copied from paper, in the writer's words.",
  },
};

export const EXPORT_TABLES: Readonly<Record<string, ExportTableDefinition>> = {
  "public.about_me": {
    context: "people",
    description: "About Me (PRSB About Me v2.01 sections).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      sections: { description: "PRSB About Me v2.01 sections as JSON keyed by section." },
      authored_by_person: { description: "True when the person wrote About Me themselves." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.about_me_share_link": {
    context: "people",
    description:
      "Expiring links that share About Me under a sharing decision (the token is never stored).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      sharing_decision_id: {
        description: "The sharing decision the link rests on (sharing_decision.id).",
      },
      token_hash: {
        class: "secret",
        description:
          "SHA-256 of the link token; never leaves Harbour, so an export cannot open a link.",
      },
      expires_at: { description: "When the link stops working (instant, UTC)." },
      revoked_at: {
        description: "When the link was revoked (instant, UTC); empty while it works.",
      },
      revoked_reason: { description: "Why the link was revoked." },
      last_opened_at: { description: "When the link was last opened (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.access_grant": {
    context: "platform",
    description: "Time-boxed delegation and acting-up grants.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      permissions: { description: "Permissions granted (module.resource.action)." },
      location_id: "exported",
      organisation_wide: { description: "Whether the grant reaches the whole organisation." },
      valid_from: "exported",
      valid_to: "exported",
      reason: { description: "Why the grant was given." },
      granted_by: "exported",
      revoked_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.activity_record": {
    context: "care",
    description: "Activities and attendance.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      handed_over_by: {
        description:
          "Sent by: the manager who handed this entry over from a device for its author (created_by), when one did (tenant_user.id; care.md section 6, Device integrity part 6). Empty when its author sent it.",
      },
      device_id: "exported",
      ...BACK_ENTRY_COLUMN_DOCS,
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      activity: { description: "The activity." },
      format: { description: "one_to_one or group." },
      group_session_id: { description: "The group session, where it was one." },
      attendance: { description: "Attendance: attended, declined, unable and so on." },
      engagement: { description: "Engagement, in words." },
      duration_minutes: { description: "How long it lasted.", unit: "minutes" },
      notes: { description: "Notes." },
    },
  },
  "public.admission_condition": {
    context: "people",
    description: "Conditions on a decision to admit, and who confirmed each one met.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      decision_id: { description: "The decision to admit (admission_decision.id)." },
      position: {
        description: "Order of the condition within the decision.",
        unit: "position (from 0)",
      },
      condition: { description: "The condition, in words." },
      met_by: { description: "Who confirmed the condition met (tenant_user.id)." },
      met_at: { description: "When the condition was confirmed met (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.admission_decision": {
    context: "people",
    description:
      "Decisions to admit, with reasons (append-only; a correction supersedes the original).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      assessment_id: {
        description: "The pre-admission assessment decided on (pre_admission_assessment.id).",
      },
      can_meet_needs: {
        description: "Whether the home can meet the person's needs.",
        codes: {
          yes: "The home can meet the needs.",
          yes_with_conditions:
            "The home can meet the needs once the conditions are met (admission_condition).",
          no: "The home cannot meet the needs; the person is not admitted.",
        },
      },
      reasons: { description: "The reasons for the decision, in words." },
      planned_admission_on: { description: "Planned admission date (UK calendar date)." },
      trial_ends_on: {
        description: "End of a trial placement (UK calendar date), if one is planned.",
      },
      decided_by: { description: "Who decided (tenant_user.id, holding people.admission.manage)." },
      decided_at: { description: "When the decision was made (instant, UTC)." },
      told_who: { description: "Who was told the decision." },
      told_at: { description: "When they were told (instant, UTC)." },
      supersedes_id: "exported",
      correction_reason: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.advance_care_record": {
    context: "care",
    description: "ReSPECT, DNACPR, ADRT and advance care plans.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      kind: { description: "respect, dnacpr, adrt or advance_care_plan." },
      status: { description: "active, withdrawn or superseded; only active records are in force." },
      cpr_decision: {
        description: "The CPR recommendation on a ReSPECT or DNACPR record.",
        codes: {
          attempt_cpr: "Attempt cardiopulmonary resuscitation",
          do_not_attempt_cpr: "Do not attempt cardiopulmonary resuscitation",
        },
      },
      clinician_name: { description: "Name of the clinician who completed the form." },
      clinician_role: { description: "Role of that clinician." },
      completed_on: { description: "Date the form was completed (UK calendar date)." },
      review_due_on: { description: "Review date (UK calendar date), if set." },
      document_id: { description: "The scanned form (document.id)." },
      details: { description: "Details as written (for example treatments refused), JSON." },
      withdrawn_at: { description: "When the record was withdrawn (instant, UTC)." },
      withdrawn_reason: { description: "Why it was withdrawn." },
      superseded_by_record_id: {
        description: "The record that replaced this one (advance_care_record.id).",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.allergy": {
    context: "people",
    description: "Allergies and the allergy status.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      substance: { description: "The substance, as recorded." },
      snomed_code: { description: "SNOMED CT concept for the substance, where coded." },
      category: { description: "Category: medicine, food, environment or other." },
      reaction: { description: "The reaction, as recorded." },
      severity: { description: "Severity: mild, moderate, severe or unknown." },
      status: {
        description: "active, inactive or entered_in_error; only active allergies are current.",
      },
      recorded_at: "exported",
      verified_by: { description: "Tenant user who verified the allergy (tenant_user.id)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.assessment": {
    context: "care",
    description:
      "Validated tool results (MUST, Waterlow, Braden, falls) with answers and workings.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      tool_key: { description: "Validated tool: must, waterlow, braden or ng249_falls." },
      tool_version: { description: "Version of the tool's published method used for this result." },
      answers: { description: "The answers, as entered, JSON." },
      score: {
        description: "The tool's total score, calculated as published.",
        unit: "points (on the tool's own scale)",
      },
      band: { description: "The tool's band for that score." },
      workings: { description: "How the score was calculated, JSON." },
      triggers: { description: "Follow-ups the result raised, JSON." },
      details: { description: "Further details the tool records, JSON." },
      next_due_on: { description: "When the next assessment is due (UK calendar date)." },
    },
  },
  "public.audit_event": {
    context: "platform",
    description:
      "The append-only, hash-chained audit trail: who did what, when, from where, with opaque record ids.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      seq: { description: "Global sequence number of the event.", unit: "sequence number" },
      tenant_id: "exported",
      chain_position: {
        description: "Position in this organisation's hash chain.",
        unit: "sequence number",
      },
      occurred_at: "exported",
      actor_tenant_user_id: "exported",
      actor_auth_user_id: "exported",
      actor_role_keys: { description: "Roles the actor held when acting." },
      action: { description: "What was done (module.resource.action, or a named event)." },
      outcome: { description: "success, denied or error." },
      resource_type: { description: "Kind of record acted on (table name)." },
      resource_id: "exported",
      scope: { description: "Scope and counts for the action, JSON with opaque ids only." },
      ip: { description: "IP address the request came from." },
      device_id: "exported",
      request_id: "exported",
      reason: { description: "Justification given, where one was required." },
      before_hash: "exported",
      after_hash: "exported",
      prev_hash: "exported",
      hash: {
        description: "SHA-256 of this event chained to the previous one; check with prev_hash.",
      },
    },
  },
  "public.bank_holiday": {
    context: "platform",
    description: "UK bank holidays.",
    treatment: "not_exported",
    retention: "operational",
    personal: false,
    reasonNotExported:
      "Global reference data with no organisation rows (published in calendar.md).",
    columns: {},
  },
  "public.bed_occupancy": {
    context: "people",
    description:
      "Who occupied which bed and when: the room and move history (half-open date ranges).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      room_id: { description: "The room (room.id)." },
      bed: { description: "The bed in the room, numbered from 1.", unit: "bed number" },
      from_date: { description: "First day in the bed (UK calendar date), inclusive." },
      to_date: {
        description:
          "Day the person left the bed (UK calendar date), exclusive; empty while there.",
      },
      reason: { description: "Why the person moved, in words." },
      backdated: { description: "True when the move was recorded after the day it happened." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.best_interests_decision": {
    context: "care",
    description:
      "Best-interests decisions after an assessment found a lack of capacity (MCA 2005 s.4). Append-only; corrections supersede.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      capacity_assessment_id: {
        description:
          "The capacity assessment that found the person lacked capacity for this decision (capacity_assessment.id).",
      },
      decision: { description: "The decision made in the person's best interests, in words." },
      decided_at: { description: "When the decision was made (instant, UTC)." },
      checklist: {
        description:
          "The MCA s.4 checklist, JSON keyed by item: { answer: considered or not_applicable, note or reason }.",
      },
      consultations: {
        description:
          "Who was consulted (MCA s.4(7)), JSON list of { consultee, name, contactId, views, consultedAt }.",
      },
      no_consultation_reason: { description: "Why nobody could be consulted, when nobody was." },
      serious_medical_treatment: {
        description: "True when the decision is about serious medical treatment.",
      },
      accommodation_change: {
        description: "True when the decision is about a long-term change of accommodation.",
      },
      imca_prompt: {
        description:
          "The prompt shown to instruct an Independent Mental Capacity Advocate (MCA s.37 to s.39), when one applied.",
      },
      review_on: { description: "When the decision is to be reviewed (UK calendar date)." },
      recorded_at: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.body_map_mark": {
    context: "care",
    description: "Body-map marks with side and site.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      handed_over_by: {
        description:
          "Sent by: the manager who handed this entry over from a device for its author (created_by), when one did (tenant_user.id; care.md section 6, Device integrity part 6). Empty when its author sent it.",
      },
      device_id: "exported",
      ...BACK_ENTRY_COLUMN_DOCS,
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      view: { description: "Body view: front or back." },
      region: { description: "Body region." },
      side: { description: "The person's left or right (never the viewer's)." },
      drawn_x: {
        description:
          "Where the mark was placed on the body map drawing, across: 0 at the viewer's left edge to 120 at the right (care.md rule 7); empty when it was placed with the zone buttons or recorded before the server checked it.",
        unit: "drawing units (0 to 120)",
      },
      drawn_y: {
        description:
          "Where the mark was placed on the body map drawing, down: 0 at the top to 240 at the bottom; the centre band reaches down to 124.",
        unit: "drawing units (0 to 240)",
      },
      drawn_zone: {
        description:
          "The zone of the drawing the mark was placed in, as the person recording saw it; empty for marks recorded before the server checked the side.",
        codes: {
          viewer_left: "The left of the drawing as seen (the person's right on the front view).",
          centre: "The narrow centre band over the head and trunk.",
          viewer_right: "The right of the drawing as seen (the person's left on the front view).",
        },
      },
      drawn_side: {
        description:
          "The person's side where the mark was drawn, as the server worked it out from the drawing and the view; side agrees with it (HZ-019). Empty for marks recorded before the server checked it.",
      },
      drawn_from_device_side: {
        description:
          "True when the place on the drawing was taken from the side a phone said it drew, because an app from before the server read the drawing sent no point or zone; the side was not checked against a place on the drawing (HZ-019).",
      },
      mark_type: {
        description: "Kind of mark: bruise, wound, pressure damage, skin tear and so on.",
      },
      pressure_category: { description: "Pressure ulcer category, where it is pressure damage." },
      device_related: { description: "True when caused by a medical device." },
      bruise_explained: { description: "Whether a bruise has an explanation recorded." },
      length_mm: { description: "Length of the mark.", unit: "mm" },
      width_mm: { description: "Width of the mark.", unit: "mm" },
      depth_mm: { description: "Depth of the mark.", unit: "mm" },
      description: { description: "Description, as recorded." },
      photo_document_id: { description: "Photo of the mark (document.id)." },
      incident_id: { description: "The incident the mark is linked to, if any." },
      status: { description: "open or healed." },
    },
  },
  "public.break_glass_event": {
    context: "people",
    description:
      "Records opened, and break-glass searches made, outside scope, with the typed justification and review.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      kind: {
        description:
          "open (a record opened outside scope) or search (a break-glass search; the people shown are in its audit event).",
      },
      person_id: {
        description: "The person whose record was opened (person.id); empty for a search.",
      },
      shown_location_ids: {
        description:
          "For a search, the homes whose people were shown (location.id), for the weekly report.",
      },
      justification: {
        description: "The typed justification for opening or finding a record outside scope.",
      },
      reason_code: {
        description:
          "The reason chosen, for the weekly report; the typed justification is kept as well.",
        codes: {
          emergency_care: "Emergency care.",
          covering_another_area: "Covering another area.",
          safeguarding: "Safeguarding.",
          incident_or_complaint: "An incident or complaint.",
          request_from_professional: "A request from a professional.",
          other: "Another reason, in the justification.",
        },
      },
      opened_at: "exported",
      expires_at: "exported",
      reviewed_at: "exported",
      reviewed_by: "exported",
      review_outcome: { description: "The manager's review of the opening." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.break_glass_weekly_report": {
    context: "people",
    description:
      "The Monday report of break-glass openings for each location: counts and opaque ids only (append-only; a review supersedes the report).",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      week_start: { description: "Monday 00:00 UK time at the start of the week (instant, UTC)." },
      week_end: { description: "The following Monday 00:00 UK time (instant, UTC), exclusive." },
      generated_at: { description: "When the report was built (instant, UTC)." },
      repeat_threshold: {
        description: "Openings by one user in the week at which the report flags repeated use.",
        unit: "openings per week",
      },
      summary: {
        description:
          "Totals, lines by user, person and reason, unreviewed openings and flags, JSON (opaque ids only).",
      },
      reviewed_by: { description: "Who reviewed the report (tenant_user.id)." },
      reviewed_at: { description: "When the report was reviewed (instant, UTC)." },
      actions_taken: { description: "What the reviewer did about the report." },
      supersedes_id: {
        description: "The report this review row completes (break_glass_weekly_report.id).",
      },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.candour_record": {
    context: "safety",
    description:
      "The duty of candour for an incident (regulation 20 of the 2014 Regulations): threshold, notification in person, written notification and contact attempts.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      incident_id: { description: "The incident (incident.id)." },
      person_id: "exported",
      state: {
        description:
          "Where the duty of candour stands (CANDOUR_WORKFLOW): threshold_assessment, not_notifiable, verbal_due, no_contact, written_due, enquiries_open or closed.",
      },
      threshold_notifiable: {
        description: "True when the incident was decided to be a notifiable safety incident.",
      },
      threshold_decided_at: { description: "When the threshold was decided (instant, UTC)." },
      threshold_decided_by: {
        description:
          "The health care professional whose opinion the threshold decision records, in words.",
      },
      verbal: {
        description:
          "The notification in person (regulation 20(3)), JSON { at, byRepresentatives, inPerson, accountGiven, enquiriesAdvised, apologyGiven, writtenRecordId }.",
      },
      contact_attempts: {
        description:
          "Attempts to contact the relevant person (regulation 20(5)(b)), JSON list of { at, note }.",
      },
      written: {
        description:
          "The written notification (regulation 20(4)), JSON { sentAt, documentId, includesAccount, includesEnquiries, includesApology }.",
      },
      enquiry_results_shared_at: {
        description: "When the results of further enquiries were shared (instant, UTC).",
      },
      correspondence_document_ids: {
        description: "Letters and other correspondence about the duty of candour (document.id).",
      },
      outcome: { description: "How the duty of candour ended, as recorded when it closed." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.capacity_assessment": {
    context: "care",
    description:
      "Mental capacity assessments: one decision at one time (MCA 2005 s.1 to s.3). Append-only; corrections supersede.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      decision: {
        description:
          "The decision assessed, in words (for example, whether to have bed rails at night).",
      },
      decision_kind: {
        description:
          "The consent decision assessed, when it is one: care_plan, photos, social_media, sharing, marketing, ai_processing, bed_rails or covert_medicines.",
      },
      assessed_at: { description: "When the assessment was carried out (instant, UTC)." },
      assessor_tenant_user_id: {
        description:
          "The member of staff who assessed (tenant_user.id); empty when an outside professional did.",
      },
      assessor_name: { description: "Name of an outside professional who assessed." },
      assessor_role: { description: "Role of an outside professional who assessed." },
      practicable_steps: {
        description:
          "Steps taken to help the person decide (MCA s.1(3)), JSON list of { step, detail }.",
      },
      stage1_impairment: {
        description:
          "Stage 1: true when there is an impairment of, or a disturbance in the functioning of, the mind or brain.",
      },
      stage1_description: { description: "Stage 1: the impairment or disturbance, in words." },
      stage2: {
        description:
          "Stage 2 (MCA s.3(1)): understand, retain, use or weigh, and communicate, each with able and evidence, JSON.",
      },
      inability_because_of_impairment: {
        description: "True when an inability to decide is because of the stage 1 impairment.",
      },
      outcome: {
        description: "The finding for this decision at this time.",
        codes: {
          has_capacity: "The person can make this decision.",
          lacks_capacity:
            "The person cannot make this decision, because of the impairment; a best-interests decision or a representative's consent is needed.",
        },
      },
      unable_to: { description: "The stage 2 abilities the person was unable to use." },
      reason: { description: "The reason for the finding, in the Act's words." },
      review_on: { description: "When the assessment is to be reviewed (UK calendar date)." },
      recorded_at: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.care_note": {
    context: "care",
    description: "Daily notes (append-only; corrections reference the original).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      handed_over_by: {
        description:
          "Sent by: the manager who handed this entry over from a device for its author (created_by), when one did (tenant_user.id; care.md section 6, Device integrity part 6). Empty when its author sent it.",
      },
      device_id: "exported",
      ...BACK_ENTRY_COLUMN_DOCS,
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      category: { description: "Note category." },
      body: { description: "The note text." },
      search_body: {
        description:
          "Search index of the note text (derived from the columns above; migration 0066); not exported.",
        class: "internal",
      },
      tags: { description: "Tags on the note." },
      attachment_document_ids: { description: "Attached documents (document.id list)." },
    },
  },
  "public.care_plan": {
    context: "care",
    description: "Care plans (PRSB personalised care and support plan) and their versions.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      status: {
        description: "draft, published or superseded; only one published plan is current.",
      },
      published_version: { description: "Version number when published.", unit: "version number" },
      based_on_plan_id: { description: "The plan this draft started from (care_plan.id)." },
      copy_from_active: {
        description:
          "Whether starting the draft asked for the active plan to be copied (null before this was kept).",
      },
      summary: { description: "Summary of the plan." },
      review_due_on: { description: "Review date (UK calendar date)." },
      review_reason: { description: "Why a review was asked for." },
      review_requested_at: { description: "When the review was asked for (instant, UTC)." },
      published_at: { description: "When the plan was published (instant, UTC)." },
      published_by: { description: "Tenant user who published it (tenant_user.id)." },
      superseded_at: { description: "When a newer plan replaced it (instant, UTC)." },
      superseded_by_plan_id: { description: "The plan that replaced it (care_plan.id)." },
      sign_off_kind: {
        description: "Who agreed the plan: the person, a representative, or unable with a reason.",
      },
      sign_off_representative_name: { description: "The representative's name, where one agreed." },
      sign_off_authority: { description: "The representative's legal authority." },
      sign_off_contact_id: { description: "The representative (contact.id)." },
      sign_off_unable_reason: { description: "Why the person could not agree the plan." },
      signed_off_at: { description: "When it was agreed (instant, UTC)." },
      signed_off_recorded_by: {
        description: "Tenant user who recorded the agreement (tenant_user.id).",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.care_plan_action": {
    context: "care",
    description: "Care plan actions and the tasks they generate.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      plan_id: { description: "The plan (care_plan.id)." },
      section_id: { description: "The section (care_plan_section.id)." },
      action: { description: "What staff do." },
      role_key: { description: "The role that does it." },
      recurrence: {
        description: "When it recurs, JSON; times of day are Europe/London wall-clock times.",
      },
      when_text: { description: "When, in words." },
      generates_tasks: { description: "True when the action creates tasks on the rota." },
      evidence_required: { description: "True when a task needs evidence to be completed." },
      risk_assessment_id: { description: "The risk assessment it controls (risk_assessment.id)." },
      task_series_id: {
        description: "The recurring task it created or took over (task_series.id).",
      },
      based_on_action_id: {
        description:
          "The action of the earlier plan version this one was copied from (care_plan_action.id); an unchanged action took over that action's recurring task.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.care_plan_change": {
    context: "people",
    description: "Changes that bring a care plan review forward (one review covers them all).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      kind: {
        description: "What changed.",
        codes: {
          return_from_hospital: "The person came back from hospital.",
          fall: "A fall.",
          change_in_needs: "The person's needs changed.",
          new_diagnosis: "A new diagnosis.",
          safeguarding: "A safeguarding concern.",
          end_of_life: "The person is approaching the end of life.",
          other: "Another change, described in the source record.",
        },
      },
      occurred_on: { description: "When the change happened (UK calendar date)." },
      source_type: "exported",
      source_id: "exported",
      reviewed_on: {
        description: "When a review covered the change (UK calendar date); empty until then.",
      },
      review_record_id: { description: "The review that covered it (review_record.id)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.care_plan_section": {
    context: "care",
    description: "Care plan sections by need domain.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      plan_id: { description: "The plan (care_plan.id)." },
      domain: { description: "PRSB personalised care and support plan need domain." },
      need: { description: "The need, as written." },
      outcome: { description: "The outcome, in the person's words." },
      strengths: { description: "Strengths." },
      contingency: { description: "Contingency plan." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.classifier_answer": {
    context: "safety",
    description:
      "Answers to the notification classifier's questions about an incident. Append-only; the latest answer to each question counts.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      incident_id: { description: "The incident (incident.id)." },
      question_key: {
        description:
          "The question (CLASSIFIER_QUESTION_KEYS), for example harm.pain_days or riddor.work_connected.",
      },
      value: {
        description:
          'The answer, JSON: "yes", "no", "unsure", a whole number of days or hours, or option values.',
      },
      answered_at: { description: "When the question was answered (instant, UTC)." },
      answered_by: { description: "Tenant user who answered (tenant_user.id)." },
      device_id: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.consent_record": {
    context: "care",
    description:
      "Consent decisions about care and optional processing: who decided, on what authority and capacity, and any withdrawal.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      decision: {
        description: "What the consent is about.",
        codes: {
          care_plan: "Agreement to the care plan.",
          photos: "Photographs, including photos shared with family.",
          social_media: "Appearing in the provider's social media.",
          sharing: "Sharing information with family or others.",
          marketing: "The provider's marketing.",
          ai_processing: "Optional AI processing of free text.",
          bed_rails: "Bed rails.",
          covert_medicines: "Giving medicines covertly.",
        },
      },
      outcome: {
        description: "The decision.",
        codes: { given: "Consent given.", refused: "Consent refused." },
      },
      given_by_kind: {
        description: "Who decided.",
        codes: {
          person: "The person themselves.",
          representative: "A representative with authority for this decision.",
        },
      },
      representative_kind: {
        description:
          "The representative's authority: lpa_health_welfare, lpa_property_financial, deputy, appointee, imca, advocate or family_or_friend.",
      },
      representative_contact_id: {
        description: "The representative as one of the person's contacts (contact.id).",
      },
      representative_name: { description: "The representative's name, as recorded." },
      lpa_registered: {
        description:
          "Lasting power of attorney: true when registered with the Office of the Public Guardian (MCA s.9(2)(b)).",
      },
      opg_reference: {
        description: "Office of the Public Guardian reference for the lasting power of attorney.",
      },
      excluded_decisions: {
        description:
          "Decisions the lasting power of attorney excludes or restricts (MCA s.9(4)(b)).",
      },
      deputy_scope: {
        description: "Deputy: personal_welfare or property_and_affairs.",
      },
      deputy_decisions: {
        description: "Deputy: the decisions the Court of Protection order covers.",
      },
      deputy_restraint_authorised: {
        description: "Deputy: true when the order expressly authorises restraint (MCA s.20).",
      },
      deputy_order_ends_at: {
        description: "Deputy: when the order ends (instant, UTC); empty when it has no end date.",
      },
      court_reference: { description: "Court of Protection order reference." },
      capacity_status: {
        description: "The person's capacity for this decision when it was recorded.",
        codes: {
          assumed: "Capacity presumed (MCA s.1(2)); no assessment found a lack of it.",
          has_capacity: "An assessment found the person can decide.",
          lacks_capacity: "An assessment found the person cannot decide.",
        },
      },
      capacity_assessment_id: {
        description:
          "The assessment behind capacity_status, when there is one (capacity_assessment.id).",
      },
      given_at: { description: "When consent was given or refused (instant, UTC)." },
      expires_at: {
        description: "When this consent ends (instant, UTC); empty when it has no end date.",
      },
      withdrawn_at: {
        description: "When consent was withdrawn (instant, UTC); empty while it stands.",
      },
      withdrawn_reason: { description: "Why consent was withdrawn." },
      evidence: { description: "How the decision was made, in words." },
      evidence_document_id: {
        description: "A supporting document, such as a signed form (document.id).",
      },
      restraint_necessary: {
        description:
          "Bed rails agreed by a representative: true when recorded as necessary to prevent harm (MCA s.11(3), or s.20 for a deputy).",
      },
      restraint_proportionate: {
        description:
          "Bed rails agreed by a representative: true when recorded as proportionate to the likelihood and seriousness of harm (MCA s.11(4), or s.20 for a deputy).",
      },
      best_interests_decision_id: {
        description:
          "Covert medicines: the best-interests decision behind them (best_interests_decision.id).",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.contact": {
    context: "people",
    description: "Family, representatives and legal authorities for each person.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      role: {
        description:
          "Contact role: next of kin, LPA attorney, deputy, IMCA, advocate, appointee and so on.",
      },
      given_name: { description: "Given name." },
      family_name: { description: "Family name." },
      relationship: { description: "Relationship to the person, as recorded." },
      phone: { description: "Telephone number." },
      email: { description: "Email address." },
      address_line1: { description: "Address line 1." },
      town: { description: "Town or city." },
      postcode: { description: "Postcode." },
      is_next_of_kin: { description: "True when this contact is the next of kin." },
      authority_reference: {
        description: "Office of the Public Guardian, court or DWP reference for a legal authority.",
      },
      authority_document_id: { description: "Evidence of the legal authority (document.id)." },
      valid_until: { description: "When the authority ends (UK calendar date), if it does." },
      authority_scope: {
        description: "For a deputy: what the Court of Protection order is for.",
        codes: {
          personal_welfare: "Personal welfare.",
          property_affairs: "Property and affairs.",
          both: "Both personal welfare and property and affairs.",
        },
      },
      notes: { description: "Free-text notes about the contact." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.dcb0160_record": {
    context: "platform",
    description:
      "The organisation's DCB0160 clinical safety assessments as recorded for onboarding (platform-completions.md rules 26 and 27; append-only): which Harbour safety case each covers, who recorded it and when.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      safety_case_version: {
        description: "The Harbour safety case version the assessment covers.",
      },
      recorded_by: "exported",
      recorded_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.destruction_certificate": {
    context: "platform",
    description: "Certificates for records destroyed past retention (ids, class, rule, method).",
    treatment: "tenant_rows",
    retention: "permanent",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      record_class: { description: "Retention class of the destroyed records (retention.md)." },
      subject_type: "exported",
      subject_ids: { description: "Ids of the destroyed records." },
      record_count: { description: "Number of records destroyed.", unit: "count" },
      retention_rule: { description: "The rule applied: period, unit, trigger and source, JSON." },
      reason: { description: "Why they were destroyed." },
      method: { description: "How: key destruction, row purge, object version deletion." },
      executed_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.device_binding": {
    context: "platform",
    description:
      "Which member of staff has used which Care mode device, when the server first and last saw them together, and whether a manager revoked the device (care.md section 6).",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      device_id: {
        description:
          "Opaque id of the device's database (the sync client id); a new database has a new id.",
      },
      tenant_user_id: "exported",
      first_seen_at: {
        description: "When the server first saw this member on this device (instant, UTC).",
      },
      last_seen_at: {
        description: "When the server last saw this member on this device (instant, UTC).",
      },
      revoked_at: {
        description: "When a manager revoked the device (instant, UTC); empty while it is not.",
      },
      revoked_by: { description: "The manager who revoked it (tenant_user.id)." },
      revocation_reason: {
        description: "Why the device was revoked, as a code.",
        codes: {
          lost_or_stolen: "The device was lost or stolen.",
          staff_left: "The member of staff using it has left.",
          access_withdrawn: "The member of staff's access to Care mode was withdrawn.",
          replaced: "The device was replaced or reset.",
          other: "Another reason, recorded outside Harbour.",
        },
      },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.device_session": {
    context: "platform",
    description:
      "The Harbour sign-in sessions bound to each Care mode device, so a revocation ends them (care.md section 6, Device integrity part 2).",
    treatment: "not_exported",
    retention: "audit_event",
    personal: true,
    reasonNotExported:
      "Security records of sign-in sessions: the session ids are Harbour's own credentials' identifiers and mean nothing outside it; which member used which device is exported in device_binding.",
    columns: {},
  },
  "public.device_discard_entry": {
    context: "care",
    description:
      "The entry ids each stage of a device's deletion of unsent entries listed, with the deletion record and whose entries they were (append-only; care.md section 6).",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      discard_id: {
        description:
          "The deletion record (the audit trail's device_discard resource id, sync.entries.* events).",
      },
      stage: {
        description: "The stage of the deletion that listed the entry.",
        codes: {
          requested: "Recorded before anything was deleted.",
          deleted: "The device checked the entries could no longer be read.",
          failed:
            "The deletion did not finish; the entries stayed on the device, never to be sent.",
        },
      },
      entry_id: {
        description:
          "The id of a care entry the deletion listed (care_note, observation, body_map_mark, activity_record or visit_log id).",
      },
      owner_tenant_user_id: {
        description:
          "Whose entries the deletion said they were (tenant_user.id); empty if unknown.",
      },
      recorded_at: { description: "When the server recorded the stage (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.device_discard_record": {
    context: "care",
    description:
      "Each stage of a device's deletion of unsent entries: its kind, coded reason, whose entries, who deleted them, who sent the stage, the device, how many and when (append-only, one row per deletion and stage; care.md section 6).",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      discard_id: {
        description:
          "The deletion record (the device's id for it, and the audit trail's device_discard resource id).",
      },
      stage: {
        description: "The stage of the deletion.",
        codes: {
          requested: "Recorded before anything was deleted.",
          deleted: "The device checked the entries could no longer be read.",
          failed:
            "The deletion did not finish; the entries stayed on the device, never to be sent.",
        },
      },
      kind: {
        description: "What was deleted.",
        codes: {
          held_deleted: "Entries held on the device after a session ended.",
          signed_out_with_unsent: "Unsent entries, at a sign-out.",
          refused_removed: "One entry the server had refused, removed from the device.",
        },
      },
      reason_code: {
        description:
          "The coded reason (discard_reason.code of this organisation); the person's own words never leave the device.",
      },
      owner_tenant_user_id: {
        description:
          "Whose entries they were (tenant_user.id); empty when the device did not know.",
      },
      deleted_by_tenant_user_id: {
        description:
          "Who deleted them, as the device recorded it (tenant_user.id); empty when unknown.",
      },
      sender_tenant_user_id: {
        description: "Who sent this stage to the server (tenant_user.id).",
      },
      device_id: { description: "Opaque id of the device the entries were held on." },
      entry_count: {
        description: "How many entries; empty when the device could not count them.",
        unit: "entries",
      },
      discarded_at: { description: "When the device recorded the stage (instant, UTC)." },
      recorded_at: { description: "When the server recorded the stage (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.discard_reason": {
    context: "care",
    description:
      "The organisation's coded reasons for deleting unsent entries on a device, starting with the five every organisation has (care.md section 6).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      code: { description: "The code a deletion record carries." },
      label: { description: "The wording staff read, in English." },
      label_cy: { description: "The wording in Welsh, when given." },
      sort_order: { description: "Where the reason sits in the list.", unit: "position" },
      seeded: { description: "True for the five reasons every organisation starts with." },
      retired_at: {
        description:
          "When it stopped being offered (instant, UTC); a device that used it before may still send it.",
      },
      retired_by: { description: "Who retired it (tenant_user.id)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.dpia": {
    context: "platform",
    description:
      "The organisation's DPIA, one row per version (platform-completions.md rules 17 to 22): Harbour's prefill, the organisation's answers and residual risk ratings, who prepared it, and its signature by the data protection lead. A signed version never changes.",
    treatment: "tenant_rows",
    retention: "dpia",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      dpia_version: { description: "The DPIA's version number, from 1.", unit: "version number" },
      status: {
        description: "Where the version stands.",
        codes: {
          draft: "Being prepared.",
          prepared: "Ready to sign.",
          signed: "Signed by the data protection lead.",
          superseded: "Signed, then replaced by a later version.",
        },
      },
      prefill: { description: "What Harbour filled in from the configuration (JSON)." },
      answers: { description: "The organisation's answers, by section and field (JSON)." },
      residual_risk: { description: "The residual risk rated for each risk (JSON)." },
      ico_reference: { description: "ICO prior consultation reference (Article 36), if any." },
      prepared_by: { description: "Everyone who wrote part of this version (tenant_user ids)." },
      version_sha256: {
        description: "SHA-256 of the version as prepared, which the signature binds.",
      },
      prepared_at: "exported",
      signed_by: "exported",
      signed_at: "exported",
      typed_name: { description: "The name the signer typed." },
      statement: { description: "What the signer agreed to." },
      basis: { description: "What the signed version covered, for re-review (JSON)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.document": {
    context: "platform",
    description:
      "Documents and their versions: category, title, display file name, type, size, SHA-256, scan result, status. The files are in documents/.",
    treatment: "tenant_rows",
    retention: "by_category",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      category: {
        description:
          "person_photo, feed_photo, care_attachment, person_document, organisation_document or organisation_logo.",
      },
      title: "exported",
      retention_class: { description: "Retention class from the category (retention.md)." },
      storage_key: {
        description: "Internal object-store key; not exported (the file is in documents/).",
        class: "internal",
      },
      content_type: { description: "MIME type checked from the file's content." },
      size_bytes: "exported",
      sha256: { description: "SHA-256 of the file in lower-case hexadecimal, recorded at upload." },
      document_version: { description: "Version of the document.", unit: "version number" },
      previous_version_id: "exported",
      legal_hold: { description: "True when a legal hold covers the document." },
      subject_type: "exported",
      subject_id: "exported",
      person_id: "exported",
      file_name: { description: "Display file name, made safe on upload (may name a person)." },
      search_title: {
        description:
          "Search index of the title and file name (derived from the columns above; migration 0066); not exported.",
        class: "internal",
      },
      status: {
        description: "available, quarantined (failed or missed the malware scan) or destroyed.",
      },
      scan_status: { description: "clean, infected, unavailable or not_scanned." },
      destroyed_at: "exported",
      image_printable: {
        description:
          "For a JPEG or PNG: whether the hospital transfer pack can print it, decided once at upload; empty for other files.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.document_signature": {
    context: "platform",
    description: "Typed-name signatures bound to the SHA-256 of the version signed.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      document_id: "exported",
      person_id: "exported",
      signer_tenant_user_id: "exported",
      signer_name: { description: "The signer's typed name." },
      signer_capacity: { description: "staff, person or representative." },
      statement: { description: "The statement agreed to." },
      document_sha256: { description: "SHA-256 of the version signed." },
      signed_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.dols_authorisation": {
    context: "care",
    description:
      "The Deprivation of Liberty Safeguards register: requests, outcomes, periods in force, conditions and the relevant person's representative.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      type: {
        description: "The kind of authorisation.",
        codes: {
          urgent: "An urgent authorisation given by the managing authority.",
          standard: "A standard authorisation from the supervisory body.",
          court_order: "An order of the Court of Protection.",
        },
      },
      nation: {
        description: "The nation whose Schedule A1 procedure applies: england or wales.",
      },
      requested_at: { description: "When the authorisation was requested (instant, UTC)." },
      outcome: {
        description: "The outcome of the request.",
        codes: {
          pending: "Requested; no decision yet.",
          granted: "Granted.",
          not_granted: "Refused.",
          withdrawn: "The request was withdrawn.",
        },
      },
      outcome_at: { description: "When the outcome was given (instant, UTC)." },
      granted_from: {
        description: "Start of the authorisation (instant, UTC), inclusive.",
      },
      granted_to: {
        description:
          "The first moment the authorisation is no longer in force (instant, UTC); empty for a court order with no end.",
      },
      extensions: {
        description:
          "Extensions of an urgent authorisation, JSON list of { requestedAt, outcome, extendedTo }.",
      },
      preceded_by_urgent: { description: "True when an urgent authorisation came first." },
      preceded_by_authorisation_id: {
        description: "The authorisation this one follows (dols_authorisation.id).",
      },
      withdrawal_reason: { description: "Why the request was withdrawn." },
      ended_at: {
        description:
          "When the authorisation ended early (instant, UTC): terminated after a review, or the person left or died.",
      },
      ended_reason: { description: "Why it ended early." },
      conditions: { description: "Conditions the supervisory body attached, in words." },
      rpr_name: { description: "The relevant person's representative (RPR), by name." },
      rpr_contact_id: {
        description:
          "The relevant person's representative as one of the person's contacts (contact.id).",
      },
      supervisory_body: { description: "The supervisory body that decides, by name." },
      supervisory_body_reference: { description: "The supervisory body's reference." },
      objection_evidence: {
        description: "How the person shows objection, where they do, in words.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.dols_legal_change_review": {
    context: "care",
    description:
      "The review of each existing DoLS authorisation after the June 2026 judgment (care.md rule 11): whether the person is still deprived of liberty.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      dols_authorisation_id: {
        description: "The authorisation reviewed (dols_authorisation.id); one review each.",
      },
      state: {
        description:
          "Where the review stands: awaiting_review, reviewed, referred (to the local authority) or closed.",
      },
      factors: {
        description:
          "The DHSC multifactorial assessment, JSON keyed by factor (MULTIFACTORIAL_FACTORS).",
      },
      objection: {
        description: "Whether the person objects: objects, does_not_object, fluctuates or unclear.",
      },
      objection_forms: { description: "How the person shows objection, as recorded." },
      consent_signs: {
        description:
          "Signs bearing on whether the person consents, JSON { consciousOfEnvironment, basicUnderstanding, expressesAcceptance, seriousDoubt }.",
      },
      decision: {
        description: "The finding: still_deprived, no_longer_deprived or in_doubt.",
      },
      decided_at: { description: "When the finding was made (instant, UTC)." },
      decided_by: { description: "Tenant user who made the finding (tenant_user.id)." },
      referral_sent_at: {
        description: "When the case was referred to the local authority (instant, UTC).",
      },
      referral_reference: { description: "The local authority's reference for the referral." },
      referral_required: {
        description: "True when the local authority must be asked before the review can close.",
      },
      prompts: { description: "Prompts the review rules raised, as shown." },
      closed_reason: { description: "Why the review was closed." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.downtime_pack": {
    context: "operations",
    description:
      "Downtime packs (operations.md): a snapshot per location of what staff need during an outage, one page per person receiving care. Kept as downtime_record when in force during a declared outage.",
    treatment: "tenant_rows",
    retention: "downtime_pack",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      source: {
        description: "How the pack was built.",
        codes: {
          server_nightly: "The nightly job built it.",
          server_rebuild:
            "The system built it again after someone moved in, out or away, or their status changed.",
          server_on_demand: "A member built it on demand.",
          kiosk_cache: "A kiosk built it from its own cache when the server could not be reached.",
        },
      },
      generated_at: { description: "When the pack was built (instant, UTC)." },
      as_at: {
        description:
          "When its information was read (instant, UTC): the server's read time, or a kiosk's last sync.",
      },
      valid_until: {
        description:
          "Until when the pack reads as current (instant, UTC): as_at plus downtime_pack.valid_hours.",
      },
      generated_by: {
        description: "Tenant user who built it (tenant_user.id); empty for the nightly job.",
      },
      person_ids: { description: "The people with a page in the pack (person.id)." },
      content: {
        description:
          "The pack as built, JSON: per person the sections in DOWNTIME_PACK_SECTIONS order with their state (data-standards.md).",
      },
      warnings: {
        description: "Warnings on the pack by kind and section: counts and opaque ids only.",
      },
      document_id: {
        description: "The rendered PDF, when the server rendered one (document.id).",
      },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.entry_device_deletion_flag": {
    context: "care",
    description:
      "The server's flag on a care entry its author's device recorded deleting: uploaded after the deletion, or deleted after it reached Harbour, with the deletion record and the review task (append-only, one per entry; care.md section 6).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      record_table: {
        description: "The table the flagged entry is in.",
        codes: {
          care_note: "A daily note (care_note).",
          observation: "A chart entry (observation).",
          body_map_mark: "A body-map mark (body_map_mark).",
          activity_record: "An activity record (activity_record).",
          visit_log: "A visit (visit_log).",
          assessment: "A validated tool result (assessment).",
        },
      },
      entry_id: { description: "The flagged entry's id in that table." },
      person_id: { description: "The person receiving care the entry is about (person.id)." },
      location_id: { description: "The entry's location (location.id)." },
      flag: {
        description: "Why the entry is flagged.",
        codes: {
          uploaded_after_deletion:
            "It reached Harbour after its author's device recorded deleting it: it may be a duplicate, or an entry its author meant to withdraw.",
          deleted_after_upload:
            "It had already reached Harbour when its author's device recorded deleting it (a reply lost on the way back).",
        },
      },
      discard_id: { description: "The deletion record that counted (device_discard_record)." },
      owner_tenant_user_id: { description: "The entry's author (tenant_user.id)." },
      review_task_id: { description: "The Registered Manager's review task (task.id)." },
      flagged_at: { description: "When the server flagged it (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.evidence_pack": {
    context: "quality",
    description:
      "Inspector evidence packs (quality.md rules 1 to 10): the request (recipient, purpose, dates, locations, statements, people in scope), who shaped it and its release, revocation or discard. The manifest is kept as proof of the disclosure.",
    treatment: "tenant_rows",
    retention: "evidence_pack",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      recipient_name: { description: "The named recipient (an inspector or commissioner)." },
      recipient_organisation: { description: "The recipient's organisation." },
      recipient_email: { description: "The recipient's work email address, in lower case." },
      purpose: {
        description: "Why the recipient asked for the evidence, in the composer's words.",
      },
      date_from: { description: "First UK date of the evidence asked for (inclusive)." },
      date_to: { description: "Last UK date of the evidence asked for (inclusive)." },
      location_ids: { description: "The locations the evidence comes from (location ids)." },
      quality_statement_ids: {
        description: "The quality statements asked for (statement ids); empty for every statement.",
      },
      person_ids: { description: "The people in scope, chosen explicitly (person ids)." },
      staff_names: {
        description: "Whether staff appear by role or by name.",
        codes: { role_only: "Staff appear by their role.", include: "Staff names are shown." },
      },
      composed_by: "exported",
      composed_at: "exported",
      editor_ids: {
        description: "Members who changed the draft after it was composed (tenant_user ids).",
      },
      state: { description: "draft, released, revoked or discarded." },
      watermark: { description: "The words printed on every page of the pack." },
      released_by: {
        description: "Who released the pack (tenant_user.id); never anyone who shaped it.",
      },
      released_at: "exported",
      revoked_by: { description: "Who revoked the pack (tenant_user.id), if anyone." },
      revoked_at: "exported",
      revocation_reason: { description: "Why the pack was revoked." },
      discarded_by: { description: "Who discarded the draft (tenant_user.id), if anyone." },
      discarded_at: "exported",
      discard_reason: { description: "Why the draft was discarded." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.evidence_pack_bundle": {
    context: "quality",
    description:
      "The shown values of an evidence pack's included fields, from which the PDF is drawn; deleted when the pack's link ends or the pack is revoked or discarded.",
    treatment: "not_exported",
    retention: "evidence_pack",
    personal: true,
    reasonNotExported:
      "A temporary copy of care records that are exported in their own tables; it is deleted when the link ends, and the manifest (evidence_pack_item) records what was disclosed.",
    columns: {},
  },
  "public.evidence_pack_item": {
    context: "quality",
    description:
      "Each record considered for an evidence pack (append-only): included with its field outcomes and reasons, or left out with its reason (internal manifest). A hand redaction adds a row that supersedes the item.",
    treatment: "tenant_rows",
    retention: "evidence_pack",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      pack_id: "exported",
      supersedes_id: { description: "The item row this one replaces (a hand redaction), if any." },
      record_type: { description: "The kind of record (incident, care_note and so on)." },
      record_id: { description: "The record's id in its own table." },
      record_version: { description: "The version of the record disclosed.", unit: "version" },
      title: { description: "The generic label Harbour built for the record (never free text)." },
      occurred_at: "exported",
      quality_statement_ids: { description: "The quality statements it is evidence for." },
      exclusion_reason: {
        description: "Why it was left out; empty when included.",
        codes: {
          restricted_record: "A restricted record, never in a pack.",
          outside_date_range: "Outside the dates asked for.",
          location_not_requested: "At a location not asked for.",
          not_tagged: "Not tagged as evidence.",
          statement_not_requested: "Tagged only to statements not asked for.",
          person_not_in_scope: "About nobody in the pack's scope.",
        },
      },
      fields: {
        description:
          "Each field's key, label, kind, outcome (included, redacted or withheld), reason, and who redacted it by hand; never the shown values or a redacted copy.",
      },
      redacted_by: { description: "Members who redacted a field by hand (tenant_user ids)." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.evidence_pack_link": {
    context: "quality",
    description:
      "The time-limited link an evidence pack is opened by (ADR-0050): its recipient, issue, expiry, revocation, failed code attempts and last open.",
    treatment: "tenant_rows",
    retention: "evidence_pack",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      pack_id: "exported",
      recipient_email: { description: "The address the link and its codes go to." },
      token_hash: {
        description: "SHA-256 of the link's token; a credential, never exported.",
        class: "secret",
      },
      issued_by: "exported",
      issued_at: "exported",
      replaces_link_id: { description: "The link this one replaced on a re-issue, if any." },
      expires_at: "exported",
      revoked_at: "exported",
      revoked_by: { description: "Who revoked the link (tenant_user.id), if anyone." },
      revocation_reason: {
        description: "Why the link was revoked.",
        codes: { pack_revoked: "The pack was revoked.", reissued: "A new link replaced it." },
      },
      failed_code_attempts: {
        description: "Wrong codes entered; never goes down, and the link locks at the limit.",
        unit: "count",
      },
      last_opened_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.evidence_pack_link_code": {
    context: "quality",
    description:
      "One-time codes sent to an evidence pack link's recipient: when each was issued, how long it lasted and when it was used.",
    treatment: "tenant_rows",
    retention: "evidence_pack",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      link_id: "exported",
      code_hash: {
        description: "Hash of the one-time code; a credential, never exported.",
        class: "secret",
      },
      issued_at: "exported",
      valid_until: { description: "When the code lapses (instant, UTC)." },
      used_at: { description: "When the code was used (instant, UTC); empty if never." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.escalation_policy_link": {
    context: "care",
    description:
      "The organisation's escalation policy for each validated tool, for one band or every band, at one location or across the organisation; results show it beside the published band (care.md section 5).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tool_key: {
        description: "The validated tool.",
        codes: {
          news2: "NEWS2 (Royal College of Physicians, 2017), on vital signs.",
          must: "'MUST' (BAPEN).",
          waterlow: "Waterlow score (2005 revision).",
          braden: "Braden Scale.",
          ng249_falls: "The NICE NG249 falls questions (no score, no band).",
        },
      },
      band: {
        description:
          "The tool's band the policy is for, as results store it (for example high, or at_risk); empty for every band.",
      },
      location_id: {
        description: "The location the policy is for (location.id); empty for the organisation.",
      },
      title: { description: "The policy's name as the organisation calls it." },
      reference: { description: "The organisation's own reference for the policy." },
      document_id: { description: "The policy document (document.id), when uploaded." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.escalation_chain": {
    context: "platform",
    description: "Notification escalation chains by role or user.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      key: { description: "The chain's key (what it escalates)." },
      name: "exported",
      steps: {
        description: "Ordered steps: minutes after raising, target role or user, channels; JSON.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.exit_checklist_item": {
    context: "people",
    description:
      "The checklist of a discharge, transfer or death, item by item, with who did each and the evidence.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      exit_record_id: { description: "The exit the item belongs to (exit_record.id)." },
      item_key: {
        description: "The item, as a stable key from exitChecklist (people.md rule 12).",
      },
      title: "exported",
      owner: {
        description: "Who is responsible for the item.",
        codes: {
          people: "The people lifecycle (the Registered Manager or the home's administrator).",
          care: "Care staff.",
          medicines: "Medicines (the nurse in charge).",
          safety: "Safety and statutory notifications.",
          finance:
            "Residents' money and deposits (finance approval, never the person who recorded the exit).",
        },
      },
      return_item: {
        description:
          "True for property, keys, money and deposit returns, counted from their own records.",
      },
      allow_not_required: {
        description: "True when the item may be marked not required, with a reason.",
      },
      position: { description: "Order of the item on the checklist.", unit: "position (from 0)" },
      status: {
        description: "Where the item stands.",
        codes: {
          pending: "Not done yet.",
          done: "Done.",
          not_required: "Not required, with the reason in reason.",
        },
      },
      reason: { description: "Why the item is not required." },
      done_by: { description: "Who completed or marked the item (tenant_user.id)." },
      done_at: { description: "When it was completed or marked (instant, UTC)." },
      evidence_type: {
        description:
          "Kind of evidence record: statutory_notification, document, ledger_entry or note.",
      },
      evidence_id: { description: "The evidence record, in the table evidence_type names." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.exit_record": {
    context: "people",
    description:
      "Discharges, transfers and deaths: when, where to, the facts the checklist needs, and the status before.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      kind: {
        description: "The kind of exit.",
        codes: {
          discharge: "The person left the service.",
          transfer: "The person moved to another provider.",
          death: "The person died.",
        },
      },
      state: {
        description: "Where the exit workflow stands.",
        codes: {
          planned: "A discharge or transfer is planned; the person has not left.",
          left: "The person has left.",
          recorded: "A death has been recorded.",
          awaiting_return: "Waiting for money, property or a deposit to be returned.",
          closed: "Everything is done.",
          cancelled:
            "Cancelled, with the reason (a planned exit that did not happen, or an exit recorded in error).",
        },
      },
      workflow_instance_id: {
        class: "internal",
        description:
          "Harbour's workflow engine record behind state; state carries the same information.",
      },
      left_at: {
        description: "When the person left or died (instant, UTC). The date is left_at_uk_date.",
        ukDate: true,
      },
      status_before: {
        description:
          "The person's status when the exit was recorded; a correction of the exit as recorded in error returns them to it (people.md rule 2).",
        codes: {
          active: "Receiving care at the home.",
          on_leave: "On leave, bed kept.",
          in_hospital: "In hospital, bed kept.",
        },
      },
      status_before_since: { description: "When that earlier status began (instant, UTC)." },
      regulator: {
        description: "The regulator for the location.",
        codes: {
          cqc: "Care Quality Commission (England).",
          ciw: "Care Inspectorate Wales.",
          care_inspectorate: "Care Inspectorate (Scotland).",
          rqia: "Regulation and Quality Improvement Authority (Northern Ireland).",
        },
      },
      local_authority_funded: {
        description: "True when a council funded the placement (it is told of the exit).",
      },
      nhs_funded: {
        description: "True when the NHS funded the placement (the integrated care board is told).",
      },
      place_of_death: {
        description: "Where the person died.",
        codes: {
          care_home: "At the care home.",
          hospital: "In hospital.",
          elsewhere: "Somewhere else.",
        },
      },
      death_expected: {
        description: "True when the death was expected; empty for a discharge or transfer.",
      },
      learning_disability_or_autism: {
        description:
          "Whether the person had a learning disability or was autistic: an explicit answer for every death (LeDeR).",
      },
      dols_in_place: {
        description: "True when a DoLS authorisation was in force (the supervisory body is told).",
      },
      home_is_dwp_appointee: {
        description: "True when the home was the person's DWP appointee (the DWP is told).",
      },
      holds_residents_money: { description: "True when the home held money for the person." },
      holds_deposit: { description: "True when the home held a deposit." },
      has_loan_equipment: { description: "True when loan equipment has to go back." },
      destination_type: {
        description: "Where the person went.",
        codes: {
          own_home: "Their own home.",
          family_home: "A family member's home.",
          care_home: "Another care home.",
          hospital: "Hospital.",
          hospice: "A hospice.",
          supported_living: "Supported living.",
          other: "Somewhere else.",
        },
      },
      receiving_provider_name: { description: "The receiving provider's name." },
      receiving_provider_cqc_location_id: {
        description: "The receiving location's CQC location ID.",
      },
      receiving_provider_ods_code: { description: "The receiving provider's ODS code." },
      reason: { description: "Why the person left, in words." },
      verified_by_name: { description: "Who verified the death (name)." },
      verified_by_role: { description: "Their role (for example registered nurse or GP)." },
      verified_at: { description: "When the death was verified (instant, UTC)." },
      present_at_death: { description: "Who was present at the death." },
      funeral_director: { description: "The funeral director." },
      collection_at: {
        description: "When the funeral director collected the person (instant, UTC).",
      },
      coroner_referred_by: { description: "Who referred the death to the coroner." },
      coroner_reference: { description: "The coroner's reference." },
      money_and_property_due_at: {
        description: "When money and property are due back (instant, UTC).",
      },
      deposit_due_at: { description: "When the deposit is due back (instant, UTC)." },
      closed_at: { description: "When the exit was closed (instant, UTC)." },
      cancelled_reason: { description: "Why the exit was cancelled." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.family_portal_user": {
    context: "comms",
    description:
      "Family portal accounts linked to the contact the sharing decisions name (ADR-0061); revoked with a reason, never deleted.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: { description: "The family member's portal account (tenant_user.id)." },
      person_id: "exported",
      contact_id: { description: "The contact the account acts as (contact.id)." },
      revoked_at: "exported",
      revoked_by: { description: "Who revoked the link (tenant_user.id)." },
      revoked_reason: { description: "Why the link was revoked." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.feed_item": {
    context: "comms",
    description:
      "Family feed updates (comms.md rules 7 to 12; append-only): the section, the record it came from, when it happened and the words shown to the family.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      kind: { description: "The kind of update (FEED_ITEM_KINDS)." },
      section: { description: "The section of the record it belongs to (FEED_ITEM_SECTIONS)." },
      care_plan_domain: { description: "For a care plan update: the care plan section." },
      source_kind: { description: "The kind of record it came from (FEED_SOURCE_KINDS)." },
      source_id: { description: "The record it came from." },
      occurred_at: "exported",
      composed_at: { description: "When it was written for the family." },
      text: { description: "The words shown to the family." },
      photo_document_id: { description: "For a photo: the photo (document.id)." },
      phrase_key: { description: "The approved phrase used, if any (FEED_PHRASES)." },
      composed_by: { description: "Who published it (tenant_user.id)." },
      confirmed_by: { description: "Who confirmed flagged words (tenant_user.id)." },
      confirmation_reason: { description: "Why the flagged words could be published." },
      supersedes_item_id: { description: "The update this one corrects." },
      other_people_identifiable: { description: "For a photo: whether anyone else can be seen." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.feed_item_withdrawal": {
    context: "comms",
    description: "Family feed updates taken down (comms.md rule 4; append-only).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      feed_item_id: { description: "The update taken down (feed_item.id)." },
      reason: { description: "Why (FEED_WITHDRAWAL_REASONS)." },
      withdrawn_by: { description: "Who took it down (tenant_user.id)." },
      withdrawn_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.feed_view": {
    context: "comms",
    description:
      "Each time a family member saw an update (comms.md rule 4; append-only): the decision that allowed it and the section, status and capacity finding then.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      feed_item_id: { description: "The update seen (feed_item.id)." },
      contact_id: { description: "The contact the family member acted as (contact.id)." },
      sharing_decision_id: { description: "The sharing decision that allowed the view." },
      section: { description: "The section of the record." },
      care_plan_domain: { description: "For a care plan update: the care plan section." },
      person_status: { description: "The person's status at the time." },
      capacity_for_sharing: { description: "The capacity finding for sharing at the time." },
      viewed_by: { description: "The family member's portal account (tenant_user.id)." },
      viewed_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.feature_flag": {
    context: "platform",
    description: "Modules switched on or off for the organisation and its locations.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      flag_key: { description: "The module or feature (feature-flags catalogue)." },
      enabled: { description: "True when switched on." },
      value: { description: "Flag settings, JSON." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.form_submission": {
    context: "platform",
    description: "Completed forms, pinned to the template version, with results and workings.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      template_id: "exported",
      template_key: { description: "The form template's key." },
      template_version: { description: "The template version answered.", unit: "version number" },
      subject_type: "exported",
      subject_id: "exported",
      answers: { description: "The answers, JSON." },
      result: { description: "The result and its workings, JSON." },
      status: { description: "draft or submitted." },
      submitted_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.form_template": {
    context: "platform",
    description:
      "The organisation's own form templates (Harbour's locked templates are cited by key and version).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      key: { description: "The template's key." },
      template_version: { description: "Template version.", unit: "version number" },
      title: "exported",
      kind: { description: "form or assessment." },
      locked: { description: "True for Harbour's locked validated templates." },
      definition: { description: "Fields, scoring and branching, JSON." },
      review_cadence_days: "exported",
      published_at: "exported",
      retired_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.handed_over_entry": {
    context: "care",
    description:
      "Each held entry a manager (or its owner, from a revoked device) sent from a Care mode device in its owner's name: the hand-over, the device, the owner and the sender (append-only; care.md section 6, Device integrity part 6).",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      handover_id: {
        description: "The hand-over the entry was sent in (one owner, device and sender).",
      },
      device_id: { description: "Opaque id of the device that held the entry." },
      owner_tenant_user_id: { description: "Whose entry it is (tenant_user.id): its author." },
      sent_by: { description: "Who sent it (tenant_user.id)." },
      record_table: {
        description: "The table the entry is in.",
        codes: {
          care_note: "A daily note.",
          observation: "A chart observation.",
          body_map_mark: "A body-map mark.",
          activity_record: "An activity record.",
          visit_log: "A visit.",
        },
      },
      entry_id: { description: "The entry's id in that table." },
      accepted_at: {
        description: "When the server accepted the entry for sending (instant, UTC).",
      },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.handover": {
    context: "care",
    description:
      "Shift handovers compiled by rule from each shift's records (care.md rule 8): one per location and shift; its items are in handover_item.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      shift_name: {
        description: "The shift's name in the location's pattern, for example day or night.",
      },
      shift_start: { description: "When the shift started (instant, UTC)." },
      shift_end: { description: "When the shift ended (instant, UTC), exclusive." },
      compiled_at: { description: "When the handover was first compiled (instant, UTC)." },
      refreshed_at: {
        description: "When its sources were last read again for late additions (instant, UTC).",
      },
      locked_at: {
        description:
          "When it was locked at the end of the shift (instant, UTC); notes close then, late additions and acknowledgements continue.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.handover_item": {
    context: "care",
    description:
      "The items of each shift handover (care.md rule 8): references to the records, never their text; only ever added to (append-only).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      handover_id: { description: "The handover (handover.id)." },
      key: {
        description:
          "The item's identity within the handover: kind, source table, source id and person.",
      },
      position: {
        description: "The order the items were compiled and added in, from 0.",
        unit: "count",
      },
      kind: {
        description:
          "fall, news2, incident, alert, body_map_mark, flagged_note (a care note tagged for the handover), overdue_task, skipped_task, unfinished_task, must_follow_up or refusal.",
      },
      person_id: { description: "The person the item is about (person.id), if any." },
      source_type: {
        description:
          "The table of the record: task, observation, incident, body_map_mark, care_note or notification.",
      },
      source_id: { description: "The record's id in that table." },
      at: { description: "When it happened, or when the task fell due (instant, UTC)." },
      late_addition: {
        description: "True for an item added after the handover was first compiled.",
      },
      added_at: { description: "When it joined the handover (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.handover_acknowledgement": {
    context: "care",
    description:
      "Each acknowledgement of a handover by a member of staff, with the items they could see then (append-only).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      handover_id: { description: "The handover acknowledged (handover.id)." },
      tenant_user_id: { description: "The member of staff who acknowledged it (tenant_user.id)." },
      item_keys: {
        description:
          "The keys of the items (handover_item.key) they could see when they acknowledged, recorded by the server; items added later need a further acknowledgement.",
      },
      acknowledged_at: {
        description: "When they acknowledged it, by the server's clock (instant, UTC).",
      },
      device_id: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.handover_note": {
    context: "care",
    description:
      "Notes the outgoing staff added to a handover or to one of its items while it was open (append-only).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      handover_id: { description: "The handover (handover.id)." },
      item_key: {
        description:
          "The item annotated (handover_item.key); empty for a note on the whole handover.",
      },
      person_id: {
        description:
          "The person the annotated item is about (person.id), if any, taken from the item.",
      },
      body: { description: "The note text." },
      device_id: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.hospital_transfer": {
    context: "people",
    description:
      "Transfers to hospital: the pack as it went with the person, the hand-over, and the checks on return.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      left_at: { description: "When the person left for hospital (instant, UTC)." },
      hospital_name: { description: "The hospital, as named." },
      hospital_ods_code: { description: "The hospital's ODS code, if known." },
      reason: { description: "Why the person went to hospital, in words." },
      pack: {
        description:
          "The hospital transfer pack exactly as it was assembled, JSON (identity, the safety-critical sections, as-of times).",
      },
      missing_critical: {
        description:
          "Safety-critical sections missing from the pack (photo, allergies, medicines, communication, resuscitation, about_me, eating_and_drinking).",
      },
      missing_expected: { description: "Other expected sections missing from the pack." },
      items_sent: { description: "Belongings sent with the person (property_item.id list)." },
      handed_over_at: { description: "When the pack was handed over (instant, UTC)." },
      handed_over_by: { description: "Who handed it over (tenant_user.id)." },
      ack_by: { description: "Who acknowledged handing over an incomplete pack (tenant_user.id)." },
      ack_at: { description: "When they acknowledged it (instant, UTC)." },
      ack_reason: { description: "Why the incomplete pack went." },
      returned_at: { description: "When the person came back (instant, UTC)." },
      return_checks: {
        description:
          "The checks on return, JSON keyed by check (discharge letter, medicines, allergies, resuscitation, IDDSI, skin, belongings) with who and when.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.incident": {
    context: "safety",
    description:
      "Incidents and near misses. Every statutory clock starts at occurred_at; each row's retention is in retention_class.",
    treatment: "tenant_rows",
    retention: "serious_incident",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      type: {
        description:
          "Incident type: fall, medication, skin, behaviour, missing_person, safeguarding_concern, injury, near_miss, environmental, ipc, staff_injury, violence_to_staff, self_harm, sexual_safety, absconding, fire_setting, substance_use or data_breach.",
      },
      occurred_at: "exported",
      device_time: "exported",
      recorded_at: "exported",
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      found_at: {
        description:
          "When the person was found, if later than the event (instant, UTC); post-fall observations count from here.",
      },
      severity: {
        description:
          "Consequence on the NPSA scale, recorded by staff: negligible, minor, moderate, major or catastrophic.",
      },
      harm_grade: {
        description:
          "Physical harm on the LFPSE scale, recorded by staff and never calculated: none, low, moderate, severe or fatal.",
      },
      description: { description: "What happened, in words." },
      immediate_actions: { description: "What was done straight away, in words." },
      emergency_services_called: { description: "True when emergency services were called." },
      gp_contacted: { description: "True when the GP was contacted." },
      contact_notes: { description: "Who was contacted and what they advised, in words." },
      family_informed_who: {
        description: "Which family member or representative was told, in words.",
      },
      family_informed_at: {
        description: "When the family member or representative was told (instant, UTC).",
      },
      status: {
        description: "Where the incident is in its workflow.",
        codes: {
          open: "Reported; not yet under review.",
          under_review: "Being reviewed or investigated.",
          closed: "Closed with a reason, by someone other than the person who raised it.",
        },
      },
      raised_by: { description: "Tenant user who reported the incident (tenant_user.id)." },
      closed_by: {
        description: "Tenant user who closed it (tenant_user.id); never the person who raised it.",
      },
      closed_at: { description: "When it was closed (instant, UTC)." },
      closed_reason: { description: "Why it was closed." },
      person_ids: {
        description:
          "The people using the service on the incident (person.id), kept in step with incident_person.",
      },
      classifier_version: {
        description: "Version of the notification classifier that last ran on the incident.",
      },
      classified_at: { description: "When the classifier last ran (instant, UTC)." },
      nation_supported: {
        description:
          "True when the classifier's rules cover the location's nation; when false, notifications were not worked out.",
      },
      classifier_result: {
        description: "The last classification: which notifications apply and why, JSON.",
      },
      open_questions: { description: "Classifier questions not yet answered (question keys)." },
      retention_class: {
        description: "This incident's retention class.",
        codes: {
          care_record: "No statutory notification applies; kept as a care record.",
          serious_incident: "A statutory notification applies; kept as a serious incident.",
        },
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.incident_person": {
    context: "safety",
    description:
      "Everyone on an incident: people using the service, workers and others, with their part and injuries.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      incident_id: { description: "The incident (incident.id)." },
      kind: {
        description: "Who they are, as RIDDOR distinguishes them (regulations 4 and 5).",
        codes: {
          service_user: "A person using the service.",
          worker: "A member of staff or an agency worker.",
          other_not_at_work: "Someone not at work, such as a visitor.",
        },
      },
      role: {
        description: "Their part in the incident.",
        codes: {
          affected: "Harmed or put at risk.",
          witness: "Saw what happened.",
          involved: "Involved in another way.",
        },
      },
      person_id: "exported",
      tenant_user_id: "exported",
      other_name: {
        description: "A worker who is not a Harbour user, or a visitor, by name.",
      },
      injury_details: { description: "Their injuries, in words." },
      died: { description: "True when they died." },
      learning_disability: {
        description: "Recorded with a death for the LeDeR prompt: true for a learning disability.",
      },
      autistic: {
        description:
          "Recorded with a death for the LeDeR prompt: true when the person was autistic.",
      },
      subject_to_mental_health_act: {
        description: "True when they were subject to the Mental Health Act 1983 at the time.",
      },
      body_map_mark_ids: {
        description: "Body-map marks recording their injuries (body_map_mark.id).",
      },
      infection: {
        description:
          "Infection incidents: one case for outbreak detection, JSON { syndrome, onsetAt, couldBeLinkedWithinSetting, fluConfirmedAt, link }.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.integration_connection": {
    context: "integrations",
    description: "Which provider each integration uses (credentials stay in the secret store).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      port: { description: "The integration port (for example comms.email)." },
      provider: { description: "The provider chosen." },
      status: { description: "configured, healthy or failing." },
      settings: { description: "Non-secret settings, JSON." },
      secret_ref: {
        description: "Reference to the credential in the secret store; never exported.",
        class: "secret",
      },
      last_health_at: "exported",
      last_health_ok: { description: "Result of the last health check." },
      last_error: { description: "The last error, without personal data." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.integration_inbound": {
    context: "integrations",
    description: "Data received from partners, with validation problems and resolutions.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      port: { description: "The integration port." },
      provider: { description: "The partner." },
      external_id: "exported",
      status: { description: "accepted, quarantined or resolved." },
      payload: { description: "The partner's payload as received, JSON." },
      problems: { description: "Validation problems, JSON." },
      received_at: "exported",
      resolved_at: "exported",
      resolved_by: "exported",
      resolution: { description: "How a quarantined item was resolved." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.invitation": {
    context: "platform",
    description:
      "Invitations to join the organisation: who was invited, by whom, when the link lapsed and whether it was accepted or revoked (platform.md, Invitations and MFA enrolment).",
    treatment: "tenant_rows",
    retention: "invitation",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: { description: "The member of staff invited (tenant_user.id)." },
      email: {
        description:
          "The work email address the invitation was sent to; empty once it was accepted, revoked or lapsed.",
      },
      token_hash: {
        description: "SHA-256 of the invitation link's token; a credential, never exported.",
        class: "secret",
      },
      created_at: "exported",
      created_by: "exported",
      created_by_operator: {
        description:
          "The Thapsus operator who sent the first owner's invitation (operator_user.id), else empty.",
      },
      expires_at: "exported",
      accepted_at: "exported",
      accepted_auth_user_id: {
        description: "Harbour's own identifier of the sign-in the member was linked to.",
        class: "internal",
      },
      claimed_auth_user_id: {
        description: "Harbour's own identifier of the sign-in an acceptance created.",
        class: "internal",
      },
      claimed_at: "exported",
      revoked_at: "exported",
      revoked_by: { description: "Who revoked the invitation (tenant_user.id), if anyone." },
      revocation_reason: {
        description: "Why it was revoked.",
        codes: {
          superseded: "A newer invitation replaced it.",
          revoked: "A manager withdrew it.",
          member_removed: "The member was suspended or removed.",
          member_changed: "The member's address, roles or grants changed.",
          expired: "It lapsed unused.",
        },
      },
    },
  },
  "public.investigation": {
    context: "safety",
    description: "The investigation of an incident: method, findings, actions and lessons.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      incident_id: { description: "The incident (incident.id)." },
      lead_tenant_user_id: {
        description: "Tenant user leading the investigation (tenant_user.id).",
      },
      method: {
        description:
          "The method used: root_cause_analysis, five_whys, fishbone, after_action_review, swarm_huddle or other.",
      },
      findings: { description: "What the investigation found, in words." },
      contributing_factors: { description: "Factors that contributed, as recorded." },
      actions: {
        description:
          "Actions agreed, JSON list of { id, action, ownerTenantUserId, dueOn, status, taskId }.",
      },
      lessons: { description: "Lessons learned, in words." },
      bulletin_published_at: {
        description: "When the lessons were shared with staff in a bulletin (instant, UTC).",
      },
      status: {
        description: "Where the investigation stands.",
        codes: { open: "Under way.", completed: "Finished." },
      },
      completed_at: { description: "When it was completed (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.key_issue": {
    context: "people",
    description: "Keys and fobs issued to the person or their representative, and their return.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      label: { description: "The key or fob, as labelled." },
      issued_on: { description: "When it was issued (UK calendar date)." },
      issued_to: {
        description: "Who holds it.",
        codes: { person: "The person.", representative: "Their representative." },
      },
      returned_on: { description: "When it was returned (UK calendar date)." },
      reported_lost_on: { description: "When it was reported lost (UK calendar date)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.legal_hold": {
    context: "platform",
    description: "Legal holds on people and records, with reasons, placed and released.",
    treatment: "tenant_rows",
    retention: "permanent",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      subject_type: "exported",
      subject_id: "exported",
      reason: { description: "Why the hold was placed (may mention legal proceedings)." },
      placed_at: "exported",
      released_at: "exported",
      released_by: "exported",
      release_reason: { description: "Why it was released." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.letter": {
    context: "comms",
    description:
      "Letters and emails made from approved templates (comms.md rules 24 and 25; append-only): the template version, the person, the recipient, the channel, the personal-data fields used and whether special category data was present. Never an email's content; a letter's rendered PDF is a document about the person. Each row's retention is in retention_class.",
    treatment: "tenant_rows",
    retention: "serious_incident",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      template_version_id: { description: "The approved template version it was made from." },
      person_id: "exported",
      recipient_kind: {
        description: "Who it went to.",
        codes: { person: "The person themselves.", contact: "One of the person's contacts." },
      },
      contact_id: { description: "The contact it went to, when it went to a contact." },
      channel: {
        description: "How it went.",
        codes: { letter: "A letter (post, by hand or the portal).", email: "An email." },
      },
      personal_fields: {
        description: "The merge fields used that hold personal data (keys of MERGE_FIELDS).",
      },
      special_category: { description: "Whether special category data was merged (letters only)." },
      results_to_follow: {
        description: "A duty of candour letter sent before the results of further enquiries.",
      },
      incident_id: { description: "The incident an incident or candour letter is about." },
      incident_serious: { description: "Whether that incident is graded serious." },
      document_id: { description: "The rendered letter (document.id); none for an email." },
      delivery_reference: { description: "The email provider's reference; none for a letter." },
      sent_by: { description: "Who sent it (tenant_user.id)." },
      sent_at: "exported",
      retention_class: {
        description:
          "serious_incident for an incident or candour letter about a serious incident, otherwise care_record.",
      },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.letter_template": {
    context: "comms",
    description:
      "Letter and email templates (comms.md rules 18 to 23): the kind and channel, fixed once made, and the approved version in use. No personal data.",
    treatment: "tenant_rows",
    retention: "organisation_document",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      kind: {
        description: "What the template is for.",
        codes: {
          admission: "Admission.",
          fee_review: "Fee review.",
          incident_follow_up: "Incident follow-up (letter only).",
          duty_of_candour: "Duty of candour (letter only).",
          general: "General.",
        },
      },
      channel: {
        description: "Letter or email.",
        codes: { letter: "A letter.", email: "An email." },
      },
      current_version_id: { description: "The approved version in use, if any." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.letter_template_version": {
    context: "comms",
    description:
      "Versions of each template (TEMPLATE_WORKFLOW): the name, email subject and body with merge fields, who wrote, edited, approved and retired each version.",
    treatment: "tenant_rows",
    retention: "organisation_document",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      template_id: "exported",
      version_number: { description: "The version's number within its template.", unit: "version" },
      state: { description: "draft, approved, superseded, retired or discarded." },
      name: { description: "The template's name in this version." },
      subject: { description: "The email subject (merge fields with no personal data only)." },
      body: { description: "The body text with {{merge.fields}}." },
      author_id: { description: "Who wrote the version (tenant_user.id)." },
      contributor_ids: { description: "The author and everyone who changed the draft." },
      approved_by: { description: "Who approved it; never its author or an editor." },
      approved_at: "exported",
      retired_by: { description: "Who retired it." },
      retired_at: "exported",
      retirement_reason: { description: "Why it was retired." },
      discard_reason: { description: "Why the draft was discarded." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.location": {
    context: "platform",
    description: "Locations with their regulator location ID, ODS code, nation and address.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      name: "exported",
      regulator: { description: "cqc, ciw, care_inspectorate, rqia or ofsted." },
      regulator_location_id: "exported",
      ods_code: { description: "ODS organisation code." },
      nation: { description: "england, wales, scotland or northern_ireland." },
      address_line1: { description: "Address line 1." },
      address_line2: { description: "Address line 2." },
      town: { description: "Town or city." },
      postcode: { description: "Postcode." },
      timezone: { description: "IANA time zone of the location (Europe/London in the UK)." },
      phone: { description: "Telephone number." },
      bed_capacity: { description: "Registered beds.", unit: "count" },
      status: { description: "active or closed." },
      downtime_mar_location: {
        description:
          "Where the paper MAR is kept, as the downtime pack prints it (location setting downtime.mar_location).",
      },
      downtime_peep_location: {
        description:
          "Where the PEEPs are kept, as the downtime pack prints it (location setting downtime.peep_location).",
      },
      downtime_places_confirmed_at: {
        description:
          "When the two places were confirmed (instant, UTC); empty while the seeded wording stands or since a place changed.",
      },
      downtime_places_confirmed_by: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.notification": {
    context: "platform",
    description: "In-app notifications with generic titles, read and acknowledged times.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      recipient_tenant_user_id: "exported",
      kind: { description: "What the notification is about (module.what)." },
      severity: { description: "info, warning or urgent." },
      title: "exported",
      body: { description: "Generic body text, without personal data." },
      link: { description: "Link inside Harbour." },
      channels: { description: "Channels used: in_app, push, email, sms." },
      source_type: "exported",
      source_id: "exported",
      person_id: { description: "The person the alert concerns (person.id), if any." },
      location_id: { description: "The location the alert concerns (location.id), if any." },
      dedupe_key: { description: "Key that stops the same notification being raised twice." },
      escalation_chain_id: "exported",
      escalation_step: { description: "Escalation steps already fired.", unit: "count" },
      escalate_at: "exported",
      read_at: "exported",
      acknowledged_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.notification_delivery": {
    context: "integrations",
    description: "Email, SMS and push deliveries of notifications.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      notification_id: "exported",
      channel: { description: "push, email or sms." },
      provider: { description: "The provider used." },
      status: { description: "queued, sent, failed or skipped." },
      attempts: { description: "Delivery attempts so far.", unit: "count" },
      provider_message_id: "exported",
      last_error: { description: "The last error, without personal data." },
      next_attempt_at: "exported",
      sent_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.notification_preference": {
    context: "platform",
    description: "Users' quiet hours and channel choices.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      quiet_hours_start: {
        description: "Start of quiet hours: a wall-clock time in Europe/London (HH:MM), not UTC.",
      },
      quiet_hours_end: {
        description: "End of quiet hours: a wall-clock time in Europe/London (HH:MM), not UTC.",
      },
      channels: { description: "Channel choices, JSON." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.observation": {
    context: "care",
    description: "Charts and vital signs, with device and server times.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      handed_over_by: {
        description:
          "Sent by: the manager who handed this entry over from a device for its author (created_by), when one did (tenant_user.id; care.md section 6, Device integrity part 6). Empty when its author sent it.",
      },
      device_id: "exported",
      ...BACK_ENTRY_COLUMN_DOCS,
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      chart: {
        description:
          "The chart: fluid_intake, fluid_output, food, repositioning, bowel, weight or vitals.",
      },
      values: {
        description:
          "The values, typed per chart: schema and units in observationValues in this file.",
        schema: "observation_values",
      },
      flags: {
        description:
          "Flags computed when the entry was saved (for example NEWS2 component scores), JSON.",
      },
    },
  },
  "public.operator_user": {
    context: "platform",
    description: "Thapsus support staff.",
    treatment: "not_exported",
    retention: "operational",
    personal: true,
    reasonNotExported:
      "Thapsus's own staff records (Thapsus is their controller), not organisation data.",
    columns: {},
  },
  "public.outage": {
    context: "operations",
    description:
      "Outages declared at a location (operations.md): the window paper records from it are back-entered against, its closure and its reconciliation.",
    treatment: "tenant_rows",
    retention: "downtime_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      kind: {
        description: "What failed.",
        codes: {
          power: "Power cut.",
          network: "Internet or network failure.",
          harbour_unavailable: "Harbour unavailable.",
          device_failure: "Devices not working.",
          planned_maintenance: "Planned maintenance.",
          other: "Other outage.",
        },
      },
      description: { description: "What failed, in the declarer's words." },
      state: { description: "declared (open), closed, reconciled or cancelled." },
      workflow_instance_id: "exported",
      started_at: { description: "When the outage began (instant, UTC)." },
      ended_at: { description: "When systems came back (instant, UTC); empty while open." },
      declared_at: "exported",
      declared_by: "exported",
      declared_late: {
        description:
          "True when it was declared more than care_note.late_entry_hours after it began.",
      },
      closed_at: "exported",
      closed_by: "exported",
      back_entry_due_at: {
        description:
          "When every paper record should be entered (instant, UTC): the closure plus downtime.back_entry_due_hours.",
      },
      reconciled_at: "exported",
      reconciled_by: {
        description:
          "Tenant user who confirmed every paper record entered and checked (tenant_user.id); never one who entered them.",
      },
      reconciliation_statement: { description: "What the reconciler checked, in their words." },
      reviewed_entry_ids: {
        description: "The possible duplicate care entries reviewed before reconciling (entry ids).",
      },
      forms_entered: { description: "Distinct paper forms entered.", unit: "count" },
      cancelled_at: "exported",
      cancelled_by: "exported",
      cancellation_reason: { description: "Why the outage was cancelled (declared in error)." },
      correction_reason: {
        description: "Why the start or end was last corrected; earlier ones are in the history.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.outbox_event": {
    context: "platform",
    description: "Events passed between modules (opaque ids and kinds).",
    treatment: "tenant_rows",
    retention: "operational",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      aggregate_type: { description: "Kind of record the event is about." },
      aggregate_id: "exported",
      event_type: { description: "The event (module.record.event)." },
      payload: { description: "Event payload with opaque ids, JSON." },
      occurred_at: "exported",
      available_at: "exported",
      published_at: "exported",
      attempts: { description: "Relay attempts so far.", unit: "count" },
      last_error: { description: "The last relay error." },
    },
  },
  "public.person": {
    context: "people",
    description:
      "People receiving care: MODS-aligned demographics, NHS number, status, communication needs, national data opt-out.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      status: {
        description: "Where the person is in the lifecycle.",
        codes: {
          enquiry: "First contact",
          pre_admission: "Being assessed",
          active: "Receiving care",
          on_leave: "Temporarily away, bed kept",
          in_hospital: "In hospital, bed kept",
          discharged: "Left the service",
          deceased: "Died",
          archived: "Closed and held under retention",
          not_admitted: "Enquiry or assessment closed without admission",
        },
      },
      status_changed_at: { description: "When the current status began (instant, UTC)." },
      is_sample: {
        description:
          "An invented person loaded as sample data (rule 29); sample rows are never exported, so always false here.",
      },
      sample_batch_id: {
        description: "The sample batch an invented person came with (empty here).",
      },
      nhs_number: {
        description: "NHS number, 10 digits without spaces, check digit validated (MODS).",
      },
      local_identifier: { description: "The organisation's own reference for the person, if any." },
      title: { description: "Title (Mr, Mrs, Ms, Mx, Dr and so on)." },
      given_name: { description: "Given name (MODS)." },
      family_name: { description: "Family name (MODS)." },
      preferred_name: { description: "The name the person likes to be called." },
      date_of_birth: { description: "Date of birth (UK calendar date, YYYY-MM-DD)." },
      sex_code: {
        description: "NHS Data Dictionary PERSON PHENOTYPIC SEX code (data-standards.md).",
      },
      gender_identity: {
        description: "NHS Data Dictionary PERSON STATED GENDER CODE (data-standards.md).",
      },
      ethnic_category_code: {
        description: "NHS Data Dictionary ETHNIC CATEGORY code (data-standards.md).",
      },
      religion: { description: "Religion or belief, as the person states it." },
      first_language: { description: "First language." },
      interpreter_required: { description: "True when the person needs an interpreter." },
      address_line1: { description: "Address before admission or home address, line 1." },
      address_line2: { description: "Address line 2." },
      town: { description: "Town or city." },
      postcode: { description: "Postcode, upper case with one space." },
      gp_practice_ods_code: { description: "ODS code of the person's GP practice." },
      legal_status: {
        description: "Legal status summary (for example DoLS or Mental Health Act), as recorded.",
      },
      photo_document_id: {
        description: "The identification photo (document.id); the file is in documents/.",
      },
      room_label: {
        description: "Display copy of the current room; the history is in bed occupancy records.",
      },
      search_names: {
        description:
          "Search index of the names (derived from the columns above; migration 0066); not exported.",
        class: "internal",
      },
      search_room: {
        description:
          "Search index of the room (derived from the columns above; migration 0066); not exported.",
        class: "internal",
      },
      communication_needs: {
        description:
          "Accessible Information Standard needs: JSON list of {code, display, system} (SNOMED CT) with the preferred format.",
      },
      communication_needs_status: {
        description:
          "Whether communication needs have been recorded. Read with communication_needs.",
        codes: {
          not_recorded:
            "Nobody has recorded the person's communication needs. Never read as none (HZ-023).",
          none_identified: "Checked and recorded: no communication needs identified.",
          recorded: "Needs are recorded in communication_needs.",
        },
      },
      communication_needs_confirmed_by: {
        description:
          "Who recorded the communication needs or that there are none (tenant_user.id).",
      },
      communication_needs_confirmed_at: { description: "When they did (instant, UTC)." },
      allergy_status: {
        description: "Whether allergies have been recorded. Read with allergy rows; see codes.",
        codes: {
          unknown:
            "Nobody has recorded whether the person has allergies. Never read as no allergies (HZ-007).",
          no_known_allergies: "Checked and recorded: no known allergies.",
          has_allergies: "One or more allergies are recorded in allergy.",
        },
      },
      allergy_status_confirmed_by: {
        description:
          "Who set the allergy status (tenant_user.id), set by the database from the signed-in user; empty when unknown.",
      },
      allergy_status_confirmed_at: {
        description: "When the allergy status was set (instant, UTC).",
      },
      national_data_opt_out: {
        description: "True when the person has registered a national data opt-out.",
      },
      deceased_at: {
        description:
          "When the person died (instant, UTC). The date of death is deceased_at_uk_date.",
        ukDate: true,
      },
      discharged_at: {
        description:
          "When the person left the service (instant, UTC). The date is discharged_at_uk_date.",
        ukDate: true,
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.person_assignment": {
    context: "people",
    description: "Which staff are assigned to which people, and when.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      person_id: "exported",
      valid_from: "exported",
      valid_to: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.person_care_profile": {
    context: "care",
    description: "IDDSI levels, fluid target, SpO2 scale and skin risk for each person.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      iddsi_food_level: {
        description:
          "IDDSI food level code (3, 4, 5, 6, 7EC or 7); see current_summary for the name and colour.",
      },
      iddsi_drink_level: { description: "IDDSI drink level code (0 to 4)." },
      iddsi_advised_by: {
        description: "Who advised the IDDSI levels (for example a speech and language therapist).",
      },
      iddsi_changed_at: { description: "When the IDDSI levels last changed (instant, UTC)." },
      fluid_target_ml: { description: "Daily fluid target.", unit: "ml per day" },
      spo2_scale2: {
        description: "True when NEWS2 SpO2 scale 2 applies (a clinician's decision).",
      },
      spo2_scale2_clinician: { description: "The clinician who decided on SpO2 scale 2." },
      spo2_scale2_recorded_on: {
        description: "When that decision was recorded (UK calendar date).",
      },
      skin_risk: { description: "Skin risk as recorded from the latest assessment." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.placement": {
    context: "people",
    description: "Placements and their dates.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      service_id: { description: "The service (service.id)." },
      room_id: { description: "The room at admission (room.id)." },
      type: { description: "Placement type: permanent, respite, trial and so on." },
      start_date: { description: "Admission date (UK calendar date)." },
      end_date: {
        description: "Last day of the placement (UK calendar date); empty while it continues.",
      },
      end_reason: { description: "Why the placement ended." },
      trial_ends_on: { description: "End of a trial placement (UK calendar date)." },
      trial_reviewed_on: { description: "When the trial was reviewed (UK calendar date)." },
      local_authority_funded: { description: "True when a council funds the placement." },
      nhs_funded: { description: "True when the NHS funds the placement." },
      admission_decision_id: { description: "The decision to admit (admission_decision.id)." },
      dependency_category: { description: "Dependency category, as recorded." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.pre_admission_assessment": {
    context: "people",
    description:
      "Pre-admission assessments, section by section, with the information sources and how the person took part.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      service_id: { description: "The service assessed for (service.id)." },
      placement_type_sought: {
        description: "The kind of placement sought (permanent, respite, trial and so on).",
      },
      status: {
        description: "Where the assessment stands.",
        codes: {
          in_progress: "Being completed.",
          complete: "Every required section is complete.",
          decided: "A decision to admit has been made on it.",
        },
      },
      sections: {
        description:
          "The twenty sections as JSON keyed by section, each with status, content, reason and who completed it when.",
      },
      information_sources: {
        description:
          "Where the information came from: person, family_or_representative, hospital, gp, social_worker, previous_provider, other.",
      },
      person_involved: {
        description: "True when the person took part in the assessment (Regulation 9).",
      },
      involvement_reason: { description: "Why the person could not take part." },
      assessor_tenant_user_id: { description: "Who assessed (tenant_user.id)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.property_item": {
    context: "people",
    description:
      "Personal property: each item received, signed for, sent with the person, returned, disposed of or lost.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      description: { description: "The item, described." },
      category: {
        description: "The kind of item (cash is never an item: residents' money is a ledger).",
        codes: {
          clothing: "Clothing.",
          jewellery: "Jewellery (a valuable).",
          watch: "A watch (a valuable).",
          electronics: "Electronics (a valuable).",
          mobility_aid: "A walking or mobility aid.",
          sensory_aid: "Glasses or hearing aids.",
          dentures: "Dentures.",
          documents: "Documents (valuable).",
          furniture: "Furniture.",
          ornament_or_picture: "An ornament or picture.",
          toiletries: "Toiletries.",
          other: "Something else.",
        },
      },
      quantity: { description: "How many.", unit: "items" },
      valuable: { description: "True when the item is a valuable (witnessed)." },
      photo_document_ids: { description: "Photos of the item (document.id list)." },
      received_on: { description: "When it was received (UK calendar date)." },
      recorded_by: { description: "Who recorded it (tenant_user.id)." },
      ack_signer: {
        description: "Who signed for the item when it was received.",
        codes: {
          person: "The person.",
          representative: "Their representative.",
          unable_to_sign:
            "Nobody could sign; the reason is in ack_unable_reason and a witness signed.",
        },
      },
      ack_name: { description: "The typed name of the signer." },
      ack_unable_reason: { description: "Why nobody could sign." },
      ack_signed_at: { description: "When it was signed for (instant, UTC)." },
      witnessed_by: { description: "The second member of staff who witnessed (tenant_user.id)." },
      status: {
        description: "Where the item is.",
        codes: {
          held: "Held at the home.",
          sent_with_person: "Sent with the person (for example to hospital).",
          returned: "Returned.",
          disposed: "Disposed of, with the reason and a witness.",
          lost: "Lost, with an incident.",
        },
      },
      hospital_transfer_id: { description: "The transfer it went with (hospital_transfer.id)." },
      returned_on: { description: "When it was returned (UK calendar date)." },
      return_recipient_name: { description: "Who it was returned to." },
      return_recipient_capacity: {
        description: "In what capacity they received it.",
        codes: {
          person: "The person.",
          representative: "Their representative.",
          personal_representative:
            "The personal representative (executor or administrator) after a death.",
          receiving_provider: "The provider the person moved to.",
        },
      },
      return_signer: {
        description: "Who signed for the return.",
        codes: {
          person: "The person.",
          representative: "A representative.",
          unable_to_sign: "Nobody could sign; the reason is in return_unable_reason.",
        },
      },
      return_signer_name: { description: "The typed name of the signer." },
      return_unable_reason: { description: "Why nobody could sign for the return." },
      return_signed_at: { description: "When the return was signed for (instant, UTC)." },
      returned_by: { description: "Who returned it (tenant_user.id)." },
      return_witnessed_by: { description: "Who witnessed the return (tenant_user.id)." },
      disposed_on: { description: "When it was disposed of (UK calendar date)." },
      disposal_reason: { description: "Why it was disposed of." },
      disposed_by: { description: "Who disposed of it (tenant_user.id)." },
      disposal_witnessed_by: { description: "Who witnessed the disposal (tenant_user.id)." },
      lost_on: { description: "When it was found to be lost (UK calendar date)." },
      loss_incident_id: { description: "The incident raised for the loss (incident.id)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.rate_table": {
    context: "platform",
    description:
      "The organisation's own settings over Harbour's rate table (global rows are in rates.md).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      key: { description: "The setting's key (rates.md)." },
      value: { description: "The organisation's own value.", unit: "as given in the unit column" },
      unit: { description: "Unit of the value (rates.md conventions)." },
      nation: { description: "Nation the row applies to." },
      valid_from: "exported",
      valid_to: "exported",
      source: { description: "Where the value comes from." },
      verification_status: { description: "verified, master-prompt, to-verify or tenant." },
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.record_version": {
    context: "platform",
    description: "Every earlier version of every changed record.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      table_name: { description: "Table of the changed record." },
      record_id: "exported",
      record_version: { description: "The version this row preserves.", unit: "version number" },
      valid_from: "exported",
      valid_to: "exported",
      changed_by: "exported",
      data: { description: "The record as it was before the change, JSON." },
    },
  },
  "public.refused_entry": {
    context: "care",
    description:
      "The server's copy of a care entry the API refused from a device, kept so a refused entry is never only on one phone, with the review task it joined (append-only; care.md section 6).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      entry_id: {
        description:
          "The entry's own id, made on the device; the same id the entry would have had in its table.",
      },
      record_table: {
        description: "The table the entry was meant for.",
        codes: {
          care_note: "A daily note (care_note).",
          observation: "A chart entry (observation).",
          body_map_mark: "A body-map mark (body_map_mark).",
          activity_record: "An activity record (activity_record).",
          visit_log: "A visit (visit_log).",
        },
      },
      person_id: {
        description:
          "The person receiving care the entry is about (person.id); empty when the device named no person known here.",
      },
      location_id: {
        description:
          "The person's location when the copy arrived, or the author's when no person was known (location.id).",
      },
      payload: {
        description:
          "The entry's columns as the device held them, JSON with snake_case keys as in the entry's own table; not validated, so read it as the device's record, not the care record.",
      },
      http_status: {
        description:
          "The HTTP status of the refusal; empty when the device refused it before sending.",
        unit: "HTTP status code",
      },
      refusal_code: {
        description: "The API's code for the refusal (for example care_event_after_exit, invalid).",
      },
      refusal_message: {
        description: "The API's reason for the refusal, in English, as the device showed it.",
      },
      refused_at: {
        description:
          "When the device recorded the refusal (instant, UTC), never later than the copy arrived.",
      },
      author_tenant_user_id: {
        description: "The member of staff who wrote the entry (tenant_user.id).",
      },
      device_id: { description: "Opaque id of the device that held the entry." },
      review_task_id: { description: "The review task the copy joined (task.id)." },
      created_at: "exported",
      created_by: {
        description:
          "Who sent the copy (tenant_user.id): the author, or a manager handing over their entries.",
      },
    },
  },
  "public.request_quota": {
    context: "platform",
    description:
      "Each member of staff's recent requests against the API's per-user limits, shared by every API instance.",
    treatment: "not_exported",
    retention: "operational",
    personal: true,
    reasonNotExported:
      "Operational rate-limit counters: a row holds at most one window's request times and is overwritten in place, so it records nothing about care or the organisation.",
    columns: {},
  },
  "public.retention_class": {
    context: "platform",
    description: "The organisation's retention overrides (the defaults are in retention.md).",
    treatment: "tenant_overrides_only",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      record_class: { description: "Retention class (retention.md)." },
      period: {
        description: "The organisation's retention period.",
        unit: "as given in the unit column",
      },
      unit: { description: "years or months." },
      trigger: { description: "What starts the retention clock (retention.md)." },
      source: { description: "Why the organisation chose this period." },
      notes: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.retention_decision": {
    context: "platform",
    description:
      "The organisation's decisions on each kind of record's retention period, for onboarding (platform-completions.md rules 26 and 27; append-only): a later decision is a new row.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      record_class: { description: "The kind of record (retention.md record_class)." },
      kind: {
        description: "What was decided.",
        codes: {
          accepted: "Harbour's period accepted.",
          lengthened: "The organisation keeps it longer, with its own period.",
          period_set: "The organisation's policy sets the period, now set.",
          not_used: "The organisation does not keep this kind of record.",
        },
      },
      decided_by: "exported",
      decided_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.review_record": {
    context: "people",
    description:
      "Reviews held: care plan, local authority, family involvement and trial reviews (append-only).",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      kind: {
        description: "The kind of review.",
        codes: {
          care_plan: "A care plan review.",
          la_review: "The local authority's review of a council-funded placement.",
          family_involvement: "Family involvement in care planning.",
          trial_review: "The review at the end of a trial placement.",
        },
      },
      held_on: { description: "When the review was held (UK calendar date)." },
      participants: { description: "Who took part, JSON list of names and roles." },
      family_involvement_kind: {
        description: "How the family was involved (family involvement reviews).",
        codes: {
          attended_review: "A family member or representative attended.",
          contributed: "They contributed without attending.",
          invited_declined: "They were invited and declined.",
          person_declines_involvement:
            "The person does not want their family involved (stops the clock).",
          no_family_or_representative: "The person has nobody to involve (stops the clock).",
        },
      },
      la_reference: { description: "The council's reference for its review." },
      changes_covered: {
        description: "The changes this review covered (care_plan_change.id list).",
      },
      outcome: { description: "The outcome, in words." },
      document_id: { description: "The review document (document.id)." },
      supersedes_id: "exported",
      correction_reason: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.risk_assessment": {
    context: "care",
    description: "Risk assessments with controls and residual risk.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      template_key: { description: "Risk assessment template." },
      template_version: { description: "Template version.", unit: "version number" },
      hazard: { description: "The hazard assessed." },
      who_at_risk: { description: "Who is at risk." },
      answers: { description: "Template answers, JSON." },
      findings: { description: "Findings, JSON (for example bed rail measurements)." },
      likelihood: {
        description: "Likelihood before controls (NPSA matrix, ADR-0032).",
        unit: "1 to 5",
      },
      severity: { description: "Severity before controls (NPSA matrix).", unit: "1 to 5" },
      risk_rating: { description: "Likelihood times severity before controls.", unit: "1 to 25" },
      risk_band: { description: "Band for that rating." },
      controls: { description: "Controls in place." },
      residual_likelihood: { description: "Likelihood after controls.", unit: "1 to 5" },
      residual_severity: { description: "Severity after controls.", unit: "1 to 5" },
      residual_rating: {
        description: "Likelihood times severity after controls.",
        unit: "1 to 25",
      },
      residual_band: { description: "Band for the residual rating." },
      positive_risk_statement: {
        description: "The positive-risk statement, where the person chooses to take a risk.",
      },
      person_views: { description: "The person's views." },
      assessed_on: { description: "Date assessed (UK calendar date)." },
      review_due_on: { description: "Review date (UK calendar date)." },
      status: { description: "draft, published, superseded or closed." },
      closed_reason: { description: "Why the assessment was closed." },
      closed_at: { description: "When it was closed (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.role": {
    context: "platform",
    description: "The organisation's roles and the permissions in each version.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      key: { description: "The role's key." },
      name: "exported",
      description: { description: "What the role is for." },
      permissions: { description: "Permissions in this role version." },
      scope_kind: { description: "tenant, location, assigned, self or none." },
      is_builtin: { description: "True for Harbour's built-in roles." },
      based_on_key: { description: "The built-in role it was cloned from." },
      archived_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.role_assignment": {
    context: "platform",
    description: "Who holds which role, where and for how long.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      role_id: "exported",
      location_id: "exported",
      organisation_wide: {
        description: "Whether a location role is held across the whole organisation.",
      },
      valid_from: "exported",
      valid_to: "exported",
      reason: { description: "Why the role was assigned." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.room": {
    context: "people",
    description: "Rooms and beds at each location.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      label: { description: "Room label shown on screens." },
      unit_name: { description: "Unit or wing." },
      floor: { description: "Floor." },
      beds: { description: "Beds in the room.", unit: "count" },
      ensuite: { description: "True when the room is en suite." },
      status: { description: "available, out_of_service or awaiting_clearance." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.sample_batch": {
    context: "platform",
    description:
      "Sample data batches (platform-completions.md rules 29 to 32): who loaded invented people to learn Harbour, when, how many, and when the batch was removed.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      loaded_by: "exported",
      loaded_at: "exported",
      people: { description: "How many invented people the batch loaded.", unit: "people" },
      removed_by: "exported",
      removed_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.service": {
    context: "platform",
    description: "Services run at each location, with their service type.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      name: "exported",
      service_type: { description: "Service type (data-standards.md)." },
      status: { description: "active or closed." },
      started_on: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.sharing_decision": {
    context: "people",
    description:
      "Decisions to share sections of the record with a family member, a professional or a share link: closed by default, every one expires.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      recipient_kind: {
        description: "Who receives the information.",
        codes: {
          family: "A family member or representative (recipient_contact_id).",
          professional: "A professional with a Harbour account (recipient_tenant_user_id).",
          link: "Whoever holds an About Me share link.",
        },
      },
      recipient_contact_id: { description: "The family member or representative (contact.id)." },
      recipient_tenant_user_id: { description: "The professional (tenant_user.id)." },
      sections: {
        description:
          "The sections shared: about_me, daily_updates, photos, activities_and_visits, care_plan, health_summary, medicines, appointments, finance, benefits, documents.",
      },
      care_plan_domains: { description: "The care plan domains shared; empty means every domain." },
      basis: {
        description: "The lawful basis for sharing (people.md rule 13).",
        codes: {
          consent:
            "The person's consent, or that of an attorney or deputy whose authority covers it.",
          legal_authority: "A legal authority held by the recipient.",
          best_interests: "A recorded best-interests decision (the person lacks capacity for it).",
          direct_care:
            "Direct care, for professionals and clinical sections only (Caldicott principle 7).",
        },
      },
      consent_given_by: {
        description: "Who consented.",
        codes: {
          person: "The person.",
          authority_holder: "An attorney or deputy whose authority covers it.",
        },
      },
      capacity: {
        description: "The person's capacity for the decision when it was made (MCA 2005 s.1(2)).",
        codes: {
          presumed: "Presumed to have capacity.",
          assessed_has_capacity: "Assessed as having capacity.",
          assessed_lacks_capacity: "Assessed as lacking capacity.",
        },
      },
      capacity_assessment_id: {
        description: "The assessment of the sharing decision relied on (capacity_assessment.id).",
      },
      best_interests_decision_id: {
        description: "The best-interests decision relied on (best_interests_decision.id).",
      },
      authority_role: {
        description: "The legal authority relied on.",
        codes: {
          lpa_health_welfare: "Lasting power of attorney for health and welfare.",
          lpa_property_finance:
            "Lasting power of attorney for property and financial affairs (finance and benefits).",
          deputy_personal_welfare:
            "Court of Protection deputy for personal welfare (the sections the order covers).",
          deputy_property_affairs:
            "Court of Protection deputy for property and affairs (the sections the order covers).",
          appointee: "DWP appointee (benefits only).",
        },
      },
      authority_contact_id: { description: "The contact who holds the authority (contact.id)." },
      authority_reference: {
        description: "Office of the Public Guardian, court or DWP reference.",
      },
      authority_evidence_document_id: { description: "Evidence of the authority (document.id)." },
      authority_valid_until: {
        description: "When the authority ends (UK calendar date), if it does.",
      },
      authority_order_sections: {
        description: "For a deputy: the sections the Court of Protection order covers.",
      },
      valid_from: "exported",
      valid_to: {
        description: "When the decision expires (instant, UTC); every decision expires.",
      },
      withdrawn_at: { description: "When the decision was withdrawn (instant, UTC)." },
      withdrawn_reason: { description: "Why it was withdrawn." },
      suspended_at: {
        description:
          "When the suspension in force now began (instant, UTC); every period is in sharing_decision_suspension.",
      },
      suspended_reason: { description: "Why it is suspended now." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.sharing_decision_suspension": {
    context: "people",
    description:
      "Every period a sharing decision was suspended (for example during a safeguarding enquiry); what happened then stays closed.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      sharing_decision_id: { description: "The decision suspended (sharing_decision.id)." },
      suspended_at: { description: "When the suspension began (instant, UTC)." },
      reason: { description: "Why it was suspended." },
      lifted_at: { description: "When it was lifted (instant, UTC); empty while it lasts." },
      lifted_by: { description: "Who lifted it (tenant_user.id)." },
      lifted_reason: { description: "Why it was lifted." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.statement_of_purpose_version": {
    context: "quality",
    description:
      "Versions of the statement of purpose (quality.md rules 11 to 15): the Schedule 3 content, who wrote and approved each version, the change summary and the CQC notification of each revision.",
    treatment: "tenant_rows",
    retention: "organisation_document",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      version_number: { description: "The version's number in the organisation.", unit: "version" },
      state: { description: "draft, approved, superseded or discarded." },
      kind: {
        description: "Whether it is the statement CQC already held or a revision.",
        codes: { baseline: "The statement CQC already held.", revision: "A revision." },
      },
      content: {
        description:
          "The statement's Schedule 3 sections, including the provider's and registered managers' business contact details.",
      },
      author_id: { description: "Who wrote the version (tenant_user.id)." },
      contributor_ids: { description: "The author and everyone who changed the draft." },
      supersedes_id: { description: "The version this one replaced on approval, if any." },
      change_summary: {
        description: "What changed from the previous version, section by section.",
      },
      registration_prompts: {
        description: "Registration applications the change may need (Harbour's prompts).",
      },
      approved_by: {
        description:
          "Who approved the version (tenant_user.id); never its author or a contributor.",
      },
      approved_at: "exported",
      notification_due_at: {
        description:
          "When written details of the revision are due at CQC (approval plus cqc.statement_of_purpose.revision_notice_days, UK days).",
      },
      notified_at: { description: "When the revision was sent to CQC." },
      notified_by: { description: "Who recorded that it was sent (tenant_user.id)." },
      notification_evidence: { description: "The CQC reference, or how it was sent." },
      discard_reason: { description: "Why the draft was discarded." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.statutory_notification": {
    context: "safety",
    description:
      "Notifications owed to regulators and agencies (CQC, HSE, the local authority and others): drafts, deadlines and submissions.",
    treatment: "tenant_rows",
    retention: "serious_incident",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      incident_id: { description: "The incident it arises from (incident.id), when it does." },
      person_id: "exported",
      dols_authorisation_id: {
        description:
          "The DoLS authorisation whose outcome it reports (dols_authorisation.id), when it does.",
      },
      source_key: {
        class: "internal",
        description: "Key that stops the same notification being drafted twice from one source.",
      },
      kind: {
        description:
          "The notification: cqc_reg16_death, cqc_reg18_serious_injury, cqc_reg18_abuse, cqc_reg18_police, cqc_reg18_service_disruption, cqc_reg18_dols_outcome, riddor_death, riddor_specified_injury, riddor_non_worker_hospital, riddor_over_7_day, riddor_dangerous_occurrence, safeguarding_s42, candour, leder, ukhsa_outbreak, medical_examiner or police_missing_person.",
      },
      status: {
        description: "Where the notification stands.",
        codes: {
          draft: "Drafted; not yet ready.",
          ready: "Ready for a holder of safety.notification.submit to submit.",
          submitted: "Submitted to the regulator or agency.",
          not_required: "A person decided it was not required, with a reason.",
        },
      },
      due_at: {
        description:
          "The earliest deadline (instant, UTC), counted from when the event happened or the outcome was given.",
      },
      deadlines: {
        description: "Every deadline, JSON list of { key, dueAt, wording, statutory }.",
      },
      provisional: {
        description:
          'True when drafted on an "unsure" answer so the clock shows; a person must confirm it.',
      },
      reasons: { description: "Why the notification applies, in words." },
      required_content: { description: "What the regulator's form needs, item by item." },
      sources: {
        description:
          "The legislation and guidance relied on, JSON list of { title, provision, url }.",
      },
      statement: {
        description: "The regulation 18(4B) statement for a DoLS outcome, JSON.",
      },
      content: { description: "What the manager prepared for the regulator's form, JSON." },
      no_longer_indicated: {
        description:
          "True when a later classification no longer finds it required; a person must still decide.",
      },
      no_longer_indicated_reason: { description: "Why it is no longer indicated." },
      not_required_reason: { description: "Why a person decided it was not required." },
      submitted_by: { description: "Tenant user who submitted it (tenant_user.id)." },
      submitted_at: { description: "When it was submitted (instant, UTC)." },
      external_reference: {
        description: "The regulator's or agency's reference for the submission.",
      },
      evidence_document_id: { description: "Proof of submission (document.id)." },
      classifier_version: { description: "Version of the classifier that drafted it." },
      retention_class: {
        description: "This notification's retention class.",
        codes: {
          serious_incident: "Kept as a serious incident record.",
          riddor_report: "A RIDDOR report, kept for the RIDDOR period.",
        },
      },
      overdue_notified_at: {
        description: "When the overdue alert went out (instant, UTC); sent once.",
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.sub_processor_notice": {
    context: "platform",
    description:
      "Thapsus's notices of a new or replacement sub-processor (platform-completions.md rules 24 and 25), the same for every organisation.",
    treatment: "not_exported",
    retention: "audit_event",
    personal: false,
    reasonNotExported:
      "Thapsus's own notices, the same for every organisation and published in sub-processors.md; the organisation's responses are exported with the notice id and sub-processor key.",
    columns: {},
  },
  "public.sub_processor_response": {
    context: "platform",
    description:
      "The organisation's responses to sub-processors (rules 24 and 25; append-only): its data protection lead acknowledging one it uses (a notice, or the register at onboarding) or objecting to a notice with its grounds, and how Thapsus resolved an objection.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      sub_processor_key: { description: "The sub-processor (the key in sub-processors.md)." },
      notice_id: { description: "The notice answered; empty for acknowledging the register." },
      kind: {
        description: "What the row records.",
        codes: {
          acknowledged: "The data protection lead acknowledged it.",
          objected: "The data protection lead objected, within the notice period.",
          objection_resolved: "Thapsus recorded how the objection was resolved.",
        },
      },
      grounds: { description: "Why the organisation objected (an objection only)." },
      resolution: {
        description: "How an objection was resolved.",
        codes: {
          objection_withdrawn: "The organisation withdrew it; the sub-processor may be used.",
          not_used_for_tenant: "Thapsus agreed not to use it for this organisation.",
          services_ended: "The organisation ended the affected services.",
        },
      },
      responded_by: "exported",
      responded_at: "exported",
      created_at: "exported",
    },
  },
  "public.support_access_request": {
    context: "platform",
    description: "Thapsus support access requests and the organisation's decisions.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      operator_user_id: "exported",
      ticket_reference: { description: "Thapsus support ticket reference." },
      reason: { description: "Why access was asked for." },
      requested_at: "exported",
      decided_at: "exported",
      decided_by: "exported",
      decision: { description: "approved or declined." },
      expires_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.task": {
    context: "platform",
    description: "Tasks with owner, due window, status, reasons and evidence.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      series_id: "exported",
      location_id: "exported",
      person_id: "exported",
      kind: { description: "What the task is (module.what)." },
      title: "exported",
      required_permission: { description: "Permission needed to complete it." },
      source_type: "exported",
      source_id: "exported",
      assignee_tenant_user_id: "exported",
      assignee_role_key: { description: "Role the task is assigned to, if not a person." },
      due_at: "exported",
      window_start: { description: "Start of the window to do it (instant, UTC)." },
      window_end: { description: "End of the window (instant, UTC)." },
      priority: { description: "routine or urgent." },
      evidence_required: { description: "True when evidence is needed to complete it." },
      status: { description: "open, done, skipped or cancelled." },
      status_reason: { description: "Why it was skipped or cancelled." },
      cancel_code: {
        description: "Why the people lifecycle cancelled the task; empty for any other reason.",
        codes: {
          paused_while_away:
            "Paused while the person was in hospital or on leave; brought back on their return.",
          ended_at_exit:
            "Ended by a discharge or death (stopped_by_exit_id names it); brought back only if that exit is corrected as recorded in error.",
          exit_recorded_in_error:
            "The exit task of a discharge or death later corrected as recorded in error.",
          planned_exit_cancelled:
            "The exit task of a planned discharge or transfer that was cancelled.",
          missed_before_return_recorded:
            "Its window passed before a late-recorded return or correction; kept cancelled and listed for the nurse in charge.",
        },
      },
      stopped_by_exit_id: { description: "The exit that cancelled the task (exit_record.id)." },
      restore_code: {
        description: "How a return or correction brought the task back, if it did.",
        codes: {
          caught_up:
            "Missed while the return or correction was not recorded; made due once more, with a fresh window.",
          answered_while_stopped:
            "An entry answered it while it was stopped, so it was restored as done, never due again.",
        },
      },
      completed_at: "exported",
      completed_by: "exported",
      evidence_type: { description: "Kind of evidence record (table name)." },
      evidence_id: "exported",
      evidence_after_close: {
        description:
          "True when the evidence arrived after the task was cancelled; the task stays cancelled.",
      },
      details: {
        description:
          "Review details, JSON: missedTasks (task id, kind, due time, reopened) and entries (entry kind, client id, device id, user id, times); opaque ids only, never clinical text.",
      },
      escalation_level: { description: "Escalation steps taken.", unit: "count" },
      escalated_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.task_series": {
    context: "platform",
    description: "Recurring task definitions.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      location_id: "exported",
      person_id: "exported",
      kind: { description: "What the tasks are (module.what)." },
      title: "exported",
      required_permission: { description: "Permission needed to complete them." },
      source_type: "exported",
      source_id: "exported",
      assignee_tenant_user_id: "exported",
      assignee_role_key: { description: "Role the tasks go to." },
      recurrence: {
        description: "Recurrence, JSON; times of day are Europe/London wall-clock times, not UTC.",
      },
      starts_on: "exported",
      ends_on: "exported",
      window_before_minutes: "exported",
      window_after_minutes: "exported",
      evidence_required: { description: "True when evidence is needed." },
      priority: { description: "routine or urgent." },
      active: { description: "True while the series runs." },
      inactive_code: {
        description: "Why the people lifecycle stopped the series; empty for any other reason.",
        codes: {
          paused_while_away:
            "Paused while the person was in hospital or on leave; brought back on their return.",
          ended_at_exit:
            "Ended by a discharge or death (stopped_by_exit_id names it); brought back only if that exit is corrected as recorded in error.",
          exit_recorded_in_error:
            "The exit task of a discharge or death later corrected as recorded in error.",
          planned_exit_cancelled:
            "The exit task of a planned discharge or transfer that was cancelled.",
          missed_before_return_recorded:
            "Its window passed before a late-recorded return or correction; kept cancelled and listed for the nurse in charge.",
        },
      },
      stopped_by_exit_id: { description: "The exit that stopped the series (exit_record.id)." },
      materialised_until: { description: "Tasks have been created up to this instant (UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.tenant": {
    context: "platform",
    description:
      "The organisation: legal name, CQC provider ID, terminology, data protection officer, Caldicott Guardian and SIRO.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
    columns: {
      id: "exported",
      group_id: "exported",
      name: "exported",
      legal_name: { description: "Legal name of the organisation." },
      cqc_provider_id: "exported",
      legal_form: { description: "Legal form (data-standards.md)." },
      vat_registered: { description: "True when VAT-registered." },
      nation: { description: "Home nation." },
      status: { description: "onboarding, active, suspended or closed." },
      brand_name: { description: "White-label name." },
      brand_accent: { description: "Accent colour (#rrggbb)." },
      logo_document_id: "exported",
      terminology: { description: "resident, client or person_we_support." },
      dpo_name: { description: "Data protection officer or lead." },
      dpo_email: { description: "Their email address." },
      caldicott_guardian: { description: "Caldicott Guardian." },
      siro: { description: "Senior information risk owner." },
      data_protection_lead_id: {
        description: "The member named as data protection officer or lead, who signs the DPIA.",
      },
      sector: {
        description: "Whether the organisation is a public authority (its lawful bases differ).",
        codes: { independent: "An independent provider.", public: "A public authority." },
      },
      privacy_notice_url: { description: "Where its privacy notice is published (https)." },
      dpa_signed_on: { description: "The UK date it signed the data processing agreement." },
      uses_data_beyond_direct_care: {
        description:
          "Whether it uses care data beyond direct care (national data opt-out); empty until it says.",
      },
      marketing_enabled: { description: "True when it uses Harbour for marketing (consent)." },
      ai_free_text_enabled: { description: "True when AI may read free text (consent)." },
      ai_provider: { description: "The AI provider it chose, when the AI module is planned." },
      staff_file_option: {
        description: "How long staff files are kept, as the organisation chose (retention.md).",
        codes: {
          "staff_file.after_leaving": "For the period in retention.md after employment ends.",
          "staff_file.to_75th_birthday": "Until the person's 75th birthday.",
        },
      },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.tenant_export": {
    context: "platform",
    description:
      "The organisation's full exports (platform-completions.md rules 10 to 16): who asked and when, where each stands, the snapshot it was read from, the manifest checksum and the single download. The archive itself is deleted at expiry.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      kind: {
        description: "What was exported.",
        codes: {
          full: "Everything the organisation holds.",
          changes_since: "Rows created, changed or removed since an earlier export's snapshot.",
        },
      },
      since: { description: "For a changes-since export: the earlier snapshot (instant, UTC)." },
      status: {
        description: "Where the export stands.",
        codes: {
          queued: "Asked for, not started.",
          running: "Being prepared.",
          ready: "Ready to download.",
          failed: "Could not be completed; never offered for download.",
          expired: "Its link lapsed and its archive was deleted.",
          revoked: "Cancelled; its archive was deleted.",
        },
      },
      requested_by: "exported",
      requested_at: "exported",
      started_at: "exported",
      snapshot_at: {
        description: "When the one read-only snapshot every file was read from was taken (UTC).",
      },
      ready_at: "exported",
      expires_at: "exported",
      failed_at: "exported",
      revoked_at: "exported",
      revoked_by: "exported",
      schema_version: {
        description: "The export format's schema version (EXPORT_SCHEMA_VERSION).",
      },
      storage_key: {
        description: "Where Harbour kept the archive in storage.",
        class: "internal",
      },
      bytes: { description: "The archive's size.", unit: "bytes" },
      manifest_sha256: { description: "SHA-256 of manifest.json, in lower-case hexadecimal." },
      problems: { description: "Why the export was incomplete, if it was (JSON)." },
      warnings: { description: "Warnings listed in the manifest (JSON)." },
      downloaded_at: "exported",
      downloaded_by: { description: "Who downloaded the archive (tenant_user.id): the requester." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.tenant_group": {
    context: "platform",
    description: "The group the organisation belongs to, if any (name only).",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      name: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.tenant_setting_decision": {
    context: "platform",
    description:
      "The organisation's decisions on the settings Harbour chose for it, for onboarding (platform-completions.md rules 26 and 27; append-only): a later decision is a new row.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      rate_key: { description: "The setting's rate table key." },
      kind: {
        description: "What was decided.",
        codes: {
          accepted: "Harbour's default accepted.",
          set: "The organisation set its own figure.",
        },
      },
      decided_by: "exported",
      decided_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
  "public.tenant_user": {
    context: "platform",
    description: "Staff and other users of the organisation: name, work email, job title, status.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      auth_user_id: {
        description: "Internal identity reference; not exported.",
        class: "internal",
      },
      display_name: { description: "The user's name." },
      search_name: {
        description:
          "Search index of the display name (derived from the columns above; migration 0066); not exported.",
        class: "internal",
      },
      email: { description: "Work email address." },
      job_title: { description: "Job title." },
      status: { description: "invited, active, suspended or left." },
      is_agency: { description: "True for agency and bank workers." },
      mfa_required: { description: "True when MFA is required (every role reading care records)." },
      last_seen_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.visit_log": {
    context: "care",
    description: "Visits, visits out and accompaniments.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      location_id: "exported",
      occurred_at: "exported",
      recorded_at: "exported",
      device_time: "exported",
      device_offset_minutes: "exported",
      created_by: "exported",
      handed_over_by: {
        description:
          "Sent by: the manager who handed this entry over from a device for its author (created_by), when one did (tenant_user.id; care.md section 6, Device integrity part 6). Empty when its author sent it.",
      },
      device_id: "exported",
      ...BACK_ENTRY_COLUMN_DOCS,
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      recorded_after_exit: {
        description:
          "True when an entry about an event at or before a discharge, death or move to hospital (or within the clock tolerance after it) was accepted afterwards (people.md rule 3).",
      },
      task_id: { description: "The task the entry named (task.id), if any." },
      task_outcome: {
        description:
          "What the entry did to the task it named (care.md rule 13); empty when it named none.",
        codes: {
          completed: "The entry completed the task.",
          task_cancelled:
            "The task had been cancelled (for example by a move); the entry is kept as late evidence and the task stays cancelled.",
          task_already_closed:
            "The task was already done, skipped or answered; the entry is kept, flagged and listed for the nurse in charge to review.",
          not_linked:
            "The author may not complete the task; the entry is kept unlinked, flagged and listed for review.",
          medicines_conflict:
            "A medicines task the entry could not complete (not the author's, or already closed or answered): kept, never completing it, with an urgent conflict review for the nurse in charge.",
        },
      },
      kind: { description: "facilitated_visit, visit_out or accompaniment." },
      contact_id: { description: "The visitor, where a recorded contact (contact.id)." },
      visitor_name: { description: "The visitor's name, where not a recorded contact." },
      visitor_relationship: { description: "The visitor's relationship to the person." },
      ended_at: { description: "When the visit ended (instant, UTC)." },
      restrictions_applied: { description: "True when visiting restrictions applied." },
      restriction_reason: { description: "Why (may mention an outbreak or health)." },
      notes: { description: "Notes." },
    },
  },
  "public.welcome_checklist_item": {
    context: "people",
    description: "The welcome checklist for each admission, item by item.",
    treatment: "tenant_rows",
    retention: "care_record",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      person_id: "exported",
      placement_id: { description: "The placement (placement.id)." },
      item_key: { description: "The item, as a stable key from the template." },
      title: "exported",
      required: { description: "True when the item must be done." },
      safety_critical: {
        description: "True for safety-critical items (for example allergies or the photo).",
      },
      allow_not_applicable: {
        description: "True when the item may be marked not applicable, with a reason.",
      },
      position: { description: "Order of the item on the checklist.", unit: "position (from 0)" },
      status: {
        description: "Where the item stands.",
        codes: {
          pending: "Not done yet.",
          done: "Done.",
          not_applicable: "Not applicable, with the reason in reason.",
        },
      },
      reason: { description: "Why the item is not applicable." },
      done_by: { description: "Who did it (tenant_user.id)." },
      done_at: { description: "When it was done (instant, UTC)." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.welcome_checklist_template": {
    context: "people",
    description: "The organisation's welcome checklist template.",
    treatment: "tenant_rows",
    retention: "tenant_configuration",
    personal: false,
    columns: {
      id: "exported",
      tenant_id: "exported",
      items: { description: "The template's items, JSON list of key, title and flags." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.workflow_instance": {
    context: "platform",
    description: "Workflow state of records such as incidents and exits.",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      definition_key: { description: "The workflow (for example safety.incident)." },
      definition_version: { description: "Workflow definition version.", unit: "version number" },
      subject_type: "exported",
      subject_id: "exported",
      person_id: "exported",
      state: { description: "Current state." },
      entered_state_at: "exported",
      sla_due_at: "exported",
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
    },
  },
  "public.workflow_transition": {
    context: "platform",
    description: "Every workflow move, who made it and why (append-only).",
    treatment: "tenant_rows",
    retention: "as_subject",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      instance_id: "exported",
      person_id: "exported",
      from_state: { description: "State before the move." },
      to_state: { description: "State after the move." },
      reason: { description: "Reason given for the move." },
      step_up: { description: "True when the move needed a fresh MFA sign-in." },
      occurred_at: "exported",
      created_at: "exported",
      created_by: "exported",
    },
  },
};
