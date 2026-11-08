/**
 * Retention registry: the platform context and the sign-in (`auth`) schema (retention sweeps
 * plan, slice 2). Classes from docs/specs/retention.md, "Mapping of tables to record classes".
 */

import {
  AS_PARENT,
  asLinked,
  careEndedOf,
  childOf,
  classes,
  col,
  derived,
  entry,
  leavingOf,
  NEVER,
  NO_SUBJECT,
  ofRecord,
  PARENT,
  PERMANENT,
  parentIs,
  person,
  type RegistryContext,
  rowClass,
  staff,
  WHILE_CURRENT,
} from "./registry";

/** Values `document.retention_class` takes (DOCUMENT_CATEGORIES and the HR document routes). */
const DOCUMENT_CLASSES = [
  "care_record",
  "organisation_document",
  "staff_file",
  "training_record",
  "serious_incident",
  "right_to_work_copy",
  "sickness_absence",
] as const;

const CATALOGUE_ONLY =
  "retention.md has no mapping row: the class is the export catalogue's, for the DPO to confirm";

export const PLATFORM_REGISTRY: RegistryContext = {
  context: "platform",
  entries: [
    entry(
      "access_grant",
      classes("audit_event"),
      { createdAt: col("created_at") },
      staff("tenant_user_id"),
      {
        note: CATALOGUE_ONLY,
      },
    ),
    entry(
      "audit_event",
      classes("audit_event"),
      { createdAt: col("occurred_at") },
      staff("actor_tenant_user_id"),
      {
        provisional: ["H-1559"],
        note: "audit_event.care_record extends events about a person's record (longest wins). Not destroyed before the chain-aware design of plan slice 14 (H-1559)",
      },
    ),
    entry("destruction_certificate", PERMANENT, {}, NO_SUBJECT, { method: NEVER }),
    entry(
      "device_binding",
      classes("audit_event"),
      { createdAt: col("created_at") },
      staff("tenant_user_id"),
    ),
    entry(
      "device_session",
      classes("audit_event"),
      { createdAt: col("created_at") },
      staff("tenant_user_id"),
      {
        parent: parentIs("device_binding", "device_id"),
      },
    ),
    entry(
      "document",
      rowClass("retention_class", ...DOCUMENT_CLASSES),
      {
        careEnded: careEndedOf("person_id"),
        createdAt: col("created_at"),
        employmentEndedAt: leavingOf("subject_id", "tenant_user"),
        closedAt: ofRecord("subject_type", "subject_id"),
      },
      person("person_id"),
      {
        otherSubjects: [staff("subject_id")],
        note: "Stored versions deleted object by object (ADR-0109). Right to work copies close with the employment, fit notes with their absence (provisional, H-1584)",
        provisional: ["H-1584"],
      },
    ),
    childOf("document_signature", "document", "document_id", person("person_id"), {
      otherSubjects: [staff("signer_tenant_user_id")],
    }),
    entry("dp_breach", classes("dp_breach"), { closedAt: col("closed_at") }, NO_SUBJECT),
    entry(
      "dp_complaint",
      classes("data_rights_case"),
      { closedAt: col("closed_on") },
      person("person_id"),
    ),
    entry(
      "dsar_case",
      classes("data_rights_case"),
      {
        closedAt: derived(
          "responded_on; a withdrawn case, the time of its withdrawal's audit event (provisional, H-1584)",
          "responded_on",
          "status",
        ),
      },
      person("subject_person_id"),
      {
        otherSubjects: [staff("subject_staff_id")],
        provisional: ["H-1584"],
        note: "The bundle under dsar/ in the exports bucket is destroyed with the case",
      },
    ),
    entry(
      "dpia",
      classes("dpia"),
      {
        closedAt: derived(
          "the signing of the next version, which supersedes it",
          "dpia_version",
          "signed_at",
        ),
      },
      NO_SUBJECT,
      {
        provisional: ["H-115"],
        note: "Names its preparer and signer (typed_name) as accountability",
      },
    ),
    entry("dsar_item", classes("data_rights_case"), { closedAt: PARENT }, person(null), {
      parent: parentIs("dsar_case", "case_id"),
    }),
    entry("form_submission", asLinked("subject_type", "subject_id"), {}, NO_SUBJECT, {
      note: CATALOGUE_ONLY,
    }),
    entry("import_batch", classes("audit_event"), { createdAt: col("uploaded_at") }, NO_SUBJECT),
    entry("import_commit", classes("audit_event"), { createdAt: col("committed_at") }, NO_SUBJECT, {
      parent: parentIs("import_batch", "batch_id"),
    }),
    entry(
      "import_row",
      {
        kind: "not_retained",
        removedBy: "the hourly import-expiry sweep, and the commit or discard of its batch",
        rateKey: "import.staging_expiry_days",
        at: PARENT,
      },
      {},
      NO_SUBJECT,
      { parent: parentIs("import_batch", "batch_id") },
    ),
    entry(
      "invitation",
      classes("invitation"),
      { createdAt: col("created_at") },
      staff("tenant_user_id"),
      {
        note: "The address is cleared when the invitation closes (invitation-sweep)",
      },
    ),
    entry("legal_hold", PERMANENT, {}, person("person_id"), { method: NEVER }),
    entry(
      "notification",
      asLinked("source_type", "source_id"),
      {},
      staff("recipient_tenant_user_id"),
      { otherSubjects: [person("person_id")], note: CATALOGUE_ONLY },
    ),
    entry("notification_preference", WHILE_CURRENT, {}, staff("tenant_user_id"), {
      method: NEVER,
      provisional: ["DPO decision"],
      note: "A member's alert settings: no class in retention.md; kept while the membership lasts",
    }),
    entry("operator_user", WHILE_CURRENT, {}, NO_SUBJECT, {
      method: NEVER,
      provisional: ["DPO decision"],
      note: "A Thapsus operator, not an organisation's record: no class in retention.md",
    }),
    entry("processor_breach_notice", classes("dp_breach"), { closedAt: PARENT }, NO_SUBJECT, {
      parent: parentIs("dp_breach", "breach_id"),
      note: "breach_id refers to the organisation's register entry, so the notice closes with it",
    }),
    entry("processor_breach_notice_ack", AS_PARENT, {}, NO_SUBJECT, {
      parent: parentIs("processor_breach_notice", "notice_id"),
      otherSubjects: [staff("acknowledged_by")],
    }),
    entry("record_version", asLinked("table_name", "record_id"), {}, NO_SUBJECT, {
      note: "Deleted with the record it copies (plan 5.6 step 2)",
    }),
    entry(
      "request_quota",
      {
        kind: "not_retained",
        removedBy: "rewritten in place for each limit window; no sweep deletes a member's rows",
        rateKey: null,
        at: col("updated_at"),
      },
      {},
      staff("tenant_user_id"),
      { provisional: ["DPO decision"] },
    ),
    entry(
      "role_assignment",
      classes("audit_event"),
      { createdAt: col("created_at") },
      staff("tenant_user_id"),
      {
        note: CATALOGUE_ONLY,
      },
    ),
    entry("signature_request", AS_PARENT, {}, staff("signer_tenant_user_id"), {
      parent: parentIs("document", "document_id"),
    }),
    entry(
      "support_access_request",
      classes("audit_event"),
      { createdAt: col("requested_at") },
      NO_SUBJECT,
      { note: CATALOGUE_ONLY },
    ),
    entry(
      "task",
      asLinked("source_type", "source_id", "care_record"),
      { careEnded: careEndedOf("person_id") },
      person("person_id"),
      { otherSubjects: [staff("assignee_tenant_user_id")] },
    ),
    entry(
      "task_series",
      asLinked("source_type", "source_id", "care_record"),
      { careEnded: careEndedOf("person_id") },
      person("person_id"),
      { otherSubjects: [staff("assignee_tenant_user_id")] },
    ),
    entry("tenant", WHILE_CURRENT, {}, NO_SUBJECT, {
      method: NEVER,
      provisional: ["DPO decision"],
      note: "Names and addresses of the organisation's officers (DPO, Caldicott guardian, SIRO): no class in retention.md; kept while the organisation is a customer",
    }),
    entry("tenant_user", WHILE_CURRENT, {}, staff("id"), {
      method: NEVER,
      provisional: ["DPO decision"],
      note: "The membership (name, email): no class in retention.md; every record naming the member refers to it, so it outlasts them; the sign-in is erased separately (H-566)",
    }),
    entry(
      "workflow_instance",
      asLinked("subject_type", "subject_id", "care_record"),
      { careEnded: careEndedOf("person_id") },
      person("person_id"),
    ),
    childOf("workflow_transition", "workflow_instance", "instance_id", person("person_id")),

    // The sign-in schema (Better Auth): not an organisation's record. Removed with the sign-in
    // or at expiry; retention.md has no class (DPO decision).
    entry(
      "auth.user",
      {
        kind: "not_retained",
        removedBy:
          "the sign-in erasure sweep, once the member's account deletion completes (H-566)",
        rateKey: null,
        at: derived("when the sign-in erasure of every membership is complete", "updated_at"),
      },
      {},
      staff("id"),
      { provisional: ["DPO decision"] },
    ),
    ...(["auth.account", "auth.passkey", "auth.two_factor"] as const).map((table) =>
      entry(
        table,
        { kind: "not_retained", removedBy: "deleted with its sign-in", rateKey: null, at: PARENT },
        {},
        staff("user_id"),
        { parent: parentIs("auth.user", "user_id"), provisional: ["DPO decision"] },
      ),
    ),
    entry(
      "auth.session",
      {
        kind: "not_retained",
        removedBy:
          "ends at expiry or sign-out, and for leavers in the leaver access sweep; no sweep deletes expired rows yet",
        rateKey: null,
        at: col("expires_at"),
      },
      {},
      staff("user_id"),
      { parent: parentIs("auth.user", "user_id"), provisional: ["DPO decision"] },
    ),
    entry(
      "auth.verification",
      {
        kind: "not_retained",
        removedBy: "ends at expiry; no sweep deletes expired rows yet",
        rateKey: null,
        at: col("expires_at"),
      },
      {},
      NO_SUBJECT,
      { provisional: ["DPO decision"] },
    ),
  ],
};
