import { z } from "zod";

/**
 * Quality: the inspector evidence pack and the statement of purpose (quality.md sections 4 and 5;
 * QUAL-003, QUAL-009; ADR-0050; hazard HZ-050). Times are ISO 8601 with offset, dates yyyy-mm-dd
 * (UK dates). Field values appear only as the pack shows them (minimised and redacted); a withheld
 * field never carries one.
 */

const uuid = z.uuid();
const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const words = (max: number) => z.string().trim().min(1).max(max);
/** The version the change is based on; a stale one is refused with 409. */
const version = z.number().int().min(1);
/** Opaque quality statement ids until the framework model (QUAL-001). */
const statementId = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

// ------------------------------------------------------------------------------------------------
// Evidence packs (rules 1 to 10)
// ------------------------------------------------------------------------------------------------

export const EvidencePackState = z
  .enum(["draft", "released", "revoked", "discarded"])
  .meta({ id: "EvidencePackState" });

export const EvidenceRecordType = z.enum(["incident", "care_note", "observation"]).meta({
  id: "EvidenceRecordType",
  description:
    "The record types a pack can take through the API so far; the other types of the field map follow (quality.md section 13).",
});

export const ComposeEvidencePack = z
  .object({
    recipient: z.object({
      name: words(120),
      organisation: words(120),
      email: z.string().trim().max(254),
    }),
    purpose: words(500),
    from: isoDate,
    to: isoDate,
    locationIds: z.array(uuid).min(1).max(50),
    /** Null for every statement. */
    qualityStatementIds: z.array(statementId).min(1).max(100).nullable(),
    /** Chosen explicitly: there is no "everyone". */
    personIds: z.array(uuid).min(1).max(500),
    staffNames: z.enum(["role_only", "include"]).default("role_only"),
  })
  .meta({ id: "ComposeEvidencePack" });
export type ComposeEvidencePack = z.infer<typeof ComposeEvidencePack>;

export const AddEvidenceItems = z
  .object({
    items: z
      .array(
        z.object({
          recordType: EvidenceRecordType,
          recordId: uuid,
          /** The statements the record is evidence for (tagging until QUAL-002). */
          qualityStatementIds: z.array(statementId).min(1).max(20),
        }),
      )
      .min(1)
      .max(50),
    version,
  })
  .meta({ id: "AddEvidenceItems" });

export const RedactEvidenceField = z
  .object({ text: words(5000), version })
  .meta({ id: "RedactEvidenceField" });

export const ReleaseEvidencePack = z
  .object({
    /** Omitted: the organisation's default (evidence_pack.link_expiry_days.default). */
    expiresAt: isoDateTime.optional(),
    version,
  })
  .meta({ id: "ReleaseEvidencePack" });

export const ReissueEvidencePackLink = z
  .object({ expiresAt: isoDateTime.optional(), version })
  .meta({ id: "ReissueEvidencePackLink" });

export const EndEvidencePack = z
  .object({ reason: words(500), version })
  .meta({ id: "EndEvidencePack" });

export const EvidencePackLinkIssued = z
  .object({
    linkId: uuid,
    /** Shown once: only its hash is stored. Send it to the recipient; the code goes separately. */
    token: z.string(),
    expiresAt: isoDateTime,
  })
  .meta({ id: "EvidencePackLinkIssued" });

export const EvidencePackField = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: z.enum([
      "organisational",
      "care_content",
      "direct_identifier",
      "staff_name",
      "third_party",
      "free_text",
    ]),
    outcome: z.enum(["included", "redacted", "withheld"]),
    reason: z.string().nullable(),
    /** Why, in words (EVIDENCE_REDACTION_TEXT); null when included. */
    reasonText: z.string().nullable(),
    redactedBy: uuid.nullable(),
    /** As the pack shows it; null when withheld or once the bundle is deleted. */
    value: z.string().nullable(),
  })
  .meta({ id: "EvidencePackField" });

export const EvidencePackItem = z
  .object({
    id: uuid,
    recordType: z.string(),
    recordId: uuid,
    recordVersion: z.number().int(),
    title: z.string(),
    occurredAt: isoDateTime,
    qualityStatementIds: z.array(z.string()),
    /** Null when included; excluded items are in the internal manifest only. */
    exclusionReason: z.string().nullable(),
    fields: z.array(EvidencePackField),
  })
  .meta({ id: "EvidencePackItem" });

export const EvidencePackLinkItem = z
  .object({
    id: uuid,
    issuedAt: isoDateTime,
    issuedBy: uuid,
    expiresAt: isoDateTime,
    replacesLinkId: uuid.nullable(),
    revokedAt: isoDateTime.nullable(),
    revocationReason: z.string().nullable(),
    failedCodeAttempts: z.number().int(),
    locked: z.boolean(),
    lastOpenedAt: isoDateTime.nullable(),
  })
  .meta({ id: "EvidencePackLinkItem" });

export const EvidencePackSummary = z
  .object({
    id: uuid,
    state: EvidencePackState,
    recipientName: z.string(),
    recipientOrganisation: z.string(),
    purpose: z.string(),
    from: isoDate,
    to: isoDate,
    locationIds: z.array(uuid),
    composedBy: uuid,
    composedAt: isoDateTime,
    releasedAt: isoDateTime.nullable(),
    revokedAt: isoDateTime.nullable(),
    discardedAt: isoDateTime.nullable(),
    version: z.number().int(),
  })
  .meta({ id: "EvidencePackSummary" });

export const EvidencePackList = z
  .object({ items: z.array(EvidencePackSummary) })
  .meta({ id: "EvidencePackList" });

export const EvidencePackDetail = EvidencePackSummary.extend({
  recipientEmail: z.string(),
  personIds: z.array(uuid),
  qualityStatementIds: z.array(z.string()).nullable(),
  staffNames: z.enum(["role_only", "include"]),
  watermark: z.string(),
  /** Everyone who shaped the pack: none of them may release it or issue its link. */
  contributorIds: z.array(uuid),
  releasedBy: uuid.nullable(),
  revokedBy: uuid.nullable(),
  revocationReason: z.string().nullable(),
  discardedBy: uuid.nullable(),
  discardReason: z.string().nullable(),
  /** The current items (a hand redaction replaces the row it redacts). */
  items: z.array(EvidencePackItem),
  /** Included items per quality statement. */
  coverage: z.record(z.string(), z.number().int()),
  links: z.array(EvidencePackLinkItem),
  /** The shown values were deleted when the link ended or the pack was revoked or discarded. */
  bundleDeleted: z.boolean(),
}).meta({ id: "EvidencePackDetail" });
export type EvidencePackDetail = z.infer<typeof EvidencePackDetail>;

// ------------------------------------------------------------------------------------------------
// The statement of purpose (rules 11 to 15)
// ------------------------------------------------------------------------------------------------

const contact = z.object({
  fullName: z.string().trim().max(200),
  businessAddress: z.string().trim().max(500),
  businessPhone: z.string().trim().max(40),
  email: z.string().trim().max(254).nullable(),
});

export const StatementOfPurposeContent = z
  .object({
    aimsAndObjectives: z.string().max(10_000),
    serviceKinds: z.array(z.string().trim().max(200)).max(20),
    needsMet: z.string().max(10_000),
    provider: contact,
    registeredManagers: z.array(contact.extend({ id: uuid })).max(50),
    serviceAddress: z.string().trim().max(500),
    consentsToEmailService: z.boolean(),
    serviceEmail: z.string().trim().max(254).nullable(),
    legalStatus: z
      .enum([
        "individual",
        "partnership",
        "limited_company",
        "limited_liability_partnership",
        "charitable_incorporated_organisation",
        "community_interest_company",
        "nhs_body",
        "local_authority",
        "other",
      ])
      .nullable(),
    legalStatusDetail: z.string().trim().max(200).nullable(),
    locations: z
      .array(
        z.object({
          id: uuid,
          name: z.string().trim().max(200),
          address: z.string().trim().max(500),
          cqcLocationId: z.string().trim().max(20).nullable(),
        }),
      )
      .max(100),
  })
  .meta({ id: "StatementOfPurposeContent" });
export type StatementOfPurposeContent = z.infer<typeof StatementOfPurposeContent>;

export const StatementOfPurposeState = z
  .enum(["draft", "approved", "superseded", "discarded"])
  .meta({ id: "StatementOfPurposeState" });

export const StatementOfPurposeVersionItem = z
  .object({
    id: uuid,
    versionNumber: z.number().int(),
    state: StatementOfPurposeState,
    kind: z.enum(["baseline", "revision"]),
    content: StatementOfPurposeContent,
    authorId: uuid,
    contributorIds: z.array(uuid),
    supersedesId: uuid.nullable(),
    /** Schedule 3: what is missing, in words; empty when complete. */
    missing: z.array(z.string()),
    warnings: z.array(z.string()),
    changeSummary: z.array(z.unknown()),
    registrationPrompts: z.array(z.unknown()),
    approvedBy: uuid.nullable(),
    approvedAt: isoDateTime.nullable(),
    notification: z.object({
      state: z.enum(["not_required", "due", "overdue", "notified"]),
      dueAt: isoDateTime.nullable(),
      notifiedAt: isoDateTime.nullable(),
      notifiedBy: uuid.nullable(),
      late: z.boolean(),
    }),
    discardReason: z.string().nullable(),
    version: z.number().int(),
  })
  .meta({ id: "StatementOfPurposeVersionItem" });
export type StatementOfPurposeVersionItem = z.infer<typeof StatementOfPurposeVersionItem>;

export const StatementOfPurposeVersionList = z
  .object({ items: z.array(StatementOfPurposeVersionItem) })
  .meta({ id: "StatementOfPurposeVersionList" });

export const DraftStatementOfPurpose = z
  .object({
    /** Required for the baseline; a revision starts from the current version when omitted. */
    content: StatementOfPurposeContent.optional(),
  })
  .meta({ id: "DraftStatementOfPurpose" });

export const EditStatementOfPurpose = z
  .object({ content: StatementOfPurposeContent, version })
  .meta({ id: "EditStatementOfPurpose" });

export const ApproveStatementOfPurpose = z
  .object({ version })
  .meta({ id: "ApproveStatementOfPurpose" });

export const DiscardStatementOfPurpose = z
  .object({ reason: words(500), version })
  .meta({ id: "DiscardStatementOfPurpose" });

export const RecordStatementOfPurposeNotification = z
  .object({
    sentAt: isoDateTime,
    /** The CQC reference, or how and when it was sent. */
    evidence: words(500),
  })
  .meta({ id: "RecordStatementOfPurposeNotification" });

export const StatementOfPurposeChanges = z
  .object({
    /** The version compared against: the current one for a draft, the one superseded otherwise. */
    comparedWithId: uuid.nullable(),
    sections: z.array(
      z.object({
        key: z.string(),
        title: z.string(),
        change: z.enum(["unchanged", "changed"]),
        lines: z.array(z.string()),
      }),
    ),
    registrationPrompts: z.array(z.object({ kind: z.string(), message: z.string() })),
  })
  .meta({ id: "StatementOfPurposeChanges" });
