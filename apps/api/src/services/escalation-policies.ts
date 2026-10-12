import type { EscalationPolicyRef } from "@harbour/contracts";
import { escalationPolicyLink, type Transaction } from "@harbour/db";
import {
  type EscalationPolicyLink,
  type EscalationPolicyTool,
  escalationPolicyFor,
  isEscalationPolicyTool,
} from "@harbour/domain";
import { isNull } from "drizzle-orm";

/**
 * The organisation's escalation policies beside validated-tool results (care.md section 5,
 * escalation policies; medical-device boundary section 5 rule 4; HZ-012, HZ-014; H-73): read once
 * per response, resolved per result by `escalationPolicyFor`, the most specific live link for the
 * result's tool, band and location, or "not configured". Harbour adds nothing of its own.
 */

/** The organisation's live links, as the domain reads them. */
export async function escalationLinks(tx: Transaction): Promise<readonly EscalationPolicyLink[]> {
  const rows = await tx
    .select()
    .from(escalationPolicyLink)
    .where(isNull(escalationPolicyLink.deletedAt));
  return rows.flatMap((r) =>
    isEscalationPolicyTool(r.toolKey)
      ? [
          {
            id: r.id,
            toolKey: r.toolKey,
            band: r.band,
            locationId: r.locationId,
            title: r.title,
            reference: r.reference,
            documentId: r.documentId,
          },
        ]
      : [],
  );
}

/** The policy a result links, as the contracts return it. */
export function escalationRef(
  links: readonly EscalationPolicyLink[],
  result: {
    readonly toolKey: EscalationPolicyTool;
    readonly band: string | null;
    readonly locationId: string | null;
  },
): EscalationPolicyRef {
  const resolved = escalationPolicyFor(links, result);
  if (resolved.status === "not_configured") {
    return { status: "not_configured", toolKey: resolved.toolKey, band: resolved.band };
  }
  return {
    status: "configured",
    toolKey: resolved.toolKey,
    band: resolved.band,
    linkId: resolved.link.id,
    title: resolved.link.title,
    reference: resolved.link.reference,
    documentId: resolved.link.documentId,
    matchedOn: resolved.matchedOn,
    scope: resolved.scope,
  };
}

/** The NEWS2 band an observation's flags carry, or null (not vital signs, or no score). */
export function news2Band(flags: unknown): string | null {
  if (typeof flags !== "object" || flags === null) return null;
  const news2 = (flags as { news2?: unknown }).news2;
  if (typeof news2 !== "object" || news2 === null) return null;
  const band = (news2 as { band?: unknown }).band;
  return typeof band === "string" ? band : null;
}
