import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { person, placement } from "./people";
import { hospitalTransfer } from "./people-lifecycle";
import { document, tenantUser } from "./platform";

/**
 * The medicines record and reconciliation (medicines.md section 2; MEDS-001; slice 16). The rules
 * are the slice 2 domain functions (`packages/domain/src/medicines`); the database enforces what
 * it can: one row per version, set-once columns for the check, stop, replacement and withdrawal
 * (trigger in migration 0111), structured doses and dm+d identifiers by shape. dm+d codes are
 * stored as validated identifiers with no foreign key to the reference tables yet: slice 10 adds
 * them, and an expand step adds the foreign keys then (medicines.md section 11).
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

const memberRef = (name: string, tenant: AnyPgColumn, member: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [tenant, member],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** dm+d identifiers: the SNOMED CT concept shape (6 to 18 digits); the check digit is the API's. */
const dmdShape = (column: string) => sql.raw(`${column} ~ '^[0-9]{6,18}$'`);

const SOURCE_KINDS =
  "'prescription','pharmacy_label','pharmacy_mar','discharge_letter','transfer_letter','gp_record','clinic_letter','prescriber_instruction','previous_mar'";

/**
 * One version of a MAR entry. A change is a new row (`replaces_id`, the next `version` of the same
 * `medicine_id`); the columns set later (check, stop, replacement, withdrawal) are set once each.
 */
export const medication = pgTable(
  "medication",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The first version's id: every version of one medicine shares it. */
    medicineId: uuid("medicine_id").notNull(),
    version: integer("version").notNull(),
    replacesId: uuid("replaces_id"),
    state: text("state").notNull().default("not_yet_checked"),
    origin: text("origin").notNull(),
    vmpId: text("vmp_id").notNull(),
    ampId: text("amp_id"),
    /** The dm+d description at transcription, shown as dm+d words it. */
    productName: text("product_name").notNull(),
    routeCode: text("route_code").notNull(),
    routeName: text("route_name").notNull(),
    directions: text("directions").notNull(),
    patternKind: text("pattern_kind"),
    intervalDays: integer("interval_days"),
    weekdays: text("weekdays").array(),
    intervalWeeks: integer("interval_weeks"),
    anchorOn: date("anchor_on"),
    dayOfMonth: integer("day_of_month"),
    /** The when-required dose (`Dose`: amount, range or variable, with its dm+d unit). */
    prnDose: jsonb("prn_dose"),
    indication: text("indication"),
    specialInstructions: text("special_instructions"),
    prescriber: text("prescriber").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    stopsAt: timestamp("stops_at", { withTimezone: true }),
    reviewOn: date("review_on"),
    sourceKind: text("source_kind").notNull(),
    sourceReference: text("source_reference").notNull(),
    sourceDocumentId: uuid("source_document_id"),
    transcribedBy: uuid("transcribed_by").notNull(),
    /** When it was recorded, as the rules were tried (the member's action, HZ-010). */
    transcribedAt: timestamp("transcribed_at", { withTimezone: true }).notNull(),
    checkBy: uuid("check_by"),
    checkAt: timestamp("check_at", { withTimezone: true }),
    checkOutcome: text("check_outcome"),
    checkDifference: text("check_difference"),
    stopBy: uuid("stop_by"),
    stopAt: timestamp("stop_at", { withTimezone: true }),
    stopEffectiveAt: timestamp("stop_effective_at", { withTimezone: true }),
    stopReason: text("stop_reason"),
    stopSourceKind: text("stop_source_kind"),
    stopSourceReference: text("stop_source_reference"),
    stopSourceDocumentId: uuid("stop_source_document_id"),
    replacedById: uuid("replaced_by_id"),
    replacedFrom: timestamp("replaced_from", { withTimezone: true }),
    reanchorBy: uuid("reanchor_by"),
    reanchorAt: timestamp("reanchor_at", { withTimezone: true }),
    reanchorReason: text("reanchor_reason"),
    withdrawnBy: uuid("withdrawn_by"),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnReason: text("withdrawn_reason"),
    correctedPartWayThrough: date("corrected_part_way_through"),
    earlierDosesDueOn: date("earlier_doses_due_on"),
    earlierDosesDueReason: text("earlier_doses_due_reason"),
    /** The controlled drug schedule from dm+d (slice 10); null until the reference data lands. */
    cdSchedule: text("cd_schedule"),
    reconciliationId: uuid("reconciliation_id"),
    /** The import batch (slice 51). */
    importBatchId: uuid("import_batch_id"),
    ...createdColumns(),
    /** When a set-once column was last set (the version number never changes on an update). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid("updated_by").default(sql`app.current_user_id()`),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("medication_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medication_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    unique("medication_medicine_version_key").on(t.tenantId, t.medicineId, t.version),
    personRef("medication_person_fk", t),
    // Every version of one medicine is for one person: the first version names the person.
    foreignKey({
      name: "medication_medicine_fk",
      columns: [t.tenantId, t.personId, t.medicineId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    foreignKey({
      name: "medication_replaces_fk",
      columns: [t.tenantId, t.personId, t.replacesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    foreignKey({
      name: "medication_replaced_by_fk",
      columns: [t.tenantId, t.personId, t.replacedById],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    foreignKey({
      name: "medication_source_document_fk",
      columns: [t.tenantId, t.sourceDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    foreignKey({
      name: "medication_stop_source_document_fk",
      columns: [t.tenantId, t.stopSourceDocumentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    memberRef("medication_transcribed_by_fk", t.tenantId, t.transcribedBy),
    memberRef("medication_check_by_fk", t.tenantId, t.checkBy),
    memberRef("medication_stop_by_fk", t.tenantId, t.stopBy),
    index("medication_person_idx").on(t.tenantId, t.personId, t.vmpId),
    index("medication_reconciliation_idx").on(t.tenantId, t.reconciliationId),
    check(
      "medication_state",
      sql`state IN ('not_yet_checked', 'checked', 'difference_found', 'stopped', 'replaced', 'withdrawn')`,
    ),
    check("medication_origin", sql`origin IN ('transcribed', 'reconciliation', 'import')`),
    check("medication_version", sql`version >= 1 AND (version = 1) = (replaces_id IS NULL)`),
    check("medication_first_version", sql`(version = 1) = (medicine_id = id)`),
    check("medication_vmp", dmdShape("vmp_id")),
    check("medication_amp", sql`amp_id IS NULL OR ${dmdShape("amp_id")}`),
    check("medication_product_name", sql`length(btrim(product_name)) > 0`),
    check("medication_route", sql`length(btrim(route_code)) > 0 AND length(btrim(route_name)) > 0`),
    check("medication_directions", sql`directions IN ('regular', 'when_required')`),
    // A regular entry has a pattern and times (medication_schedule); a when-required one a dose.
    check(
      "medication_pattern",
      sql`(directions = 'regular' AND prn_dose IS NULL AND (
            (pattern_kind = 'every_day')
         OR (pattern_kind = 'every_n_days' AND interval_days >= 2 AND anchor_on IS NOT NULL)
         OR (pattern_kind = 'weekly' AND interval_weeks >= 1 AND anchor_on IS NOT NULL
             AND cardinality(weekdays) BETWEEN 1 AND 7)
         OR (pattern_kind = 'monthly' AND day_of_month BETWEEN 1 AND 31)))
       OR (directions = 'when_required' AND pattern_kind IS NULL
           AND prn_dose ? 'kind' AND prn_dose->>'kind' IN ('amount', 'range', 'variable')
           AND length(btrim(coalesce(indication, ''))) > 0)`,
    ),
    check("medication_prescriber", sql`length(btrim(prescriber)) > 0`),
    check(
      "medication_source",
      sql.raw(`source_kind IN (${SOURCE_KINDS}) AND length(btrim(source_reference)) > 0`),
    ),
    check("medication_period", sql`stops_at IS NULL OR stops_at > starts_at`),
    check(
      "medication_check",
      sql`(check_by IS NULL AND check_at IS NULL AND check_outcome IS NULL AND check_difference IS NULL)
       OR (check_by IS NOT NULL AND check_at IS NOT NULL AND check_by <> transcribed_by
           AND ((check_outcome = 'matches_source' AND check_difference IS NULL)
             OR (check_outcome = 'differs_from_source' AND length(btrim(coalesce(check_difference, ''))) > 0)))`,
    ),
    check(
      "medication_stop",
      sql.raw(`(stop_by IS NULL AND stop_at IS NULL AND stop_effective_at IS NULL AND stop_reason IS NULL
           AND stop_source_kind IS NULL AND stop_source_reference IS NULL)
       OR (stop_by IS NOT NULL AND stop_at IS NOT NULL AND stop_effective_at >= stop_at
           AND length(btrim(coalesce(stop_reason, ''))) > 0
           AND stop_source_kind IN (${SOURCE_KINDS}) AND length(btrim(coalesce(stop_source_reference, ''))) > 0)`),
    ),
    check("medication_replaced", sql`(replaced_by_id IS NULL) = (replaced_from IS NULL)`),
    check(
      "medication_reanchor",
      sql`(reanchor_by IS NULL AND reanchor_at IS NULL AND reanchor_reason IS NULL)
       OR (reanchor_by IS NOT NULL AND reanchor_at IS NOT NULL AND length(btrim(coalesce(reanchor_reason, ''))) > 0)`,
    ),
    check(
      "medication_withdrawn",
      sql`(withdrawn_by IS NULL AND withdrawn_at IS NULL AND withdrawn_reason IS NULL)
       OR (withdrawn_by IS NOT NULL AND withdrawn_at IS NOT NULL AND length(btrim(coalesce(withdrawn_reason, ''))) > 0)`,
    ),
    check(
      "medication_earlier_doses",
      sql`(earlier_doses_due_on IS NULL) = (earlier_doses_due_reason IS NULL)
       AND (earlier_doses_due_reason IS NULL OR length(btrim(earlier_doses_due_reason)) > 0)`,
    ),
    // Each state needs the set-once column that defines it (a stop may sit beside a check, a
    // replacement or a not-yet-checked version that carried it over, rule 6b).
    check(
      "medication_state_matches",
      sql`CASE state
            WHEN 'withdrawn' THEN withdrawn_at IS NOT NULL
            WHEN 'replaced' THEN replaced_by_id IS NOT NULL AND withdrawn_at IS NULL
            WHEN 'stopped' THEN stop_at IS NOT NULL AND withdrawn_at IS NULL
            WHEN 'difference_found' THEN check_outcome = 'differs_from_source' AND withdrawn_at IS NULL
                 AND replaced_by_id IS NULL
            WHEN 'checked' THEN check_outcome = 'matches_source' AND withdrawn_at IS NULL
                 AND replaced_by_id IS NULL
            ELSE check_at IS NULL AND replaced_by_id IS NULL AND withdrawn_at IS NULL
          END`,
    ),
    check(
      "medication_origin_link",
      sql`(origin = 'reconciliation') = (reconciliation_id IS NOT NULL)`,
    ),
    check(
      "medication_cd_schedule",
      sql`cd_schedule IS NULL OR cd_schedule IN ('1', '2', '3', '4', '4.1', '4.2', '5')`,
    ),
  ],
);

/** One prescribed time of a regular entry and the dose due at it; written with its entry. */
export const medicationSchedule = pgTable(
  "medication_schedule",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    medicationId: uuid("medication_id").notNull(),
    position: integer("position").notNull(),
    /** HH:MM, 24-hour, UK time. */
    time: text("time").notNull(),
    doseKind: text("dose_kind").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    fromQuantity: numeric("from_quantity", { precision: 12, scale: 3 }),
    toQuantity: numeric("to_quantity", { precision: 12, scale: 3 }),
    unitCode: text("unit_code").notNull(),
    unitName: text("unit_name").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("medication_schedule_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medication_schedule_position_key").on(t.tenantId, t.medicationId, t.position),
    unique("medication_schedule_time_key").on(t.tenantId, t.medicationId, t.time),
    foreignKey({
      name: "medication_schedule_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    check("medication_schedule_time", sql`time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'`),
    check(
      "medication_schedule_dose",
      sql`(dose_kind = 'amount' AND quantity > 0 AND from_quantity IS NULL AND to_quantity IS NULL)
       OR (dose_kind = 'range' AND quantity IS NULL AND from_quantity > 0 AND to_quantity > from_quantity)
       OR (dose_kind = 'variable' AND quantity IS NULL AND from_quantity IS NULL AND to_quantity IS NULL)`,
    ),
    check(
      "medication_schedule_unit",
      sql`length(btrim(unit_code)) > 0 AND length(btrim(unit_name)) > 0`,
    ),
  ],
);

/** A reconciliation: open while decisions are made, then closed (rules 7 to 12). */
export const medicationReconciliation = pgTable(
  "medication_reconciliation",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    trigger: text("trigger").notNull(),
    /** The admission (placement) it answers. */
    placementId: uuid("placement_id"),
    /** The return from hospital it answers. */
    hospitalTransferId: uuid("hospital_transfer_id"),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    startedBy: uuid("started_by").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** The entries and versions to decide on when it began (`entriesToReconcile`). */
    entriesAtStart: jsonb("entries_at_start").notNull(),
    status: text("status").notNull().default("open"),
    completedBy: uuid("completed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    allergiesCompared: text("allergies_compared"),
    personInvolved: text("person_involved"),
    notInvolvedReason: text("not_involved_reason"),
    noDischargeLetterReason: text("no_discharge_letter_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("medication_reconciliation_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medication_reconciliation_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("medication_reconciliation_person_fk", t),
    foreignKey({
      name: "medication_reconciliation_placement_fk",
      columns: [t.tenantId, t.personId, t.placementId],
      foreignColumns: [placement.tenantId, placement.personId, placement.id],
    }),
    foreignKey({
      name: "medication_reconciliation_transfer_fk",
      columns: [t.tenantId, t.personId, t.hospitalTransferId],
      foreignColumns: [hospitalTransfer.tenantId, hospitalTransfer.personId, hospitalTransfer.id],
    }),
    memberRef("medication_reconciliation_started_by_fk", t.tenantId, t.startedBy),
    memberRef("medication_reconciliation_completed_by_fk", t.tenantId, t.completedBy),
    // One open reconciliation per person at a time.
    uniqueIndex("medication_reconciliation_one_open")
      .on(t.tenantId, t.personId)
      .where(sql`status = 'open' AND deleted_at IS NULL`),
    check(
      "medication_reconciliation_trigger",
      sql`(trigger = 'admission' AND placement_id IS NOT NULL AND hospital_transfer_id IS NULL)
       OR (trigger = 'return_from_hospital' AND hospital_transfer_id IS NOT NULL AND placement_id IS NULL)
       OR (trigger IN ('transfer', 'change') AND placement_id IS NULL AND hospital_transfer_id IS NULL)`,
    ),
    check("medication_reconciliation_status", sql`status IN ('open', 'completed')`),
    check(
      "medication_reconciliation_completed",
      sql`(status = 'open' AND completed_by IS NULL AND completed_at IS NULL)
       OR (status = 'completed' AND completed_by IS NOT NULL AND completed_at IS NOT NULL
           AND allergies_compared = 'yes'
           AND (person_involved = 'yes'
             OR (person_involved = 'no' AND length(btrim(coalesce(not_involved_reason, ''))) > 0)))`,
    ),
  ],
);

/** A document the reconciliation compares against; append-only (rule 9). */
export const medicationReconciliationSource = pgTable(
  "medication_reconciliation_source",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    kind: text("kind").notNull(),
    reference: text("reference").notNull(),
    documentId: uuid("document_id"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    currentBecause: text("current_because"),
    ...createdColumns(),
  },
  (t) => [
    unique("medication_reconciliation_source_tenant_id_id_key").on(t.tenantId, t.id),
    unique("medication_reconciliation_source_rec_key").on(t.tenantId, t.reconciliationId, t.id),
    foreignKey({
      name: "medication_reconciliation_source_rec_fk",
      columns: [t.tenantId, t.personId, t.reconciliationId],
      foreignColumns: [
        medicationReconciliation.tenantId,
        medicationReconciliation.personId,
        medicationReconciliation.id,
      ],
    }),
    foreignKey({
      name: "medication_reconciliation_source_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check(
      "medication_reconciliation_source_kind",
      sql.raw(`kind IN (${SOURCE_KINDS},'person_or_family') AND length(btrim(reference)) > 0`),
    ),
    check(
      "medication_reconciliation_source_current",
      sql`current_because IS NULL OR length(btrim(current_because)) > 0`,
    ),
  ],
);

/** One line of a source, as written, with what it says; append-only. */
export const medicationReconciliationItem = pgTable(
  "medication_reconciliation_item",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    asWritten: text("as_written").notNull(),
    vmpId: text("vmp_id"),
    ampId: text("amp_id"),
    productName: text("product_name"),
    says: text("says").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("medication_reconciliation_item_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medication_reconciliation_item_source_fk",
      columns: [t.tenantId, t.reconciliationId, t.sourceId],
      foreignColumns: [
        medicationReconciliationSource.tenantId,
        medicationReconciliationSource.reconciliationId,
        medicationReconciliationSource.id,
      ],
    }),
    personRef("medication_reconciliation_item_person_fk", t),
    check(
      "medication_reconciliation_item_says",
      sql`says IN ('start', 'continue', 'change', 'stop', 'unclear')`,
    ),
    check("medication_reconciliation_item_written", sql`length(btrim(as_written)) > 0`),
    check(
      "medication_reconciliation_item_product",
      sql`(vmp_id IS NULL AND amp_id IS NULL AND product_name IS NULL)
       OR (${dmdShape("vmp_id")} AND (amp_id IS NULL OR ${dmdShape("amp_id")})
           AND length(btrim(coalesce(product_name, ''))) > 0)`,
    ),
  ],
);

/**
 * A person's decision on an entry or a source line: replaced while the reconciliation is open
 * (one current decision per entry or line), frozen once it completes (trigger in migration 0111).
 */
export const medicationReconciliationDecision = pgTable(
  "medication_reconciliation_decision",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    reconciliationId: uuid("reconciliation_id").notNull(),
    /** The entry version decided on (`EntryDecision.entryId`). */
    entryId: uuid("entry_id"),
    /** The source line decided on (`ItemDecision.itemId`). */
    itemId: uuid("item_id"),
    kind: text("kind").notNull(),
    /** The decision as the domain takes it (`EntryDecision` or `ItemDecision`), validated by the API. */
    decision: jsonb("decision").notNull(),
    /** The entry the plan made from it, when it completes. */
    madeEntryId: uuid("made_entry_id"),
    decidedBy: uuid("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("medication_reconciliation_decision_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "medication_reconciliation_decision_rec_fk",
      columns: [t.tenantId, t.personId, t.reconciliationId],
      foreignColumns: [
        medicationReconciliation.tenantId,
        medicationReconciliation.personId,
        medicationReconciliation.id,
      ],
    }),
    foreignKey({
      name: "medication_reconciliation_decision_entry_fk",
      columns: [t.tenantId, t.personId, t.entryId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    foreignKey({
      name: "medication_reconciliation_decision_item_fk",
      columns: [t.tenantId, t.itemId],
      foreignColumns: [medicationReconciliationItem.tenantId, medicationReconciliationItem.id],
    }),
    memberRef("medication_reconciliation_decision_by_fk", t.tenantId, t.decidedBy),
    uniqueIndex("medication_reconciliation_decision_entry_key")
      .on(t.tenantId, t.reconciliationId, t.entryId)
      .where(sql`entry_id IS NOT NULL AND deleted_at IS NULL`),
    uniqueIndex("medication_reconciliation_decision_item_key")
      .on(t.tenantId, t.reconciliationId, t.itemId)
      .where(sql`item_id IS NOT NULL AND deleted_at IS NULL`),
    check(
      "medication_reconciliation_decision_target",
      sql`(entry_id IS NOT NULL AND item_id IS NULL AND kind IN ('continue', 'change', 'stop', 'query'))
       OR (item_id IS NOT NULL AND entry_id IS NULL AND kind IN ('start', 'not_started', 'query'))`,
    ),
    check("medication_reconciliation_decision_kind_matches", sql`decision->>'kind' = kind`),
  ],
);
