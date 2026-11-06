import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { medication, medicationAdministration } from "./medicines";
import { person } from "./people";
import { tenantUser } from "./platform";

/**
 * PRN protocols, their outcomes and the organisation's medicine lists (Phase 2 slice 28;
 * medicines.md section 16; MEDS-003; HZ-117). Migration 0143. The dose, the most in 24 hours and
 * the minimum interval stay on the medicines entry (migration 0123); a protocol never copies them.
 */

const personRef = (name: string, t: { tenantId: AnyPgColumn; personId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.personId],
    foreignColumns: [person.tenantId, person.id],
  });

/** One product on one of the organisation's medicine lists (ADR-0082, H-514); removal is kept. */
export const medicineListItem = pgTable(
  "medicine_list_item",
  {
    id: id(),
    tenantId: tenantId(),
    /** The tag the list feeds (MEDICINE_TAGS), for example `psychotropic`. */
    list: text("list").notNull(),
    vmpId: text("vmp_id").notNull(),
    /** The dm+d name when added, for reading the list. */
    productName: text("product_name").notNull(),
    reason: text("reason"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedReason: text("removed_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("medicine_list_item_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("medicine_list_item_open_key")
      .on(t.tenantId, t.list, t.vmpId)
      .where(sql`removed_at IS NULL AND deleted_at IS NULL`),
    check(
      "medicine_list_item_list",
      sql`list IN ('time_critical', 'paracetamol', 'bisphosphonate', 'psychotropic')`,
    ),
    check("medicine_list_item_vmp", sql`vmp_id ~ '^[0-9]{6,18}$'`),
    check("medicine_list_item_removed", sql`(removed_at IS NULL) = (removed_reason IS NULL)`),
  ],
);

/** The home's protocol for one when-required medicine (mutable, every version kept). */
export const prnProtocol = pgTable(
  "prn_protocol",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    /** The entry version it was written against; the guard copies its stable `medicine_id`. */
    medicationId: uuid("medication_id").notNull(),
    medicineId: uuid("medicine_id").notNull(),
    /** What it is for, in words staff use. */
    purpose: text("purpose").notNull(),
    /** The signs that mean it may be needed. */
    triggers: text("triggers").array().notNull(),
    /** What to try first. */
    nonDrugAlternatives: text("non_drug_alternatives").array().notNull(),
    /** The group of the person's when-required medicines for one purpose, and this one's place. */
    purposeGroup: text("purpose_group"),
    orderOfUse: integer("order_of_use"),
    expectedEffect: text("expected_effect").notNull(),
    agreedWithName: text("agreed_with_name").notNull(),
    agreedWithRole: text("agreed_with_role").notNull(),
    agreedOn: date("agreed_on").notNull(),
    reviewOn: date("review_on").notNull(),
    withdrawnOn: date("withdrawn_on"),
    withdrawnReason: text("withdrawn_reason"),
    changeReason: text("change_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("prn_protocol_tenant_id_id_key").on(t.tenantId, t.id),
    personRef("prn_protocol_person_fk", t),
    foreignKey({
      name: "prn_protocol_medication_fk",
      columns: [t.tenantId, t.personId, t.medicationId],
      foreignColumns: [medication.tenantId, medication.personId, medication.id],
    }),
    // One open protocol per medicine, and one place per group for the person.
    uniqueIndex("prn_protocol_open_key")
      .on(t.tenantId, t.medicineId)
      .where(sql`withdrawn_on IS NULL AND deleted_at IS NULL`),
    uniqueIndex("prn_protocol_order_key")
      .on(t.tenantId, t.personId, t.purposeGroup, t.orderOfUse)
      .where(sql`withdrawn_on IS NULL AND deleted_at IS NULL AND order_of_use IS NOT NULL`),
    index("prn_protocol_person_idx").on(t.tenantId, t.personId),
    check(
      "prn_protocol_words",
      sql`length(btrim(purpose)) > 0 AND length(btrim(expected_effect)) > 0
        AND cardinality(triggers) > 0`,
    ),
    check("prn_protocol_role", sql`agreed_with_role IN ('prescriber', 'pharmacist')`),
    check(
      "prn_protocol_order",
      sql`order_of_use IS NULL OR (order_of_use >= 1 AND length(btrim(coalesce(purpose_group, ''))) > 0)`,
    ),
    check("prn_protocol_review", sql`review_on > agreed_on`),
    check("prn_protocol_withdrawn", sql`(withdrawn_on IS NULL) = (withdrawn_reason IS NULL)`),
  ],
);

/** The outcome of a when-required dose (append-only; a correction is a new row). */
export const prnOutcome = pgTable(
  "prn_outcome",
  {
    /** The client's UUID: the same id twice is the same record. */
    id: uuid("id").primaryKey(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    administrationId: uuid("administration_id").notNull(),
    outcome: text("outcome").notNull(),
    note: text("note"),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    supersedesId: uuid("supersedes_id"),
    correctionReason: text("correction_reason"),
    ...createdColumns(),
  },
  (t) => [
    unique("prn_outcome_tenant_id_id_key").on(t.tenantId, t.id),
    unique("prn_outcome_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    personRef("prn_outcome_person_fk", t),
    foreignKey({
      name: "prn_outcome_administration_fk",
      columns: [t.tenantId, t.personId, t.administrationId],
      foreignColumns: [
        medicationAdministration.tenantId,
        medicationAdministration.personId,
        medicationAdministration.id,
      ],
    }),
    foreignKey({
      name: "prn_outcome_recorded_by_fk",
      columns: [t.tenantId, t.recordedBy],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "prn_outcome_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    // One original outcome per dose; corrections chain from it, one each.
    uniqueIndex("prn_outcome_dose_key")
      .on(t.tenantId, t.administrationId)
      .where(sql`supersedes_id IS NULL`),
    uniqueIndex("prn_outcome_supersedes_key")
      .on(t.tenantId, t.supersedesId)
      .where(sql`supersedes_id IS NOT NULL`),
    index("prn_outcome_person_idx").on(t.tenantId, t.personId, t.observedAt),
    check(
      "prn_outcome_outcome",
      sql`outcome IN ('effective', 'partly_effective', 'not_effective', 'person_asleep', 'could_not_assess')`,
    ),
    check(
      "prn_outcome_correction",
      sql`(supersedes_id IS NULL AND correction_reason IS NULL)
       OR (supersedes_id IS NOT NULL AND supersedes_id <> id
           AND length(btrim(coalesce(correction_reason, ''))) > 0)`,
    ),
  ],
);
