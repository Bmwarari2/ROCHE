import { z } from "zod";

/**
 * Imports of external training records from a learning platform (workforce.md section 13;
 * WORK-006, slice 78; ADR-0102). Learners are named by the platform's stable id, never by name;
 * every import has a dry run before anything is recorded.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const version = z.number().int().min(1);
const learnerId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/, "The platform's learner id, never an email");
const courseCode = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/);
const topic = z.enum([
  "care_certificate",
  "safeguarding_adults",
  "safeguarding_children",
  "moving_and_handling",
  "infection_prevention_and_control",
  "fire_safety",
  "health_and_safety",
  "basic_life_support",
  "food_hygiene",
  "medicines",
  "mental_capacity_and_dols",
  "equality_diversity_and_human_rights",
  "information_governance",
  "dementia_awareness",
  "fluids_and_nutrition",
  "oliver_mcgowan",
]);

export const LmsRowClass = z
  .enum([
    "ready",
    "unmatched_learner",
    "unmapped_course",
    "already_recorded",
    "own_record",
    "invalid",
  ])
  .meta({ id: "LmsRowClass" });

export const LmsSourceItem = z
  .object({
    id: uuid,
    version,
    name: z.string(),
    kind: z.enum(["file", "api"]),
    externalOrganisationId: z.string().nullable(),
    status: z.enum(["active", "ended"]),
    endedAt: isoDateTime.nullable(),
  })
  .meta({ id: "LmsSourceItem", description: "Never a credential" });

export const LmsSourceList = z
  .object({ items: z.array(LmsSourceItem) })
  .meta({ id: "LmsSourceList" });

export const NewLmsSource = z
  .object({
    name: z.string().trim().min(2).max(80),
    kind: z.enum(["file", "api"]),
    /** For an API source: the platform's id for the organisation. */
    externalOrganisationId: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/)
      .nullable()
      .default(null),
  })
  .meta({ id: "NewLmsSource" });

export const EndLmsSource = z.object({ version }).meta({ id: "EndLmsSource" });

export const LmsCourseMapItem = z
  .object({
    id: uuid,
    version,
    courseCode: z.string(),
    topic,
    tier: z.number().int().nullable(),
    active: z.boolean(),
  })
  .meta({ id: "LmsCourseMapItem" });

export const LmsCourseMapList = z
  .object({ items: z.array(LmsCourseMapItem) })
  .meta({ id: "LmsCourseMapList" });

export const NewLmsCourseMap = z
  .object({ courseCode, topic, tier: z.number().int().min(1).max(2).nullable().default(null) })
  .meta({ id: "NewLmsCourseMap" });

export const ChangeLmsCourseMap = z
  .object({
    version,
    topic,
    tier: z.number().int().min(1).max(2).nullable().default(null),
    active: z.boolean(),
  })
  .meta({ id: "ChangeLmsCourseMap" });

export const LmsLearnerLinkItem = z
  .object({ id: uuid, learnerId: z.string(), workerId: uuid, linkedBy: uuid })
  .meta({ id: "LmsLearnerLinkItem" });

export const LmsLearnerLinkList = z
  .object({ items: z.array(LmsLearnerLinkItem) })
  .meta({ id: "LmsLearnerLinkList" });

export const NewLmsLearnerLink = z
  .object({ learnerId, workerId: uuid })
  .meta({ id: "NewLmsLearnerLink" });

export const NewLmsImport = z
  .object({
    format: z.enum(["csv", "json"]),
    /** The file's text, UTF-8. Names, emails and other columns are ignored. */
    content: z.string().min(1).max(5_000_000),
  })
  .meta({ id: "NewLmsImport" });

export const LmsImportRowItem = z
  .object({
    id: uuid,
    rowNumber: z.number().int(),
    learnerId: z.string(),
    courseCode: z.string(),
    completedOn: isoDate.nullable(),
    expiresOn: isoDate.nullable(),
    recordId: z.string(),
    problems: z.array(z.string()),
    class: LmsRowClass.nullable(),
    workerId: uuid.nullable(),
    topic: topic.nullable(),
    tier: z.number().int().nullable(),
    outcome: z.enum(["pending", "imported", "skipped"]),
    trainingRecordId: uuid.nullable(),
    skipReason: z.string().nullable(),
  })
  .meta({ id: "LmsImportRowItem" });

export const LmsImportItem = z
  .object({
    id: uuid,
    version,
    sourceId: uuid,
    format: z.enum(["csv", "json", "api"]),
    rowCount: z.number().int(),
    contentSha256: z.string(),
    status: z.enum(["open", "closed", "discarded"]),
    dryRunNumber: z.number().int(),
    dryRunAt: isoDateTime.nullable(),
    /** Pending rows in each class at the latest dry run. */
    dryRunCounts: z.record(LmsRowClass, z.number().int()).nullable(),
    uploadedBy: uuid,
    uploadedAt: isoDateTime,
    closedAt: isoDateTime.nullable(),
  })
  .meta({ id: "LmsImportItem" });

export const LmsImportDetail = z
  .object({ import: LmsImportItem, rows: z.array(LmsImportRowItem) })
  .meta({ id: "LmsImportDetail" });

export const LmsImportList = z
  .object({ items: z.array(LmsImportItem) })
  .meta({ id: "LmsImportList" });

export const CommitLmsImport = z
  .object({
    /** The dry run the commit follows: refused (409 dry_run_stale) if it is not the latest. */
    dryRunNumber: z.number().int().min(1),
  })
  .meta({ id: "CommitLmsImport" });

export const LmsCommitResult = z
  .object({
    detail: LmsImportDetail,
    imported: z.number().int(),
    /** Certificates stored for the imported records (API sources). */
    certificates: z.number().int(),
    /** Certificates refused by the malware scan or not readable; the records stand. */
    certificatesRefused: z.number().int(),
    message: z.string(),
  })
  .meta({ id: "LmsCommitResult" });

export const SkipLmsRow = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .meta({ id: "SkipLmsRow" });

export const LmsImportVersion = z.object({ version }).meta({ id: "LmsImportVersion" });
