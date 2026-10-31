import { sql } from "drizzle-orm";
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sqlList } from "./_codes";
import { createdColumns, id, mutableColumns, tenantId } from "./_columns";

/**
 * The compliance framework and the evidence library (master prompt 11.2; QUAL-001, QUAL-002;
 * docs/specs/quality.md sections 17 and 18; ADR-0096). Framework versions are global reference data
 * (no tenant): key questions, quality statements and evidence categories, seeded by migration 0076
 * and read-only to the application. Tenant mappings are append-only versions; evidence links tag any
 * record against statements of one framework version. Rules live in
 * packages/domain/src/quality/quality-framework.ts; row-level security and guards in migration 0076.
 */

/** `REGULATORS` in packages/domain. */
export const FRAMEWORK_REGULATOR_CODES = ["cqc", "ciw", "care_inspectorate", "rqia"] as const;
/** `FRAMEWORK_WORKFLOW` states in packages/domain. */
export const FRAMEWORK_STATE_CODES = ["draft", "published", "retired"] as const;

export const frameworkVersion = pgTable(
  "framework_version",
  {
    id: uuid("id").primaryKey(),
    frameworkKey: text("framework_key").notNull(),
    regulator: text("regulator").notNull(),
    /** The version's number within its framework (not a row version: the rows never change). */
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull(),
    publishedOn: date("published_on"),
    retiredOn: date("retired_on"),
    sourceName: text("source_name").notNull(),
    sourceProvision: text("source_provision").notNull(),
    sourceUrl: text("source_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("framework_version_number_key").on(t.frameworkKey, t.versionNumber),
    check(
      "framework_version_regulator",
      sql`${t.regulator} IN (${sqlList(FRAMEWORK_REGULATOR_CODES)})`,
    ),
    check("framework_version_state", sql`${t.state} IN (${sqlList(FRAMEWORK_STATE_CODES)})`),
    check("framework_version_source_https", sql`${t.sourceUrl} LIKE 'https://%'`),
    check(
      "framework_version_dates",
      sql`(${t.state} = 'draft') = (${t.publishedOn} IS NULL)
        AND (${t.retiredOn} IS NULL OR ${t.retiredOn} > ${t.publishedOn})
        AND ((${t.state} = 'retired') = (${t.retiredOn} IS NOT NULL))`,
    ),
  ],
);

export const frameworkKeyQuestion = pgTable(
  "framework_key_question",
  {
    frameworkVersionId: uuid("framework_version_id").notNull(),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
  },
  (t) => [
    primaryKey({ name: "framework_key_question_pkey", columns: [t.frameworkVersionId, t.id] }),
    foreignKey({
      name: "framework_key_question_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    check("framework_key_question_id", sql`${t.id} ~ '^[A-Za-z0-9._-]{1,64}$'`),
  ],
);

export const frameworkStatement = pgTable(
  "framework_statement",
  {
    frameworkVersionId: uuid("framework_version_id").notNull(),
    id: text("id").notNull(),
    keyQuestionId: text("key_question_id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
  },
  (t) => [
    primaryKey({ name: "framework_statement_pkey", columns: [t.frameworkVersionId, t.id] }),
    foreignKey({
      name: "framework_statement_key_question_fk",
      columns: [t.frameworkVersionId, t.keyQuestionId],
      foreignColumns: [frameworkKeyQuestion.frameworkVersionId, frameworkKeyQuestion.id],
    }),
    check("framework_statement_id", sql`${t.id} ~ '^[A-Za-z0-9._-]{1,64}$'`),
  ],
);

export const frameworkEvidenceCategory = pgTable(
  "framework_evidence_category",
  {
    frameworkVersionId: uuid("framework_version_id").notNull(),
    id: text("id").notNull(),
    position: integer("position").notNull(),
    title: text("title").notNull(),
  },
  (t) => [
    primaryKey({ name: "framework_evidence_category_pkey", columns: [t.frameworkVersionId, t.id] }),
    foreignKey({
      name: "framework_evidence_category_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    check("framework_evidence_category_id", sql`${t.id} ~ '^[A-Za-z0-9._-]{1,64}$'`),
  ],
);

/**
 * A tenant's mapping of one framework version: append-only, one row per mapping version, so a past
 * audit is read with the mapping of its time (`mappingAt`). Entries: statement id, local title,
 * owner role, expected evidence categories (checked against the framework by the database).
 */
export const frameworkMapping = pgTable(
  "framework_mapping",
  {
    id: id(),
    tenantId: tenantId(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    mappingVersion: integer("mapping_version").notNull(),
    entries: jsonb("entries").notNull(),
    madeBy: uuid("made_by").notNull().default(sql`app.current_user_id()`),
    madeAt: timestamp("made_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("framework_mapping_version_key").on(t.tenantId, t.frameworkVersionId, t.mappingVersion),
    foreignKey({
      name: "framework_mapping_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    unique("framework_mapping_tenant_id_key").on(t.tenantId, t.id),
    check("framework_mapping_version_positive", sql`${t.mappingVersion} >= 1`),
    check("framework_mapping_entries_array", sql`jsonb_typeof(${t.entries}) = 'array'`),
  ],
);

/**
 * A record tagged as evidence against statements of one framework version (rule 6). Mutable only to
 * be removed (with who, when and why); the record itself is never copied here.
 */
export const evidenceLink = pgTable(
  "evidence_link",
  {
    id: id(),
    tenantId: tenantId(),
    recordType: text("record_type").notNull(),
    recordId: uuid("record_id").notNull(),
    frameworkVersionId: uuid("framework_version_id").notNull(),
    statementIds: text("statement_ids").array().notNull(),
    taggedBy: uuid("tagged_by").notNull().default(sql`app.current_user_id()`),
    taggedAt: timestamp("tagged_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedBy: uuid("removed_by"),
    removalReason: text("removal_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("evidence_link_tenant_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "evidence_link_framework_fk",
      columns: [t.frameworkVersionId],
      foreignColumns: [frameworkVersion.id],
    }),
    index("evidence_link_record_idx").on(t.tenantId, t.recordType, t.recordId),
    index("evidence_link_statements_idx").using("gin", t.statementIds),
    check("evidence_link_statements", sql`cardinality(${t.statementIds}) BETWEEN 1 AND 20`),
    check("evidence_link_record_type", sql`${t.recordType} ~ '^[a-z_]{1,40}$'`),
    check(
      "evidence_link_removal",
      sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)
        AND (${t.removedAt} IS NULL) = (${t.removalReason} IS NULL)
        AND (${t.removalReason} IS NULL OR length(btrim(${t.removalReason})) BETWEEN 3 AND 500)`,
    ),
  ],
);
