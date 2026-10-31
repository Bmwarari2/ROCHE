import type { EvidencePackDetail, EvidencePackSummary } from "@harbour/contracts";
import { isPlausibleEmail, MIN_EVIDENCE_PURPOSE_LENGTH } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { FormValues } from "./incident-forms";
import type { FieldErrors, FieldProblem } from "./outcome";
import { readDateField } from "./uk-time";

/**
 * View logic for the inspector evidence pack screens (docs/specs/quality.md section 16; QUAL-003;
 * hazard HZ-050; ADR-0050). Pure and unit tested. The API decides every rule; these functions say
 * its decisions in words and check a form before it is sent.
 */

export const COMPOSE = "quality.evidence_pack.compose";
export const RELEASE = "quality.evidence_pack.release";

/** Whether the evidence pack screens are offered (the sidebar and the pages). */
export function evidencePacksShown(permissions: readonly string[]): boolean {
  return permissions.includes(COMPOSE) || permissions.includes(RELEASE);
}

/**
 * The CQC key questions, offered as quality statement ids until the framework model (QUAL-001)
 * replaces them with the statements themselves (quality.md section 16).
 */
export const KEY_QUESTIONS = ["safe", "effective", "caring", "responsive", "well-led"] as const;
export type KeyQuestion = (typeof KEY_QUESTIONS)[number];

export const isKeyQuestion = (value: unknown): value is KeyQuestion =>
  typeof value === "string" && (KEY_QUESTIONS as readonly string[]).includes(value);

/** A key question's name ("Well-led"); ICU select keys cannot hold a hyphen. */
export function keyQuestionLabel(q: KeyQuestion, t: Translator): string {
  return t("quality.keyQuestion", { q: q.replace("-", "_") });
}

/** The longest texts the API takes (packages/contracts/src/quality.ts). */
export const NAME_MAX = 120;
export const EMAIL_MAX = 254;
export const PURPOSE_MAX = 500;
export const REDACTION_MAX = 5000;
export const END_REASON_MAX = 500;
export const END_REASON_MIN = 3;

/** The record types the API takes so far. */
export const EVIDENCE_RECORD_TYPES = ["care_note", "observation", "incident"] as const;
export type EvidenceRecordType = (typeof EVIDENCE_RECORD_TYPES)[number];

export const isEvidenceRecordType = (value: unknown): value is EvidenceRecordType =>
  typeof value === "string" && (EVIDENCE_RECORD_TYPES as readonly string[]).includes(value);

export type QualityIcon =
  | "file-pen"
  | "send"
  | "circle-minus"
  | "circle-check"
  | "eye-off"
  | "pen-line"
  | "clock"
  | "circle-alert"
  | "lock"
  | "link";

/** A status said with an icon and a word, never colour alone. */
export interface QualityChip {
  readonly status: "overdue" | "due" | "done" | "notApplicable" | "info" | "neutral";
  readonly icon: QualityIcon;
  readonly label: string;
}

const PACK_CHIPS: Record<EvidencePackSummary["state"], Pick<QualityChip, "status" | "icon">> = {
  draft: { status: "neutral", icon: "file-pen" },
  released: { status: "info", icon: "send" },
  revoked: { status: "notApplicable", icon: "circle-minus" },
  discarded: { status: "notApplicable", icon: "circle-minus" },
};

export function packStateChip(state: EvidencePackSummary["state"], t: Translator): QualityChip {
  return { ...PACK_CHIPS[state], label: t("quality.pack.state", { state }) };
}

type Outcome = EvidencePackDetail["items"][number]["fields"][number]["outcome"];

const OUTCOME_CHIPS: Record<Outcome, Pick<QualityChip, "status" | "icon">> = {
  included: { status: "done", icon: "circle-check" },
  redacted: { status: "info", icon: "pen-line" },
  withheld: { status: "neutral", icon: "eye-off" },
};

/** What happens to one field in the pack: shown, redacted by hand, or withheld. */
export function fieldOutcomeChip(outcome: Outcome, t: Translator): QualityChip {
  return { ...OUTCOME_CHIPS[outcome], label: t("quality.pack.outcome", { outcome }) };
}

/** What the pack will disclose, counted: records shown and the fields withheld or redacted. */
export function shareCounts(pack: Pick<EvidencePackDetail, "items">): {
  readonly included: number;
  readonly excluded: number;
  readonly withheld: number;
  readonly redacted: number;
  readonly awaitingRedaction: number;
} {
  let included = 0;
  let excluded = 0;
  let withheld = 0;
  let redacted = 0;
  let awaitingRedaction = 0;
  for (const item of pack.items) {
    if (item.exclusionReason !== null) {
      excluded += 1;
      continue;
    }
    included += 1;
    for (const field of item.fields) {
      if (field.outcome === "withheld") withheld += 1;
      if (field.outcome === "redacted") redacted += 1;
      if (redactable(field)) awaitingRedaction += 1;
    }
  }
  return { included, excluded, withheld, redacted, awaitingRedaction };
}

/** A free-text field still withheld: a person may redact it by hand on a draft. */
export function redactable(
  field: Pick<EvidencePackDetail["items"][number]["fields"][number], "kind" | "outcome">,
): boolean {
  return field.kind === "free_text" && field.outcome === "withheld";
}

// ------------------------------------------------------------------------------------------------
// Links (rules 7 to 10)
// ------------------------------------------------------------------------------------------------

type Link = EvidencePackDetail["links"][number];

export type LinkState = "live" | "expired" | "revoked" | "replaced" | "locked";

/** Where a link stands now. A revoked link that a newer one replaces is "replaced". */
export function linkState(link: Link, now: Date): LinkState {
  if (link.revokedAt !== null) {
    return link.revocationReason === "reissued" ? "replaced" : "revoked";
  }
  if (link.locked) return "locked";
  return Date.parse(link.expiresAt) <= now.getTime() ? "expired" : "live";
}

const LINK_CHIPS: Record<LinkState, Pick<QualityChip, "status" | "icon">> = {
  live: { status: "info", icon: "link" },
  expired: { status: "notApplicable", icon: "clock" },
  revoked: { status: "notApplicable", icon: "circle-minus" },
  replaced: { status: "notApplicable", icon: "circle-minus" },
  locked: { status: "overdue", icon: "lock" },
};

export function linkStateChip(state: LinkState, t: Translator): QualityChip {
  return { ...LINK_CHIPS[state], label: t("quality.link.state", { state }) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whole days from now until an instant, rounded up, so "in 1 day" never means a link that has
 * already stopped; 0 once it has passed.
 */
export function daysUntil(iso: string, now: Date): number {
  const ms = Date.parse(iso) - now.getTime();
  return ms <= 0 ? 0 : Math.ceil(ms / DAY_MS);
}

/**
 * The link's expiry in words: "Works until 07/11/2026 14:05, in 7 days", "Stopped working at
 * 07/11/2026 14:05". `when` is the formatted UK time.
 */
export function expiryWords(expiresAt: string, when: string, now: Date, t: Translator): string {
  const days = daysUntil(expiresAt, now);
  return days === 0
    ? t("quality.link.expiry", { tense: "past", when, days: 0 })
    : t("quality.link.expiry", { tense: "future", when, days });
}

/** The pack's newest link, which a new link would replace; null when there is none. */
export function latestLink(pack: Pick<EvidencePackDetail, "links">): Link | null {
  let latest: Link | null = null;
  for (const link of pack.links) {
    if (!latest || Date.parse(link.issuedAt) > Date.parse(latest.issuedAt)) latest = link;
  }
  return latest;
}

/**
 * The address to send the recipient. The token rides in the fragment, which a browser never sends
 * to a server, so it stays out of URLs, logs and Referer headers (as invitations do, ADR-0050).
 */
export function evidenceLinkUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/evidence#${token}`;
}

/**
 * The days a link may be set to work, never past the maximum: a few short choices, the
 * organisation's default and the maximum, each once and in order.
 */
export function expiryChoices(defaultDays: number, maxDays: number): number[] {
  const max = Math.max(1, Math.floor(maxDays));
  const wanted = [1, 3, Math.floor(defaultDays), 14, max];
  return [...new Set(wanted.filter((d) => d >= 1 && d <= max))].sort((a, b) => a - b);
}

// ------------------------------------------------------------------------------------------------
// Who may act (rule 6; the API checks again)
// ------------------------------------------------------------------------------------------------

export type ReleaseBlock = "contributor" | "no_permission" | "no_items" | null;

export interface PackActions {
  readonly addRecords: boolean;
  readonly redact: boolean;
  readonly discard: boolean;
  /** Offered to a non-contributor holding release, on a draft with something to send. */
  readonly release: boolean;
  /** Why release is not offered on a draft, to say in words; null when it is. */
  readonly releaseBlock: ReleaseBlock;
  readonly reissue: boolean;
  readonly revoke: boolean;
}

export function packActions(
  pack: Pick<EvidencePackDetail, "state" | "contributorIds" | "items" | "links" | "bundleDeleted">,
  me: { readonly tenantUserId: string; readonly permissions: readonly string[] },
  now: Date,
): PackActions {
  const compose = me.permissions.includes(COMPOSE);
  const release = me.permissions.includes(RELEASE);
  const contributor = pack.contributorIds.includes(me.tenantUserId);
  const draft = pack.state === "draft";
  const released = pack.state === "released";
  const included = shareCounts(pack).included;
  const releaseBlock: ReleaseBlock = !draft
    ? null
    : !release
      ? "no_permission"
      : contributor
        ? "contributor"
        : included === 0
          ? "no_items"
          : null;
  const latest = latestLink(pack);
  const live = latest !== null && linkState(latest, now) !== "expired" && !latest.revokedAt;
  return {
    addRecords: draft && compose,
    redact: draft && compose,
    discard: draft && compose,
    release: draft && releaseBlock === null,
    releaseBlock,
    reissue: released && release && !contributor && live && !pack.bundleDeleted,
    revoke: released && compose,
  };
}

// ------------------------------------------------------------------------------------------------
// The compose form (rule 1)
// ------------------------------------------------------------------------------------------------

export interface ComposeBody {
  readonly recipient: {
    readonly name: string;
    readonly organisation: string;
    readonly email: string;
  };
  readonly purpose: string;
  readonly from: string;
  readonly to: string;
  readonly locationIds: string[];
  readonly qualityStatementIds: string[] | null;
  readonly personIds: string[];
  readonly staffNames: "role_only" | "include";
}

export type ComposeRead =
  | { readonly ok: true; readonly body: ComposeBody }
  | {
      readonly ok: false;
      readonly problems: FieldProblem[];
    };

const text = (form: FormValues, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
};

const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allOf = (form: FormValues, name: string, keep: (value: string) => boolean): string[] => [
  ...new Set(
    form
      .getAll(name)
      .filter((v): v is string => typeof v === "string")
      .filter(keep),
  ),
];

/**
 * Reads the compose form, in the order of its fields, finding every problem at once (WCAG 3.3.1):
 * the recipient, a work email, a purpose of the domain's minimum length, real dates in order, at
 * least one location and at least one person (there is no "everyone"), and the key questions.
 */
export function readComposeForm(form: FormValues, t: Translator): ComposeRead {
  const problems: FieldProblem[] = [];
  const say = (field: string, problem: string) =>
    problems.push({ field, message: t("quality.compose.error", { problem }) });

  const name = text(form, "recipientName");
  if (!name || name.length > NAME_MAX) say("recipientName", "name");
  const organisation = text(form, "recipientOrganisation");
  if (!organisation || organisation.length > NAME_MAX) say("recipientOrganisation", "organisation");
  const email = text(form, "recipientEmail");
  if (email.length > EMAIL_MAX || !isPlausibleEmail(email)) say("recipientEmail", "email");
  const purpose = text(form, "purpose");
  if (purpose.length < MIN_EVIDENCE_PURPOSE_LENGTH || purpose.length > PURPOSE_MAX) {
    problems.push({
      field: "purpose",
      message: t("quality.compose.purposeError", { min: MIN_EVIDENCE_PURPOSE_LENGTH }),
    });
  }
  const from = readDateField(form, "from", { subject: t("quality.compose.fromSubject"), t });
  if (!from.ok) problems.push({ field: "from", message: from.message, parts: from.parts });
  const to = readDateField(form, "to", { subject: t("quality.compose.toSubject"), t });
  if (!to.ok) problems.push({ field: "to", message: to.message, parts: to.parts });
  if (from.ok && to.ok && from.date && to.date && from.date > to.date) say("to", "order");

  const locationIds = allOf(form, "locationIds", (v) => uuidLike.test(v));
  if (locationIds.length === 0) say("locationIds", "locations");
  const personIds = allOf(form, "personIds", (v) => uuidLike.test(v));
  if (personIds.length === 0) say("personIds", "people");

  const staffNames = text(form, "staffNames") === "include" ? "include" : "role_only";
  const every = text(form, "statements") !== "some";
  const chosen = allOf(form, "statementIds", isKeyQuestion);
  if (!every && chosen.length === 0) say("statementIds", "statements");

  if (problems.length > 0 || !from.ok || !to.ok || !from.date || !to.date) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    body: {
      recipient: { name, organisation, email },
      purpose,
      from: from.date,
      to: to.date,
      locationIds,
      qualityStatementIds: every ? null : chosen,
      personIds,
      staffNames,
    },
  };
}

/** A reason to revoke or discard: 3 to 500 characters, or the words that say what to do. */
export function readEndReason(
  form: FormValues,
  t: Translator,
):
  | { readonly ok: true; readonly reason: string }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const reason = text(form, "reason");
  return reason.length >= END_REASON_MIN && reason.length <= END_REASON_MAX
    ? { ok: true, reason }
    : { ok: false, errors: { reason: t("quality.reasonError", { min: END_REASON_MIN }) } };
}

// ------------------------------------------------------------------------------------------------
// Choosing records (rule 2)
// ------------------------------------------------------------------------------------------------

export interface RecordChoice {
  readonly recordType: EvidenceRecordType;
  readonly recordId: string;
  readonly qualityStatementIds: KeyQuestion[];
}

/**
 * The ticked records (`records`, each `type:id`) with the key questions they are evidence for
 * (`statementIds`, one choice for the batch), or the fields to fix: nothing ticked, or no key
 * question.
 */
export function readRecordChoices(
  form: FormValues,
  t: Translator,
):
  | { readonly ok: true; readonly items: RecordChoice[] }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const errors: Record<string, string> = {};
  const items: RecordChoice[] = [];
  const statements = allOf(form, "statementIds", isKeyQuestion) as KeyQuestion[];
  for (const value of allOf(form, "records", () => true)) {
    const [recordType, recordId] = value.split(":");
    if (!isEvidenceRecordType(recordType) || !recordId || !uuidLike.test(recordId)) continue;
    items.push({ recordType, recordId, qualityStatementIds: statements });
  }
  if (items.length === 0) errors.records = t("quality.records.noneError");
  if (statements.length === 0) errors.statementIds = t("quality.records.statementsError");
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, items };
}

/** The UK day bounds of the pack's dates, for reading a person's records in that range. */
export function packRangeQuery(
  pack: Pick<EvidencePackDetail, "from" | "to">,
  bounds: { readonly start: (date: string) => Date; readonly end: (date: string) => Date },
): { readonly from: string; readonly to: string } {
  return { from: bounds.start(pack.from).toISOString(), to: bounds.end(pack.to).toISOString() };
}
