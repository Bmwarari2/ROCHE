import { IMPORT_LIMITS, parseImportCsv, parseUkDate, unstorableText } from "../platform/imports";
import { type OliverMcGowanTier, TRAINING_TOPICS, type TrainingTopic } from "./training";

/**
 * Imports of external training records from a learning platform (workforce.md section 13;
 * WORK-006, slice 78; ADR-0102). A file (CSV or JSON) or a pull through the learning platform port
 * gives completions: the platform's stable learner id, its course code, the completion date and,
 * when it has them, an expiry, its own record id and the provider's name. Nothing else is read:
 * a name, an email or a score in the file is ignored, and a row is never matched by name.
 *
 * Every row is classified by a dry run before anything is imported (rule 3). Only `ready` rows
 * are imported; the rest wait for a person to link the learner, map the course or skip the row.
 * An imported completion is a new training record marked with its source; a record made in
 * Harbour is never changed by an import (rule 6).
 */

export const LMS_SOURCE_KINDS = ["file", "api"] as const;
export type LmsSourceKind = (typeof LMS_SOURCE_KINDS)[number];

export const LMS_IMPORT_FORMATS = ["csv", "json", "api"] as const;
export type LmsImportFormat = (typeof LMS_IMPORT_FORMATS)[number];

export const LMS_ROW_CLASSES = [
  "ready",
  "unmatched_learner",
  "unmapped_course",
  "already_recorded",
  "own_record",
  "invalid",
] as const;
export type LmsRowClass = (typeof LMS_ROW_CLASSES)[number];

export const LMS_ROW_OUTCOMES = ["pending", "imported", "skipped"] as const;
export type LmsRowOutcome = (typeof LMS_ROW_OUTCOMES)[number];

/** What a row may be wrong with, when it is `invalid`. */
export const LMS_ROW_PROBLEMS = [
  "learner_id",
  "course_code",
  "completed_on",
  "completed_in_future",
  "expires_on",
  "expires_before_completion",
  "record_id",
  "provider",
] as const;
export type LmsRowProblem = (typeof LMS_ROW_PROBLEMS)[number];

/** Limits on one import: rows, as the import wizard's (platform.md rule 19). */
export const LMS_IMPORT_LIMITS = { rows: IMPORT_LIMITS.rows, columns: 30, cellCharacters: 500 };

/** The platform's ids and codes: letters, digits and `._:/-`, never an `@` (an email is not one). */
const LEARNER_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const COURSE_CODE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const isLmsLearnerId = (v: string) => LEARNER_ID.test(v);
export const isLmsCourseCode = (v: string) => COURSE_CODE.test(v);
export const isLmsRecordId = (v: string) => RECORD_ID.test(v);

/** One completion as given, every value still text (trimmed). */
export interface LmsCompletionInput {
  readonly learnerId: string;
  readonly courseCode: string;
  readonly completedOn: string;
  readonly expiresOn?: string | null;
  readonly recordId?: string | null;
  readonly provider?: string | null;
}

/** One completion as staged: checked values, or what was wrong. */
export interface LmsStagedRow {
  readonly rowNumber: number;
  readonly learnerId: string;
  readonly courseCode: string;
  readonly completedOn: string | null;
  readonly expiresOn: string | null;
  /** The platform's own id for the completion, or one derived from the row when it has none. */
  readonly recordId: string;
  readonly provider: string | null;
  readonly problems: readonly LmsRowProblem[];
}

export type LmsParseResult =
  | { readonly ok: true; readonly rows: readonly LmsStagedRow[] }
  | { readonly ok: false; readonly message: string };

/** dd/mm/yyyy or yyyy-mm-dd to yyyy-mm-dd, or null when neither is a real date. */
export function lmsDate(value: string): string | null {
  const v = value.trim();
  if (ISO_DATE.test(v)) {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v ? v : null;
  }
  return parseUkDate(v);
}

/**
 * The record id a completion is known by: the platform's own when it gives one, otherwise one
 * derived from the learner, the course and the date, so the same completion imported twice is
 * the same record (rule 7).
 */
export function lmsRecordId(input: {
  readonly learnerId: string;
  readonly courseCode: string;
  readonly completedOn: string | null;
  readonly recordId?: string | null;
}): string {
  const given = input.recordId?.trim();
  if (given) return given;
  return `derived:${input.learnerId}/${input.courseCode}/${input.completedOn ?? ""}`;
}

/** Rule 2: check one completion's values; problems are named, never echoed. */
export function stageLmsRow(
  rowNumber: number,
  input: LmsCompletionInput,
  today: string,
): LmsStagedRow {
  const problems: LmsRowProblem[] = [];
  const learnerId = input.learnerId.trim();
  const courseCode = input.courseCode.trim();
  if (!isLmsLearnerId(learnerId)) problems.push("learner_id");
  if (!isLmsCourseCode(courseCode)) problems.push("course_code");
  const completedOn = lmsDate(input.completedOn);
  if (!completedOn) problems.push("completed_on");
  else if (completedOn > today) problems.push("completed_in_future");
  const expiresText = input.expiresOn?.trim() ?? "";
  const expiresOn = expiresText === "" ? null : lmsDate(expiresText);
  if (expiresText !== "" && !expiresOn) problems.push("expires_on");
  else if (expiresOn && completedOn && expiresOn < completedOn) {
    problems.push("expires_before_completion");
  }
  const recordText = input.recordId?.trim() ?? "";
  if (recordText !== "" && !isLmsRecordId(recordText)) problems.push("record_id");
  const providerText = input.provider?.trim() ?? "";
  const provider = providerText === "" ? null : providerText;
  // A provider is an organisation's name: never an email, never a spreadsheet formula.
  if (
    provider &&
    (provider.length < 2 ||
      provider.length > 160 ||
      unstorableText(provider) ||
      provider.includes("@") ||
      /^[-=+@]/.test(provider))
  ) {
    problems.push("provider");
  }
  // A value that broke a check is never kept as given, nor in a derived id: only its problem is.
  const keptLearner = problems.includes("learner_id") ? "" : learnerId;
  const keptCourse = problems.includes("course_code") ? "" : courseCode;
  const keptCompleted =
    completedOn && !problems.includes("completed_in_future") ? completedOn : null;
  return {
    rowNumber,
    learnerId: keptLearner,
    courseCode: keptCourse,
    completedOn: keptCompleted,
    expiresOn: problems.includes("expires_on") ? null : expiresOn,
    recordId: lmsRecordId({
      learnerId: keptLearner,
      courseCode: keptCourse,
      completedOn: keptCompleted,
      recordId: problems.includes("record_id") ? null : recordText,
    }),
    provider: problems.includes("provider") ? null : provider,
    problems,
  };
}

/** The headings a CSV may use for each value; any other column (a name, an email) is ignored. */
export const LMS_CSV_HEADINGS: Readonly<Record<keyof LmsCompletionInput, readonly string[]>> = {
  learnerId: ["learner_id", "learner id", "user_id", "user id", "employee_id", "employee id"],
  courseCode: ["course_code", "course code", "course_id", "course id"],
  completedOn: ["completed_on", "completed on", "completion_date", "completion date"],
  expiresOn: ["expires_on", "expires on", "expiry_date", "expiry date"],
  recordId: ["record_id", "record id", "completion_id", "completion id"],
  provider: ["provider", "training_provider", "training provider"],
};

/** Rule 2: a CSV of completions, by heading. */
export function parseLmsCsv(text: string, today: string): LmsParseResult {
  const parsed = parseImportCsv(text, LMS_IMPORT_LIMITS);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  const heading = parsed.header.map((h) => h.trim().toLowerCase());
  const column = (key: keyof LmsCompletionInput) =>
    heading.findIndex((h) => LMS_CSV_HEADINGS[key].includes(h));
  const at = {
    learnerId: column("learnerId"),
    courseCode: column("courseCode"),
    completedOn: column("completedOn"),
    expiresOn: column("expiresOn"),
    recordId: column("recordId"),
    provider: column("provider"),
  };
  if (at.learnerId < 0 || at.courseCode < 0 || at.completedOn < 0) {
    return {
      ok: false,
      message: "The file needs a learner id, a course code and a completion date column.",
    };
  }
  if (parsed.rows.length === 0) return { ok: false, message: "The file has no rows." };
  const cell = (row: readonly string[], i: number) => (i < 0 ? "" : (row[i] ?? ""));
  return {
    ok: true,
    rows: parsed.rows.map((row, i) =>
      stageLmsRow(
        i + 1,
        {
          learnerId: cell(row, at.learnerId),
          courseCode: cell(row, at.courseCode),
          completedOn: cell(row, at.completedOn),
          expiresOn: cell(row, at.expiresOn),
          recordId: cell(row, at.recordId),
          provider: cell(row, at.provider),
        },
        today,
      ),
    ),
  };
}

/** Rule 2: a JSON array of completions (`learnerId`, `courseCode`, `completedOn`, ...). */
export function parseLmsJson(text: string, today: string): LmsParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "The file is not valid JSON." };
  }
  if (!Array.isArray(value))
    return { ok: false, message: "The file must be a list of completions." };
  if (value.length === 0) return { ok: false, message: "The file has no rows." };
  if (value.length > LMS_IMPORT_LIMITS.rows) {
    return { ok: false, message: `The file has more than ${LMS_IMPORT_LIMITS.rows} rows.` };
  }
  const text_ = (v: unknown) =>
    typeof v === "string" ? v.slice(0, LMS_IMPORT_LIMITS.cellCharacters) : "";
  return {
    ok: true,
    rows: value.map((item, i) => {
      const o = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return stageLmsRow(
        i + 1,
        {
          learnerId: text_(o.learnerId),
          courseCode: text_(o.courseCode),
          completedOn: text_(o.completedOn),
          expiresOn: text_(o.expiresOn),
          recordId: text_(o.recordId),
          provider: text_(o.provider),
        },
        today,
      );
    }),
  };
}

/** What the dry run reads: the organisation's links, mappings and existing records. */
export interface LmsClassifyContext {
  /** Learner id to member (tenant_user.id), for this source. */
  readonly links: ReadonlyMap<string, string>;
  /** Course code to topic and tier, for this source (active mappings only). */
  readonly courses: ReadonlyMap<
    string,
    { readonly topic: TrainingTopic; readonly tier: OliverMcGowanTier | null }
  >;
  /** Record ids this source has already imported. */
  readonly importedRecordIds: ReadonlySet<string>;
  /** Live training records, by member, as `topic|tier|completedOn`. */
  readonly existing: ReadonlyMap<string, ReadonlySet<string>>;
  /** Who is running the import: never imports their own record (rule 5). */
  readonly importerId: string;
}

export interface LmsClassified {
  readonly rowNumber: number;
  readonly class: LmsRowClass;
  readonly workerId: string | null;
  readonly topic: TrainingTopic | null;
  readonly tier: OliverMcGowanTier | null;
}

export const trainingKey = (topic: string, tier: number | null, completedOn: string) =>
  `${topic}|${tier ?? ""}|${completedOn}`;

/** Rules 3 to 6: what each staged row is, in this order of precedence. */
export function classifyLmsRow(row: LmsStagedRow, ctx: LmsClassifyContext): LmsClassified {
  const base = { rowNumber: row.rowNumber, workerId: null, topic: null, tier: null };
  if (row.problems.length > 0 || !row.completedOn) return { ...base, class: "invalid" };
  const workerId = ctx.links.get(row.learnerId) ?? null;
  const course = ctx.courses.get(row.courseCode) ?? null;
  if (!workerId) return { ...base, class: "unmatched_learner" };
  if (!course) return { ...base, class: "unmapped_course", workerId };
  const found = { rowNumber: row.rowNumber, workerId, topic: course.topic, tier: course.tier };
  if (workerId === ctx.importerId) return { ...found, class: "own_record" };
  if (
    ctx.importedRecordIds.has(row.recordId) ||
    ctx.existing.get(workerId)?.has(trainingKey(course.topic, course.tier, row.completedOn))
  ) {
    return { ...found, class: "already_recorded" };
  }
  return { ...found, class: "ready" };
}

/**
 * Rule 3: classify a batch's pending rows. Two rows of one batch that are the same completion are
 * one: the later is `already_recorded`.
 */
export function classifyLmsRows(
  rows: readonly LmsStagedRow[],
  ctx: LmsClassifyContext,
): LmsClassified[] {
  const seenIds = new Set(ctx.importedRecordIds);
  const seenKeys = new Map<string, Set<string>>();
  for (const [worker, keys] of ctx.existing) seenKeys.set(worker, new Set(keys));
  return [...rows]
    .sort((a, b) => a.rowNumber - b.rowNumber)
    .map((row) => {
      const out = classifyLmsRow(row, {
        ...ctx,
        importedRecordIds: seenIds,
        existing: seenKeys,
      });
      if (out.class === "ready" && out.workerId && out.topic && row.completedOn) {
        seenIds.add(row.recordId);
        const keys = seenKeys.get(out.workerId) ?? new Set<string>();
        keys.add(trainingKey(out.topic, out.tier, row.completedOn));
        seenKeys.set(out.workerId, keys);
      }
      return out;
    });
}

/**
 * Rule 4: a dry run's fingerprint, as canonical text: the ready rows with who and what they would
 * record. The API keeps its SHA-256; a commit names the dry run it follows and is refused if the
 * rows it would import differ.
 */
export function lmsDryRunFingerprint(classified: readonly LmsClassified[]): string {
  return classified
    .filter((c) => c.class === "ready")
    .map((c) => `${c.rowNumber}|${c.workerId}|${c.topic}|${c.tier ?? ""}`)
    .sort()
    .join("\n");
}

export type LmsClassCounts = Readonly<Record<LmsRowClass, number>>;

export function countLmsClasses(classified: readonly LmsClassified[]): LmsClassCounts {
  const counts = Object.fromEntries(LMS_ROW_CLASSES.map((k) => [k, 0])) as Record<
    LmsRowClass,
    number
  >;
  for (const c of classified) counts[c.class] += 1;
  return counts;
}

/** Plain words for each class, for the dry-run report. */
export const LMS_ROW_CLASS_WORDS: Readonly<Record<LmsRowClass, string>> = {
  ready: "Ready to import",
  unmatched_learner: "Learner not linked to a member of staff",
  unmapped_course: "Course not mapped to a training topic",
  already_recorded: "Already recorded",
  own_record: "Your own record: someone else must import it",
  invalid: "Not a valid completion",
};

/** A course mapping's topic must be one Harbour knows, with a tier only for Oliver McGowan. */
export function checkCourseMapping(topic: string, tier: number | null): string | null {
  if (!(TRAINING_TOPICS as readonly string[]).includes(topic)) return "unknown_topic";
  if (topic === "oliver_mcgowan" ? tier !== 1 && tier !== 2 : tier !== null) return "tier";
  return null;
}
