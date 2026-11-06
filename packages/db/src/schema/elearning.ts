import { sql } from "drizzle-orm";
import {
  check,
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
import { document, tenantUser } from "./platform";
import { TRAINING_TOPIC_CODES, trainingRecord } from "./workforce";

/**
 * E-learning courses, attempts and xAPI statements (workforce.md section 14; slice 43; WORK-006;
 * ADR-0093; migration 0112). A course's package is a document (`elearning_package`) checked
 * entry by entry on upload; its files are served only on the content origin. Courses are managed
 * by holders of `workforce.training.manage` and taken by staff (`workforce.self.read`); a member's
 * attempts and statements are their own, read by training leads. A completion is recorded as a
 * training record (slice 17) by the organisation's system context.
 */

export const ELEARNING_STANDARD_CODES = ["scorm_1_2", "scorm_2004", "xapi"] as const;
export const ELEARNING_ATTEMPT_STATUS_CODES = [
  "in_progress",
  "completed",
  "passed",
  "failed",
] as const;

export const elearningCourse = pgTable(
  "elearning_course",
  {
    id: id(),
    tenantId: tenantId(),
    title: text("title").notNull(),
    /** The training topic a completion records (`TRAINING_TOPICS`). */
    topic: text("topic").notNull(),
    tier: integer("tier"),
    standard: text("standard").notNull(),
    documentId: uuid("document_id").notNull(),
    /** The package's SHA-256, as stored. */
    packageSha256: text("package_sha256").notNull(),
    /** The launch page inside the package, a checked relative path. */
    launchPath: text("launch_path").notNull(),
    launchQuery: text("launch_query").notNull().default(""),
    /** The manifest's own identifier (SCORM) or activity id (xAPI). */
    packageIdentifier: text("package_identifier"),
    fileCount: integer("file_count").notNull(),
    unpackedBytes: integer("unpacked_bytes").notNull(),
    /**
     * Each file of the package, read and checked once at upload: path, where its data starts in
     * the stored archive, its sizes, CRC and method. Files are served by a ranged read of just
     * their bytes, inflated as a stream, so nothing holds a whole archive in memory (review H2).
     */
    packageIndex: jsonb("package_index").notNull(),
    /** `active` (offered to staff) or `retired`. */
    status: text("status").notNull().default("active"),
    ...mutableColumns(),
  },
  (t) => [
    unique("elearning_course_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "elearning_course_document_fk",
      columns: [t.tenantId, t.documentId],
      foreignColumns: [document.tenantId, document.id],
    }),
    check("elearning_course_title", sql`length(btrim(title)) BETWEEN 2 AND 160`),
    check("elearning_course_topic", sql`topic IN (${sqlList(TRAINING_TOPIC_CODES)})`),
    check(
      "elearning_course_tier",
      sql`(tier IS NULL) = (topic <> 'oliver_mcgowan') AND (tier IS NULL OR tier IN (1, 2))`,
    ),
    check("elearning_course_standard", sql`standard IN (${sqlList(ELEARNING_STANDARD_CODES)})`),
    check("elearning_course_status", sql`status IN ('active', 'retired')`),
    check("elearning_course_sha256", sql`package_sha256 ~ '^[0-9a-f]{64}$'`),
    check(
      "elearning_course_launch_path",
      sql`length(launch_path) BETWEEN 1 AND 240 AND launch_path !~ '(^/|\\\\|(^|/)\\.\\.?(/|$))'`,
    ),
    check("elearning_course_launch_query", sql`length(launch_query) <= 500`),
    check("elearning_course_counts", sql`file_count > 0 AND unpacked_bytes >= 0`),
    check(
      "elearning_course_index",
      sql`jsonb_typeof(package_index) = 'array' AND jsonb_array_length(package_index) = file_count`,
    ),
  ],
);

export const elearningAttempt = pgTable(
  "elearning_attempt",
  {
    id: id(),
    tenantId: tenantId(),
    courseId: uuid("course_id").notNull(),
    workerId: uuid("worker_id").notNull(),
    status: text("status").notNull().default("in_progress"),
    /** Scaled 0 to 1, as the content last reported it. */
    score: numeric("score", { precision: 5, scale: 4 }),
    /** Where the learner was, and the content's own saved state, to resume (bounded). */
    location: text("location"),
    suspendData: text("suspend_data"),
    totalSeconds: integer("total_seconds").notNull().default(0),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The training record its completion made, once. */
    trainingRecordId: uuid("training_record_id"),
    /**
     * The current launch: every launch token carries it, and starting or resuming the attempt
     * replaces it, so an earlier token stops working (review M6).
     */
    launchNonce: uuid("launch_nonce").notNull().default(sql`app.uuid_v7()`),
    ...mutableColumns(),
  },
  (t) => [
    unique("elearning_attempt_tenant_id_id_key").on(t.tenantId, t.id),
    unique("elearning_attempt_training_record_key").on(t.tenantId, t.trainingRecordId),
    index("elearning_attempt_worker_idx").on(t.tenantId, t.workerId, t.courseId),
    foreignKey({
      name: "elearning_attempt_course_fk",
      columns: [t.tenantId, t.courseId],
      foreignColumns: [elearningCourse.tenantId, elearningCourse.id],
    }),
    foreignKey({
      name: "elearning_attempt_worker_fk",
      columns: [t.tenantId, t.workerId],
      foreignColumns: [tenantUser.tenantId, tenantUser.id],
    }),
    foreignKey({
      name: "elearning_attempt_training_record_fk",
      columns: [t.tenantId, t.trainingRecordId],
      foreignColumns: [trainingRecord.tenantId, trainingRecord.id],
    }),
    check("elearning_attempt_status", sql`status IN (${sqlList(ELEARNING_ATTEMPT_STATUS_CODES)})`),
    check("elearning_attempt_score", sql`score IS NULL OR score BETWEEN 0 AND 1`),
    check("elearning_attempt_location", sql`location IS NULL OR length(location) <= 1000`),
    check("elearning_attempt_suspend", sql`suspend_data IS NULL OR length(suspend_data) <= 64000`),
    check("elearning_attempt_seconds", sql`total_seconds >= 0`),
    check(
      "elearning_attempt_record",
      sql`training_record_id IS NULL OR status IN ('completed', 'passed')`,
    ),
  ],
);

/** An xAPI statement the content sent, kept as sent (append-only; no external LRS). */
export const elearningStatement = pgTable(
  "elearning_statement",
  {
    id: id(),
    tenantId: tenantId(),
    attemptId: uuid("attempt_id").notNull(),
    /** The statement's own id (a UUID the content chose), once per attempt. */
    statementId: uuid("statement_id").notNull(),
    verb: text("verb").notNull(),
    statement: jsonb("statement").notNull(),
    ...createdColumns(),
  },
  (t) => [
    unique("elearning_statement_tenant_id_id_key").on(t.tenantId, t.id),
    unique("elearning_statement_once_key").on(t.tenantId, t.attemptId, t.statementId),
    index("elearning_statement_attempt_idx").on(t.tenantId, t.attemptId),
    foreignKey({
      name: "elearning_statement_attempt_fk",
      columns: [t.tenantId, t.attemptId],
      foreignColumns: [elearningAttempt.tenantId, elearningAttempt.id],
    }),
    check("elearning_statement_verb", sql`verb ~ '^https?://' AND length(verb) <= 300`),
    // A backstop above the API's limit (16 KB as sent), which is the one that refuses (review L2).
    check("elearning_statement_size", sql`octet_length(statement::text) <= 32768`),
  ],
);
