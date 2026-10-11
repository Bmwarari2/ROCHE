import type { SharingDecisionOut } from "@harbour/contracts";
import { aboutMeShareLink, sharingDecision, type Transaction } from "@harbour/db";
import {
  type AuthorityRole,
  type CapacityForSharing,
  checkSectionVisibility,
  type PersonStatus,
  type SharingBasis,
  type SharingDecision,
  type SharingRecipient,
  type SharingSection,
} from "@harbour/domain";
import { and, eq, isNull } from "drizzle-orm";

/**
 * Sharing decisions as the sharing rules read them (people.md rule 13; HZ-022). A decision for a
 * share link has no recipient of its own: each link names its decision, and the link is the
 * recipient the rules check.
 */

export type SharingRow = typeof sharingDecision.$inferSelect;

export function toSharingDecision(row: SharingRow, linkId: string | null = null): SharingDecision {
  const recipient: SharingRecipient =
    row.recipientKind === "family"
      ? { kind: "family", contactId: row.recipientContactId ?? "" }
      : row.recipientKind === "professional"
        ? { kind: "professional", tenantUserId: row.recipientTenantUserId ?? "" }
        : { kind: "link", linkId: linkId ?? "" };
  return {
    id: row.id,
    personId: row.personId,
    recipient,
    sections: row.sections,
    carePlanDomains: row.carePlanDomains ?? "all",
    basis: row.basis as SharingBasis,
    consentGivenBy: (row.consentGivenBy ?? null) as SharingDecision["consentGivenBy"],
    capacity: row.capacity as CapacityForSharing,
    bestInterestsDecisionId: row.bestInterestsDecisionId,
    authority:
      row.authorityRole && row.authorityContactId
        ? {
            role: row.authorityRole as AuthorityRole,
            contactId: row.authorityContactId,
            reference: row.authorityReference,
            evidenceDocumentId: row.authorityEvidenceDocumentId,
            validUntil: row.authorityValidUntil,
          }
        : null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    withdrawnAt: row.withdrawnAt,
    suspendedAt: row.suspendedAt,
  };
}

/** Whether a stored decision is in force now for its own recipient and sections. */
export function decisionInForce(row: SharingRow, personStatus: PersonStatus, now: Date): boolean {
  const decision = toSharingDecision(row, row.recipientKind === "link" ? "link" : null);
  const section = row.sections[0] as SharingSection | undefined;
  if (!section) return false;
  return checkSectionVisibility([decision], {
    personId: row.personId,
    personStatus,
    recipient: decision.recipient,
    section,
    now,
  }).visible;
}

export function sharingDecisionOut(
  row: SharingRow,
  personStatus: PersonStatus,
  now: Date,
): SharingDecisionOut {
  return {
    id: row.id,
    personId: row.personId,
    recipient:
      row.recipientKind === "family"
        ? { kind: "family", contactId: row.recipientContactId ?? "" }
        : row.recipientKind === "professional"
          ? { kind: "professional", tenantUserId: row.recipientTenantUserId ?? "" }
          : { kind: "link" },
    sections: row.sections as SharingSection[],
    carePlanDomains: row.carePlanDomains,
    basis: row.basis as SharingBasis,
    consentGivenBy: (row.consentGivenBy ?? null) as SharingDecisionOut["consentGivenBy"],
    capacity: row.capacity as CapacityForSharing,
    capacityAssessmentId: row.capacityAssessmentId,
    bestInterestsDecisionId: row.bestInterestsDecisionId,
    authority:
      row.authorityRole && row.authorityContactId
        ? {
            role: row.authorityRole as AuthorityRole,
            contactId: row.authorityContactId,
            ...(row.authorityReference ? { reference: row.authorityReference } : {}),
            ...(row.authorityEvidenceDocumentId
              ? { evidenceDocumentId: row.authorityEvidenceDocumentId }
              : {}),
            ...(row.authorityValidUntil ? { validUntil: row.authorityValidUntil } : {}),
          }
        : null,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo.toISOString(),
    withdrawnAt: row.withdrawnAt?.toISOString() ?? null,
    withdrawnReason: row.withdrawnReason,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspendedReason: row.suspendedReason,
    inForce: decisionInForce(row, personStatus, now),
    recordedBy: row.createdBy,
    version: row.version,
  };
}

export async function personDecisions(tx: Transaction, personId: string) {
  return tx
    .select()
    .from(sharingDecision)
    .where(and(eq(sharingDecision.personId, personId), isNull(sharingDecision.deletedAt)));
}

/** The decisions as the rules read them, with each share link as its own recipient. */
export async function decisionsWithLinks(tx: Transaction, personId: string) {
  const rows = await personDecisions(tx, personId);
  const links = await tx
    .select({ id: aboutMeShareLink.id, decisionId: aboutMeShareLink.sharingDecisionId })
    .from(aboutMeShareLink)
    .where(eq(aboutMeShareLink.personId, personId));
  return rows.flatMap((row) =>
    row.recipientKind === "link"
      ? links.filter((l) => l.decisionId === row.id).map((l) => toSharingDecision(row, l.id))
      : [toSharingDecision(row)],
  );
}
