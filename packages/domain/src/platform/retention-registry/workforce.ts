/**
 * Retention registry: the workforce context (retention sweeps plan, slice 3). Staff files follow
 * the organisation's chosen staff file row (`staff_file`, resolved by `resolveRule`); training
 * from completion; applicants from the closing of their last application, redacted rather than
 * deleted (workforce.md); sponsor records from the later of sponsorship and employment ending.
 */

import {
  applicant,
  childOf,
  classes,
  clearColumns,
  col,
  derived,
  entry,
  latestChild,
  leavingOf,
  lookup,
  NO_SUBJECT,
  PARENT,
  parentIs,
  type RegistryContext,
  rowClass,
  staff,
  staffFileRecord,
} from "./registry";

const BY_PROFILE = [
  "care_certificate_progress",
  "compliance_item",
  "induction_plan",
  "leaver_record",
  "probation_review",
  "reference_request",
  "shadow_shift",
  "staff_checklist_item",
  "vetting_check",
  "vetting_consent",
] as const;

const BY_MEMBER = ["ldss_claim", "staff_image_consent", "staff_privacy_acknowledgement"] as const;

const training = (table: string, created: string) =>
  entry(table, classes("training_record"), { createdAt: col(created) }, staff("worker_id"));

export const WORKFORCE_REGISTRY: RegistryContext = {
  context: "workforce",
  entries: [
    staffFileRecord("staff_profile", "id", "staff_profile", { subject: staff("tenant_user_id") }),
    ...BY_PROFILE.map((table) => staffFileRecord(table, "staff_profile_id", "staff_profile")),
    ...BY_MEMBER.map((table) => staffFileRecord(table, "tenant_user_id", "tenant_user")),
    staffFileRecord("supervision_record", "worker_id", "tenant_user"),
    childOf("supervision_note", "supervision_record", "supervision_id", staff("worker_id")),
    entry(
      "employee_case",
      rowClass("retention_class", "staff_file", "casework_no_sanction"),
      {
        employmentEndedAt: leavingOf("subject_tenant_user_id", "tenant_user"),
        closedAt: col("closed_on"),
      },
      staff("subject_tenant_user_id"),
      {
        note: "Restricted silo: destruction batches reach it as the system; certificates carry ids only",
      },
    ),
    childOf("employee_case_event", "employee_case", "case_id", staff(null)),
    childOf("employee_case_hearing", "employee_case", "case_id", staff(null)),
    childOf("employee_case_member", "employee_case", "case_id", staff(null), {
      otherSubjects: [staff("tenant_user_id")],
    }),
    entry(
      "casework_support_ticket",
      classes("staff_file"),
      { employmentEndedAt: PARENT },
      staff(null),
      {
        parent: parentIs("employee_case", "case_id"),
        note: "Follows the staff file of the member the case is about (H-804)",
      },
    ),

    training("training_record", "completed_on"),
    training("competence_sign_off", "observed_on"),
    training("revalidation_evidence", "created_at"),
    training("elearning_attempt", "finished_at"),
    entry(
      "competence_withdrawal",
      classes("training_record"),
      { createdAt: col("created_at") },
      staff(null),
      {
        parent: parentIs("competence_sign_off", "sign_off_id"),
      },
    ),
    childOf("elearning_statement", "elearning_attempt", "attempt_id", staff(null)),
    entry("lms_import", classes("audit_event"), { createdAt: col("uploaded_at") }, NO_SUBJECT, {
      provisional: ["H-1558"],
    }),
    entry(
      "lms_import_row",
      {
        kind: "not_retained",
        removedBy:
          "no sweep yet: plan slice 13 expires it as the import-expiry sweep does import_row",
        rateKey: "import.staging_expiry_days",
        at: lookup("lms_import", "import_id", "uploaded_at"),
      },
      {},
      staff("worker_id"),
      { parent: parentIs("lms_import", "import_id"), provisional: ["H-1558"] },
    ),
    entry(
      "lms_learner_link",
      classes("training_record"),
      {
        createdAt: derived(
          "the latest completion of the member's training records from this source",
          "worker_id",
          "source_id",
        ),
      },
      staff("worker_id"),
      { provisional: ["H-1558", "H-1584"] },
    ),

    entry(
      "applicant",
      classes("applicant.unsuccessful"),
      { closedAt: latestChild("application", "applicant_id", "closed_on") },
      applicant("id"),
      {
        method: clearColumns("given_name", "family_name", "email", "phone"),
        note: "Redacted (redacted_at), not deleted. applicant.talent_pool applies instead when later (talent_pool_until); a hired applicant's records follow the staff file",
      },
    ),
    entry(
      "application",
      classes("applicant.unsuccessful"),
      { closedAt: col("closed_on") },
      applicant("applicant_id"),
      {
        parent: parentIs("applicant", "applicant_id"),
      },
    ),
    childOf("application_event", "application", "application_id", applicant(null)),
    childOf("interview", "application", "application_id", applicant(null)),
    childOf("job_offer", "application", "application_id", applicant(null)),
    entry(
      "equality_monitoring",
      classes("applicant.unsuccessful"),
      { closedAt: lookup("vacancy", "vacancy_id", "closes_on") },
      NO_SUBJECT,
      { note: "Anonymous: from the vacancy's closing date" },
    ),

    entry(
      "sponsored_worker",
      classes("sponsor_record"),
      {
        closedAt: derived(
          "the later of ended_on and the member's leaving date",
          "ended_on",
          "tenant_user_id",
        ),
      },
      staff("tenant_user_id"),
      { provisional: ["H-901"] },
    ),
    ...(["sponsor_absence", "sponsor_report"] as const).map((table) =>
      entry(table, classes("sponsor_record"), { closedAt: PARENT }, staff(null), {
        parent: parentIs("sponsored_worker", "sponsored_worker_id"),
      }),
    ),
  ],
};
