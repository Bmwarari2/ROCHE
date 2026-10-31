import type { RecordHistory } from "@harbour/contracts";
import { RISK_TEMPLATES, type RiskTemplate, type RiskTemplateKey } from "@harbour/domain";
import type { MessageKey, Translator } from "@harbour/i18n";
import { formatDate, formatDateTime } from "./format";

/**
 * Earlier versions of mutable records (care plans, sections, actions, risk assessments, advance
 * care records and the person's own details), as the API's record history returns them. Nothing
 * in a care record is deleted; each change keeps the version before it (master prompt 5.5).
 */

export type HistoryTable =
  | "care_plan"
  | "care_plan_section"
  | "care_plan_action"
  | "risk_assessment"
  | "advance_care_record"
  | "consent_record"
  | "dols_authorisation";

export const HISTORY_TABLES: readonly HistoryTable[] = [
  "care_plan",
  "care_plan_section",
  "care_plan_action",
  "risk_assessment",
  "advance_care_record",
  "consent_record",
  "dols_authorisation",
];

export function isHistoryTable(value: unknown): value is HistoryTable {
  return typeof value === "string" && (HISTORY_TABLES as readonly string[]).includes(value);
}

/** Bookkeeping columns that say nothing about the person; the version is shown on its own. */
const HIDDEN = new Set([
  "id",
  "tenant_id",
  "tenantId",
  "person_id",
  "personId",
  "location_id",
  "locationId",
  "plan_id",
  "planId",
  "section_id",
  "sectionId",
  "version",
  "created_at",
  "createdAt",
  "created_by",
  "createdBy",
  "updated_at",
  "updatedAt",
  "updated_by",
  "updatedBy",
  "deleted_at",
  "deletedAt",
]);

/** "review_due_on" or "reviewDueOn" as "Review due on". */
export function fieldLabel(key: string): string {
  const words: string[] = [];
  let word = "";
  for (const char of key) {
    if (char === "_" || char === " ") {
      if (word) words.push(word);
      word = "";
    } else if (char >= "A" && char <= "Z") {
      if (word) words.push(word);
      word = char.toLowerCase();
    } else {
      word += char;
    }
  }
  if (word) words.push(word);
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** A stored value in words: dates in UK form, yes or no, and "Not recorded" for nothing. */
export function fieldValue(value: unknown, t: Translator): string {
  if (value === null || value === undefined || value === "") return t("care.history.empty");
  if (typeof value === "boolean") return value ? t("care.common.yes") : t("care.common.no");
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    if (value.length === 10 && ISO_DATE.test(value)) return formatDate(value) ?? value;
    if (value.length <= 40 && ISO_INSTANT.test(value)) return formatDateTime(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) {
    return value.length === 0
      ? t("care.history.empty")
      : value.map((item) => fieldValue(item, t)).join("; ");
  }
  if (typeof value === "object") return objectLines(value as Record<string, unknown>, t);
  return String(value);
}

/** An object as one "Label: value" line per entry; `labels` names keys the label cannot. */
function objectLines(
  value: Record<string, unknown>,
  t: Translator,
  labels: Readonly<Record<string, string>> = {},
): string {
  const entries = Object.entries(value);
  if (entries.length === 0) return t("care.history.empty");
  return entries
    .map(([key, item]) => {
      const label = labels[key] ?? fieldLabel(key);
      // A question already ends in a question mark: "Can they stand? Yes", not "stand?: Yes".
      return `${label}${label.endsWith("?") ? "" : ":"} ${fieldValue(item, t)}`;
    })
    .join("\n");
}

/** The statuses that already have words, by the table the record lives in. */
const STATUS_MESSAGES: Readonly<Record<string, MessageKey>> = {
  person: "platform.search.status",
  care_plan: "care.plan.status",
  advance_care_record: "care.advance.status",
  dols_authorisation: "care.mca.dols.status",
};

/** One field of a stored row in words, using what the table says about it where Harbour knows. */
export function recordFieldValue(
  table: string | undefined,
  key: string,
  data: Readonly<Record<string, unknown>>,
  t: Translator,
): string {
  const value = data[key];
  if (key === "status" && typeof value === "string") {
    if (table === "risk_assessment" && (value === "active" || value === "closed")) {
      return t(value === "active" ? "care.risk.active.title" : "care.risk.closed.title");
    }
    const message = table ? STATUS_MESSAGES[table] : undefined;
    if (message) return t(message, { status: value });
  }
  if (
    table === "risk_assessment" &&
    key === "answers" &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  ) {
    const template = RISK_TEMPLATES[data.template_key as RiskTemplateKey] as
      | RiskTemplate
      | undefined;
    const labels = Object.fromEntries(template?.questions.map((q) => [q.key, q.text]) ?? []);
    return objectLines(value as Record<string, unknown>, t, labels);
  }
  return fieldValue(value, t);
}

export interface VersionView {
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string;
  readonly changedBy: string | null;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    /** The value is different in the version that followed. */
    readonly changedNext: boolean;
  }[];
}

/** What the version list needs: the versions, and the table and current row when known. */
export type HistoryInput = Pick<RecordHistory, "versions"> &
  Partial<Pick<RecordHistory, "table" | "current">>;

/** Key order does not matter in stored objects (jsonb does not keep it). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  return (
    aKeys.length === bKeys.length &&
    aKeys.every((key) =>
      sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    )
  );
}

/**
 * Versions newest first, each field in words, marked where the next version changed it. The
 * newest earlier version is compared with the record as it is now (`current`), so the latest
 * change is marked too.
 */
export function versionViews(history: HistoryInput, t: Translator): VersionView[] {
  const ordered = [...history.versions].sort((a, b) => a.version - b.version);
  return ordered
    .map((version, index) => {
      const next = ordered[index + 1]?.data ?? history.current;
      const fields = Object.entries(version.data)
        .filter(([key]) => !HIDDEN.has(key))
        .map(([key, value]) => ({
          key,
          label: fieldLabel(key),
          value: recordFieldValue(history.table, key, version.data, t),
          changedNext: next !== undefined && !sameValue(next[key], value),
        }));
      return {
        version: version.version,
        validFrom: version.validFrom,
        validTo: version.validTo,
        changedBy: version.changedBy,
        fields,
      };
    })
    .reverse();
}
