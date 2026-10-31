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

/** The link's token: only ever in a request body, never in a URL Harbour serves. */
const linkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const EvidenceLinkCodeRequest = z
  .object({ token: linkToken })
  .meta({ id: "EvidenceLinkCodeRequest" });

export const EvidenceLinkVerify = z
  .object({ token: linkToken, code: z.string().trim().max(12) })
  .meta({ id: "EvidenceLinkVerify" });

export const EvidenceLinkCodeSent = z
  .object({ sent: z.boolean() })
  .meta({ id: "EvidenceLinkCodeSent", description: "Whether the email with the code was sent" });

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
    /** The link's own version, which a new link is issued against (409 when stale). */
    version: z.number().int(),
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
export type EvidencePackSummary = z.infer<typeof EvidencePackSummary>;

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
export type StatementOfPurposeChanges = z.infer<typeof StatementOfPurposeChanges>;

// ------------------------------------------------------------------------------------------------
// Policy library and read-and-sign (quality.md section 18; QUAL-008; HZ-128; slice 25)
// ------------------------------------------------------------------------------------------------

const policyRoleKey = z.string().regex(/^[a-z][a-z0-9_]{1,63}$/, "A role's key");

export const PolicyVersionState = z
  .enum(["draft", "published", "superseded", "retired"])
  .meta({ id: "PolicyVersionState" });
export const PolicyChange = z.enum(["minor", "major"]).meta({ id: "PolicyChange" });
export const PolicyReviewStatus = z
  .enum(["current", "due_soon", "overdue", "no_review_date"])
  .meta({ id: "PolicyReviewStatus" });

const policyDraftFields = {
  change: PolicyChange,
  changeSummary: z.string().trim().min(2).max(2000),
  body: z.string().max(100_000).nullable(),
  documentId: uuid.nullable(),
  roles: z.array(policyRoleKey).max(40),
  reviewDueOn: isoDate.nullable(),
};

export const DraftPolicyVersion = z.object(policyDraftFields).meta({ id: "DraftPolicyVersion" });
export type DraftPolicyVersion = z.infer<typeof DraftPolicyVersion>;

export const NewPolicyVersion = z
  .object({
    change: PolicyChange,
    changeSummary: z.string().trim().min(2).max(2000),
    /** Omitted: the content and roles of the version in force are copied. */
    body: z.string().max(100_000).nullable().optional(),
    documentId: uuid.nullable().optional(),
    roles: z.array(policyRoleKey).max(40).optional(),
    reviewDueOn: isoDate.nullable().optional(),
  })
  .meta({ id: "NewPolicyVersion" });
export type NewPolicyVersion = z.infer<typeof NewPolicyVersion>;

export const CreatePolicy = z
  .object({
    policyKey: policyRoleKey,
    title: z.string().trim().min(2).max(160),
    requireSecondReviewer: z.boolean(),
    firstVersion: z.object({
      changeSummary: z.string().trim().min(2).max(2000),
      body: z.string().max(100_000).nullable(),
      documentId: uuid.nullable(),
      roles: z.array(policyRoleKey).max(40),
      reviewDueOn: isoDate.nullable(),
    }),
  })
  .meta({ id: "CreatePolicy" });
export type CreatePolicy = z.infer<typeof CreatePolicy>;

export const UpdatePolicyVersion = z
  .object({ expectedVersion: version, ...policyDraftFields })
  .meta({ id: "UpdatePolicyVersion" });
export type UpdatePolicyVersion = z.infer<typeof UpdatePolicyVersion>;

export const PublishPolicyVersion = z
  .object({ expectedVersion: version })
  .meta({ id: "PublishPolicyVersion" });

export const RetirePolicy = z
  .object({ expectedVersion: version, reason: z.string().trim().min(10).max(500) })
  .meta({ id: "RetirePolicy" });

export const PolicyVersionItem = z
  .object({
    id: uuid,
    version: z.number().int(),
    versionNumber: z.number().int(),
    state: PolicyVersionState,
    change: PolicyChange,
    changeSummary: z.string(),
    body: z.string().nullable(),
    documentId: uuid.nullable(),
    roles: z.array(z.string()),
    reviewDueOn: isoDate.nullable(),
    reviewStatus: PolicyReviewStatus.nullable(),
    authorId: uuid,
    publishedBy: uuid.nullable(),
    publishedOn: isoDate.nullable(),
    supersededAt: isoDateTime.nullable(),
    /** For a superseded version: the version in force now (HZ-128). */
    supersededBy: uuid.nullable(),
    retiredReason: z.string().nullable(),
  })
  .meta({ id: "PolicyVersionItem" });

export const PolicyItem = z
  .object({
    id: uuid,
    version: z.number().int(),
    policyKey: z.string(),
    title: z.string(),
    requireSecondReviewer: z.boolean(),
    retiredAt: isoDateTime.nullable(),
    inForce: PolicyVersionItem.nullable(),
    /** Newest first: the change log. Drafts only for holders of quality.policy.manage. */
    versions: z.array(PolicyVersionItem),
    mustSign: z.boolean(),
    signed: z.boolean(),
  })
  .meta({ id: "PolicyItem" });
export type PolicyItem = z.infer<typeof PolicyItem>;

export const PolicySummary = z
  .object({
    id: uuid,
    policyKey: z.string(),
    title: z.string(),
    inForce: z
      .object({
        id: uuid,
        versionNumber: z.number().int(),
        change: PolicyChange,
        publishedOn: isoDate.nullable(),
        reviewDueOn: isoDate.nullable(),
        reviewStatus: PolicyReviewStatus,
      })
      .nullable(),
    mustSign: z.boolean(),
    signed: z.boolean(),
  })
  .meta({ id: "PolicySummary" });

export const PolicyList = z.object({ items: z.array(PolicySummary) }).meta({ id: "PolicyList" });

export const ReadAndSignView = z
  .object({
    versionId: uuid,
    required: z.number().int(),
    signed: z.array(z.object({ memberId: uuid, displayName: z.string() })),
    outstanding: z.array(z.object({ memberId: uuid, displayName: z.string(), dueFrom: isoDate })),
  })
  .meta({ id: "ReadAndSignView" });

export const MyPolicies = z
  .object({
    items: z.array(
      z.object({
        policyId: uuid,
        versionId: uuid,
        title: z.string(),
        versionNumber: z.number().int(),
        dueFrom: isoDate,
      }),
    ),
  })
  .meta({ id: "MyPolicies" });
