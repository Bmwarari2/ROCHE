import { z } from "zod";

/**
 * The compliance framework and the evidence library (quality.md section 18; QUAL-001, QUAL-002;
 * ADR-0096). Framework versions are global reference data; mappings and evidence links are the
 * organisation's. Dates are yyyy-mm-dd UK dates, times ISO 8601 with offset.
 */

const uuid = z.uuid();
const isoDate = z.iso.date();
const isoDateTime = z.iso.datetime({ offset: true });
const frameworkId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);
const version = z.number().int().min(1);

export const FrameworkVersionSummary = z
  .object({
    id: uuid,
    frameworkKey: z.string(),
    regulator: z.enum(["cqc", "ciw", "care_inspectorate", "rqia"]),
    versionNumber: z.number().int(),
    state: z.enum(["draft", "published", "retired"]),
    publishedOn: isoDate.nullable(),
    retiredOn: isoDate.nullable(),
    source: z.object({ name: z.string(), provision: z.string(), url: z.string() }),
    /** The version in force today for its regulator (rule 3). */
    inForce: z.boolean(),
  })
  .meta({ id: "FrameworkVersionSummary" });

export const FrameworkVersionList = z
  .object({ items: z.array(FrameworkVersionSummary) })
  .meta({ id: "FrameworkVersionList" });

export const FrameworkVersionDetail = FrameworkVersionSummary.extend({
  keyQuestions: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      statements: z.array(z.object({ id: z.string(), title: z.string() })),
    }),
  ),
  evidenceCategories: z.array(z.object({ id: z.string(), title: z.string() })),
}).meta({ id: "FrameworkVersionDetail" });
export type FrameworkVersionDetail = z.infer<typeof FrameworkVersionDetail>;

export const FrameworkMappingEntry = z
  .object({
    statementId: frameworkId,
    localTitle: z.string().trim().min(1).max(200).nullable(),
    ownerRole: z.string().trim().min(1).max(64).nullable(),
    evidenceCategoryIds: z.array(frameworkId).max(20),
  })
  .meta({ id: "FrameworkMappingEntry" });

export const FrameworkMappingView = z
  .object({
    frameworkVersionId: uuid,
    /** 0 while the organisation has not mapped this version. */
    mappingVersion: z.number().int().min(0),
    entries: z.array(FrameworkMappingEntry),
    madeBy: uuid.nullable(),
    madeAt: isoDateTime.nullable(),
  })
  .meta({ id: "FrameworkMappingView" });

export const SaveFrameworkMapping = z
  .object({
    /** The next version: the one read plus one (409 when someone else saved first). */
    mappingVersion: version,
    entries: z.array(FrameworkMappingEntry).max(500),
  })
  .meta({ id: "SaveFrameworkMapping" });

export const EvidenceLinkItem = z
  .object({
    id: uuid,
    recordType: z.string(),
    recordId: uuid,
    frameworkVersionId: uuid,
    statementIds: z.array(z.string()),
    taggedBy: uuid,
    taggedAt: isoDateTime,
    removedAt: isoDateTime.nullable(),
    removedBy: uuid.nullable(),
    removalReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "EvidenceLinkItem" });

export const EvidenceLinkList = z
  .object({ items: z.array(EvidenceLinkItem) })
  .meta({ id: "EvidenceLinkList" });

export const CreateEvidenceLink = z
  .object({
    recordType: z.string().regex(/^[a-z_]{1,40}$/),
    recordId: uuid,
    frameworkVersionId: uuid,
    statementIds: z.array(frameworkId).min(1).max(20),
  })
  .meta({ id: "CreateEvidenceLink" });

export const RemoveEvidenceLink = z
  .object({ reason: z.string().trim().min(3).max(500), version })
  .meta({ id: "RemoveEvidenceLink" });

export const EvidenceCoverage = z
  .object({
    frameworkVersionId: uuid,
    statements: z.array(
      z.object({ statementId: z.string(), keyQuestionId: z.string(), records: z.number().int() }),
    ),
    /** Statements with no evidence, listed so a gap is shown (rule 7). */
    gaps: z.array(z.string()),
  })
  .meta({ id: "EvidenceCoverage" });

export type FrameworkVersionSummary = z.infer<typeof FrameworkVersionSummary>;
export type FrameworkMappingView = z.infer<typeof FrameworkMappingView>;
export type FrameworkMappingEntry = z.infer<typeof FrameworkMappingEntry>;
export type EvidenceLinkItem = z.infer<typeof EvidenceLinkItem>;
export type EvidenceCoverage = z.infer<typeof EvidenceCoverage>;
