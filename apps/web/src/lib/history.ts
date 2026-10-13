import type { RecordHistory } from "@harbour/contracts";
import type { Translator } from "@harbour/i18n";
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
  | "dols_authorisation";

export const HISTORY_TABLES: readonly HistoryTable[] = [
  "care_plan",
  "care_plan_section",
  "care_plan_action",
  "risk_assessment",
  "advance_care_record",
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
  const json = JSON.stringify(value);
  return json.length > 300 ? `${json.slice(0, 300)}…` : json;
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

/** Versions newest first, each field in words, marked where the next version changed it. */
export function versionViews(
  history: Pick<RecordHistory, "versions">,
  t: Translator,
): VersionView[] {
  const ordered = [...history.versions].sort((a, b) => a.version - b.version);
  return ordered
    .map((version, index) => {
      const next = ordered[index + 1];
      const fields = Object.entries(version.data)
        .filter(([key]) => !HIDDEN.has(key))
        .map(([key, value]) => ({
          key,
          label: fieldLabel(key),
          value: fieldValue(value, t),
          changedNext:
            next !== undefined && JSON.stringify(next.data[key]) !== JSON.stringify(value),
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
