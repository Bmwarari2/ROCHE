/**
 * Test support for variable doses: an invented warfarin entry for Ada Example, dosed at 18:00 from
 * the anticoagulant clinic's dosing record, and that record (all invented).
 */

import type { DosingRecordDraft } from "../src/medicines/dosing-record";
import type { MarEntry } from "../src/medicines/mar-entry";
import { entry, PERSON, PRODUCT, UNIT } from "./medicines-fixtures";

export const WARFARIN: MarEntry = entry(
  {
    product: PRODUCT.warfarin,
    indication: "Atrial fibrillation",
    directions: {
      kind: "regular",
      schedule: {
        pattern: { kind: "every_day" },
        times: [{ time: "18:00", dose: { kind: "variable", unit: UNIT.mg } }],
      },
    },
  },
  "entry-warf",
);

export const CLINIC_RECORD: DosingRecordDraft = {
  personId: PERSON,
  entryId: "entry-warf",
  source: {
    kind: "clinic_letter",
    reference: "Anticoagulant clinic dosing record, 01/11/2026",
    documentId: "document-inr",
  },
  doses: [
    { date: "2026-11-02", time: "18:00", quantity: 3 },
    { date: "2026-11-03", time: "18:00", quantity: 2.5 },
  ],
};
