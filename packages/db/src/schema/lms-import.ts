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
import { id, mutableColumns, tenantId } from "./_columns";
import { tenantUser } from "./platform";
import { TRAINING_TOPIC_CODES } from "./workforce";

/**
 * Imports of external training records from a learning platform (workforce.md section 13;
 * WORK-006, slice 78; ADR-0102; migration 0132). A source is a learning platform the organisation
 * imports from, by file or through the learning platform port; its course codes map to Harbour's
 * training topics and its learner ids link to members of staff, never by name. An import is staged
 * row by row and classified by a dry run before any training record is made. Row-level security
 * and guards are in migration 0132.
 */

/** `LMS_SOURCE_KINDS` and friends in packages/domain (lms-import.ts); a test keeps them in step. */
export const LMS_SOURCE_KIND_CODES = ["file", "api"] as const;
export const LMS_IMPORT_FORMAT_CODES = ["csv", "json", "api"] as const;
export const LMS_ROW_CLASS_CODES = [
  "ready",
  "unmatched_learner",
  "unmapped_course",
  "already_recorded",
  "own_record",
  "invalid",
] as const;
export const LMS_ROW_OUTCOME_CODES = ["pending", "imported", "skipped"] as const;
export const TRAINING_RECORD_SOURCE_CODES = ["harbour", "lms"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/** A learning platform the organisation imports completions from (rule 1). */
export const lmsSource = pgTable(
  "lms_source",
  {
    id: id(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    /** For an API source: the platform's own id for the organisation. */
    externalOrganisationId: text("external_organisation_id"),
    /**
     * For an API source: the managed secret holding its credentials, named by the database
     * (`lms/{tenant}/{source}`), never by a request. Null for a file source.
     */
    secretRef: text("secret_ref"),
    status: text("status").notNull().default("active"),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("lms_source_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("lms_source_name_key")
      .on(t.tenantId, sql`lower(name)`)
      .where(sql`status = 'active' AND deleted_at IS NULL`),
    check("lms_source_kind", sql`kind IN (${sqlList(LMS_SOURCE_KIND_CODES)})`),
    check("lms_source_status", sql`status IN ('active', 'ended')`),
    check("lms_source_ended", sql`(status = 'ended') = (ended_at IS NOT NULL)`),
    check("lms_source_name", sql`length(btrim(name)) BETWEEN 2 AND 80`),
    check(
      "lms_source_api",
      sql`(kind = 'api') = (external_organisation_id IS NOT NULL)
        AND (external_organisation_id IS NULL OR external_organisation_id ~ '^[A-Za-z0-9-]{1,64}$')
        AND secret_ref IS NOT DISTINCT FROM
          CASE WHEN kind = 'api' THEN 'lms/' || tenant_id::text || '/' || id::text END`,
    ),
  ],
);

/** A source's course code, mapped to a Harbour training topic (rule 4). */
export const lmsCourseMap = pgTable(
  "lms_course_map",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id").notNull(),
    courseCode: text("course_code").notNull(),
    topic: text("topic").notNull(),
    tier: integer("tier"),
    active: boolean("active").notNull().default(true),
    ...mutableColumns(),
  },
  (t) => [
    unique("lms_course_map_tenant_id_id_key").on(t.tenantId, t.id),
    unique("lms_course_map_code_key").on(t.tenantId, t.sourceId, t.courseCode),
    foreignKey({
      name: "lms_course_map_source_fk",
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [lmsSource.tenantId, lmsSource.id],
    }),
    check("lms_course_map_code", sql`course_code ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$'`),
    check("lms_course_map_topic", sql`topic IN (${sqlList(TRAINING_TOPIC_CODES)})`),
    check(
      "lms_course_map_tier",
      sql`(tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))`,
    ),
  ],
);

/** A source's stable learner id, linked to one member of staff by a person (rule 3). */
export const lmsLearnerLink = pgTable(
  "lms_learner_link",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id").notNull(),
    learnerId: text("learner_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    linkedBy: uuid("linked_by").notNull(),
    ...mutableColumns(),
  },
  (t) => [
    unique("lms_learner_link_tenant_id_id_key").on(t.tenantId, t.id),
    uniqueIndex("lms_learner_link_learner_key")
      .on(t.tenantId, t.sourceId, t.learnerId)
      .where(sql`deleted_at IS NULL`),
    uniqueIndex("lms_learner_link_worker_key")
      .on(t.tenantId, t.sourceId, t.workerId)
      .where(sql`deleted_at IS NULL`),
    foreignKey({
      name: "lms_learner_link_source_fk",
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [lmsSource.tenantId, lmsSource.id],
    }),
    staffRef("lms_learner_link_worker_fk", t, t.workerId),
    staffRef("lms_learner_link_linked_by_fk", t, t.linkedBy),
    // A stable id: never an email.
    check("lms_learner_link_learner", sql`learner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$'`),
  ],
);

/** One staged import from a source: a file or a pull (rules 2 and 3). */
export const lmsImport = pgTable(
  "lms_import",
  {
    id: id(),
    tenantId: tenantId(),
    sourceId: uuid("source_id").notNull(),
    format: text("format").notNull(),
    rowCount: integer("row_count").notNull(),
    /** The SHA-256 of the file as uploaded, or of the pulled completions. */
    contentSha256: text("content_sha256").notNull(),
    status: text("status").notNull().default("open"),
    /** The latest dry run (rule 4): its number, when, by whom, its counts and fingerprint. */
    dryRunNumber: integer("dry_run_number").notNull().default(0),
    dryRunAt: timestamp("dry_run_at", { withTimezone: true }),
    dryRunBy: uuid("dry_run_by"),
    dryRunCounts: jsonb("dry_run_counts"),
    dryRunSha256: text("dry_run_sha256"),
    uploadedBy: uuid("uploaded_by").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: uuid("closed_by"),
    ...mutableColumns(),
  },
  (t) => [
    unique("lms_import_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "lms_import_source_fk",
      columns: [t.tenantId, t.sourceId],
      foreignColumns: [lmsSource.tenantId, lmsSource.id],
    }),
    staffRef("lms_import_uploaded_by_fk", t, t.uploadedBy),
    staffRef("lms_import_dry_run_by_fk", t, t.dryRunBy),
    staffRef("lms_import_closed_by_fk", t, t.closedBy),
    index("lms_import_source_idx").on(t.tenantId, t.sourceId, t.uploadedAt),
    check("lms_import_format", sql`format IN (${sqlList(LMS_IMPORT_FORMAT_CODES)})`),
    check("lms_import_status", sql`status IN ('open', 'closed', 'discarded')`),
    check("lms_import_closed", sql`(status = 'open') = (closed_at IS NULL)`),
    check("lms_import_rows", sql`row_count BETWEEN 1 AND 5000`),
    check("lms_import_hash", sql`content_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "lms_import_dry_run",
      sql`dry_run_number >= 0
        AND (dry_run_number = 0) = (dry_run_at IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_by IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_counts IS NULL)
        AND (dry_run_at IS NULL) = (dry_run_sha256 IS NULL)
        AND (dry_run_sha256 IS NULL OR dry_run_sha256 ~ '^[0-9a-f]{64}$')`,
    ),
  ],
);

/**
 * One completion of an import, as checked (rule 2): the platform's ids and the dates, never a name;
 * what the latest dry run classified it as; and what became of it.
 */
export const lmsImportRow = pgTable(
  "lms_import_row",
  {
    id: id(),
    tenantId: tenantId(),
    importId: uuid("import_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    learnerId: text("learner_id").notNull(),
    courseCode: text("course_code").notNull(),
    completedOn: date("completed_on"),
    expiresOn: date("expires_on"),
    recordId: text("record_id").notNull(),
    provider: text("provider"),
    /** `LMS_ROW_PROBLEMS` the row has; empty when it is a valid completion. */
    problems: text("problems").array().notNull(),
    class: text("class"),
    workerId: uuid("worker_id"),
    topic: text("topic"),
    tier: integer("tier"),
    outcome: text("outcome").notNull().default("pending"),
    trainingRecordId: uuid("training_record_id"),
    skipReason: text("skip_reason"),
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    ...mutableColumns(),
  },
  (t) => [
    unique("lms_import_row_tenant_id_id_key").on(t.tenantId, t.id),
    unique("lms_import_row_number_key").on(t.tenantId, t.importId, t.rowNumber),
    foreignKey({
      name: "lms_import_row_import_fk",
      columns: [t.tenantId, t.importId],
      foreignColumns: [lmsImport.tenantId, lmsImport.id],
    }),
    staffRef("lms_import_row_worker_fk", t, t.workerId),
    staffRef("lms_import_row_resolved_by_fk", t, t.resolvedBy),
    check("lms_import_row_number", sql`row_number BETWEEN 1 AND 5000`),
    check(
      "lms_import_row_ids",
      sql`(learner_id = '' OR learner_id ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$')
        AND (course_code = '' OR course_code ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$')
        AND length(record_id) BETWEEN 1 AND 240 AND position('@' in record_id) = 0`,
    ),
    check(
      "lms_import_row_provider",
      sql`provider IS NULL OR (length(btrim(provider)) BETWEEN 2 AND 160 AND position('@' in provider) = 0 AND provider !~ '^[-=+@]')`,
    ),
    check("lms_import_row_class", sql`class IS NULL OR class IN (${sqlList(LMS_ROW_CLASS_CODES)})`),
    check("lms_import_row_outcome", sql`outcome IN (${sqlList(LMS_ROW_OUTCOME_CODES)})`),
    check(
      "lms_import_row_topic",
      sql`(topic IS NULL OR topic IN (${sqlList(TRAINING_TOPIC_CODES)}))
        AND (tier IS NULL OR tier IN (1, 2))`,
    ),
    check(
      "lms_import_row_resolved",
      sql`(outcome = 'pending') = (resolved_at IS NULL)
        AND (resolved_at IS NULL) = (resolved_by IS NULL)
        AND (outcome = 'imported') = (training_record_id IS NOT NULL)
        AND (outcome = 'skipped') = (skip_reason IS NOT NULL)
        AND (skip_reason IS NULL OR length(btrim(skip_reason)) BETWEEN 3 AND 500)`,
    ),
  ],
);
