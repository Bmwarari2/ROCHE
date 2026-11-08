/**
 * Retention registry: the medicines context (retention sweeps plan, slice 3). A person's
 * medicines record is mar_chart, from when their care ended; the controlled drugs register from
 * the last entry on the page, an administration keeping mar_chart too (longest wins); stock,
 * disposal, order and temperature logs from the entry (provisional, H-1558).
 */

import {
  byValue,
  careEndedOf,
  classes,
  col,
  entry,
  latestChild,
  NO_SUBJECT,
  PARENT,
  parentIs,
  person,
  personRecord,
  type RegistryContext,
  rowClass,
  staff,
} from "./registry";

const MAR_CHART = [
  "medication",
  "medication_schedule",
  "medication_administration",
  "medication_administration_witness",
  "medication_dosing_record",
  "medication_administration_conflict",
  "medication_reconciliation",
  "medication_reconciliation_source",
  "medication_reconciliation_item",
  "medication_reconciliation_decision",
  "covert_medication_record",
  "self_administration_assessment",
  "homely_remedy_administration",
  "prn_protocol",
  "prn_outcome",
] as const;

const cdPage = parentIs("controlled_drug_page", "page_id");

export const MEDICINES_REGISTRY: RegistryContext = {
  context: "medicines",
  entries: [
    ...MAR_CHART.map((table) => personRecord(table, "mar_chart")),
    personRecord("medication_review", "mar_chart", {
      retention: rowClass("retention_class", "mar_chart"),
    }),
    personRecord("medication_error", "serious_incident", {
      retention: rowClass("retention_class", "care_record", "serious_incident"),
      facts: { careEnded: careEndedOf("person_id"), closedAt: PARENT },
      parent: parentIs("incident", "incident_id"),
      note: "Kept with its incident, by the incident's class",
    }),

    entry(
      "controlled_drug_page",
      classes("controlled_drugs_register"),
      { entryDates: latestChild("controlled_drug_entry", "page_id", "occurred_at") },
      person("person_id"),
    ),
    entry(
      "controlled_drug_entry",
      byValue(
        "movement",
        { administration: ["controlled_drugs_register", "mar_chart"] },
        { otherwise: ["controlled_drugs_register"] },
      ),
      { entryDates: PARENT, careEnded: careEndedOf("person_id") },
      person("person_id"),
      { parent: cdPage, otherSubjects: [staff("recorded_by")] },
    ),
    entry(
      "controlled_drug_stock_check",
      classes("controlled_drugs_register"),
      { entryDates: PARENT },
      person("person_id"),
      { parent: cdPage },
    ),
    entry(
      "controlled_drug_witness_assertion",
      classes("controlled_drugs_register"),
      { entryDates: col("expires_at") },
      person("person_id"),
      { parent: cdPage, otherSubjects: [staff("witness_id")], note: "A short-lived witness token" },
    ),

    entry(
      "medicine_stock_item",
      classes("medicines_stock_log"),
      { createdAt: col("opened_at") },
      person("person_id"),
      { provisional: ["H-1558"] },
    ),
    entry(
      "medicine_stock_movement",
      classes("medicines_stock_log"),
      { createdAt: col("recorded_at") },
      person("person_id"),
      {
        parent: parentIs("medicine_stock_item", "item_id"),
        provisional: ["H-1558"],
        note: "The administration a movement records keeps mar_chart in its own table",
      },
    ),
    entry(
      "medicine_disposal",
      classes("medicines_disposal_log"),
      { createdAt: col("recorded_at") },
      person("person_id"),
      { provisional: ["H-1558"] },
    ),
    entry(
      "medicine_temperature_reading",
      classes("temperature_log"),
      { createdAt: col("recorded_at") },
      NO_SUBJECT,
      { provisional: ["H-1558"] },
    ),
    entry(
      "medicine_order",
      classes("medicines_stock_log"),
      { createdAt: col("submitted_at") },
      NO_SUBJECT,
      {
        provisional: ["H-1558"],
      },
    ),
    entry(
      "medicine_order_line",
      classes("medicines_stock_log"),
      { createdAt: col("created_at") },
      person("person_id"),
      { parent: parentIs("medicine_order", "order_id"), provisional: ["H-1558"] },
    ),
  ],
};
