import type { DsarCase } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
import type { StatusChipStatus } from "@harbour/ui";
import { formatDate } from "./format";
import type { Problem } from "./outcome";
import { problemMessage } from "./outcome";

/**
 * The DSAR workbench screens (PLAT-022; platform.md, the DSAR workbench; slice 66). Pure, unit
 * tested: the clock in words, the chips, the step the case has reached and the API's refusals in
 * plain words. The API works out the clock on every read; nothing here recomputes a due date.
 */

export const requestPage = (id: string) => `/data-rights/requests/${id}`;
export const itemPage = (id: string, itemId: string) =>
  `/data-rights/requests/${id}/items/${itemId}`;
export const bundlePage = (id: string) => `/data-rights/requests/${id}/bundle`;

type Clock = NonNullable<DsarCase["clock"]>;

const CLOCK_CHIPS: Readonly<Record<Clock["state"], StatusChipStatus>> = {
  awaiting_identity: "info",
  running: "due",
  paused: "neutral",
  due_soon: "due",
  overdue: "overdue",
  closed: "done",
};

export interface ClockView {
  readonly status: StatusChipStatus;
  /** The chip's word. */
  readonly label: string;
  /** The sentence that says what to do and by when. */
  readonly words: string;
}

/**
 * The clock as a chip (an icon and a word) and a sentence (HZ-011 style: never colour alone). A
 * case whose clock the API could not work out says so rather than showing no clock.
 */
export function clockView(
  clock: Clock | null,
  respondedOn: string | null,
  t: Translator,
): ClockView {
  if (!clock) {
    return {
      status: "notRecorded",
      label: t("dataRights.clock.state", { state: "unknown" }),
      words: t("dataRights.clock.words", { state: "unknown", due: "", responded: "" }),
    };
  }
  const due = formatDate(clock.dueOn) ?? "";
  const responded = formatDate(respondedOn) ?? "";
  const late = clock.state === "closed" && clock.late === true;
  return {
    status: CLOCK_CHIPS[clock.state] ?? "notRecorded",
    label: t("dataRights.clock.state", { state: late ? "closed_late" : clock.state }),
    words:
      clock.state === "closed" && !responded
        ? t("dataRights.clock.closedUndated")
        : t("dataRights.clock.words", { state: clock.state, due, responded }),
  };
}

const DECISION_CHIPS: Record<string, StatusChipStatus> = {
  pending: "due",
  disclose: "done",
  redact: "info",
  withhold: "neutral",
};

/** A record's decision as a chip. */
export function decisionChip(
  decision: string,
  t: Translator,
): { status: StatusChipStatus; label: string } {
  return {
    status: DECISION_CHIPS[decision] ?? "notRecorded",
    label: t("dataRights.decision", { decision }),
  };
}

/** A part of the record ("care_note") in words ("Care note"), for the lists on the case. */
export function partName(table: string): string {
  const words = table
    .replace(/^public\./, "")
    .split("_")
    .filter(Boolean)
    .join(" ");
  return words.length === 0 ? table : words.charAt(0).toUpperCase() + words.slice(1);
}

/** Why the bundle cannot be checked yet, or null when it can (rule 5). */
export function bundleBlocker(
  c: Pick<DsarCase, "identityRequired" | "identityVerifiedOn" | "collectedAt" | "items">,
): "identity" | "collect" | "pending" | null {
  if (c.identityRequired && c.identityVerifiedOn === null) return "identity";
  if (c.collectedAt === null || c.items.total === 0) return "collect";
  if (c.items.pending > 0) return "pending";
  return null;
}

const DSAR_CODES = new Set([
  "dsar_needs_organisation_role",
  "dsar_identity_not_verified",
  "dsar_record_changed",
  "dsar_records_changed",
  "dsar_not_collected",
  "dsar_bundle_not_kept",
]);
const DSAR_DETAILS = new Set([
  "subject_not_found",
  "request_shape_refused",
  "outcome_reason_required",
]);
/** The field each coded refusal is about, so the form ties the message to it. */
const DETAIL_FIELDS: Record<string, string> = {
  subject_not_found: "subject",
  outcome_reason_required: "outcomeReason",
};

/**
 * The API's refusal in plain words: the workbench's own codes and coded details from the
 * catalogue, everything else as the shared forms say it (step-up, conflicts, the API's sentences).
 */
export function dsarProblem(error: unknown, t: Translator): Problem {
  const problem =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const code = typeof problem.code === "string" ? problem.code : "";
  const detail = typeof problem.detail === "string" ? problem.detail.trim() : "";
  if (DSAR_CODES.has(code)) return { code, message: t("dataRights.refusal", { code }) };
  if (code === "invalid" && DSAR_DETAILS.has(detail)) {
    const message = t("dataRights.refusal", { code: detail });
    const field = DETAIL_FIELDS[detail];
    return { code, message, ...(field ? { fields: { [field]: message } } : {}) };
  }
  return problemMessage(error, t);
}

/** A record's value as text for the reviewer: dates and numbers as given, objects as JSON. */
export function fieldText(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value, null, 2);
}

export interface TextPart {
  readonly text: string;
  readonly name: boolean;
}

/**
 * Splits a field's text at the highlighted names (the API's start and end offsets), so the view
 * can mark each name and say it is one; overlapping or out-of-range offsets are ignored.
 */
export function splitHighlights(
  text: string,
  highlights: readonly { readonly start: number; readonly end: number }[],
): TextPart[] {
  const parts: TextPart[] = [];
  let at = 0;
  for (const h of [...highlights].sort((a, b) => a.start - b.start)) {
    if (h.start < at || h.end <= h.start || h.end > text.length) continue;
    if (h.start > at) parts.push({ text: text.slice(at, h.start), name: false });
    parts.push({ text: text.slice(h.start, h.end), name: true });
    at = h.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), name: false });
  return parts;
}
