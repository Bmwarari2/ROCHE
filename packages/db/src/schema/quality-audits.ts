import { sql } from "drizzle-orm";
import {
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
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";
import { location, tenantUser } from "./platform";
import { frameworkVersion } from "./quality-framework";

/**
 * The audit programme and mock inspections (master prompt 11.2; QUAL-004; Reg 17;
 * docs/specs/quality.md sections 17 and 19). Starter templates are global reference data (seeded,
 * read-only); each organisation copies them into its own templates, schedules audits by location,
 * and records audits that keep the questions and framework version they were scored against for
 * good. Actions for what fell short are append-only and go into the task engine. Rules live in
 * packages/domain/src/quality/quality-audits.ts; row-level security and guards in migration 0081.
 */

/** `AUDIT_KINDS` in packages/domain. */
export const AUDIT_KIND_CODES = [
  "medication",
  "care_plans",
  "ipc",
  "environment",
  "dignity",
  "night_visit",
  "mock_inspection",
  "other",
] as const;
export const AUDIT_TEMPLATE_STATES = ["active", "retired"] as const;
export const AUDIT_RECORD_STATES = ["in_progress", "completed"] as const;

const kindCheck = (column: unknown) => sql`${column} IN (${sqlList(AUDIT_KIND_CODES)})`;

export const auditStarterTemplate = pgTable(
  "audit_starter_template",
  {
    key: text("key").primaryKey(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    questions: jsonb("questions").notNull(),
    source: text("source").notNull(),
  },
  (t) => [
    foreignKey({
      name: "audit_starter_template_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    check("audit_starter_template_kind", kindCheck(t.kind)),
    check("audit_starter_template_questions", sql`jsonb_typeof(${t.questions}) = 'array'`),
  ],
);

export const auditTemplate = pgTable(
  "audit_template",
  {
    id: id(),
    tenantId: tenantId(),
    key: text("key").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    questions: jsonb("questions").notNull(),
    starterKey: text("starter_key"),
    state: text("state").notNull().default("active"),
    ...mutableColumns(),
  },
  (t) => [
    unique("audit_template_key").on(t.tenantId, t.key),
    unique("audit_template_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "audit_template_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    check("audit_template_kind", kindCheck(t.kind)),
    check("audit_template_state", sql`${t.state} IN (${sqlList(AUDIT_TEMPLATE_STATES)})`),
    check("audit_template_key_format", sql`${t.key} ~ '^[a-z0-9_-]{1,64}$'`),
    check(
      "audit_template_questions",
      sql`jsonb_typeof(${t.questions}) = 'array' AND jsonb_array_length(${t.questions}) BETWEEN 1 AND 200`,
    ),
  ],
);

export const auditSchedule = pgTable(
  "audit_schedule",
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid("template_id").notNull(),
    locationId: uuid("location_id").notNull(),
    frequencyMonths: integer("frequency_months").notNull(),
    firstDueOn: date("first_due_on").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("audit_schedule_template_location").on(t.tenantId, t.templateId, t.locationId),
    foreignKey({
      name: "audit_schedule_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [auditTemplate.tenantId, auditTemplate.id],
    }),
    foreignKey({
      name: "audit_schedule_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check("audit_schedule_frequency", sql`${t.frequencyMonths} BETWEEN 1 AND 60`),
  ],
);

export const auditRecord = pgTable(
  "audit_record",
  {
    id: id(),
    tenantId: tenantId(),
    templateId: uuid("template_id").notNull(),
    /** The template's row version when the audit started; its questions are copied below. */
    templateVersion: integer("template_version").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    questions: jsonb("questions").notNull(),
    /** The framework version it is scored against, kept for good (rule 4). */
    frameworkVersionId: uuid("framework_version_id").notNull(),
    locationId: uuid("location_id").notNull(),
    auditedOn: date("audited_on").notNull(),
    answers: jsonb("answers").notNull().default(sql`'{}'::jsonb`),
    state: text("state").notNull().default("in_progress"),
    scorePercent: numeric("score_percent", { precision: 6, scale: 3 }),
    achieved: numeric("achieved", { precision: 10, scale: 2 }),
    possible: integer("possible"),
    selfRating: integer("self_rating"),
    startedBy: uuid("started_by").notNull().default(sql`app.current_user_id()`),
    completedBy: uuid("completed_by"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("audit_record_tenant_id_key").on(t.tenantId, t.id),
    index("audit_record_location_idx").on(t.tenantId, t.locationId, t.auditedOn),
    foreignKey({
      name: "audit_record_template_fk",
      columns: [t.tenantId, t.templateId],
      foreignColumns: [auditTemplate.tenantId, auditTemplate.id],
    }),
    foreignKey({
      name: "audit_record_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    foreignKey({
      name: "audit_record_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    check("audit_record_kind", kindCheck(t.kind)),
    check("audit_record_state", sql`${t.state} IN (${sqlList(AUDIT_RECORD_STATES)})`),
    check("audit_record_answers", sql`jsonb_typeof(${t.answers}) = 'object'`),
    check(
      "audit_record_completion",
      sql`(${t.state} = 'completed') = (${t.completedAt} IS NOT NULL)
        AND (${t.completedAt} IS NULL) = (${t.completedBy} IS NULL)
        AND (${t.state} = 'in_progress' OR ${t.selfRating} IS NOT NULL)
        AND (${t.selfRating} IS NULL OR ${t.selfRating} >= 1)
        AND (${t.scorePercent} IS NULL OR ${t.scorePercent} BETWEEN 0 AND 100)`,
    ),
  ],
);

export const auditAction = pgTable(
  "audit_action",
  {
    id: id(),
    tenantId: tenantId(),
    auditId: uuid("audit_id").notNull(),
    questionKey: text("question_key").notNull(),
    description: text("description").notNull(),
    ownerId: uuid("owner_id").notNull(),
    dueOn: date("due_on").notNull(),
    taskId: uuid("task_id"),
    ...createdColumns(),
  },
  (t) => [
    foreignKey({
      name: "audit_action_audit_fk",
      columns: [t.tenantId, t.auditId],
      foreignColumns: [auditRecord.tenantId, auditRecord.id],
    }),
    foreignKey({
      name: "audit_action_owner_fk",
      columns: [t.tenantId, t.ownerId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    index("audit_action_audit_idx").on(t.tenantId, t.auditId),
    check("audit_action_description", sql`length(btrim(${t.description})) BETWEEN 3 AND 1000`),
  ],
);
