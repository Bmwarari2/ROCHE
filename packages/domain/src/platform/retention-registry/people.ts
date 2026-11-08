/**
 * Retention registry: the people context (retention sweeps plan, slice 2). A person and their
 * contacts take enquiry_not_assessed while at enquiry, and pre_admission_not_admitted when an
 * assessment closed without admission (H-39); everyone else's records are care_record.
 */

import {
  byValue,
  type ClassList,
  careEndedOf,
  classes,
  col,
  entry,
  lookup,
  NO_SUBJECT,
  PARENT,
  parentIs,
  person,
  personRecord,
  type RegistryContext,
  type RegistryRetention,
  staff,
} from "./registry";

const NOT_ASSESSED: ClassList = ["enquiry_not_assessed"];
const NOT_ADMITTED: ClassList = ["pre_admission_not_admitted"];
/**
 * A person closed without admission (`not_admitted`) had an enquiry, perhaps an assessment too:
 * until the sweep tells them apart, both classes apply and the longer wins (DPO to confirm).
 */
const CLOSED_UNADMITTED: ClassList = ["enquiry_not_assessed", "pre_admission_not_admitted"];

/** The person's or contact's class, by the person's `status`. */
const byPersonStatus = (key: string | null): RegistryRetention =>
  byValue(
    "status",
    { enquiry: NOT_ASSESSED, pre_admission: NOT_ADMITTED, not_admitted: CLOSED_UNADMITTED },
    { otherwise: ["care_record"], ...(key ? { through: { table: "person", key } } : {}) },
  );

/** A pre-admission record: pre_admission_not_admitted unless the person was admitted. */
const byAdmission: RegistryRetention = byValue(
  "status",
  { enquiry: NOT_ADMITTED, pre_admission: NOT_ADMITTED, not_admitted: NOT_ADMITTED },
  { otherwise: ["care_record"], through: { table: "person", key: "person_id" } },
);

const enquiryClosed = lookup("person", "person_id", "status_changed_at");

const CATALOGUE_ONLY =
  "retention.md has no mapping row: the class is the export catalogue's, for the DPO to confirm";

export const PEOPLE_REGISTRY: RegistryContext = {
  context: "people",
  entries: [
    entry(
      "person",
      byPersonStatus(null),
      { careEnded: careEndedOf("id"), closedAt: col("status_changed_at") },
      person("id"),
      {
        provisional: ["H-39", "DPO decision"],
        note: "Destroyed last: every record about the person refers to it. An enquiry closes when the status moves to not_admitted (status_changed_at)",
      },
    ),
    entry(
      "contact",
      byPersonStatus("person_id"),
      { careEnded: careEndedOf("person_id"), closedAt: PARENT },
      person("person_id"),
      { parent: parentIs("person", "person_id"), provisional: ["H-39"] },
    ),
    ...(["pre_admission_assessment", "admission_decision", "admission_condition"] as const).map(
      (table) =>
        entry(
          table,
          byAdmission,
          { careEnded: careEndedOf("person_id"), closedAt: enquiryClosed },
          person("person_id"),
          { provisional: ["H-39"] },
        ),
    ),
    ...(
      [
        "about_me",
        "about_me_share_link",
        "allergy",
        "bed_occupancy",
        "care_plan_change",
        "exit_checklist_item",
        "exit_record",
        "hospital_transfer",
        "key_issue",
        "placement",
        "property_item",
        "review_record",
        "sharing_decision",
        "sharing_decision_suspension",
        "welcome_checklist_item",
      ] as const
    ).map((table) => personRecord(table, "care_record")),
    personRecord("person_assignment", "care_record", {
      otherSubjects: [staff("tenant_user_id")],
      note: CATALOGUE_ONLY,
    }),
    entry(
      "break_glass_event",
      classes("audit_event"),
      { createdAt: col("opened_at") },
      staff("tenant_user_id"),
      {
        otherSubjects: [person("person_id")],
      },
    ),
    entry(
      "break_glass_weekly_report",
      classes("audit_event"),
      { createdAt: col("generated_at") },
      NO_SUBJECT,
    ),
  ],
};
