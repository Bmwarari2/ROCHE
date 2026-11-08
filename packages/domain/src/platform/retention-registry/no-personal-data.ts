/**
 * Tables known to hold no personal data, so they need no retention registry entry (retention
 * sweeps plan, section 3.1, and the Phase 0 and 1 configuration). Every other table in
 * `packages/db/src/schema` needs an entry: `packages/db/src/retention-registry.test.ts` fails
 * otherwise. Member ids in `*_by` columns are accountability evidence and follow the record
 * (plan 3.1); a table the export catalogue marks `personal` is never listed here.
 */

import type { NoPersonalDataTable } from "./registry";

const REFERENCE = "Global reference data, the same for every organisation";
const CONFIGURATION =
  "Organisation configuration, kept while current; member ids only as accountability";
const ORGANISATION_DOCUMENT =
  "Organisation material (organisation_document, the organisation's own policy), about no person";
const ACCOUNTABILITY =
  "The organisation's own record, naming members only as accountability (interim audit_event)";
const PLUMBING = "Delivery or sync plumbing: opaque ids, codes and times";

const list = (reason: string, ...tables: string[]): NoPersonalDataTable[] =>
  tables.map((table) => ({ table, reason }));

export const NO_PERSONAL_DATA: readonly NoPersonalDataTable[] = [
  ...list(
    REFERENCE,
    "bank_holiday",
    "dmd_amp",
    "dmd_ampp",
    "dmd_gtin",
    "dmd_lookup",
    "dmd_release",
    "dmd_vmp",
    "dmd_vmpp",
    "dmd_vtm",
    "framework_evidence_category",
    "framework_key_question",
    "framework_statement",
    "framework_version",
    "ipc_code_criterion",
    "audit_starter_template",
  ),
  ...list(
    CONFIGURATION,
    "agency",
    "audit_schedule",
    "clock_setting",
    "discard_reason",
    "escalation_chain",
    "escalation_policy_link",
    "feature_flag",
    "form_template",
    "framework_mapping",
    "hr_location_link",
    "hr_pay_period",
    "integration_connection",
    "lms_course_map",
    "lms_source",
    "location",
    "medicine_order_cycle",
    "medicine_storage",
    "pay_rule_set",
    "payroll_connection",
    "pulse_survey",
    "rate_table",
    "retention_class",
    "role",
    "room",
    "service",
    "shift_pattern",
    "shift_template",
    "sso_connection",
    "sso_domain",
    "staff_team",
    "tenant_group",
    "training_requirement",
    "welcome_checklist_template",
  ),
  ...list(
    ORGANISATION_DOCUMENT,
    "audit_template",
    "dependency_scale",
    "elearning_course",
    "job_template",
    "letter_template",
    "medicine_list_item",
    "policy",
    "quality_indicator_target",
    "vacancy",
  ),
  ...list(
    ACCOUNTABILITY,
    "dcb0160_record",
    "dspt_assertion",
    "dspt_evidence",
    "dspt_submission",
    "retention_decision",
    "sample_batch",
    "security_certificate",
    "sub_processor_notice",
    "sub_processor_response",
    "tenant_export",
    "tenant_setting_decision",
  ),
  ...list(PLUMBING, "hr_delivery", "hr_sync_state", "outbox_event"),
  {
    table: "homely_remedy_protocol",
    reason:
      "A location's homely remedy protocol (configuration); retention.md maps it to mar_chart, whose trigger never fires for it",
  },
  {
    table: "tenant_shred_request",
    reason: "Kept permanently as proof of the whole-organisation shred (plan 3.1)",
  },
  {
    table: "pulse_survey_response_pending",
    reason: "Answers held until the survey closes, then released without the person (plan 3.1)",
  },
  {
    table: "retention_report",
    reason: "The retention sweep's report: counts per table and class, no record id or subject",
  },
  {
    table: "speak_up_intake",
    reason: "Rate-limit windows of the public speak-up form: counts only, swept hourly",
  },
  {
    table: "evidence_pack_link_code",
    reason: "Hashed one-time codes of an evidence pack link, which go with the link",
  },
  { table: "auth.sso_provider", reason: "An organisation's single sign-on provider configuration" },
];
