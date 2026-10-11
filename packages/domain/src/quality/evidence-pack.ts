import { checkWorkflowTransition, defineWorkflow } from "../platform/workflow";
import { isPlausibleEmail, normaliseEmail } from "../shared/email";
import { addUkDays, formatUkDateTime, toUkWallClock } from "../shared/time";
import type { EvidencePackPolicy } from "./rates";

/**
 * Inspector evidence pack (master prompt 11.2, evidence library row: "inspector evidence pack
 * export (PDF bundle, watermarked, time-limited link)"; section 4 inspector role: "read-only,
 * time-boxed, watermarked exports"; quality.md section 4; hazard HZ-050; ADR-0050).
 *
 * The pack is composed from evidence items tagged to quality statements, for a date range and a
 * set of locations, then minimised and redacted by rule: only the people in scope appear, third
 * parties' names are replaced by their role, identifiers are left out, and free text that may name
 * other people is withheld until a person has redacted it. Every withheld or redacted field says
 * why. A different person releases it, by a link bound to one recipient that expires and can be
 * revoked; every page carries a watermark naming the recipient, the purpose, the time and the pack.
 */

// ------------------------------------------------------------------------------------------------
// Evidence items and the request
// ------------------------------------------------------------------------------------------------

/**
 * How a field is treated: `organisational` (no personal data), `care_content` (about the person
 * named in `aboutPersonId`), `direct_identifier` (NHS number, date of birth, address, phone),
 * `staff_name`, `third_party` (relatives, visitors, other residents, witnesses who are not staff)
 * and `free_text` (may mention anyone).
 */
export const EVIDENCE_FIELD_KINDS = [
  "organisational",
  "care_content",
  "direct_identifier",
  "staff_name",
  "third_party",
  "free_text",
] as const;

export type EvidenceFieldKind = (typeof EVIDENCE_FIELD_KINDS)[number];

export interface EvidenceField {
  readonly key: string;
  readonly label: string;
  readonly kind: EvidenceFieldKind;
  readonly value: string;
  /** Whom a `care_content` or `direct_identifier` field is about. */
  readonly aboutPersonId: string | null;
  /** Shown instead of a staff member's or third party's name, for example "relative". */
  readonly role: string | null;
  /** Free text only: a copy a person has redacted by hand, with who did it and when. */
  readonly redacted: { readonly text: string; readonly by: string; readonly at: Date } | null;
}

export interface EvidenceItem {
  readonly id: string;
  readonly recordType: string;
  readonly recordId: string;
  /** The record version the pack shows, so the manifest can rebuild the pack exactly. */
  readonly recordVersion: number;
  readonly locationId: string;
  readonly occurredAt: Date;
  /** A generic label built by Harbour (for example "Fall incident"), never free text. */
  readonly title: string;
  readonly qualityStatementIds: readonly string[];
  /** The people the record is about. */
  readonly aboutPersonIds: readonly string[];
  /** Restricted silos never go in a pack: speak-up concerns, employee relations, legal advice. */
  readonly restricted: boolean;
  readonly fields: readonly EvidenceField[];
}

export interface EvidencePackRecipient {
  readonly name: string;
  readonly organisation: string;
  readonly email: string;
}

export interface EvidencePackRequest {
  readonly packId: string;
  readonly recipient: EvidencePackRecipient;
  readonly purpose: string;
  /** yyyy-mm-dd, inclusive, in UK time. */
  readonly from: string;
  readonly to: string;
  readonly locationIds: readonly string[];
  /** Only items tagged to these statements; null for every tagged item. */
  readonly qualityStatementIds: readonly string[] | null;
  /** The people whose records may appear; everyone else is excluded or withheld. */
  readonly peopleInScope: readonly string[];
  /** Staff names appear only when the request needs them (for example staffing evidence). */
  readonly staffNames: "role_only" | "include";
  readonly composedBy: string;
  readonly composedAt: Date;
}

/** Why: one clear sentence of purpose ("Assessment of Harbour House, safe key question"). */
export const MIN_EVIDENCE_PURPOSE_LENGTH = 15;
/** Why: the watermark must fit across a page; longer purposes are shortened there only. */
export const MAX_WATERMARK_PURPOSE_LENGTH = 80;

export type EvidencePackRequestProblem =
  | "recipient_name_missing"
  | "recipient_organisation_missing"
  | "recipient_email_invalid"
  | "purpose_too_short"
  | "date_range_invalid"
  | "no_locations";

export const EVIDENCE_PACK_REQUEST_MESSAGES: Readonly<Record<EvidencePackRequestProblem, string>> =
  {
    recipient_name_missing: "Name the person the pack is for.",
    recipient_organisation_missing: "Name the recipient's organisation, for example CQC.",
    recipient_email_invalid: "Enter the recipient's work email address.",
    purpose_too_short: "Say what the pack is for, for example 'Assessment of Harbour House'.",
    date_range_invalid: "Choose a start date on or before the end date.",
    no_locations: "Choose at least one location.",
  };

const ISO_DATE_LENGTH = 10;

function isIsoDate(value: string): boolean {
  if (value.length !== ISO_DATE_LENGTH) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, ISO_DATE_LENGTH) === value;
}

function hasText(value: string | null | undefined, min = 1): boolean {
  return (value?.trim().length ?? 0) >= min;
}

export function checkEvidencePackRequest(
  request: EvidencePackRequest,
): readonly EvidencePackRequestProblem[] {
  const problems: EvidencePackRequestProblem[] = [];
  if (!hasText(request.recipient.name)) problems.push("recipient_name_missing");
  if (!hasText(request.recipient.organisation)) problems.push("recipient_organisation_missing");
  if (!isPlausibleEmail(request.recipient.email)) problems.push("recipient_email_invalid");
  if (!hasText(request.purpose, MIN_EVIDENCE_PURPOSE_LENGTH)) problems.push("purpose_too_short");
  if (!isIsoDate(request.from) || !isIsoDate(request.to) || request.from > request.to) {
    problems.push("date_range_invalid");
  }
  if (request.locationIds.length === 0) problems.push("no_locations");
  return problems;
}

// ------------------------------------------------------------------------------------------------
// Minimisation and redaction
// ------------------------------------------------------------------------------------------------

export type EvidenceExclusionReason =
  | "restricted_record"
  | "outside_date_range"
  | "location_not_requested"
  | "not_tagged"
  | "statement_not_requested"
  | "person_not_in_scope";

export type EvidenceFieldOutcome = "included" | "redacted" | "withheld";

export type EvidenceRedactionReason =
  | "third_party"
  | "staff_role_only"
  | "free_text_redacted_by_hand"
  | "person_not_in_scope"
  | "person_unknown"
  | "identifier_not_needed"
  | "free_text_not_reviewed";

/** The words printed where a field is redacted or withheld, so the reader knows why. */
export const EVIDENCE_REDACTION_TEXT: Readonly<Record<EvidenceRedactionReason, string>> = {
  third_party: "Name removed: someone other than the person this record is about.",
  staff_role_only: "Staff name replaced by their role.",
  free_text_redacted_by_hand: "Redacted by hand before release.",
  person_not_in_scope: "Withheld: about a person this pack does not cover.",
  person_unknown: "Withheld: it is not clear whom this is about.",
  identifier_not_needed:
    "Withheld: identifiers are not needed to assess care. Ask the provider if you need them.",
  free_text_not_reviewed:
    "Withheld: free text may name other people and nobody has reviewed and redacted it yet.",
};

export interface EvidencePackField {
  readonly key: string;
  readonly label: string;
  readonly outcome: EvidenceFieldOutcome;
  /** The value shown: the original, a role in brackets, a redacted copy, or null when withheld. */
  readonly value: string | null;
  readonly reason: EvidenceRedactionReason | null;
}

export interface EvidencePackItem {
  readonly itemId: string;
  readonly recordType: string;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly title: string;
  readonly occurredAt: Date;
  readonly qualityStatementIds: readonly string[];
  readonly fields: readonly EvidencePackField[];
}

function bracketed(role: string | null, fallback: string): string {
  return `[${hasText(role) ? (role as string).trim() : fallback}]`;
}

/** The rule for one field (quality.md rule 3), in the order the spec lists them. */
export function minimiseEvidenceField(
  field: EvidenceField,
  scope: {
    readonly peopleInScope: ReadonlySet<string>;
    readonly staffNames: "role_only" | "include";
  },
): EvidencePackField {
  const base = { key: field.key, label: field.label };
  const kept = (value: string): EvidencePackField => ({
    ...base,
    outcome: "included",
    value,
    reason: null,
  });
  const redacted = (value: string, reason: EvidenceRedactionReason): EvidencePackField => ({
    ...base,
    outcome: "redacted",
    value,
    reason,
  });
  const withheld = (reason: EvidenceRedactionReason): EvidencePackField => ({
    ...base,
    outcome: "withheld",
    value: null,
    reason,
  });
  switch (field.kind) {
    case "organisational":
      return kept(field.value);
    case "care_content":
      if (field.aboutPersonId === null) return withheld("person_unknown");
      return scope.peopleInScope.has(field.aboutPersonId)
        ? kept(field.value)
        : withheld("person_not_in_scope");
    case "direct_identifier":
      return withheld("identifier_not_needed");
    case "staff_name":
      return scope.staffNames === "include"
        ? kept(field.value)
        : redacted(bracketed(field.role, "member of staff"), "staff_role_only");
    case "third_party":
      return redacted(bracketed(field.role, "another person"), "third_party");
    case "free_text":
      return field.redacted && hasText(field.redacted.by) && hasText(field.redacted.text)
        ? redacted(field.redacted.text.trim(), "free_text_redacted_by_hand")
        : withheld("free_text_not_reviewed");
  }
}

function ukDate(instant: Date): string {
  const w = toUkWallClock(instant);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
}

/** Why an item is left out, or null when it belongs in the pack (quality.md rule 2). */
export function evidenceItemExclusion(
  item: EvidenceItem,
  request: Pick<
    EvidencePackRequest,
    "from" | "to" | "locationIds" | "qualityStatementIds" | "peopleInScope"
  >,
): EvidenceExclusionReason | null {
  if (item.restricted) return "restricted_record";
  const day = ukDate(item.occurredAt);
  if (day < request.from || day > request.to) return "outside_date_range";
  if (!request.locationIds.includes(item.locationId)) return "location_not_requested";
  if (item.qualityStatementIds.length === 0) return "not_tagged";
  if (
    request.qualityStatementIds !== null &&
    !item.qualityStatementIds.some((s) => request.qualityStatementIds?.includes(s))
  ) {
    return "statement_not_requested";
  }
  if (
    item.aboutPersonIds.length > 0 &&
    !item.aboutPersonIds.some((p) => request.peopleInScope.includes(p))
  ) {
    return "person_not_in_scope";
  }
  return null;
}

// ------------------------------------------------------------------------------------------------
// Watermark and composition
// ------------------------------------------------------------------------------------------------

function shorten(text: string, max: number): string {
  const clean = text.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim()}...`;
}

/** On every page: who it is for, why, when it was made and which pack it is. */
export function evidencePackWatermark(input: {
  readonly packId: string;
  readonly recipient: Pick<EvidencePackRecipient, "name" | "organisation">;
  readonly purpose: string;
  readonly generatedAt: Date;
}): string {
  return [
    `Prepared for ${input.recipient.name.trim()}, ${input.recipient.organisation.trim()}.`,
    `Purpose: ${shorten(input.purpose, MAX_WATERMARK_PURPOSE_LENGTH)}.`,
    `Made ${formatUkDateTime(input.generatedAt)}.`,
    `Pack ${input.packId}.`,
    "Do not share further.",
  ].join(" ");
}

export interface EvidencePack {
  readonly packId: string;
  readonly recipient: EvidencePackRecipient;
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
  readonly locationIds: readonly string[];
  readonly generatedAt: Date;
  readonly composedBy: string;
  readonly watermark: string;
  readonly items: readonly EvidencePackItem[];
  /** Kept in the internal manifest only; never sent to the recipient. */
  readonly excluded: readonly {
    readonly itemId: string;
    readonly reason: EvidenceExclusionReason;
  }[];
  /** Included items per quality statement. */
  readonly coverage: Readonly<Record<string, number>>;
  readonly redactedFields: number;
  readonly withheldFields: number;
}

export type EvidencePackComposition =
  | { readonly ok: true; readonly pack: EvidencePack }
  | { readonly ok: false; readonly problems: readonly EvidencePackRequestProblem[] };

/** Composes the pack: selects the items, then minimises every field (HZ-050). */
export function composeEvidencePack(
  request: EvidencePackRequest,
  items: readonly EvidenceItem[],
): EvidencePackComposition {
  const problems = checkEvidencePackRequest(request);
  if (problems.length > 0) return { ok: false, problems };
  const scope = { peopleInScope: new Set(request.peopleInScope), staffNames: request.staffNames };
  const excluded: { itemId: string; reason: EvidenceExclusionReason }[] = [];
  const included: EvidencePackItem[] = [];
  for (const item of items) {
    const reason = evidenceItemExclusion(item, request);
    if (reason) {
      excluded.push({ itemId: item.id, reason });
      continue;
    }
    const statementIds =
      request.qualityStatementIds === null
        ? item.qualityStatementIds
        : item.qualityStatementIds.filter((s) => request.qualityStatementIds?.includes(s));
    included.push({
      itemId: item.id,
      recordType: item.recordType,
      recordId: item.recordId,
      recordVersion: item.recordVersion,
      title: item.title,
      occurredAt: item.occurredAt,
      qualityStatementIds: statementIds,
      fields: item.fields.map((f) => minimiseEvidenceField(f, scope)),
    });
  }
  included.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const coverage: Record<string, number> = {};
  for (const item of included) {
    for (const s of item.qualityStatementIds) coverage[s] = (coverage[s] ?? 0) + 1;
  }
  const fields = included.flatMap((i) => i.fields);
  return {
    ok: true,
    pack: {
      packId: request.packId,
      recipient: {
        name: request.recipient.name.trim(),
        organisation: request.recipient.organisation.trim(),
        email: normaliseEmail(request.recipient.email),
      },
      purpose: request.purpose.trim(),
      from: request.from,
      to: request.to,
      locationIds: request.locationIds,
      generatedAt: request.composedAt,
      composedBy: request.composedBy,
      watermark: evidencePackWatermark({
        packId: request.packId,
        recipient: request.recipient,
        purpose: request.purpose,
        generatedAt: request.composedAt,
      }),
      items: included,
      excluded,
      coverage,
      redactedFields: fields.filter((f) => f.outcome === "redacted").length,
      withheldFields: fields.filter((f) => f.outcome === "withheld").length,
    },
  };
}

// ------------------------------------------------------------------------------------------------
// Release, the time-limited link and revocation (ADR-0050)
// ------------------------------------------------------------------------------------------------

export type EvidencePackState = "draft" | "released" | "revoked" | "discarded";

/**
 * Draft to released (step-up, by someone other than the composer) to revoked; a draft no longer
 * needed is discarded. Expiry is not a state: the link stops working at its expiry time.
 */
export const EVIDENCE_PACK_WORKFLOW = defineWorkflow<EvidencePackState>({
  key: "quality.evidence_pack",
  version: 1,
  states: ["draft", "released", "revoked", "discarded"],
  initial: "draft",
  terminal: ["revoked", "discarded"],
  transitions: [
    {
      from: "draft",
      to: "released",
      permission: "quality.evidence_pack.release",
      distinctFromCreator: true,
    },
    {
      from: "draft",
      to: "discarded",
      permission: "quality.evidence_pack.compose",
      requiresReason: true,
    },
    {
      from: "released",
      to: "revoked",
      permission: "quality.evidence_pack.compose",
      requiresReason: true,
    },
  ],
});

/** The link's expiry when the sender does not choose one: the tenant's default number of days. */
export function defaultEvidencePackLinkExpiry(
  releasedAt: Date,
  policy: Pick<EvidencePackPolicy, "defaultLinkDays">,
): Date {
  return addUkDays(releasedAt, policy.defaultLinkDays);
}

export type EvidencePackReleaseProblem =
  | "not_draft"
  | "missing_permission"
  | "composer_cannot_release"
  | "step_up_required"
  | "empty_pack"
  | "expiry_in_past"
  | "expiry_beyond_maximum"
  | "recipient_email_invalid";

export const EVIDENCE_PACK_RELEASE_MESSAGES: Readonly<Record<EvidencePackReleaseProblem, string>> =
  {
    not_draft: "Only a draft pack can be released.",
    missing_permission: "Your role does not allow you to release evidence packs.",
    composer_cannot_release:
      "Someone other than the person who put the pack together must release it.",
    step_up_required: "Sign in again to confirm it is you, then release the pack.",
    empty_pack: "The pack has no evidence in it.",
    expiry_in_past: "Choose an expiry time in the future.",
    expiry_beyond_maximum: "The link cannot last that long. Choose an earlier expiry.",
    recipient_email_invalid: "Enter the recipient's work email address.",
  };

export interface EvidencePackReleaseRequest {
  readonly actorId: string;
  readonly permissions: ReadonlySet<string>;
  readonly stepUpFresh: boolean;
  readonly releasedAt: Date;
  /** Null takes the default expiry. */
  readonly expiresAt: Date | null;
}

export type EvidencePackReleaseCheck =
  | { readonly ok: true; readonly expiresAt: Date }
  | { readonly ok: false; readonly problems: readonly EvidencePackReleaseProblem[] };

/** Every check before a link is issued: workflow, separation of duties, step-up and expiry. */
export function checkEvidencePackRelease(
  pack: {
    readonly state: EvidencePackState;
    readonly composedBy: string;
    readonly itemCount: number;
    readonly recipientEmail: string;
  },
  request: EvidencePackReleaseRequest,
  policy: EvidencePackPolicy,
): EvidencePackReleaseCheck {
  const problems: EvidencePackReleaseProblem[] = [];
  const move = checkWorkflowTransition(
    EVIDENCE_PACK_WORKFLOW,
    { state: pack.state, createdBy: pack.composedBy },
    {
      to: "released",
      actorId: request.actorId,
      permissions: request.permissions,
      stepUpFresh: request.stepUpFresh,
    },
  );
  if (!move.ok) {
    const byProblem: Record<string, EvidencePackReleaseProblem> = {
      terminal: "not_draft",
      no_such_transition: "not_draft",
      missing_permission: "missing_permission",
      separation_of_duties: "composer_cannot_release",
      step_up_required: "step_up_required",
    };
    problems.push(byProblem[move.problem] ?? "not_draft");
  }
  if (pack.itemCount === 0) problems.push("empty_pack");
  if (!isPlausibleEmail(pack.recipientEmail)) problems.push("recipient_email_invalid");
  const expiresAt = request.expiresAt ?? defaultEvidencePackLinkExpiry(request.releasedAt, policy);
  if (expiresAt.getTime() <= request.releasedAt.getTime()) problems.push("expiry_in_past");
  else if (expiresAt.getTime() > addUkDays(request.releasedAt, policy.maxLinkDays).getTime()) {
    problems.push("expiry_beyond_maximum");
  }
  return problems.length === 0 ? { ok: true, expiresAt } : { ok: false, problems };
}

/**
 * Why: wrong one-time codes are throttled, not unlimited (NCSC); after this many the link locks
 * and the sender issues a new one. A security constant, not a tenant setting.
 */
export const EVIDENCE_LINK_MAX_CODE_ATTEMPTS = 5;

export interface EvidencePackLinkView {
  readonly packState: EvidencePackState;
  readonly recipientEmail: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly failedCodeAttempts: number;
}

export type EvidencePackLinkRefusal =
  | "not_released"
  | "revoked"
  | "expired"
  | "locked"
  | "code_required"
  | "wrong_recipient";

export const EVIDENCE_PACK_LINK_MESSAGES: Readonly<Record<EvidencePackLinkRefusal, string>> = {
  not_released: "This pack has not been released.",
  revoked: "This link has been withdrawn by the provider.",
  expired: "This link has expired. Ask the provider for a new one.",
  locked: "Too many wrong codes. Ask the provider for a new link.",
  code_required: "Enter the code sent to your email address.",
  wrong_recipient: "This link was sent to someone else. Ask the provider for your own link.",
};

export type EvidencePackLinkAccess =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: EvidencePackLinkRefusal;
      readonly message: string;
    };

/**
 * Whether a link opens at `at` for the person who proved, with a one-time code, that they hold
 * `verifiedEmail` (null until they have). Bound to one recipient; revocation and expiry win.
 */
export function evidencePackLinkAccess(
  link: EvidencePackLinkView,
  attempt: { readonly at: Date; readonly verifiedEmail: string | null },
): EvidencePackLinkAccess {
  const refuse = (reason: EvidencePackLinkRefusal): EvidencePackLinkAccess => ({
    allowed: false,
    reason,
    message: EVIDENCE_PACK_LINK_MESSAGES[reason],
  });
  if (link.packState === "draft" || link.packState === "discarded") return refuse("not_released");
  if (
    link.packState === "revoked" ||
    (link.revokedAt !== null && link.revokedAt.getTime() <= attempt.at.getTime())
  ) {
    return refuse("revoked");
  }
  if (attempt.at.getTime() >= link.expiresAt.getTime()) return refuse("expired");
  if (link.failedCodeAttempts >= EVIDENCE_LINK_MAX_CODE_ATTEMPTS) return refuse("locked");
  if (attempt.verifiedEmail === null) return refuse("code_required");
  if (normaliseEmail(attempt.verifiedEmail) !== normaliseEmail(link.recipientEmail)) {
    return refuse("wrong_recipient");
  }
  return { allowed: true };
}

/**
 * The rendered PDF bundle is deleted once its link can no longer open (expired or revoked); the
 * manifest stays under the `evidence_pack` retention class (retention.md).
 */
export function evidencePackBundleDeletable(
  link: Pick<EvidencePackLinkView, "packState" | "expiresAt" | "revokedAt">,
  at: Date,
): boolean {
  return (
    link.packState === "revoked" ||
    link.packState === "discarded" ||
    (link.revokedAt !== null && link.revokedAt.getTime() <= at.getTime()) ||
    at.getTime() >= link.expiresAt.getTime()
  );
}
