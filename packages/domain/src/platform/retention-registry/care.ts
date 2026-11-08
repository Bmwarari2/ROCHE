/**
 * Retention registry: the care context (retention sweeps plan, slice 2). Care records are kept
 * from when the person's care ended (care_record); Care mode device records are audit
 * evidence (audit_event); a handover is kept as long as the care records it lists.
 */

import {
  AS_PARENT,
  children,
  classes,
  col,
  entry,
  NO_SUBJECT,
  parentIs,
  personRecord,
  type RegistryContext,
  staff,
} from "./registry";

const deviceAudit = (table: string) =>
  entry(
    table,
    classes("audit_event"),
    { createdAt: col("created_at") },
    staff("owner_tenant_user_id"),
  );

export const CARE_REGISTRY: RegistryContext = {
  context: "care",
  entries: [
    ...(
      [
        "activity_record",
        "advance_care_record",
        "assessment",
        "best_interests_decision",
        "body_map_mark",
        "capacity_assessment",
        "care_note",
        "care_plan",
        "care_plan_action",
        "care_plan_section",
        "consent_record",
        "dependency_assessment",
        "dols_authorisation",
        "dols_legal_change_review",
        "observation",
        "person_care_profile",
        "risk_assessment",
        "visit_log",
      ] as const
    ).map((table) => personRecord(table, "care_record")),
    personRecord("entry_device_deletion_flag", "care_record", {
      otherSubjects: [staff("owner_tenant_user_id")],
      note: "care_record, as the entry it flags",
    }),
    personRecord("refused_entry", "care_record", {
      otherSubjects: [staff("author_tenant_user_id")],
    }),
    deviceAudit("device_discard_entry"),
    deviceAudit("device_discard_record"),
    deviceAudit("handed_over_entry"),
    entry(
      "handover",
      classes("care_record"),
      { careEnded: children("handover_item", "handover_id") },
      NO_SUBJECT,
      {
        note: "Kept as long as the care records it lists: from the latest care end among its items",
      },
    ),
    personRecord("handover_item", "care_record", { parent: parentIs("handover", "handover_id") }),
    personRecord("handover_note", "care_record", { parent: parentIs("handover", "handover_id") }),
    entry("handover_acknowledgement", AS_PARENT, {}, staff("tenant_user_id"), {
      parent: parentIs("handover", "handover_id"),
    }),
  ],
};
