import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";

/**
 * The staff profile and pre-employment file (workforce.md section 2a; WORK-002, WORK-011; plan
 * slice 11, migration 0073). One profile per member of staff, and one compliance item per Schedule
 * 3 requirement. Whether an item is satisfied is never stored: `staffFileState` in packages/domain
 * works it out from the details on the day asked about. Read by holders of
 * `workforce.staff_file.read` (or the worker themselves with `workforce.self.read`), written by
 * holders of `workforce.staff_file.manage`, never by the worker; the DBS risk assessment is signed
 * only by a holder of `workforce.dbs_risk_assessment.sign`. The database enforces the same.
 */

/** `SCHEDULE3_ITEMS` in packages/domain, kept in step by test/staff-file.test.ts. */
export const COMPLIANCE_ITEM_KINDS = [
  "identity_with_photo",
  "dbs_certificate",
  "conduct_in_care_work",
  "references",
  "relevant_qualifications",
  "employment_history",
  "health_fitness",
  "right_to_work",
  "professional_registration",
] as const;

/** Professional registers a role may need (`RoleRegistration` in packages/domain). */
export const REGISTRATION_BODIES = ["nmc", "hcpc", "swe", "gmc"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

export const staffProfile = pgTable(
  "staff_profile",
  {
    id: id(),
    tenantId: tenantId(),
    /** The member of staff the file is about. */
    tenantUserId: uuid("tenant_user_id").notNull(),
    /** Where they mainly work; null for organisation-wide roles. */
    locationId: uuid("location_id"),
    jobTitle: text("job_title").notNull(),
    /** Care Workforce Pathway role category, as the organisation names it. */
    pathwayCategory: text("pathway_category"),
    /** The register the role needs (`REGISTRATION_BODIES`), adding professional registration. */
    registrationBody: text("registration_body"),
    /** Has worked in health or social care before (adds conduct evidence; Schedule 3 para 4). */
    previousCareWork: boolean("previous_care_work").notNull().default(false),
    /** For the `staff_file.to_75th_birthday` retention row and the under-18 working time rules. */
    dateOfBirth: date("date_of_birth"),
    startsOn: date("starts_on"),
    leftOn: date("left_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("staff_profile_tenant_id_id_key").on(t.tenantId, t.id),
    unique("staff_profile_member_key").on(t.tenantId, t.tenantUserId),
    staffRef("staff_profile_tenant_user_fk", t, t.tenantUserId),
    foreignKey({
      name: "staff_profile_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check(
      "staff_profile_registration_body",
      sql`registration_body IS NULL OR registration_body IN (${sqlList(REGISTRATION_BODIES)})`,
    ),
    check("staff_profile_job_title", sql`length(btrim(job_title)) BETWEEN 2 AND 120`),
    check(
      "staff_profile_left_after_start",
      sql`left_on IS NULL OR starts_on IS NULL OR left_on >= starts_on`,
    ),
  ],
);

export const complianceItem = pgTable(
  "compliance_item",
  {
    id: id(),
    tenantId: tenantId(),
    staffProfileId: uuid("staff_profile_id").notNull(),
    /** One of `COMPLIANCE_ITEM_KINDS`. */
    kind: text("kind").notNull(),
    /** `ComplianceDetail` for the kind, as JSON (checked by the API with the kind's schema). */
    detail: jsonb("detail").notNull(),
    /** The UK date the evidence was seen, and who saw it (never the worker). */
    verifiedOn: date("verified_on"),
    verifiedBy: uuid("verified_by"),
    /** DBS only: the risk assessment, signed by a holder of the sign permission (not the worker). */
    riskAssessmentSignedOn: date("risk_assessment_signed_on"),
    riskAssessmentSignedBy: uuid("risk_assessment_signed_by"),
    /** Worked out from the details by the API when the item is saved, for the reminder sweep. */
    expiresOn: date("expires_on"),
    recheckDueOn: date("recheck_due_on"),
    ...mutableColumns(),
  },
  (t) => [
    unique("compliance_item_tenant_id_id_key").on(t.tenantId, t.id),
    unique("compliance_item_kind_key").on(t.tenantId, t.staffProfileId, t.kind),
    foreignKey({
      name: "compliance_item_profile_fk",
      columns: [t.tenantId, t.staffProfileId],
      foreignColumns: [staffProfile.tenantId, staffProfile.id],
    }),
    staffRef("compliance_item_verified_by_fk", t, t.verifiedBy),
    staffRef("compliance_item_risk_assessment_signed_by_fk", t, t.riskAssessmentSignedBy),
    index("compliance_item_reminder_idx").on(t.tenantId, t.expiresOn, t.recheckDueOn),
    check("compliance_item_kind", sql`kind IN (${sqlList(COMPLIANCE_ITEM_KINDS)})`),
    check(
      "compliance_item_detail",
      sql`jsonb_typeof(detail) = 'object' AND detail->>'kind' = kind`,
    ),
    check("compliance_item_verified", sql`(verified_on IS NULL) = (verified_by IS NULL)`),
    check(
      "compliance_item_risk_assessment",
      sql`(risk_assessment_signed_on IS NULL) = (risk_assessment_signed_by IS NULL)
        AND (risk_assessment_signed_on IS NULL OR kind = 'dbs_certificate')`,
    ),
  ],
);
