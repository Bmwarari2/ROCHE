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
  | "serious_incident"
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
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      activity: { description: "The activity." },
      format: { description: "one_to_one or group." },
      group_session_id: { description: "The group session, where it was one." },
      attendance: { description: "Attendance: attended, declined, unable and so on." },
      engagement: { description: "Engagement, in words." },
      duration_minutes: { description: "How long it lasted.", unit: "minutes" },
      notes: { description: "Notes." },
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
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      view: { description: "Body view: front or back." },
      region: { description: "Body region." },
      side: { description: "The person's left or right (never the viewer's)." },
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
    description: "Records opened outside scope, with the typed justification and review.",
    treatment: "tenant_rows",
    retention: "audit_event",
    personal: true,
    columns: {
      id: "exported",
      tenant_id: "exported",
      tenant_user_id: "exported",
      person_id: "exported",
      justification: {
        description: "The typed justification for opening or finding a record outside scope.",
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
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
      category: { description: "Note category." },
      body: { description: "The note text." },
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
      task_series_id: { description: "The recurring task it created (task_series.id)." },
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
        description: "Deputy: true when the order expressly authorises restraint (MCA s.20(8)).",
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
          "Bed rails agreed by a representative: true when recorded as necessary to prevent harm (MCA s.11(3) or s.20(10)).",
      },
      restraint_proportionate: {
        description:
          "Bed rails agreed by a representative: true when recorded as proportionate to the likelihood and seriousness of harm (MCA s.11(4) or s.20(11)).",
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
      notes: { description: "Free-text notes about the contact." },
      created_at: "exported",
      created_by: "exported",
      updated_at: "exported",
      updated_by: "exported",
      version: "exported",
      deleted_at: "exported",
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
        description: "person_photo, care_attachment, person_document or organisation_document.",
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
      status: {
        description: "available, quarantined (failed or missed the malware scan) or destroyed.",
      },
      scan_status: { description: "clean, infected, unavailable or not_scanned." },
      destroyed_at: "exported",
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
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
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
      communication_needs: {
        description:
          "Accessible Information Standard needs: JSON list of {code, display, system} (SNOMED CT) with the preferred format.",
      },
      allergy_status: {
        description: "Whether allergies have been recorded. Read with allergy rows; see codes.",
        codes: {
          unknown:
            "Nobody has recorded whether the person has allergies. Never read as no allergies (HZ-007).",
          no_known_allergies: "Checked and recorded: no known allergies.",
          has_allergies: "One or more allergies are recorded in allergy.",
        },
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
      dependency_category: { description: "Dependency category, as recorded." },
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
      completed_at: "exported",
      completed_by: "exported",
      evidence_type: { description: "Kind of evidence record (table name)." },
      evidence_id: "exported",
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
      device_id: "exported",
      late_entry: "exported",
      clock_drift: "exported",
      supersedes_id: "exported",
      correction_reason: "exported",
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
