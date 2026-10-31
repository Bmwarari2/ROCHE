import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
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
import { person } from "./people";
import { location, tenantUser } from "./platform";

/**
 * The dependency tool (scheduling.md section 12; CARE-004, SCHED-001; hazard HZ-123): the
 * organisation's own scale, its versions, and each person's category. The rules live in
 * packages/domain/src/scheduling/dependency.ts; row-level security, the version workflow, the
 * append-only chain and the checks against the scale are in migration 0074. Lane C owns this file
 * (phase-2.md), so care.ts is untouched.
 */

/** `DEPENDENCY_SCALE_STATES` in packages/domain; a test keeps the lists in step. */
export const DEPENDENCY_SCALE_VERSION_STATES = [
  "draft",
  "approved",
  "superseded",
  "discarded",
] as const;
/** `DEPENDENCY_ASSESSMENT_KINDS` in packages/domain. */
export const DEPENDENCY_ASSESSMENT_KIND_CODES = ["initial", "review", "correction"] as const;

const staffRef = (name: string, t: { tenantId: AnyPgColumn }, column: AnyPgColumn) =>
  foreignKey({
    name,
    columns: [t.tenantId, column],
    foreignColumns: [tenantUser.tenantId, tenantUser.id],
  });

/**
 * A dependency scale: for one location, or the organisation-wide one (null location) used where
 * a location has none of its own. One live scale per location and one organisation-wide; the
 * location is fixed once made; archiving (`deleted_at`, with a reason) is final. No personal data.
 * Retention `organisation_document`.
 */
export const dependencyScale = pgTable(
  "dependency_scale",
  {
    id: id(),
    tenantId: tenantId(),
    locationId: uuid("location_id"),
    name: text("name").notNull(),
    archiveReason: text("archive_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dependency_scale_tenant_id_id_key").on(t.tenantId, t.id),
    foreignKey({
      name: "dependency_scale_location_fk",
      columns: [t.tenantId, t.locationId],
      foreignColumns: [location.tenantId, location.id],
    }),
    uniqueIndex("dependency_scale_location_key")
      .on(t.tenantId, t.locationId)
      .where(sql`deleted_at IS NULL AND location_id IS NOT NULL`),
    uniqueIndex("dependency_scale_organisation_key")
      .on(t.tenantId)
      .where(sql`deleted_at IS NULL AND location_id IS NULL`),
    check("dependency_scale_name", sql`char_length(btrim(name)) BETWEEN 1 AND 120`),
    check(
      "dependency_scale_archived",
      sql`(deleted_at IS NULL) = (archive_reason IS NULL) AND (archive_reason IS NULL OR btrim(archive_reason) <> '')`,
    ),
  ],
);

/**
 * A version of a scale (`DEPENDENCY_SCALE_WORKFLOW`): the definition changes only while a draft,
 * then is fixed. One draft and one approved version per scale; approved never by its author or a
 * contributor. Retention `organisation_document`.
 */
export const dependencyScaleVersion = pgTable(
  "dependency_scale_version",
  {
    id: id(),
    tenantId: tenantId(),
    scaleId: uuid("scale_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull().default("draft"),
    /** `DependencyScaleDefinition`: periods, categories with care minutes, skill mix, review interval. */
    definition: jsonb("definition").notNull(),
    authorId: uuid("author_id").notNull().default(sql`app.current_user_id()`),
    /** The author and everyone who changed the draft (kept by the database). */
    contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'::uuid[]`),
    approvedBy: uuid("approved_by"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    discardReason: text("discard_reason"),
    ...mutableColumns(),
  },
  (t) => [
    unique("dependency_scale_version_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dependency_scale_version_scale_id_key").on(t.tenantId, t.scaleId, t.id),
    unique("dependency_scale_version_number_key").on(t.tenantId, t.scaleId, t.versionNumber),
    foreignKey({
      name: "dependency_scale_version_scale_fk",
      columns: [t.tenantId, t.scaleId],
      foreignColumns: [dependencyScale.tenantId, dependencyScale.id],
    }),
    staffRef("dependency_scale_version_author_fk", t, t.authorId),
    staffRef("dependency_scale_version_approved_by_fk", t, t.approvedBy),
    uniqueIndex("dependency_scale_version_one_draft_key")
      .on(t.tenantId, t.scaleId)
      .where(sql`state = 'draft'`),
    uniqueIndex("dependency_scale_version_one_approved_key")
      .on(t.tenantId, t.scaleId)
      .where(sql`state = 'approved'`),
    check(
      "dependency_scale_version_state",
      sql`state IN (${sqlList(DEPENDENCY_SCALE_VERSION_STATES)})`,
    ),
    check("dependency_scale_version_number", sql`version_number >= 1`),
    check("dependency_scale_version_definition", sql`jsonb_typeof(definition) = 'object'`),
    check(
      "dependency_scale_version_approved",
      sql`(state IN ('approved', 'superseded')) = (approved_by IS NOT NULL AND approved_at IS NOT NULL)`,
    ),
    check(
      "dependency_scale_version_superseded",
      sql`(state = 'superseded') = (superseded_at IS NOT NULL)`,
    ),
    check(
      "dependency_scale_version_discarded",
      sql`(state = 'discarded') = (discard_reason IS NOT NULL AND btrim(discard_reason) <> '')`,
    ),
  ],
);

/**
 * A person's dependency category and one-to-one minutes, from an approved version of the scale
 * at their location, with the reason and who decided. Append-only: one chain per person, each row
 * superseded at most once; a review applies from its own date, a correction replaces the row it
 * corrects from that row's date. Health data (B1). Retention `care_record`.
 */
export const dependencyAssessment = pgTable(
  "dependency_assessment",
  {
    id: id(),
    tenantId: tenantId(),
    personId: uuid("person_id").notNull(),
    scaleId: uuid("scale_id").notNull(),
    scaleVersionId: uuid("scale_version_id").notNull(),
    categoryKey: text("category_key").notNull(),
    /** `[{ periodKey, minutes }]`: one-to-one minutes per period, beyond the category's. */
    oneToOne: jsonb("one_to_one").notNull().default(sql`'[]'::jsonb`),
    kind: text("kind").notNull(),
    /** The UK date the category applies from. */
    effectiveFrom: date("effective_from").notNull(),
    reason: text("reason").notNull(),
    /** The member of staff who decided the category (the recorder is `created_by`). */
    decidedBy: uuid("decided_by").notNull(),
    supersedesId: uuid("supersedes_id"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
    ...createdColumns(),
  },
  (t) => [
    unique("dependency_assessment_tenant_id_id_key").on(t.tenantId, t.id),
    unique("dependency_assessment_tenant_person_id_key").on(t.tenantId, t.personId, t.id),
    foreignKey({
      name: "dependency_assessment_person_fk",
      columns: [t.tenantId, t.personId],
      foreignColumns: [person.tenantId, person.id],
    }),
    foreignKey({
      name: "dependency_assessment_version_fk",
      columns: [t.tenantId, t.scaleId, t.scaleVersionId],
      foreignColumns: [
        dependencyScaleVersion.tenantId,
        dependencyScaleVersion.scaleId,
        dependencyScaleVersion.id,
      ],
    }),
    staffRef("dependency_assessment_decided_by_fk", t, t.decidedBy),
    staffRef("dependency_assessment_created_by_fk", t, t.createdBy),
    foreignKey({
      name: "dependency_assessment_supersedes_fk",
      columns: [t.tenantId, t.personId, t.supersedesId],
      foreignColumns: [t.tenantId, t.personId, t.id],
    }),
    uniqueIndex("dependency_assessment_one_chain_key")
      .on(t.tenantId, t.personId)
      .where(sql`supersedes_id IS NULL`),
    uniqueIndex("dependency_assessment_superseded_once_key").on(t.tenantId, t.supersedesId),
    check(
      "dependency_assessment_kind",
      sql`kind IN (${sqlList(DEPENDENCY_ASSESSMENT_KIND_CODES)})`,
    ),
    check("dependency_assessment_chain", sql`(kind = 'initial') = (supersedes_id IS NULL)`),
    check("dependency_assessment_reason", sql`char_length(btrim(reason)) BETWEEN 1 AND 2000`),
    check("dependency_assessment_category_key", sql`category_key ~ '^[a-z][a-z0-9_]{0,39}$'`),
    check("dependency_assessment_one_to_one", sql`jsonb_typeof(one_to_one) = 'array'`),
    index("dependency_assessment_person_idx").on(t.tenantId, t.personId, t.recordedAt),
  ],
);
