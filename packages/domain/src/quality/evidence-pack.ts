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
 * set of locations, then minimised and redacted by rule. How each field is treated comes from a
 * fixed map of record type and field to kind (`EVIDENCE_FIELD_KIND_MAP`), never from the caller,
 * and anything not in the map is treated as free text. Only the people in scope appear, third
 * parties and (by default) staff appear as a role from a closed list, identifiers are left out,
 * and free text is withheld until a person has redacted it by hand, and withheld again if the
 * redacted copy still names someone it should not or holds a long number. Every withheld or
 * redacted field says why. Nobody who composed, redacted or edited the pack releases it; the link
 * is bound to one recipient through a one-time code and a session for that link, expires, and can
 * be revoked; every page carries a watermark naming the recipient, the purpose, the time and the
 * pack.
 */

// ------------------------------------------------------------------------------------------------
// Field kinds, the field map and roles
// ------------------------------------------------------------------------------------------------

/**
 * `organisational` (no personal data), `care_content` (about the person named in
 * `aboutPersonId`), `direct_identifier` (NHS number, date of birth, address, phone),
 * `staff_name`, `third_party` (relatives, visitors, other residents, witnesses who are not staff,
 * outside professionals) and `free_text` (anything a person typed: may mention anyone).
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

/** The record types that can be evidence in Phase 1. */
export const EVIDENCE_RECORD_TYPES = [
  "incident",
  "care_note",
  "observation",
  "body_map_mark",
  "assessment",
  "care_plan_section",
  "risk_assessment",
  "activity_record",
  "visit_log",
  "advance_care_record",
] as const;

export type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];

const PERSON = { person_name: "care_content", room: "care_content" } as const;
const IDENTIFIERS = {
  nhs_number: "direct_identifier",
  date_of_birth: "direct_identifier",
  address: "direct_identifier",
  phone: "direct_identifier",
} as const;

/**
 * The kind of every field of every evidence record type (quality.md rule 3 table). Every column a
 * person types into is `free_text`. A field missing from the map is treated as `free_text`.
 */
export const EVIDENCE_FIELD_KIND_MAP: Readonly<
  Record<EvidenceRecordType, Readonly<Record<string, EvidenceFieldKind>>>
> = {
  incident: {
    ...PERSON,
    ...IDENTIFIERS,
    type: "organisational",
    occurred_at: "organisational",
    location: "organisational",
    severity: "organisational",
    harm_grade: "care_content",
    injury: "care_content",
    description: "free_text",
    immediate_actions: "free_text",
    emergency_services: "organisational",
    raised_by: "staff_name",
    closed_by: "staff_name",
    staff_involved: "staff_name",
    witness_staff: "staff_name",
    witness_other: "third_party",
    family_informed: "third_party",
  },
  care_note: {
    ...PERSON,
    ...IDENTIFIERS,
    category: "organisational",
    tags: "organisational",
    occurred_at: "organisational",
    late_entry: "organisational",
    text: "free_text",
    author: "staff_name",
  },
  observation: {
    ...PERSON,
    ...IDENTIFIERS,
    chart: "organisational",
    occurred_at: "organisational",
    values: "care_content",
    news2: "care_content",
    comment: "free_text",
    recorded_by: "staff_name",
  },
  body_map_mark: {
    ...PERSON,
    ...IDENTIFIERS,
    region: "care_content",
    side: "care_content",
    mark_type: "care_content",
    category: "care_content",
    size: "care_content",
    note: "free_text",
    recorded_by: "staff_name",
  },
  assessment: {
    ...PERSON,
    ...IDENTIFIERS,
    tool: "organisational",
    tool_version: "organisational",
    score: "care_content",
    band: "care_content",
    workings: "care_content",
    next_due_on: "organisational",
    assessor: "staff_name",
  },
  care_plan_section: {
    ...PERSON,
    ...IDENTIFIERS,
    domain: "organisational",
    published_version: "organisational",
    need: "free_text",
    outcome: "free_text",
    strengths: "free_text",
    contingency: "free_text",
    published_by: "staff_name",
  },
  risk_assessment: {
    ...PERSON,
    ...IDENTIFIERS,
    template: "organisational",
    likelihood: "care_content",
    severity: "care_content",
    rating: "care_content",
    review_date: "organisational",
    hazard: "free_text",
    controls: "free_text",
    positive_risk: "free_text",
    assessor: "staff_name",
  },
  activity_record: {
    ...PERSON,
    ...IDENTIFIERS,
    attendance: "care_content",
    engagement: "care_content",
    format: "organisational",
    activity: "free_text",
    notes: "free_text",
    staff: "staff_name",
  },
  visit_log: {
    ...PERSON,
    ...IDENTIFIERS,
    kind: "organisational",
    starts_at: "organisational",
    ends_at: "organisational",
    restrictions_applied: "care_content",
    visitor_name: "third_party",
    visitor_relationship: "free_text",
    restriction_reason: "free_text",
    notes: "free_text",
    recorded_by: "staff_name",
  },
  advance_care_record: {
    ...PERSON,
    ...IDENTIFIERS,
    kind: "organisational",
    cpr_decision: "care_content",
    completed_on: "organisational",
    review_due_on: "organisational",
    status: "organisational",
    clinician_name: "third_party",
    details: "free_text",
    withdrawn_reason: "free_text",
  },
};

/** The kind of a field: from the map, and `free_text` (the safest) when the map does not name it. */
export function evidenceFieldKind(recordType: EvidenceRecordType, key: string): EvidenceFieldKind {
  const fields = EVIDENCE_FIELD_KIND_MAP[recordType];
  return Object.hasOwn(fields, key) ? (fields[key] as EvidenceFieldKind) : "free_text";
}

/** Roles shown in place of a third party's name: a closed list, never free text. */
export const EVIDENCE_PARTY_ROLES = [
  "relative",
  "friend",
  "visitor",
  "another resident",
  "health or care professional",
  "witness",
  "another person",
] as const;

/** Roles shown in place of a staff member's name: a closed list, never free text. */
export const EVIDENCE_STAFF_ROLES = [
  "care worker",
  "senior carer",
  "team leader",
  "nurse",
  "clinical lead",
  "deputy manager",
  "registered manager",
  "activities coordinator",
  "housekeeper",
  "cook",
  "maintenance worker",
  "administrator",
  "agency worker",
  "member of staff",
] as const;

export type EvidencePartyRole = (typeof EVIDENCE_PARTY_ROLES)[number];
export type EvidenceStaffRole = (typeof EVIDENCE_STAFF_ROLES)[number];
export type EvidenceRole = EvidencePartyRole | EvidenceStaffRole;

// ------------------------------------------------------------------------------------------------
// Evidence items and the request
// ------------------------------------------------------------------------------------------------

export interface EvidenceField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** Whom a `care_content` or `direct_identifier` field is about. */
  readonly aboutPersonId: string | null;
  /** Shown instead of a staff member's or third party's name, from the closed lists. */
  readonly role: EvidenceRole | null;
  /** Free text only: a copy a person has redacted by hand, with who did it and when. */
  readonly redacted: { readonly text: string; readonly by: string; readonly at: Date } | null;
}

export interface EvidenceItem {
  readonly id: string;
  readonly recordType: EvidenceRecordType;
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
  /** The names (full, given, family, preferred) of the people the record is about. */
  readonly namedPeople: readonly { readonly personId: string; readonly names: readonly string[] }[];
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
  /**
   * Within the composer's scope for `quality.evidence_pack.compose` only (`scopeFor`, ADR-0071),
   * never another role's; likewise `peopleInScope`.
   */
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

/** Why an item is left out of a pack (internal manifest only; `evidence_pack_item`). */
export const EVIDENCE_EXCLUSION_REASONS = [
  "restricted_record",
  "outside_date_range",
  "location_not_requested",
  "not_tagged",
  "statement_not_requested",
  "person_not_in_scope",
] as const;

export type EvidenceExclusionReason = (typeof EVIDENCE_EXCLUSION_REASONS)[number];

export type EvidenceFieldOutcome = "included" | "redacted" | "withheld";

export type EvidenceRedactionReason =
  | "third_party"
  | "staff_role_only"
  | "free_text_redacted_by_hand"
  | "person_not_in_scope"
  | "person_unknown"
  | "identifier_not_needed"
  | "free_text_not_reviewed"
  | "redaction_incomplete";

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
  redaction_incomplete:
    "Withheld: the redacted text still names someone or holds a number like an NHS or telephone number.",
};

export interface EvidencePackField {
  readonly key: string;
  readonly label: string;
  readonly kind: EvidenceFieldKind;
  readonly outcome: EvidenceFieldOutcome;
  /** The value shown: the original, a role in brackets, a redacted copy, or null when withheld. */
  readonly value: string | null;
  readonly reason: EvidenceRedactionReason | null;
  /** Who redacted free text by hand; they are a contributor and cannot release the pack. */
  readonly redactedBy: string | null;
}

export interface EvidencePackItem {
  readonly itemId: string;
  readonly recordType: EvidenceRecordType;
  readonly recordId: string;
  readonly recordVersion: number;
  readonly title: string;
  readonly occurredAt: Date;
  readonly qualityStatementIds: readonly string[];
  readonly fields: readonly EvidencePackField[];
}

const ROLES: ReadonlySet<string> = new Set<string>([
  ...EVIDENCE_PARTY_ROLES,
  ...EVIDENCE_STAFF_ROLES,
]);

function bracketedRole(role: string | null, fallback: EvidenceRole): string {
  return `[${role !== null && ROLES.has(role) ? role : fallback}]`;
}

/** The rule for one field once its kind is known (quality.md rule 3). */
export function minimiseEvidenceField(
  field: EvidenceField & { readonly kind: EvidenceFieldKind },
  scope: {
    readonly peopleInScope: ReadonlySet<string>;
    readonly staffNames: "role_only" | "include";
  },
): EvidencePackField {
  const base = { key: field.key, label: field.label, kind: field.kind, redactedBy: null };
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
        : redacted(bracketedRole(field.role, "member of staff"), "staff_role_only");
    case "third_party":
      return redacted(bracketedRole(field.role, "another person"), "third_party");
    case "free_text":
      return field.redacted && hasText(field.redacted.by) && hasText(field.redacted.text)
        ? {
            ...redacted(field.redacted.text.trim(), "free_text_redacted_by_hand"),
            redactedBy: field.redacted.by,
          }
        : withheld("free_text_not_reviewed");
  }
}

/** Why: NHS numbers are 10 digits and UK telephone numbers 10 or 11, however they are spaced. */
export const REDACTION_DIGIT_RUN = 10;
/** Why: name parts shorter than this ("Al", "Jo") match too much ordinary text to be useful. */
const MIN_NAME_PART_LENGTH = 3;

function hasLongDigitRun(text: string): boolean {
  let run = 0;
  for (const ch of text) {
    if (ch >= "0" && ch <= "9") {
      run += 1;
      if (run >= REDACTION_DIGIT_RUN) return true;
    } else if (ch !== " " && ch !== "-") {
      run = 0;
    }
  }
  return false;
}

/** The full name and each part of it long enough to search for, lower case. */
function nameNeedles(name: string): string[] {
  const full = name.trim().toLowerCase();
  if (full.length === 0) return [];
  const parts = full.split(" ").filter((p) => p.length >= MIN_NAME_PART_LENGTH);
  return [full, ...parts];
}

/**
 * A hand-redacted copy is withheld again when it still holds a known third party's name, a staff
 * name while only roles are shown, the name of a person on the same record who is outside the
 * pack's scope, or a run of ten digits (an NHS or telephone number).
 */
export function redactionLeaks(text: string, names: readonly string[]): boolean {
  if (hasLongDigitRun(text)) return true;
  const haystack = text.toLowerCase();
  return names.some((name) => nameNeedles(name).some((needle) => haystack.includes(needle)));
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

/** Minimises every field of one included item, then checks hand redactions for leaks. */
function minimiseItem(
  item: EvidenceItem,
  scope: {
    readonly peopleInScope: ReadonlySet<string>;
    readonly staffNames: "role_only" | "include";
  },
): EvidencePackField[] {
  const typed = item.fields.map((f) => ({ ...f, kind: evidenceFieldKind(item.recordType, f.key) }));
  const forbiddenNames = [
    ...typed.filter((f) => f.kind === "third_party").map((f) => f.value),
    ...(scope.staffNames === "role_only"
      ? typed.filter((f) => f.kind === "staff_name").map((f) => f.value)
      : []),
    ...item.namedPeople.filter((p) => !scope.peopleInScope.has(p.personId)).flatMap((p) => p.names),
  ];
  return typed.map((field) => {
    const outcome = minimiseEvidenceField(field, scope);
    if (
      outcome.reason === "free_text_redacted_by_hand" &&
      outcome.value !== null &&
      redactionLeaks(outcome.value, forbiddenNames)
    ) {
      return { ...outcome, outcome: "withheld", value: null, reason: "redaction_incomplete" };
    }
    return outcome;
  });
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
      fields: minimiseItem(item, scope),
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

/**
 * Everyone who shaped the pack: the composer, everyone who redacted free text by hand and every
 * other editor. None of them may release it or re-issue its link (HZ-050).
 */
export function evidencePackContributors(
  pack: Pick<EvidencePack, "composedBy" | "items">,
  editorIds: readonly string[],
): readonly string[] {
  const ids = new Set<string>([pack.composedBy, ...editorIds]);
  for (const item of pack.items) {
    for (const field of item.fields) if (field.redactedBy) ids.add(field.redactedBy);
  }
  return [...ids];
}

// ------------------------------------------------------------------------------------------------
// Release, the time-limited link, codes and revocation (ADR-0050)
// ------------------------------------------------------------------------------------------------

export type EvidencePackState = "draft" | "released" | "revoked" | "discarded";

/**
 * Draft to released (step-up, by someone other than the composer; the full contributor check is
 * in `checkEvidencePackRelease`) to revoked; a draft no longer needed is discarded. Expiry is not a
 * state: the link stops working at its expiry time.
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
  | "not_released"
  | "missing_permission"
  | "contributor_cannot_release"
  | "step_up_required"
  | "empty_pack"
  | "expiry_in_past"
  | "expiry_beyond_maximum"
  | "recipient_email_invalid"
  | "different_recipient";

export const EVIDENCE_PACK_RELEASE_MESSAGES: Readonly<Record<EvidencePackReleaseProblem, string>> =
  {
    not_draft: "Only a draft pack can be released.",
    not_released: "Only a released pack's link can be issued again.",
    missing_permission: "Your role does not allow you to release evidence packs.",
    contributor_cannot_release:
      "Someone who did not compose, redact or edit the pack must release it.",
    step_up_required: "Sign in again to confirm it is you, then release the pack.",
    empty_pack: "The pack has no evidence in it.",
    expiry_in_past: "Choose an expiry time in the future.",
    expiry_beyond_maximum: "The link cannot last that long. Choose an earlier expiry.",
    recipient_email_invalid: "Enter the recipient's work email address.",
    different_recipient:
      "A new link goes to the same recipient. Compose a new pack for anyone else.",
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

function expiryProblems(
  request: EvidencePackReleaseRequest,
  policy: EvidencePackPolicy,
): { expiresAt: Date; problems: EvidencePackReleaseProblem[] } {
  const expiresAt = request.expiresAt ?? defaultEvidencePackLinkExpiry(request.releasedAt, policy);
  const problems: EvidencePackReleaseProblem[] = [];
  if (expiresAt.getTime() <= request.releasedAt.getTime()) problems.push("expiry_in_past");
  else if (expiresAt.getTime() > addUkDays(request.releasedAt, policy.maxLinkDays).getTime()) {
    problems.push("expiry_beyond_maximum");
  }
  return { expiresAt, problems };
}

function releaserProblems(
  contributorIds: readonly string[],
  request: EvidencePackReleaseRequest,
): EvidencePackReleaseProblem[] {
  const problems: EvidencePackReleaseProblem[] = [];
  if (!request.permissions.has("quality.evidence_pack.release"))
    problems.push("missing_permission");
  if (contributorIds.includes(request.actorId)) problems.push("contributor_cannot_release");
  if (!request.stepUpFresh) problems.push("step_up_required");
  return problems;
}

/**
 * Every check before a link is issued: workflow, separation of duties (no composer, redactor or
 * editor; `evidencePackContributors`), step-up and expiry.
 */
export function checkEvidencePackRelease(
  pack: {
    readonly state: EvidencePackState;
    readonly composedBy: string;
    readonly contributorIds: readonly string[];
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
  if (!move.ok && (move.problem === "terminal" || move.problem === "no_such_transition")) {
    problems.push("not_draft");
  }
  problems.push(...releaserProblems([pack.composedBy, ...pack.contributorIds], request));
  if (pack.itemCount === 0) problems.push("empty_pack");
  if (!isPlausibleEmail(pack.recipientEmail)) problems.push("recipient_email_invalid");
  const expiry = expiryProblems(request, policy);
  problems.push(...expiry.problems);
  return problems.length === 0
    ? { ok: true, expiresAt: expiry.expiresAt }
    : { ok: false, problems: [...new Set(problems)] };
}

export type EvidencePackReissueCheck =
  | { readonly ok: true; readonly expiresAt: Date; readonly revokeLinkId: string }
  | { readonly ok: false; readonly problems: readonly EvidencePackReleaseProblem[] };

/**
 * Issuing a new link (after a lock-out or a lost email) is a release: step-up, by someone who did
 * not shape the pack, to the same recipient only, and the old link is revoked at the same time.
 */
export function checkEvidencePackLinkReissue(
  pack: {
    readonly state: EvidencePackState;
    readonly contributorIds: readonly string[];
    readonly recipientEmail: string;
  },
  current: { readonly linkId: string },
  request: EvidencePackReleaseRequest & { readonly recipientEmail: string },
  policy: EvidencePackPolicy,
): EvidencePackReissueCheck {
  const problems: EvidencePackReleaseProblem[] = [];
  if (pack.state !== "released") problems.push("not_released");
  problems.push(...releaserProblems(pack.contributorIds, request));
  if (normaliseEmail(request.recipientEmail) !== normaliseEmail(pack.recipientEmail)) {
    problems.push("different_recipient");
  }
  const expiry = expiryProblems(request, policy);
  problems.push(...expiry.problems);
  return problems.length === 0
    ? { ok: true, expiresAt: expiry.expiresAt, revokeLinkId: current.linkId }
    : { ok: false, problems };
}

/**
 * Why: wrong one-time codes are throttled, not unlimited (NCSC); after this many the link locks
 * for good and a new link must be issued. A security constant, not a tenant setting.
 */
export const EVIDENCE_LINK_MAX_CODE_ATTEMPTS = 5;
/** Why: 6 digits from a CSPRNG gives a million codes against at most five guesses (ADR-0050). */
export const EVIDENCE_LINK_CODE_DIGITS = 6;

/** True for exactly six ASCII digits, the only shape of code Harbour issues. */
export function isWellFormedEvidenceCode(text: string): boolean {
  if (text.length !== EVIDENCE_LINK_CODE_DIGITS) return false;
  for (const ch of text) if (ch < "0" || ch > "9") return false;
  return true;
}

/**
 * The failed-attempt count after an attempt. It only ever goes up: a correct code does not reset
 * it, so a guesser cannot alternate with the real recipient to get unlimited tries.
 */
export function failedCodeAttemptsAfter(current: number, outcome: "correct" | "wrong"): number {
  return outcome === "wrong" ? current + 1 : current;
}

export interface EvidencePackCodeView {
  readonly linkId: string;
  readonly issuedAt: Date;
  /** Single use: set when the code is accepted. */
  readonly usedAt: Date | null;
}

export type EvidencePackCodeCheck =
  | "accepted"
  | "wrong_link"
  | "malformed"
  | "already_used"
  | "expired"
  | "wrong_code";

/**
 * Checking an entered code against the stored one. The API compares hashes in constant time and
 * passes `matches`; codes last `evidence_pack.code_valid_minutes` and are used once.
 */
export function checkEvidencePackCode(
  code: EvidencePackCodeView,
  attempt: {
    readonly linkId: string;
    readonly entered: string;
    readonly matches: boolean;
    readonly at: Date;
  },
  policy: Pick<EvidencePackPolicy, "codeValidMinutes">,
): EvidencePackCodeCheck {
  if (attempt.linkId !== code.linkId) return "wrong_link";
  if (!isWellFormedEvidenceCode(attempt.entered)) return "malformed";
  if (code.usedAt !== null) return "already_used";
  if (attempt.at.getTime() - code.issuedAt.getTime() >= policy.codeValidMinutes * 60_000) {
    return "expired";
  }
  return attempt.matches ? "accepted" : "wrong_code";
}

export interface EvidencePackLinkView {
  readonly id: string;
  readonly packState: EvidencePackState;
  readonly recipientEmail: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly failedCodeAttempts: number;
}

/**
 * The verified session for one link: an HttpOnly cookie set when the code is accepted, holding the
 * link and the address the code went to. Never stored on the link row, so verifying in one browser
 * opens nothing anywhere else.
 */
export interface EvidencePackLinkSession {
  readonly linkId: string;
  readonly verifiedEmail: string;
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
 * Whether a link opens at `at` for a request carrying `session` (null until a code is accepted in
 * that browser). Bound to one recipient; revocation, expiry and lock-out win.
 */
export function evidencePackLinkAccess(
  link: EvidencePackLinkView,
  attempt: { readonly at: Date; readonly session: EvidencePackLinkSession | null },
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
  if (attempt.session === null || attempt.session.linkId !== link.id)
    return refuse("code_required");
  if (normaliseEmail(attempt.session.verifiedEmail) !== normaliseEmail(link.recipientEmail)) {
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
