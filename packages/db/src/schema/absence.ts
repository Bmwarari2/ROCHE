import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { document, location, tenantUser } from "./platform";
import { shift, shiftAssignment } from "./rota";

/**
 * Absence and leave (scheduling.md section 15; SCHED-010; hazards HZ-123 and HZ-124): absences
 * with their requests and decisions, fit notes (an HR-only document with its dates, never the
 * condition), return to work records, and the cover needs an absence raises on the member's
 * rostered shifts. The rules live in packages/domain/src/scheduling/absence.ts; row-level
 * security, the guards and the grants are in migration 0107. Lane C owns this file.
 */

/** `ABSENCE_KINDS` and `ABSENCE_STATES` in packages/domain; a test keeps the lists in step. */
export const ABSENCE_KIND_CODES = [
  "annual_leave",
  "sickness",
  "compassionate",
  "carers_leave",
  "parental_leave",
  "maternity",
  "paternity",
  "adoption",
  "unpaid",
  "other",
] as const;
export const ABSENCE_STATE_CODES = [
  "requested",
  "approved",
  "declined",
  "cancelled",
  "recorded",
] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });
const locationRef = (name: string, t: { tenantId: AnyPgColumn; locationId: AnyPgColumn }) =>
  foreignKey({
    name,
    columns: [t.tenantId, t.locationId],
    foreignColumns: [location.tenantId, location.id],
  });

/** One absence of one member: leave asked for and decided, or sickness or leave recorded. */
export const absence = pgTable(
  "absence",
  {
    id: id(),
    tenantId: tenantId(),
    memberId: uuid("member_id").notNull(),
    /** The home whose rota and managers it belongs to. */
    locationId: uuid("location_id").notNull(),
    kind: text("kind").notNull(),
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    /** Null while a sickness is open. */
    endsOn: date("ends_on", { mode: "string" }),
    state: text("state").notNull(),
    decidedBy: uuid("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    /** Why it was declined or cancelled: words about the rota, never about health. */
    decisionReason: text("decision_reason"),
    /** When the member's own statement for the first days of a sickness was taken. */
    selfCertifiedAt: timestamp("self_certified_at", { withTimezone: true }),
    /** A manager's reason for leaving it out of the Bradford factor (pregnancy, disability). */
    bradfordExcludedReason: text("bradford_excluded_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("absence_tenant_id_id_key").on(t.tenantId, t.id),
    staffRef("absence_member_fk", t, t.memberId),
    staffRef("absence_decided_by_fk", t, t.decidedBy),
    locationRef("absence_location_fk", t),
    index("absence_member_idx").on(t.tenantId, t.memberId, t.startsOn),
    index("absence_location_idx").on(t.tenantId, t.locationId, t.startsOn),
    check("absence_kind", sql`kind IN (${sqlList(ABSENCE_KIND_CODES)})`),
    check("absence_state", sql`state IN (${sqlList(ABSENCE_STATE_CODES)})`),
    check(
      "absence_dates",
      sql`(ends_on IS NULL OR ends_on >= starts_on) AND (ends_on IS NOT NULL OR kind = 'sickness')`,
    ),
    check(
      "absence_decision",
      sql`(state NOT IN ('approved', 'declined') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL))
        AND (state NOT IN ('requested', 'recorded') OR (decided_by IS NULL AND decided_at IS NULL))`,
    ),
    // The approver is never the member (separation of duties).
    check("absence_decider_is_member", sql`decided_by IS DISTINCT FROM member_id`),
    check(
      "absence_reason",
      sql`(state <> 'declined' OR decision_reason IS NOT NULL)
        AND (decision_reason IS NULL OR char_length(btrim(decision_reason)) BETWEEN 3 AND 500)
        AND (bradford_excluded_reason IS NULL OR (kind = 'sickness' AND char_length(btrim(bradford_excluded_reason)) BETWEEN 3 AND 500))`,
    ),
    check("absence_self_certified", sql`self_certified_at IS NULL OR kind = 'sickness'`),
  ],
);

/** A fit note for a sickness: the HR-only document and the dates and ticks, never the condition. */
export const fitNote = pgTable(
  "fit_note",
  {
    id: id(),
    tenantId: tenantId(),
    absenceId: uuid("absence_id").notNull(),
    locationId: uuid("location_id").notNull(),
    documentId: uuid("document_id").notNull(),
    issuedOn: date("issued_on", { mode: "string" }).notNull(),
    coversFrom: date("covers_from", { mode: "string" }).notNull(),
    coversTo: date("covers_to", { mode: "string" }).notNull(),
    fitness: text("fitness").notNull(),
    phasedReturn: boolean("phased_return").notNull().default(false),
    amendedDuties: boolean("amended_duties").notNull().default(false),
    alteredHours: boolean("altered_hours").notNull().default(false),
    workplaceAdaptations: boolean("workplace_adaptations").notNull().default(false),
    ...createdColumns(),
  },
  (t) => [
    unique("fit_note_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "fit_note_absence_fk",
      columns: [t.tenantId, t.absenceId],
      foreignColumns: [absence.tenantId, absence.id],
    }),
    foreignKey({
      name: "fit_note_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    locationRef("fit_note_location_fk", t),
    uniqueIndex("fit_note_document_key").on(t.tenantId, t.documentId),
    index("fit_note_absence_idx").on(t.tenantId, t.absenceId),
    check("fit_note_fitness", sql`fitness IN ('not_fit', 'may_be_fit')`),
    check("fit_note_dates", sql`covers_to >= covers_from AND issued_on <= covers_to`),
    check(
      "fit_note_adjustments",
      sql`fitness = 'may_be_fit' OR NOT (phased_return OR amended_duties OR altered_hours OR workplace_adaptations)`,
    ),
  ],
);

/** The return to work conversation after a sickness: one per absence, append-only. */
export const returnToWork = pgTable(
  "return_to_work",
  {
    id: id(),
    tenantId: tenantId(),
    absenceId: uuid("absence_id").notNull(),
    locationId: uuid("location_id").notNull(),
    memberId: uuid("member_id").notNull(),
    heldOn: date("held_on", { mode: "string" }).notNull(),
    heldBy: uuid("held_by").notNull(),
    fitForUsualDuties: boolean("fit_for_usual_duties").notNull(),
    phasedReturn: boolean("phased_return").notNull().default(false),
    amendedDuties: boolean("amended_duties").notNull().default(false),
    alteredHours: boolean("altered_hours").notNull().default(false),
    workplaceAdaptations: boolean("workplace_adaptations").notNull().default(false),
    /** The conversation, in the holder's words: special category, never in an audit event. */
    notes: text("notes"),
    ...createdColumns(),
  },
  (t) => [
    unique("return_to_work_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "return_to_work_absence_fk",
      columns: [t.tenantId, t.absenceId],
      foreignColumns: [absence.tenantId, absence.id],
    }),
    staffRef("return_to_work_member_fk", t, t.memberId),
    staffRef("return_to_work_held_by_fk", t, t.heldBy),
    locationRef("return_to_work_location_fk", t),
    uniqueIndex("return_to_work_absence_key").on(t.tenantId, t.absenceId),
    check("return_to_work_holder", sql`held_by IS DISTINCT FROM member_id`),
    check(
      "return_to_work_notes",
      sql`notes IS NULL OR char_length(btrim(notes)) BETWEEN 1 AND 4000`,
    ),
  ],
);

/**
 * A rostered shift an absence leaves needing cover (HZ-123): the assignment stays, flagged, until
 * it is removed or the absence ends. Raised once, resolved once.
 */
export const shiftCoverNeed = pgTable(
  "shift_cover_need",
  {
    id: id(),
    tenantId: tenantId(),
    shiftId: uuid("shift_id").notNull(),
    assignmentId: uuid("assignment_id").notNull(),
    absenceId: uuid("absence_id").notNull(),
    /** The shift's location (its rota's managers see it). */
    locationId: uuid("location_id").notNull(),
    raisedAt: timestamp("raised_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    ...createdColumns(),
  },
  (t) => [
    unique("shift_cover_need_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "shift_cover_need_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shift.tenantId, shift.id],
    }),
    foreignKey({
      name: "shift_cover_need_assignment_fk",
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [shiftAssignment.tenantId, shiftAssignment.id],
    }),
    foreignKey({
      name: "shift_cover_need_absence_fk",
      columns: [t.tenantId, t.absenceId],
      foreignColumns: [absence.tenantId, absence.id],
    }),
    locationRef("shift_cover_need_location_fk", t),
    uniqueIndex("shift_cover_need_open_key")
      .on(t.tenantId, t.assignmentId, t.absenceId)
      .where(sql`resolved_at IS NULL`),
    index("shift_cover_need_shift_idx").on(t.tenantId, t.shiftId),
    check(
      "shift_cover_need_resolution",
      sql`(resolved_at IS NULL) = (resolution IS NULL)
        AND (resolution IS NULL OR resolution IN ('assignment_removed', 'absence_ended'))`,
    ),
  ],
);
