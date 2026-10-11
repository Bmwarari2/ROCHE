import type { SharingDecisionOut } from "@harbour/contracts";
import {
  aboutMeShareLink,
  capacityAssessment,
  sharingDecision,
  sharingDecisionSuspension,
  type Transaction,
} from "@harbour/db";
import {
  type AuthorityRole,
  type CapacityForSharing,
  capacityFinding,
  checkSectionVisibility,
  type PersonStatus,
  type SharingBasis,
  type SharingDecision,
  type SharingRecipient,
  type SharingSection,
  ukIsoDate,
} from "@harbour/domain";
import { and, asc, eq, isNull } from "drizzle-orm";
import { capacityViews } from "./mca";

/**
 * Sharing decisions as the sharing rules read them (people.md rule 13; comms.md rules 2 and 5;
 * HZ-022). A decision for a share link has no recipient of its own: each link names its decision,
 * and the link is the recipient the rules check. Suspensions are periods
 * (`sharing_decision_suspension`), and a decision that rests on the person lacking capacity is
 * judged against the current capacity finding for the sharing decision.
 */

export type SharingRow = typeof sharingDecision.$inferSelect;
export type SuspensionRow = typeof sharingDecisionSuspension.$inferSelect;

/** What the rules need besides the decisions: their suspension periods and capacity now. */
export interface SharingContext {
  readonly suspensions: ReadonlyMap<string, readonly SuspensionRow[]>;
  readonly capacityNow: CapacityForSharing;
}

export function toSharingDecision(
  row: SharingRow,
  linkId: string | null = null,
  suspensions: readonly SuspensionRow[] = [],
): SharingDecision {
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
            orderSections: (row.authorityOrderSections ?? null) as SharingSection[] | null,
          }
        : null,
    validFrom: row.validFrom,
    validTo: row.validTo,
    withdrawnAt: row.withdrawnAt,
    // The open suspension kept on the decision counts as well as the periods (fail closed).
    suspendedAt: row.suspendedAt,
    suspensions: suspensions
      .filter((s) => s.deletedAt === null)
      .map((s) => ({ from: s.suspendedAt, to: s.liftedAt })),
  };
}

/** Each decision's suspension periods for one person, oldest first. */
export async function personSuspensions(
  tx: Transaction,
  personId: string,
): Promise<Map<string, SuspensionRow[]>> {
  const rows = await tx
    .select()
    .from(sharingDecisionSuspension)
    .where(
      and(
        eq(sharingDecisionSuspension.personId, personId),
        isNull(sharingDecisionSuspension.deletedAt),
      ),
    )
    .orderBy(asc(sharingDecisionSuspension.suspendedAt));
  const byDecision = new Map<string, SuspensionRow[]>();
  for (const row of rows) {
    byDecision.set(row.sharingDecisionId, [...(byDecision.get(row.sharingDecisionId) ?? []), row]);
  }
  return byDecision;
}

/**
 * The person's capacity for the sharing decision now: the latest assessment of the sharing
 * decision made by now, or presumed capacity when there is none (MCA 2005 s.1(2)). An assessment
 * of a different decision never counts (decision-specific).
 */
export async function capacityForSharingNow(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<CapacityForSharing> {
  const views = capacityViews(
    await tx.select().from(capacityAssessment).where(eq(capacityAssessment.personId, personId)),
  );
  const finding = capacityFinding(views, "sharing", now, ukIsoDate(now));
  if (finding.status === "lacks_capacity") return "assessed_lacks_capacity";
  if (finding.status === "has_capacity") return "assessed_has_capacity";
  return "presumed";
}

export async function sharingContext(
  tx: Transaction,
  personId: string,
  now: Date,
): Promise<SharingContext> {
  const [suspensions, capacityNow] = await Promise.all([
    personSuspensions(tx, personId),
    capacityForSharingNow(tx, personId, now),
  ]);
  return { suspensions, capacityNow };
}

/** Whether a stored decision is in force now for its own recipient and every one of its sections. */
export function decisionInForce(
  row: SharingRow,
  personStatus: PersonStatus,
  now: Date,
  context: SharingContext,
): boolean {
  const decision = toSharingDecision(
    row,
    row.recipientKind === "link" ? "link" : null,
    context.suspensions.get(row.id),
  );
  if (row.sections.length === 0) return false;
  return row.sections.every(
    (section) =>
      checkSectionVisibility([decision], {
        personId: row.personId,
        personStatus,
        recipient: decision.recipient,
        section: section as SharingSection,
        capacityNow: context.capacityNow,
        now,
      }).visible,
  );
}

export function sharingDecisionOut(
  row: SharingRow,
  personStatus: PersonStatus,
  now: Date,
  context: SharingContext,
): SharingDecisionOut {
  const iso = (d: Date | null) => d?.toISOString() ?? null;
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
            ...(row.authorityOrderSections
              ? { orderSections: row.authorityOrderSections as SharingSection[] }
              : {}),
          }
        : null,
    validFrom: row.validFrom.toISOString(),
    validTo: row.validTo.toISOString(),
    withdrawnAt: iso(row.withdrawnAt),
    withdrawnReason: row.withdrawnReason,
    suspendedAt: iso(row.suspendedAt),
    suspendedReason: row.suspendedReason,
    suspensions: (context.suspensions.get(row.id) ?? []).map((s) => ({
      id: s.id,
      suspendedAt: s.suspendedAt.toISOString(),
      reason: s.reason,
      liftedAt: iso(s.liftedAt),
      liftedBy: s.liftedBy,
      liftedReason: s.liftedReason,
    })),
    inForce: decisionInForce(row, personStatus, now, context),
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
export async function decisionsWithLinks(
  tx: Transaction,
  personId: string,
  context: SharingContext,
) {
  const rows = await personDecisions(tx, personId);
  const links = await tx
    .select({ id: aboutMeShareLink.id, decisionId: aboutMeShareLink.sharingDecisionId })
    .from(aboutMeShareLink)
    .where(eq(aboutMeShareLink.personId, personId));
  return rows.flatMap((row) => {
    const periods = context.suspensions.get(row.id);
    return row.recipientKind === "link"
      ? links
          .filter((l) => l.decisionId === row.id)
          .map((l) => toSharingDecision(row, l.id, periods))
      : [toSharingDecision(row, null, periods)];
  });
}
