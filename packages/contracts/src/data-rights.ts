import { z } from "zod";
import { StaffName } from "./staff";

/**
 * The DSAR workbench (PLAT-022; platform.md, Phase 2: the DSAR workbench; ADR-0090): data subject
 * requests from or for a person supported, a contact or a member of staff, with the statutory clock
 * worked out on read, collection over the export catalogue, redaction decided by a person, the
 * bundle, rectification and erasure recorded, and portability where it applies.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const ukDate = z.iso.date();
const reason = z.string().trim().min(1).max(2000);

export const DsarRequestKind = z
  .enum(["access", "rectification", "erasure", "portability"])
  .meta({ id: "DsarRequestKind" });
export const DsarSubjectKind = z
  .enum(["person", "contact", "staff"])
  .meta({ id: "DsarSubjectKind" });
export const DsarAuthority = z
  .enum(["lpa_health_welfare", "lpa_property_finance", "deputy", "written_authority", "other"])
  .meta({ id: "DsarAuthority" });
export const DsarChannel = z
  .enum(["email", "post", "phone", "in_person", "portal"])
  .meta({ id: "DsarChannel" });
export const DsarIdentityMethod = z
  .enum(["document_seen", "known_to_staff", "authority_checked", "portal_account"])
  .meta({ id: "DsarIdentityMethod" });
export const DsarDecision = z
  .enum(["pending", "disclose", "redact", "withhold"])
  .meta({ id: "DsarDecision" });

export const NewDsarCase = z
  .object({
    requestKind: DsarRequestKind,
    subjectKind: DsarSubjectKind,
    subjectPersonId: uuid.nullable().default(null),
    subjectContactId: uuid.nullable().default(null),
    subjectStaffId: uuid.nullable().default(null),
    requesterKind: z.enum(["subject", "representative"]),
    requesterName: z.string().trim().min(1).max(200).nullable().default(null),
    requesterAddress: z.string().trim().max(1000).nullable().default(null),
    authority: DsarAuthority.nullable().default(null),
    channel: DsarChannel,
    receivedOn: ukDate,
    /** Whether proof of identity is needed before the clock starts (rule 2). */
    identityRequired: z.boolean().default(true),
  })
  .meta({ id: "NewDsarCase" });
export type NewDsarCase = z.infer<typeof NewDsarCase>;

export const DsarClockView = z
  .object({
    state: z.enum(["awaiting_identity", "running", "paused", "due_soon", "overdue", "closed"]),
    startedOn: ukDate.nullable(),
    dueOn: ukDate.nullable(),
    originalDueOn: ukDate.nullable(),
    pausedDays: z.number().int(),
    extended: z.boolean(),
    late: z.boolean().nullable(),
  })
  .meta({ id: "DsarClockView" });

export const DsarSubject = z
  .object({
    kind: DsarSubjectKind,
    personId: uuid.nullable(),
    contactId: uuid.nullable(),
    staffId: uuid.nullable(),
    /** The subject's name as the organisation records it. */
    name: z.string(),
  })
  .meta({ id: "DsarSubject" });

export const DsarCaseSummary = z
  .object({
    id: uuid,
    requestKind: DsarRequestKind,
    subject: DsarSubject,
    receivedOn: ukDate,
    status: z.enum(["open", "closed", "withdrawn"]),
    clock: DsarClockView.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DsarCaseSummary" });

export const DsarRectification = z
  .object({
    table: z.string().min(1).max(100),
    recordId: z.string().min(1).max(100),
    field: z.string().min(1).max(100),
    decision: z.enum(["corrected", "declined", "statement_added"]),
    reason,
    decidedOn: ukDate,
  })
  .meta({ id: "DsarRectification" });

export const DsarErasureRecord = z
  .object({
    assessedAt: isoDateTime,
    held: z.number().int(),
    retained: z.number().int(),
    erasable: z.number().int(),
    byClass: z.array(
      z.object({
        recordClass: z.string(),
        outcome: z.enum(["held", "retained", "erasable"]),
        count: z.number().int(),
        /** The latest day a retained record of this class may go, when known. */
        until: ukDate.nullable(),
      }),
    ),
  })
  .meta({ id: "DsarErasureRecord" });

export const DsarCase = DsarCaseSummary.extend({
  requesterKind: z.enum(["subject", "representative"]),
  requesterName: z.string().nullable(),
  requesterAddress: z.string().nullable(),
  authority: DsarAuthority.nullable(),
  channel: DsarChannel,
  identityRequired: z.boolean(),
  identityVerifiedOn: ukDate.nullable(),
  identityMethod: DsarIdentityMethod.nullable(),
  pauses: z.array(z.object({ from: ukDate, to: ukDate.nullable() })),
  extension: z
    .object({
      months: z.number().int(),
      grounds: z.enum(["complex", "multiple_requests"]),
      reason: z.string(),
      decidedOn: ukDate,
    })
    .nullable(),
  /** The clock's refusal, when stored dates no longer satisfy it (shown, never hidden). */
  clockProblem: z.string().nullable(),
  respondedOn: ukDate.nullable(),
  outcome: z.enum(["fulfilled", "partly_fulfilled", "refused", "withdrawn"]).nullable(),
  outcomeReason: z.string().nullable(),
  collectedAt: isoDateTime.nullable(),
  notSearched: z.array(z.string()),
  items: z.object({
    total: z.number().int(),
    pending: z.number().int(),
    disclosed: z.number().int(),
    withheld: z.number().int(),
  }),
  portability: z.object({ applies: z.boolean(), basis: z.string() }),
  rectification: z.array(DsarRectification),
  erasure: DsarErasureRecord.nullable(),
  bundleSha256: z.string().nullable(),
  bundleIssuedAt: isoDateTime.nullable(),
}).meta({ id: "DsarCase" });
export type DsarCase = z.infer<typeof DsarCase>;

export const DsarCaseList = z
  .object({ items: z.array(DsarCaseSummary) })
  .meta({ id: "DsarCaseList" });

const expectedVersion = z.number().int();

export const DsarIdentityInput = z
  .object({ verifiedOn: ukDate, method: DsarIdentityMethod, expectedVersion })
  .meta({ id: "DsarIdentityInput" });
export const DsarPauseStart = z
  .object({ from: ukDate, expectedVersion })
  .meta({ id: "DsarPauseStart" });
export const DsarPauseEnd = z.object({ to: ukDate, expectedVersion }).meta({ id: "DsarPauseEnd" });
export const DsarExtensionInput = z
  .object({
    months: z.number().int().min(1),
    grounds: z.enum(["complex", "multiple_requests"]),
    reason,
    decidedOn: ukDate,
    expectedVersion,
  })
  .meta({ id: "DsarExtensionInput" });

export const DsarCollectResult = z
  .object({
    added: z.number().int(),
    total: z.number().int(),
    tablesSearched: z.number().int(),
    notSearched: z.array(z.string()),
    /** The collection stopped at the item limit; collect again after reviewing. */
    truncated: z.boolean(),
  })
  .meta({ id: "DsarCollectResult" });

export const DsarItem = z
  .object({
    id: uuid,
    tableName: z.string(),
    recordId: z.string(),
    decision: DsarDecision,
    redactedFields: z.array(z.string()),
    reason: z.string().nullable(),
    reviewedBy: StaffName.nullable(),
    reviewedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "DsarItem" });

export const DsarItemList = z
  .object({ items: z.array(DsarItem), total: z.number().int() })
  .meta({ id: "DsarItemList" });

export const DsarItemDetail = DsarItem.extend({
  /** The record as the export shows it (no internal or secret columns); null when it has gone. */
  record: z.record(z.string(), z.unknown()).nullable(),
  /** Other people's names found in the record's text, for the reviewer to judge (never redacted). */
  highlights: z.array(
    z.object({
      field: z.string(),
      name: z.string(),
      start: z.number().int(),
      end: z.number().int(),
    }),
  ),
}).meta({ id: "DsarItemDetail" });

export const DsarItemDecisionInput = z
  .object({
    decision: z.enum(["disclose", "redact", "withhold"]),
    redactedFields: z.array(z.string().min(1).max(100)).max(200).default([]),
    reason: reason.nullable().default(null),
    expectedVersion,
  })
  .meta({ id: "DsarItemDecisionInput" });

export const DsarBundle = z
  .object({
    caseId: uuid,
    format: z.enum(["access", "portable"]),
    generatedAt: isoDateTime,
    subjectKind: DsarSubjectKind,
    records: z.array(
      z.object({
        table: z.string(),
        recordId: z.string(),
        fields: z.record(z.string(), z.unknown()),
      }),
    ),
    redactedCount: z.number().int(),
    withheldCount: z.number().int(),
    notSearched: z.array(z.string()),
    /** SHA-256 of `records`, `redactedCount` and `withheldCount` as canonical JSON. */
    sha256: z.string(),
  })
  .meta({ id: "DsarBundle" });

export const DsarRespondInput = z
  .object({
    respondedOn: ukDate,
    outcome: z.enum(["fulfilled", "partly_fulfilled", "refused", "withdrawn"]),
    outcomeReason: reason.nullable().default(null),
    expectedVersion,
  })
  .meta({ id: "DsarRespondInput" });

export const DsarRectificationInput = z
  .object({ decisions: z.array(DsarRectification).min(1).max(200), expectedVersion })
  .meta({ id: "DsarRectificationInput" });

export const DsarErasureInput = z.object({ expectedVersion }).meta({ id: "DsarErasureInput" });
