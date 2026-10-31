import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";

/**
 * The rota builder (scheduling.md section 14; SCHED-001, SCHED-002; hazards HZ-123 and HZ-124):
 * shift templates and patterns, rotas with their publications, shifts (one position each) and who
 * is assigned, and the manager overrides of the rostering rule. The rules live in
 * packages/domain/src/scheduling/rota.ts and packages/domain/src/workforce/rostering.ts; row-level
 * security, the guards and the grants are in migration 0083. Lane C owns this file (phase-2.md).
 * Retention `rota_and_timesheet` for every table (retention.md).
 */

/** `SHIFT_KINDS` in packages/domain; a test keeps the lists in step. */
export const SHIFT_KIND_CODES = [
  "work",
  "sleep_in",
  "on_call_at_workplace",
  "on_call_away",
  "training",
] as const;
export const ROTA_STATES = ["draft", "published"] as const;

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

/** A shift as a location usually runs it. Archived (`deleted_at`), never deleted. No personal data. */
export const shiftTemplate = pgTable(
  "shift_template",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** UK wall-clock minutes after midnight; an end at or before the start is the next day. */
    startMinute: integer("start_minute").notNull(),
    endMinute: integer("end_minute").notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    requiredCompetences: text("required_competences").array().notNull().default(sql`'{}'`),
    requiredSkills: text("required_skills").array().notNull().default(sql`'{}'`),
    /** The shift is worked alongside a cleared colleague (a supervised-only DBS may work it). */
    supervised: boolean("supervised").notNull().default(false),
    ...mutableColumns(),
  },
  (t) => [
    unique("shift_template_tenant_id_id_key").on(t.tenantId, t.id),
    locationRef("shift_template_location_fk", t),
    check("shift_template_name", sql`char_length(btrim(name)) BETWEEN 1 AND 80`),
    check("shift_template_kind", sql`kind IN (${sqlList(SHIFT_KIND_CODES)})`),
    check(
      "shift_template_minutes",
      sql`start_minute BETWEEN 0 AND 1439 AND end_minute BETWEEN 0 AND 1439 AND break_minutes >= 0`,
    ),
  ],
);

/** A cycle of templates by day (`entries`: [{ day, templateId, count }]). No personal data. */
export const shiftPattern = pgTable(
  "shift_pattern",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    name: text("name").notNull(),
    cycleDays: integer("cycle_days").notNull(),
    entries: jsonb("entries").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("shift_pattern_tenant_id_id_key").on(t.tenantId, t.id),
    locationRef("shift_pattern_location_fk", t),
    check("shift_pattern_name", sql`char_length(btrim(name)) BETWEEN 1 AND 80`),
    check("shift_pattern_cycle", sql`cycle_days BETWEEN 1 AND 56`),
    check("shift_pattern_entries", sql`jsonb_typeof(entries) = 'array'`),
  ],
);

/** A location's rota for a run of UK dates; live rotas at a location never overlap. */
export const rota = pgTable(
  "rota",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    state: text("state").notNull().default("draft"),
    /** The latest publication, or null while a draft. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("rota_tenant_id_id_key").on(t.tenantId, t.id),
    locationRef("rota_location_fk", t),
    check("rota_dates", sql`ends_on >= starts_on AND ends_on - starts_on < 42`),
    check("rota_state", sql`state IN (${sqlList(ROTA_STATES)})`),
    check("rota_published", sql`(state = 'published') = (published_at IS NOT NULL)`),
    index("rota_location_idx").on(t.tenantId, t.locationId, t.startsOn),
  ],
);

/**
 * Each time a rota was published, with the notice it gave and what the publisher was shown
 * (append-only): the staffing comparison's status per period, the working time findings and the
 * overrides counted, and the digest of the check they saw.
 */
export const rotaPublication = pgTable(
  "rota_publication",
  {
    id: id(),
    tenantId: tenantId(),
    rotaId: uuid("rota_id").notNull(),
    locationId: uuid("location_id").notNull(),
    publishedBy: uuid("published_by").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull().defaultNow(),
    firstShiftStart: timestamp("first_shift_start", { withTimezone: true }),
    noticeMinutes: integer("notice_minutes"),
    shiftCount: integer("shift_count").notNull(),
    openShiftCount: integer("open_shift_count").notNull(),
    overrideCount: integer("override_count").notNull(),
    workingTimeBreaches: integer("working_time_breaches").notNull(),
    workingTimeConditionals: integer("working_time_conditionals").notNull(),
    /** [{ date, periodKey, status }] from compareStaffing; no personal data. */
    staffing: jsonb("staffing").notNull(),
    checkDigest: text("check_digest").notNull(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "rota_publication_rota_fk",
      columns: [t.tenantId, t.rotaId],
      foreignColumns: [rota.tenantId, rota.id],
    }),
    locationRef("rota_publication_location_fk", t),
    staffRef("rota_publication_published_by_fk", t, t.publishedBy),
    check(
      "rota_publication_counts",
      sql`shift_count >= 0 AND open_shift_count >= 0 AND override_count >= 0 AND working_time_breaches >= 0 AND working_time_conditionals >= 0 AND (notice_minutes IS NULL OR notice_minutes >= 0)`,
    ),
    check("rota_publication_staffing", sql`jsonb_typeof(staffing) = 'array'`),
    index("rota_publication_rota_idx").on(t.tenantId, t.rotaId),
  ],
);

/** One position on a rota. Cancelled (`deleted_at`, with a reason), never deleted. */
export const shift = pgTable(
  "shift",
  {
    id: id(),
    tenantId: tenantId(),
    rotaId: uuid("rota_id").notNull(),
    locationId: uuid("location_id").notNull(),
    templateId: uuid("template_id"),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    breakMinutes: integer("break_minutes").notNull().default(0),
    requiredCompetences: text("required_competences").array().notNull().default(sql`'{}'`),
    requiredSkills: text("required_skills").array().notNull().default(sql`'{}'`),
    supervised: boolean("supervised").notNull().default(false),
    /** Set when a publication included the shift. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /** The last change after it was published (notice tracking). */
    changedAfterPublishAt: timestamp("changed_after_publish_at", { withTimezone: true }),
    cancelReason: text("cancel_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("shift_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "shift_rota_fk",
      columns: [t.tenantId, t.rotaId],
      foreignColumns: [rota.tenantId, rota.id],
    }),
    foreignKey({
      name: "shift_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [shiftTemplate.tenantId, shiftTemplate.id],
    }),
    locationRef("shift_location_fk", t),
    check("shift_label", sql`char_length(btrim(label)) BETWEEN 1 AND 80`),
    check("shift_kind", sql`kind IN (${sqlList(SHIFT_KIND_CODES)})`),
    check(
      "shift_times",
      sql`ends_at > starts_at AND ends_at - starts_at <= interval '25 hours' AND break_minutes >= 0`,
    ),
    check(
      "shift_cancelled",
      sql`(deleted_at IS NULL) = (cancel_reason IS NULL) AND (cancel_reason IS NULL OR btrim(cancel_reason) <> '')`,
    ),
    index("shift_rota_idx").on(t.tenantId, t.rotaId, t.startsAt),
  ],
);

/**
 * Who works a shift: one live assignment per shift. `location_id` repeats the shift's for row-level
 * security; `published_at` is set when a publication included it, so the worker sees it from then.
 * Removed (`deleted_at`, with a reason), never deleted.
 */
export const shiftAssignment = pgTable(
  "shift_assignment",
  {
    id: id(),
    tenantId: tenantId(),
    shiftId: uuid("shift_id").notNull(),
    locationId: uuid("location_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    removeReason: text("remove_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("shift_assignment_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "shift_assignment_shift_fk",
      columns: [t.tenantId, t.shiftId],
      foreignColumns: [shift.tenantId, shift.id],
    }),
    locationRef("shift_assignment_location_fk", t),
    staffRef("shift_assignment_worker_fk", t, t.workerId),
    uniqueIndex("shift_assignment_live_key")
      .on(t.tenantId, t.shiftId)
      .where(sql`deleted_at IS NULL`),
    index("shift_assignment_worker_idx").on(t.tenantId, t.workerId),
    check(
      "shift_assignment_removed",
      sql`(deleted_at IS NULL) = (remove_reason IS NULL) AND (remove_reason IS NULL OR btrim(remove_reason) <> '')`,
    ),
  ],
);

/**
 * A manager's override of the rostering rule for one assignment (HZ-124; workforce.md rule 10),
 * append-only: which blockers it covered (`blockerKey`: `dbs`, `dbs_supervised_only`,
 * `registration`, `competence:<name>`; never `right_to_work`), the justification and who gave it.
 * No DBS detail: only the kind of blocker.
 */
export const rosterOverride = pgTable(
  "roster_override",
  {
    id: id(),
    tenantId: tenantId(),
    assignmentId: uuid("assignment_id").notNull(),
    locationId: uuid("location_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    blockerKeys: text("blocker_keys").array().notNull(),
    justification: text("justification").notNull(),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "roster_override_assignment_fk",
      columns: [t.tenantId, t.assignmentId],
      foreignColumns: [shiftAssignment.tenantId, shiftAssignment.id],
    }),
    locationRef("roster_override_location_fk", t),
    staffRef("roster_override_worker_fk", t, t.workerId),
    check(
      "roster_override_blockers",
      sql`cardinality(blocker_keys) >= 1 AND NOT ('right_to_work' = ANY (blocker_keys))`,
    ),
    check(
      "roster_override_justification",
      sql`char_length(btrim(justification)) BETWEEN 10 AND 1000`,
    ),
    index("roster_override_assignment_idx").on(t.tenantId, t.assignmentId),
  ],
);
