"use server";

import {
  ComposeEvidencePack,
  type EvidencePackDetail,
  RedactEvidenceField,
  StatementOfPurposeContent,
  type StatementOfPurposeVersionItem,
} from "@harbour/contracts";
import { isUuid } from "@/lib/context-cookies";
import { type ComposeBody, linkStopsAt, type RecordChoice } from "@/lib/evidence-packs";
import { t } from "@/lib/i18n";
import { type ActionResult, refused } from "@/lib/outcome";
import { sendQuality } from "@/lib/quality-actions";
import { isIsoInstant } from "@/lib/uk-time";

/**
 * Writes for the evidence pack and statement of purpose screens (quality.md section 16; QUAL-003,
 * QUAL-009; HZ-050, HZ-080). The API checks every permission, separation of duties, step-up and
 * rule; the web holds nothing of its own. A link's token is returned to the page that released it
 * and nowhere else: never logged, stored or put in a URL here.
 */

const PACKS = "/quality/evidence-packs";
const SOP = "/quality/statement-of-purpose";
const packPaths = (id: string) => [PACKS, `${PACKS}/${id}`];
const notFound = () => refused(t("errors.notFound"), "not_found");
/** Server actions are public endpoints: anything malformed is refused here, never passed on. */
const invalid = () => refused(t("care.errors.invalid"));
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 1;
const isReason = (v: unknown, max = 500): v is string =>
  typeof v === "string" && v.trim().length >= 1 && v.length <= max;

export async function composeEvidencePack(
  body: ComposeBody,
): Promise<ActionResult<EvidencePackDetail>> {
  const parsed = ComposeEvidencePack.safeParse(body);
  if (!parsed.success) return invalid();
  return sendQuality("pack", [PACKS], (api) =>
    api.POST("/v1/evidence-packs", { body: parsed.data }),
  );
}

export async function addEvidenceItems(
  packId: string,
  input: { readonly items: readonly RecordChoice[]; readonly version: number },
): Promise<ActionResult<EvidencePackDetail>> {
  if (!isUuid(packId)) return notFound();
  if (!isVersion(input.version) || input.items.length < 1 || input.items.length > 50) {
    return invalid();
  }
  return sendQuality("pack", packPaths(packId), (api) =>
    api.POST("/v1/evidence-packs/{id}/items", {
      params: { path: { id: packId } },
      body: {
        items: input.items.map((i) => ({
          recordType: i.recordType,
          recordId: i.recordId,
          qualityStatementIds: [...i.qualityStatementIds],
        })),
        version: input.version,
      },
    }),
  );
}

export async function redactEvidenceField(
  packId: string,
  itemId: string,
  key: string,
  input: { readonly text: string; readonly version: number },
): Promise<ActionResult<EvidencePackDetail>> {
  if (!isUuid(packId) || !isUuid(itemId) || !/^[a-z_]{1,64}$/.test(key)) return notFound();
  if (!RedactEvidenceField.safeParse(input).success) return invalid();
  return sendQuality("pack", packPaths(packId), (api) =>
    api.PUT("/v1/evidence-packs/{id}/items/{itemId}/fields/{key}/redaction", {
      params: { path: { id: packId, itemId, key } },
      body: { text: input.text, version: input.version },
    }),
  );
}

export interface LinkIssued {
  readonly linkId: string;
  readonly token: string;
  readonly expiresAt: string;
}

/**
 * The instant a link chosen to work for `days` UK days from now stops, by the server's clock;
 * undefined for the organisation's default (no choice); null when the choice is not a whole
 * number of days, which is refused rather than quietly replaced by the default. The API holds
 * the maximum.
 */
function expiryFor(days: number | null): string | undefined | null {
  if (days === null) return undefined;
  if (!Number.isInteger(days) || days < 1 || days > 366) return null;
  return linkStopsAt(new Date(), days).toISOString();
}

/** Release a draft and issue its link (`quality.evidence_pack.release`, step-up, rule 6). */
export async function releaseEvidencePack(
  packId: string,
  input: { readonly days: number | null; readonly version: number },
): Promise<ActionResult<LinkIssued>> {
  if (!isUuid(packId)) return notFound();
  const expiresAt = expiryFor(input.days);
  if (expiresAt === null || !isVersion(input.version)) return invalid();
  return sendQuality("pack", packPaths(packId), (api) =>
    api.POST("/v1/evidence-packs/{id}/release", {
      params: { path: { id: packId } },
      body: { version: input.version, ...(expiresAt ? { expiresAt } : {}) },
    }),
  );
}

/** A new link to the same recipient (a release: step-up, not a contributor; rule 9). */
export async function reissueEvidenceLink(
  packId: string,
  linkId: string,
  input: { readonly days: number | null; readonly version: number },
): Promise<ActionResult<LinkIssued>> {
  if (!isUuid(packId) || !isUuid(linkId)) return notFound();
  const expiresAt = expiryFor(input.days);
  if (expiresAt === null || !isVersion(input.version)) return invalid();
  return sendQuality("pack", packPaths(packId), (api) =>
    api.POST("/v1/evidence-packs/{id}/links/{linkId}/reissue", {
      params: { path: { id: packId, linkId } },
      body: { version: input.version, ...(expiresAt ? { expiresAt } : {}) },
    }),
  );
}

export async function revokeEvidencePack(
  packId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<EvidencePackDetail>> {
  if (!isUuid(packId)) return notFound();
  if (!isReason(input.reason) || !isVersion(input.version)) return invalid();
  return sendQuality("pack", packPaths(packId), (api) =>
    api.POST("/v1/evidence-packs/{id}/revoke", {
      params: { path: { id: packId } },
      body: input,
    }),
  );
}

export async function discardEvidencePack(
  packId: string,
  input: { readonly reason: string; readonly version: number },
): Promise<ActionResult<EvidencePackDetail>> {
  if (!isUuid(packId)) return notFound();
  if (!isReason(input.reason) || !isVersion(input.version)) return invalid();
  return sendQuality("pack", packPaths(packId), (api) =>
    api.POST("/v1/evidence-packs/{id}/discard", {
      params: { path: { id: packId } },
      body: input,
    }),
  );
}

// ------------------------------------------------------------------------------------------------
// The statement of purpose
// ------------------------------------------------------------------------------------------------

type VersionResult = Promise<ActionResult<StatementOfPurposeVersionItem>>;

/** Start a draft: the baseline with its content, or a revision from the current version. */
export async function startStatementDraft(
  content: StatementOfPurposeContent | null,
): VersionResult {
  return sendQuality("sop", [SOP], (api) =>
    api.POST("/v1/statement-of-purpose/versions", { body: content ? { content } : {} }),
  );
}

export async function saveStatementDraft(
  id: string,
  input: { readonly content: StatementOfPurposeContent; readonly version: number },
): VersionResult {
  if (!isUuid(id)) return notFound();
  if (!StatementOfPurposeContent.safeParse(input.content).success || !isVersion(input.version)) {
    return invalid();
  }
  return sendQuality("sop", [SOP], (api) =>
    api.PUT("/v1/statement-of-purpose/versions/{id}", {
      params: { path: { id } },
      body: input,
    }),
  );
}

export async function approveStatement(id: string, version: number): VersionResult {
  if (!isUuid(id)) return notFound();
  if (!isVersion(version)) return invalid();
  return sendQuality("sop", [SOP], (api) =>
    api.POST("/v1/statement-of-purpose/versions/{id}/approve", {
      params: { path: { id } },
      body: { version },
    }),
  );
}

export async function discardStatement(
  id: string,
  input: { readonly reason: string; readonly version: number },
): VersionResult {
  if (!isUuid(id)) return notFound();
  if (!isReason(input.reason) || !isVersion(input.version)) return invalid();
  return sendQuality("sop", [SOP], (api) =>
    api.POST("/v1/statement-of-purpose/versions/{id}/discard", {
      params: { path: { id } },
      body: input,
    }),
  );
}

/** Record that a revision was sent to CQC (`safety.notification.submit`, step-up; rule 15). */
export async function recordStatementNotification(
  id: string,
  input: { readonly sentAt: string | null; readonly evidence: string },
): VersionResult {
  if (!isUuid(id)) return notFound();
  if (!isReason(input.evidence)) return invalid();
  // "Just now" is when the server receives the form, never the browser's clock (HZ-090).
  const sentAt = input.sentAt ?? new Date().toISOString();
  if (!isIsoInstant(sentAt)) {
    return refused(t("quality.sop.notify.whenError"), "invalid", ["sentAt"]);
  }
  return sendQuality("sop", [SOP], (api) =>
    api.POST("/v1/statement-of-purpose/versions/{id}/notification", {
      params: { path: { id } },
      body: { sentAt, evidence: input.evidence },
    }),
  );
}
