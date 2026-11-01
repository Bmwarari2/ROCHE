import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { id, mutableColumns, tenantId } from "./_columns";
import { medication, medicationAdministration } from "./medicines";
import { person } from "./people";
import { tenantUser } from "./platform";
import { incident } from "./safety";

/**
 * Medication errors on incidents and medication reviews (slice 45; medicines.md section 14;
 * MEDS-012, MEDS-013; migration 0135). The error kinds and stages mirror
 * `MEDICATION_ERROR_KINDS` and `MEDICATION_ERROR_STAGES` in packages/domain, the reviewer roles
 * `REVIEWER_ROLES`; the database tests keep them in step. Nothing here scores or recommends.
 */

export const MEDICATION_ERROR_KIND_SQL =
  "'omitted_dose','wrong_dose','wrong_medicine','wrong_person','wrong_time','wrong_route','given_after_stopped','other','wrong_frequency','wrong_formulation','wrong_quantity','allergy_or_contraindication','expired_medicine','wrong_storage','monitoring_not_done','record_unclear_or_missing'";
export const MEDICATION_ERROR_STAGE_SQL =
  "'prescribing','transcribing','dispensing','administration','monitoring','storage','other'";
export const REVIEWER_ROLE_SQL = "'gp','pharmacist','prescriber','consultant','other'";

const tri = (column: string) => sql.raw(`${column} IS NULL OR ${column} IN ('yes','no','unsure')`);

/** One per medication incident: what went wrong, for whom, and what was done. */
export const medicationError = pgTable(
  "medication_error",
  {
    id: id(),
    tenantId: tenantId(),
    incidentId: uuid("incident_id").notNull(),
    /** One of the people on the incident. */
    personId: uuid("person_id").notNull(),
    /** A version of one of the person's medicines entries (medication.id), when known. */
    medicationId: uuid("medication_id"),
    /** The person's administration record it concerns, when there is one. */
    administrationId: uuid("administration_id"),
    kinds: text("kinds").array().notNull().default(sql`'{}'::text[]`),
    stage: text("stage"),
    reachedPerson: text("reached_person"),
    controlledDrug: text("controlled_drug"),
    deliberateOrRepeated: text("deliberate_or_repeated"),
    immediateActions: text("immediate_actions"),
    clinicianToldAt: timestamp("clinician_told_at", { withTimezone: true }),
    /** Who was told, as written (for example "Out-of-hours GP"). */
    clinicianTold: text("clinician_told"),
    adviceGiven: text("advice_given"),
    rootCause: text("root_cause"),
    cdReportedOn: date("cd_reported_on", { mode: "string" }),
    cdReportReference: text("cd_report_reference"),
    retentionClass: text("retention_class").notNull().default("serious_incident"),
    ...mutableColumns(),
  },
  (t) => [
    unique("medication_error_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medication_error_incident_key").on(t.tenantId, t.incidentId),
    foreignKey({
      name: "medication_error_incident_fk",
      columns: [t.tenantId, t.incidentId],
      foreignColumns: [incident.tenantId, incident.id],
    }),
    foreignKey({
      name: "medication_error_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "medication_error_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    foreignKey({
      name: "medication_error_administration_fk",
      columns: [t.tenantId, t.personId, t.administrationId],
      foreignColumns: [
        medicationAdministration.tenantId,
        medicationAdministration.personId,
        medicationAdministration.id,
      ],
    }),
    check(
      "medication_error_kinds",
      sql`kinds <@ ARRAY[${sql.raw(MEDICATION_ERROR_KIND_SQL)}]::text[] AND cardinality(kinds) <= 16`,
    ),
    check(
      "medication_error_stage",
      sql`stage IS NULL OR stage IN (${sql.raw(MEDICATION_ERROR_STAGE_SQL)})`,
    ),
    check("medication_error_reached", tri("reached_person")),
    check("medication_error_cd", tri("controlled_drug")),
    check("medication_error_deliberate", tri("deliberate_or_repeated")),
    check(
      "medication_error_text",
      sql`(immediate_actions IS NULL OR char_length(immediate_actions) <= 2000)
        AND (advice_given IS NULL OR char_length(advice_given) <= 2000)
        AND (root_cause IS NULL OR char_length(root_cause) <= 2000)
        AND (clinician_told IS NULL OR char_length(btrim(clinician_told)) BETWEEN 1 AND 2000)`,
    ),
    check(
      "medication_error_clinician",
      sql`(clinician_told_at IS NULL) = (clinician_told IS NULL)`,
    ),
    check(
      "medication_error_cd_report",
      sql`(cd_reported_on IS NULL) = (cd_report_reference IS NULL)
        AND (cd_report_reference IS NULL OR char_length(btrim(cd_report_reference)) BETWEEN 1 AND 120)
        AND (cd_reported_on IS NULL OR controlled_drug IS DISTINCT FROM 'no')`,
    ),
    check("medication_error_retention", sql`retention_class = 'serious_incident'`),
  ],
);

/** A medication review: scheduled, then done by a named clinician with the outcome in their words. */
export const medicationReview = pgTable(
  "medication_review",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    dueOn: date("due_on", { mode: "string" }).notNull(),
    doneOn: date("done_on", { mode: "string" }),
    clinicianName: text("clinician_name"),
    clinicianRole: text("clinician_role"),
    outcome: text("outcome"),
    recordedBy: uuid("recorded_by"),
    /** Why a done review was changed: required for any change once done. */
    correctionReason: text("correction_reason"),
    retentionClass: text("retention_class").notNull().default("mar_chart"),
    ...mutableColumns(),
  },
  (t) => [
    unique("medication_review_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medication_review_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "medication_review_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    check(
      "medication_review_done",
      sql`(done_on IS NULL) = (clinician_name IS NULL)
        AND (done_on IS NULL) = (clinician_role IS NULL)
        AND (done_on IS NULL) = (outcome IS NULL)
        AND (done_on IS NULL) = (recorded_by IS NULL)`,
    ),
    check(
      "medication_review_role",
      sql`clinician_role IS NULL OR clinician_role IN (${sql.raw(REVIEWER_ROLE_SQL)})`,
    ),
    check(
      "medication_review_text",
      sql`(clinician_name IS NULL OR char_length(btrim(clinician_name)) BETWEEN 1 AND 200)
        AND (outcome IS NULL OR char_length(btrim(outcome)) BETWEEN 1 AND 4000)
        AND (correction_reason IS NULL OR char_length(btrim(correction_reason)) BETWEEN 1 AND 500)`,
    ),
    check("medication_review_retention", sql`retention_class = 'mar_chart'`),
  ],
);
