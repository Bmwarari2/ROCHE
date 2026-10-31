import type { RecordHistory } from "@harbour/contracts";
import { RISK_TEMPLATES, type RiskTemplate, type RiskTemplateKey } from "@harbour/domain";
import type { MessageKey, Translator } from "@harbour/i18n";
import type { RecordTab } from "./care-record";
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

/** The tab that shows each kind of record as it is now. */
export const CURRENT_RECORD_TAB: Readonly<Record<HistoryTable, RecordTab>> = {
  care_plan: "care-plan",
  care_plan_section: "care-plan",
  care_plan_action: "care-plan",
  risk_assessment: "risk-assessments",
  advance_care_record: "advance-care",
  consent_record: "capacity",
  dols_authorisation: "capacity",
};

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

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
  if (isPlainObject(value)) {
    const lines = objectLines(value, t);
    return lines.length === 0 ? t("care.history.empty") : lines.join("; ");
  }
  return String(value);
}

/** "Label: value", or "Question? Yes" where the label is already a question. */
function line(label: string, value: string): string {
  return `${label}${label.endsWith("?") ? "" : ":"} ${value}`;
}

/** An object as one line per entry, each named in words. */
function objectLines(value: Record<string, unknown>, t: Translator): string[] {
  return Object.entries(value).map(([key, item]) => line(fieldLabel(key), fieldValue(item, t)));
}

/** A field's words: one line, or a list of lines (answers, findings, other stored objects). */
export type FieldText = string | readonly string[];

/**
 * The `status` columns that already have words, by the table the record lives in. Consent records
 * and DoLS authorisations keep an `outcome` instead, shown as stored for now (an open item).
 */
const STATUS_MESSAGES: Readonly<Record<string, MessageKey>> = {
  person: "platform.search.status",
  care_plan: "care.plan.status",
  advance_care_record: "care.advance.status",
};

/** Field names the label alone would get wrong, by table. */
const FIELD_LABELS: Readonly<Record<string, Readonly<Record<string, MessageKey>>>> = {
  risk_assessment: { template_key: "care.risk.template", controls: "care.risk.controls" },
};

/** A measurement question without its unit: the value carries it ("110 mm"). */
const withoutUnit = (text: string) => text.replace(/\s*\(mm\)$/, "");

function riskTemplate(data: Readonly<Record<string, unknown>>): RiskTemplate | undefined {
  return RISK_TEMPLATES[data.template_key as RiskTemplateKey] as RiskTemplate | undefined;
}

/**
 * How to name an answer's question: the template's own words only when the answer was given under
 * the template version Harbour has now; otherwise the stored key in words and the version it was
 * asked in, so a reworded question is never shown against an old answer (clinical safety review
 * round 1, M2).
 */
function questionNamer(data: Readonly<Record<string, unknown>>, t: Translator) {
  const template = riskTemplate(data);
  const sameVersion = template !== undefined && data.template_version === template.version;
  return (key: string) => {
    const asked = sameVersion ? template.questions.find((q) => q.key === key) : undefined;
    if (asked)
      return { text: withoutUnit(asked.text), measurement: asked.kind === "measurement_mm" };
    const label = fieldLabel(key);
    return {
      text: template
        ? t("care.history.askedIn", {
            question: label,
            version: fieldValue(data.template_version, t),
          })
        : label,
      measurement: false,
    };
  };
}

/** A risk assessment's own fields in words: the template's questions, bands and MHRA findings. */
function riskFieldValue(
  key: string,
  data: Readonly<Record<string, unknown>>,
  t: Translator,
): FieldText | undefined {
  const value = data[key];
  const template = riskTemplate(data);
  const question = questionNamer(data, t);
  if (key === "status" && (value === "active" || value === "closed")) {
    return t(value === "active" ? "care.risk.active.title" : "care.risk.closed.title");
  }
  if (key === "template_key" && template) return template.title;
  if ((key === "risk_band" || key === "residual_band") && typeof value === "string") {
    const rating = data[key === "risk_band" ? "risk_rating" : "residual_rating"];
    return t(key === "risk_band" ? "care.risk.rating" : "care.risk.residual", {
      rating: typeof rating === "number" ? rating : "",
      band: value,
    });
  }
  if (key === "answers" && isPlainObject(value)) {
    const lines = Object.entries(value).map(([answerKey, answer]) => {
      const asked = question(answerKey);
      if (asked.measurement && typeof answer === "number") {
        return t("care.history.measurement", { question: asked.text, value: answer });
      }
      return line(asked.text, fieldValue(answer, t));
    });
    return lines.length === 0 ? t("care.history.empty") : lines;
  }
  if (key === "findings" && Array.isArray(value)) {
    if (value.length === 0) return t("care.history.empty");
    return value.map((finding) => {
      if (!isPlainObject(finding)) return fieldValue(finding, t);
      const { questionKey, valueMm, limitMm, rule, withinLimit } = finding;
      const sentence = t("care.risk.finding", {
        question: question(String(questionKey)).text,
        value: Number(valueMm),
        rule: rule === "at_least" ? "at_least" : "under",
        limit: Number(limitMm),
      });
      return line(t(withinLimit ? "care.risk.withinLimit" : "care.risk.outsideLimit"), sentence);
    });
  }
  return undefined;
}

/**
 * The label for one field of an earlier version. A status is the status at the time, never a
 * present-tense "In use" (clinical safety review round 1, M1).
 */
export function recordFieldLabel(table: string | undefined, key: string, t: Translator): string {
  if (key === "status") return t("care.history.statusAtTheTime");
  const message = table ? FIELD_LABELS[table]?.[key] : undefined;
  return message ? t(message) : fieldLabel(key);
}

/** One field of a stored row in words, using what the table says about it where Harbour knows. */
export function recordFieldValue(
  table: string | undefined,
  key: string,
  data: Readonly<Record<string, unknown>>,
  t: Translator,
): FieldText {
  const value = data[key];
  if (table === "risk_assessment") {
    const words = riskFieldValue(key, data, t);
    if (words !== undefined) return words;
  }
  if (key === "status" && typeof value === "string") {
    const message = table ? STATUS_MESSAGES[table] : undefined;
    if (message) return t(message, { status: value });
  }
  if (isPlainObject(value)) {
    const lines = objectLines(value, t);
    return lines.length === 0 ? t("care.history.empty") : lines;
  }
  return fieldValue(value, t);
}

export interface VersionView {
  readonly version: number;
  readonly validFrom: string;
  readonly validTo: string;
  readonly changedBy: string | null;
  /**
   * What the marks compare with: the version that followed, the record as it is now (the newest
   * earlier version), or nothing (the API could not say what the latest change altered).
   */
  readonly comparedWith: "next" | "now" | null;
  readonly fields: readonly {
    readonly key: string;
    readonly label: string;
    readonly value: FieldText;
    /** The value is different in what this version is compared with. */
    readonly changed: boolean;
  }[];
}

/** What the version list needs: the versions, and the table and latest change when known. */
export type HistoryInput = Pick<RecordHistory, "versions"> &
  Partial<Pick<RecordHistory, "table" | "latestChanged">>;

/** Key order does not matter in stored objects (jsonb does not keep it). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.hasOwn(right, key) && sameValue(left[key], right[key]))
  );
}

/**
 * Versions newest first, each field in words, marked where it changed afterwards: an older version
 * against the version that followed it, the newest against the record as it is now, from the keys
 * the API says the latest change altered (`latestChanged`).
 */
export function versionViews(history: HistoryInput, t: Translator): VersionView[] {
  const ordered = [...history.versions].sort((a, b) => a.version - b.version);
  const latest = history.latestChanged ? new Set(history.latestChanged) : null;
  return ordered
    .map((version, index): VersionView => {
      const newest = index === ordered.length - 1;
      const next = newest ? undefined : ordered[index + 1]?.data;
      const comparedWith = !newest ? "next" : latest ? "now" : null;
      // A key the next version no longer has (a dropped column) is not a change.
      const changed = (key: string) =>
        next !== undefined
          ? Object.hasOwn(next, key) && !sameValue(next[key], version.data[key])
          : latest?.has(key) === true;
      const fields = Object.keys(version.data)
        .filter((key) => !HIDDEN.has(key))
        .map((key) => ({
          key,
          label: recordFieldLabel(history.table, key, t),
          value: recordFieldValue(history.table, key, version.data, t),
          changed: changed(key),
        }));
      return {
        version: version.version,
        validFrom: version.validFrom,
        validTo: version.validTo,
        changedBy: version.changedBy,
        comparedWith,
        fields,
      };
    })
    .reverse();
}
