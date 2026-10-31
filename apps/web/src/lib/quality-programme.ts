import type {
  AuditAnswerValue,
  AuditQuestion,
  AuditRecordSummary,
  AuditScheduleItem,
  EvidenceCoverage,
  FrameworkMappingEntry,
  FrameworkVersionDetail,
  FrameworkVersionSummary,
} from "@harbour/contracts";
import { SELF_RATING_WORDS } from "@harbour/domain";
import type { Translator } from "@harbour/i18n";
import type { QualityChip } from "./evidence-packs";
import type { FormValues } from "./incident-forms";
import type { FieldErrors } from "./outcome";
import { readDateField } from "./uk-time";

/**
 * The compliance framework, evidence library and audit programme screens (quality.md section 20;
 * QUAL-001, QUAL-002, QUAL-004). Pure helpers: who sees what, statuses as an icon and a word,
 * and reading the forms into the API's bodies. The API checks every rule again.
 */

export const EVIDENCE_MANAGE = "quality.evidence.manage";
export const AUDIT_MANAGE = "quality.audit.manage";
/** Who may read the framework itself (the API's readers). */
export const FRAMEWORK_READERS = [
  EVIDENCE_MANAGE,
  AUDIT_MANAGE,
  "quality.policy.manage",
  "quality.evidence_pack.compose",
  "quality.evidence_pack.release",
] as const;

export const frameworkShown = (permissions: readonly string[]) =>
  FRAMEWORK_READERS.some((p) => permissions.includes(p));
export const evidenceManaged = (permissions: readonly string[]) =>
  permissions.includes(EVIDENCE_MANAGE);
export const auditsShown = (permissions: readonly string[]) => permissions.includes(AUDIT_MANAGE);

// ---------------------------------------------------------------------------------------------
// The framework and the mapping

/** A framework version's status: in force, published, a draft or retired. */
export function versionChip(version: FrameworkVersionSummary, t: Translator): QualityChip {
  const state = version.inForce ? "inForce" : version.state;
  const look: Record<string, Pick<QualityChip, "status" | "icon">> = {
    inForce: { status: "done", icon: "circle-check" },
    published: { status: "info", icon: "send" },
    draft: { status: "neutral", icon: "file-pen" },
    retired: { status: "neutral", icon: "circle-minus" },
  };
  return {
    ...(look[state] ?? look.draft),
    label: t("quality.framework.state", { state }),
  } as QualityChip;
}

export interface StatementRow {
  readonly id: string;
  readonly title: string;
  readonly keyQuestionId: string;
  readonly keyQuestionTitle: string;
}

/** Every statement of a version, in the framework's order, with its key question. */
export function statementRows(
  detail: Pick<FrameworkVersionDetail, "keyQuestions">,
): StatementRow[] {
  return detail.keyQuestions.flatMap((q) =>
    q.statements.map((s) => ({
      id: s.id,
      title: s.title,
      keyQuestionId: q.id,
      keyQuestionTitle: q.title,
    })),
  );
}

export const MAPPING_TITLE_MAX = 200;
export const MAPPING_OWNER_MAX = 64;

/** The field names of one statement's row in the mapping editor. */
export const mappingField = {
  title: (statementId: string) => `title:${statementId}`,
  owner: (statementId: string) => `owner:${statementId}`,
  category: (statementId: string) => `category:${statementId}`,
} as const;

/**
 * The mapping editor's form as the next mapping version: a row for each statement with a local
 * title, an owner role or evidence categories; rows left empty are left out. Problems are said
 * at their fields.
 */
export function readMapping(
  form: FormValues,
  detail: Pick<FrameworkVersionDetail, "keyQuestions" | "evidenceCategories">,
  t: Translator,
):
  | { readonly ok: true; readonly entries: FrameworkMappingEntry[] }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const categories = new Set(detail.evidenceCategories.map((c) => c.id));
  const entries: FrameworkMappingEntry[] = [];
  const errors: Record<string, string> = {};
  for (const statement of statementRows(detail)) {
    const title = String(form.get(mappingField.title(statement.id)) ?? "").trim();
    const owner = String(form.get(mappingField.owner(statement.id)) ?? "").trim();
    const chosen = form
      .getAll(mappingField.category(statement.id))
      .map(String)
      .filter((c) => categories.has(c));
    if (title.length > MAPPING_TITLE_MAX) {
      errors[mappingField.title(statement.id)] = t("quality.mapping.titleTooLong", {
        max: MAPPING_TITLE_MAX,
        statement: statement.title,
      });
    }
    if (owner.length > MAPPING_OWNER_MAX) {
      errors[mappingField.owner(statement.id)] = t("quality.mapping.ownerTooLong", {
        max: MAPPING_OWNER_MAX,
        statement: statement.title,
      });
    }
    if (!title && !owner && chosen.length === 0) continue;
    entries.push({
      statementId: statement.id,
      localTitle: title || null,
      ownerRole: owner || null,
      evidenceCategoryIds: chosen,
    });
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, entries };
}

export interface CoverageRow extends StatementRow {
  readonly records: number;
}

/** Coverage in the framework's order, so the gaps read in place, never sorted away. */
export function coverageRows(
  coverage: Pick<EvidenceCoverage, "statements">,
  detail: Pick<FrameworkVersionDetail, "keyQuestions">,
): CoverageRow[] {
  const counts = new Map(coverage.statements.map((s) => [s.statementId, s.records]));
  return statementRows(detail).map((s) => ({ ...s, records: counts.get(s.id) ?? 0 }));
}

/** A statement's evidence: a gap is said in words, never shown only by colour. */
export function coverageChip(records: number, t: Translator): QualityChip {
  return records === 0
    ? { status: "due", icon: "circle-alert", label: t("quality.coverage.gap") }
    : { status: "done", icon: "circle-check", label: t("quality.coverage.records", { records }) };
}

// ---------------------------------------------------------------------------------------------
// Evidence tagging

/** Record types the evidence library can tag (the API's list), with audits from slice 19. */
export const TAGGABLE_RECORD_TYPES = [
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
  "audit",
] as const;
export type TaggableRecordType = (typeof TAGGABLE_RECORD_TYPES)[number];
export const isTaggable = (value: unknown): value is TaggableRecordType =>
  typeof value === "string" && (TAGGABLE_RECORD_TYPES as readonly string[]).includes(value);

export const TAG_STATEMENTS_MAX = 20;

/** The statements ticked on the tagging form, each a statement of the version, 1 to 20. */
export function readTag(
  form: FormValues,
  detail: Pick<FrameworkVersionDetail, "keyQuestions">,
  t: Translator,
):
  | { readonly ok: true; readonly statementIds: string[] }
  | { readonly ok: false; readonly errors: FieldErrors } {
  const known = new Set(statementRows(detail).map((s) => s.id));
  const chosen = [...new Set(form.getAll("statement").map(String))].filter((s) => known.has(s));
  if (chosen.length === 0) return { ok: false, errors: { statement: t("quality.tag.noneChosen") } };
  if (chosen.length > TAG_STATEMENTS_MAX) {
    return {
      ok: false,
      errors: { statement: t("quality.tag.tooMany", { max: TAG_STATEMENTS_MAX }) },
    };
  }
  return { ok: true, statementIds: chosen };
}

// ---------------------------------------------------------------------------------------------
// The audit programme

export function auditStateChip(state: AuditRecordSummary["state"], t: Translator): QualityChip {
  return state === "completed"
    ? { status: "done", icon: "circle-check", label: t("quality.audit.state", { state }) }
    : { status: "due", icon: "pen-line", label: t("quality.audit.state", { state }) };
}

/** When a schedule's next audit is due: overdue from the day after, said with the date. */
export function scheduleChip(
  item: Pick<AuditScheduleItem, "nextDueOn" | "overdue">,
  formatDate: (iso: string) => string,
  t: Translator,
): QualityChip {
  const date = formatDate(item.nextDueOn);
  return item.overdue
    ? { status: "overdue", icon: "circle-alert", label: t("quality.schedule.overdue", { date }) }
    : { status: "due", icon: "clock", label: t("quality.schedule.due", { date }) };
}

export const ANSWERS: readonly AuditAnswerValue[] = ["yes", "partial", "no", "not_applicable"];

/** The answer field for a question. */
export const answerField = (key: string) => `answer:${key}`;

/** The answers chosen on the form, for this audit's own questions only (null clears one). */
export function readAnswers(
  form: FormValues,
  questions: readonly Pick<AuditQuestion, "key">[],
): Record<string, AuditAnswerValue | null> {
  const answers: Record<string, AuditAnswerValue | null> = {};
  for (const q of questions) {
    const value = String(form.get(answerField(q.key)) ?? "");
    answers[q.key] = (ANSWERS as readonly string[]).includes(value)
      ? (value as AuditAnswerValue)
      : null;
  }
  return answers;
}

/** The questions that fell short and need an action ("no" or "partial", action required). */
export function needsAction(
  questions: readonly AuditQuestion[],
  answers: Readonly<Record<string, AuditAnswerValue | null>>,
): AuditQuestion[] {
  return questions.filter(
    (q) => q.actionRequired && (answers[q.key] === "no" || answers[q.key] === "partial"),
  );
}

/** The self-rating choices: the CQC words with their number, given by a person. */
export function selfRatingChoices(t: Translator): { value: string; label: string }[] {
  return Object.keys(SELF_RATING_WORDS).map((value) => ({
    value,
    label: t("quality.audit.ratingChoice", { value }),
  }));
}

/** The score's method in words, from its weighted points (rule 9), for every language. */
export function methodText(
  score: { readonly achieved: number; readonly possible: number },
  t: Translator,
): string {
  const round = (n: number) => String(Math.round(n * 10) / 10);
  return t("quality.audit.method", {
    possible: score.possible,
    achieved: round(score.achieved),
    total: round(score.possible),
  });
}

export const actionField = {
  description: (key: string) => `action:${key}:description`,
  owner: (key: string) => `action:${key}:owner`,
  due: (key: string) => `action:${key}:due`,
} as const;
export const ACTION_DESCRIPTION_MAX = 1000;

export interface CompletionBody {
  readonly selfRating: number;
  readonly actions: {
    readonly questionKey: string;
    readonly description: string;
    readonly ownerId: string;
    readonly dueOn?: string;
  }[];
}

/**
 * The completion form: the self-rating, and an action for each question that fell short, with a
 * description, an owner and an optional due date (dd/mm/yyyy; left empty, the organisation's
 * default applies). Every problem is said at its field at once.
 */
export function readCompletion(
  form: FormValues,
  shortfalls: readonly Pick<AuditQuestion, "key" | "text">[],
  owners: readonly string[],
  t: Translator,
):
  | { readonly ok: true; readonly body: CompletionBody }
  | {
      readonly ok: false;
      readonly errors: FieldErrors;
      readonly parts: Readonly<Record<string, readonly string[]>>;
    } {
  const errors: Record<string, string> = {};
  const parts: Record<string, readonly string[]> = {};
  const rating = Number(form.get("selfRating"));
  if (!(String(rating) in SELF_RATING_WORDS)) errors.selfRating = t("quality.audit.ratingMissing");
  const actions: CompletionBody["actions"] = [];
  for (const q of shortfalls) {
    const description = String(form.get(actionField.description(q.key)) ?? "").trim();
    const owner = String(form.get(actionField.owner(q.key)) ?? "");
    if (description.length < 3) {
      errors[actionField.description(q.key)] = t("quality.audit.actionDescriptionMissing", {
        text: q.text,
      });
    } else if (description.length > ACTION_DESCRIPTION_MAX) {
      errors[actionField.description(q.key)] = t("quality.audit.actionDescriptionTooLong", {
        max: ACTION_DESCRIPTION_MAX,
        text: q.text,
      });
    }
    if (!owners.includes(owner)) {
      errors[actionField.owner(q.key)] = t("quality.audit.ownerMissing", { text: q.text });
    }
    const due = readDateField(form, actionField.due(q.key), {
      subject: t("quality.audit.actionDueSubject"),
      optional: true,
      t,
    });
    if (!due.ok) {
      errors[actionField.due(q.key)] = due.message;
      parts[actionField.due(q.key)] = due.parts;
    }
    actions.push({
      questionKey: q.key,
      description,
      ownerId: owner,
      ...(due.ok && due.date ? { dueOn: due.date } : {}),
    });
  }
  return Object.keys(errors).length > 0
    ? { ok: false, errors, parts }
    : { ok: true, body: { selfRating: rating, actions } };
}

/** A score with one decimal, or the words for none (never 0 or 100 made up). */
export function scoreText(percent: number | null, t: Translator): string {
  return percent === null
    ? t("quality.audit.noScore")
    : t("quality.audit.score", { percent: (Math.round(percent * 10) / 10).toFixed(1) });
}

/** Where a tagged record opens, for the kinds with their own page; others are named only. */
export function recordHref(recordType: string, recordId: string): string | null {
  switch (recordType) {
    case "incident":
      return `/incidents/${recordId}`;
    case "audit":
      return `/quality/audits/${recordId}`;
    default:
      return null;
  }
}
